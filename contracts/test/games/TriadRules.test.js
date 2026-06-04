const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// State = 9 bytes (cells 0..8): 0 empty, 1 p1, 2 p2. Move = 1 byte cell index.
const EMPTY = "0x" + "00".repeat(9);

function cells(arr) {
  return "0x" + arr.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function move(cell) {
  return "0x" + cell.toString(16).padStart(2, "0");
}

describe("TriadRules", function () {
  async function deployFixture() {
    const F = await ethers.getContractFactory("TriadRules");
    const rules = await F.deploy();
    await rules.waitForDeployment();
    return { rules };
  }

  it("metadata + initial state", async function () {
    const { rules } = await loadFixture(deployFixture);
    expect(await rules.gameName()).to.equal("Triad");
    expect(await rules.minPlayers()).to.equal(2);
    expect(await rules.maxPlayers()).to.equal(2);
    expect(await rules.simultaneous(EMPTY)).to.equal(false);
    expect(await rules.initialState("0x", 2)).to.equal(EMPTY);
  });

  it("rejects non-2 player counts", async function () {
    const { rules } = await loadFixture(deployFixture);
    await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(
      rules,
      "BadPlayerCount"
    );
  });

  it("applies a legal move (p1 plays cell 0)", async function () {
    const { rules } = await loadFixture(deployFixture);
    const s = await rules.applyMove(EMPTY, 0, move(0));
    expect(s).to.equal(cells([1, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect(await rules.status(s)).to.equal(0);
  });

  it("reverts taken cell, out-of-range cell, bad move length", async function () {
    const { rules } = await loadFixture(deployFixture);
    const s1 = await rules.applyMove(EMPTY, 0, move(0));
    // p2's turn; cell 0 is taken
    await expect(rules.applyMove(s1, 1, move(0))).to.be.revertedWithCustomError(
      rules,
      "CellTaken"
    );
    await expect(rules.applyMove(s1, 1, move(9))).to.be.revertedWithCustomError(
      rules,
      "CellOutOfRange"
    );
    await expect(rules.applyMove(s1, 1, "0x0102")).to.be.revertedWithCustomError(
      rules,
      "BadMoveLength"
    );
  });

  it("enforces turn parity (p2 cannot move on an empty board)", async function () {
    const { rules } = await loadFixture(deployFixture);
    await expect(rules.applyMove(EMPTY, 1, move(0))).to.be.revertedWithCustomError(
      rules,
      "NotYourTurn"
    );
  });

  it("detects all 3 row wins for p1", async function () {
    const { rules } = await loadFixture(deployFixture);
    const rows = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ];
    for (const r of rows) {
      const board = Array(9).fill(0);
      r.forEach((c) => (board[c] = 1));
      expect(await rules.status(cells(board))).to.equal(1);
    }
  });

  it("detects all 3 column wins for p2", async function () {
    const { rules } = await loadFixture(deployFixture);
    const cols = [
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8],
    ];
    for (const c of cols) {
      const board = Array(9).fill(0);
      c.forEach((i) => (board[i] = 2));
      expect(await rules.status(cells(board))).to.equal(2);
    }
  });

  it("detects both diagonal wins", async function () {
    const { rules } = await loadFixture(deployFixture);
    const d1 = Array(9).fill(0);
    [0, 4, 8].forEach((i) => (d1[i] = 1));
    expect(await rules.status(cells(d1))).to.equal(1);

    const d2 = Array(9).fill(0);
    [2, 4, 6].forEach((i) => (d2[i] = 2));
    expect(await rules.status(cells(d2))).to.equal(2);
  });

  it("reports a full no-line board as a draw (255)", async function () {
    const { rules } = await loadFixture(deployFixture);
    // 1 2 1 / 1 2 2 / 2 1 1  — no three-in-a-row
    const board = [1, 2, 1, 1, 2, 2, 2, 1, 1];
    expect(await rules.status(cells(board))).to.equal(255);
  });

  it("reverts applyMove once the game is over", async function () {
    const { rules } = await loadFixture(deployFixture);
    // p1 has top row → won
    const board = cells([1, 1, 1, 2, 2, 0, 0, 0, 0]);
    await expect(rules.applyMove(board, 1, move(5))).to.be.revertedWithCustomError(
      rules,
      "GameOver"
    );
  });
});
