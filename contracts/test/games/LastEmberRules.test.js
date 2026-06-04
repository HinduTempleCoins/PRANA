const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// config = heap sizes, one byte each. state = [lastMover, heap0..heapN]. move = [heapIdx, take].
function bytesOf(arr) {
  return "0x" + arr.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function nimMove(heap, take) {
  return bytesOf([heap, take]);
}

describe("LastEmberRules", function () {
  async function deployFixture() {
    const F = await ethers.getContractFactory("LastEmberRules");
    const rules = await F.deploy();
    await rules.waitForDeployment();
    return { rules };
  }

  it("metadata + initial state encodes lastMover=0 then heaps", async function () {
    const { rules } = await loadFixture(deployFixture);
    expect(await rules.gameName()).to.equal("LastEmber");
    expect(await rules.minPlayers()).to.equal(2);
    expect(await rules.maxPlayers()).to.equal(2);
    const s = await rules.initialState(bytesOf([3, 4, 5]), 2);
    expect(s).to.equal(bytesOf([0, 3, 4, 5]));
    expect(await rules.simultaneous(s)).to.equal(false);
    expect(await rules.status(s)).to.equal(0);
  });

  it("rejects empty/oversized/zero-heap config and non-2 players", async function () {
    const { rules } = await loadFixture(deployFixture);
    await expect(rules.initialState("0x", 2)).to.be.revertedWithCustomError(
      rules,
      "BadConfig"
    );
    await expect(
      rules.initialState(bytesOf([1, 1, 1, 1, 1, 1, 1, 1, 1]), 2)
    ).to.be.revertedWithCustomError(rules, "BadConfig");
    await expect(
      rules.initialState(bytesOf([3, 0, 5]), 2)
    ).to.be.revertedWithCustomError(rules, "BadConfig");
    await expect(
      rules.initialState(bytesOf([3]), 3)
    ).to.be.revertedWithCustomError(rules, "BadPlayerCount");
  });

  it("applies a legal take and records the mover", async function () {
    const { rules } = await loadFixture(deployFixture);
    const s0 = bytesOf([0, 3, 4, 5]);
    const s1 = await rules.applyMove(s0, 0, nimMove(2, 3)); // p1 takes 3 from heap 2
    expect(s1).to.equal(bytesOf([1, 3, 4, 2])); // lastMover=1
  });

  it("reverts illegal takes: out-of-range heap, take 0/4, exceeding heap", async function () {
    const { rules } = await loadFixture(deployFixture);
    const s = bytesOf([0, 3, 4, 5]);
    await expect(rules.applyMove(s, 0, nimMove(3, 1))).to.be.revertedWithCustomError(
      rules,
      "HeapOutOfRange"
    );
    await expect(rules.applyMove(s, 0, nimMove(0, 0))).to.be.revertedWithCustomError(
      rules,
      "BadTakeAmount"
    );
    await expect(rules.applyMove(s, 0, nimMove(0, 4))).to.be.revertedWithCustomError(
      rules,
      "BadTakeAmount"
    );
    // a legal take from heap 0 (which has 3) succeeds and returns the new state.
    expect(await rules.applyMove(s, 0, nimMove(0, 3))).to.equal(bytesOf([1, 0, 4, 5]));
    // heap 0 has 3; taking from heap that has fewer than requested:
    const small = bytesOf([0, 1, 4, 5]);
    await expect(rules.applyMove(small, 0, nimMove(0, 3))).to.be.revertedWithCustomError(
      rules,
      "HeapTooSmall"
    );
  });

  it("misère: the player who empties the last heap LOSES", async function () {
    const { rules } = await loadFixture(deployFixture);
    // one heap of size 1, p1 (index 0) takes the last object → p1 loses, p2 wins.
    const s0 = bytesOf([0, 1]);
    const s1 = await rules.applyMove(s0, 0, nimMove(0, 1));
    expect(s1).to.equal(bytesOf([1, 0])); // lastMover=1, heap empty
    expect(await rules.status(s1)).to.equal(2); // winner is p2

    // symmetric: p2 takes the last → p1 wins
    const t1 = await rules.applyMove(s0, 1, nimMove(0, 1));
    expect(await rules.status(t1)).to.equal(1);
  });

  it("reverts applyMove after all heaps are empty", async function () {
    const { rules } = await loadFixture(deployFixture);
    const done = bytesOf([1, 0]);
    await expect(rules.applyMove(done, 1, nimMove(0, 1))).to.be.revertedWithCustomError(
      rules,
      "GameOver"
    );
  });

  // ----------------------------------------------------------------- //
  //  Integration: a full match on GameTable                           //
  // ----------------------------------------------------------------- //
  async function tableFixture() {
    const [admin, rake, p1, p2] = await ethers.getSigners();
    const Rules = await ethers.getContractFactory("LastEmberRules");
    const rules = await Rules.deploy();
    const Table = await ethers.getContractFactory("GameTable");
    const table = await Table.deploy(admin.address, 0, rake.address);
    return { table, rules, admin, rake, p1, p2 };
  }

  it("integration: full Nim match settles the winner's pot on GameTable", async function () {
    const { table, rules, p1, p2 } = await loadFixture(tableFixture);
    const stake = ethers.parseEther("1");
    const cfg = bytesOf([1]); // single heap of 1 → first mover takes last → loses

    await table
      .connect(p1)
      .createMatch(await rules.getAddress(), cfg, ethers.ZeroAddress, stake, 2, 0, {
        value: stake,
      });
    await table.connect(p2).joinMatch(0, { value: stake }); // auto-starts (full)

    // p1 (player index 0) is forced to take the only object and thus LOSES; p2 wins.
    // rules.status returns the 1-based winner = 2 (the other player), pot → ps[1] = p2.
    await expect(
      table.connect(p1).submitMove(0, nimMove(0, 1))
    ).to.changeEtherBalances([p2], [stake * 2n]);

    const m = await table.getMatch(0);
    expect(m.winner).to.equal(2); // 1-based winner = p2
  });
});
