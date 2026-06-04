const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// ---- Triad helpers (state = 9 bytes, move = 1 byte cell index) ----
function move(cell) {
  return "0x" + cell.toString(16).padStart(2, "0");
}

const NATIVE = ethers.ZeroAddress;
const STAKE = ethers.parseEther("1");
const TIMEOUT = 3600; // 1 hour per move

describe("GameTable", function () {
  async function deployFixture() {
    const [admin, rake, p1, p2, p3, outsider] = await ethers.getSigners();

    const Triad = await ethers.getContractFactory("TriadRules");
    const triad = await Triad.deploy();

    const Mock = await ethers.getContractFactory("MockERC20");
    const token = await Mock.deploy("Stake", "STK");

    const Table = await ethers.getContractFactory("GameTable");
    // default rake = 2% (200 bps) routed to `rake`.
    const table = await Table.deploy(admin.address, 200, rake.address);

    const tableAddr = await table.getAddress();
    for (const s of [p1, p2, p3]) {
      await token.mint(s.address, ethers.parseEther("1000"));
      await token.connect(s).approve(tableAddr, ethers.MaxUint256);
    }

    return { table, triad, token, admin, rake, p1, p2, p3, outsider };
  }

  // Open a native-stake Triad match with p1 as creator, p2 joining (auto-starts at 2).
  async function openTriad(table, triad, p1, p2, timeout = TIMEOUT) {
    await table
      .connect(p1)
      .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, timeout, {
        value: STAKE,
      });
    await table.connect(p2).joinMatch(0, { value: STAKE });
    return 0;
  }

  // -------------------------------------------------------------- //
  //  Lobby / escrow                                                //
  // -------------------------------------------------------------- //

  it("createMatch escrows the creator's native stake and records them", async function () {
    const { table, triad, p1 } = await loadFixture(deployFixture);
    await expect(
      table
        .connect(p1)
        .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, TIMEOUT, {
          value: STAKE,
        })
    ).to.changeEtherBalances([p1, table], [-STAKE, STAKE]);

    const m = await table.getMatch(0);
    expect(m.status).to.equal(0); // Open
    expect(m.numPlayers).to.equal(1);
    expect(await table.isPlayer(0, p1.address)).to.equal(true);
  });

  it("reverts on wrong native value and on native sent for an ERC-20 stake", async function () {
    const { table, triad, token, p1 } = await loadFixture(deployFixture);
    await expect(
      table
        .connect(p1)
        .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, TIMEOUT, {
          value: STAKE - 1n,
        })
    ).to.be.revertedWithCustomError(table, "WrongNativeValue");

    await expect(
      table
        .connect(p1)
        .createMatch(
          await triad.getAddress(),
          "0x",
          await token.getAddress(),
          STAKE,
          2,
          TIMEOUT,
          { value: 1 }
        )
    ).to.be.revertedWithCustomError(table, "NativeNotAccepted");
  });

  it("ERC-20 escrow: both stakes pulled into the table", async function () {
    const { table, triad, token, p1, p2 } = await loadFixture(deployFixture);
    const tokenAddr = await token.getAddress();
    await table
      .connect(p1)
      .createMatch(await triad.getAddress(), "0x", tokenAddr, STAKE, 2, TIMEOUT);
    await table.connect(p2).joinMatch(0);

    expect(await token.balanceOf(await table.getAddress())).to.equal(STAKE * 2n);
    const m = await table.getMatch(0);
    expect(m.status).to.equal(1); // Active (auto-started full)
  });

  it("joinMatch auto-starts when the lobby fills and builds initial state", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);
    const m = await table.getMatch(0);
    expect(m.status).to.equal(1); // Active
    expect(await table.getState(0)).to.equal("0x" + "00".repeat(9));
    expect(await table.currentTurn(0)).to.equal(p1.address);
  });

  it("rejects double-join and join when full", async function () {
    const { table, triad, p1, p2, p3 } = await loadFixture(deployFixture);
    await table
      .connect(p1)
      .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, TIMEOUT, {
        value: STAKE,
      });
    await expect(
      table.connect(p1).joinMatch(0, { value: STAKE })
    ).to.be.revertedWithCustomError(table, "AlreadyJoined");
    await table.connect(p2).joinMatch(0, { value: STAKE }); // fills + starts
    await expect(
      table.connect(p3).joinMatch(0, { value: STAKE })
    ).to.be.revertedWithCustomError(table, "NotOpen");
  });

  // -------------------------------------------------------------- //
  //  Full game → win + rake                                        //
  // -------------------------------------------------------------- //

  it("plays Triad to a p1 win and settles pot minus rake", async function () {
    const { table, triad, rake, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);

    // p1: 0,1,2 (top row). p2: 3,4.
    await table.connect(p1).submitMove(0, move(0));
    await table.connect(p2).submitMove(0, move(3));
    await table.connect(p1).submitMove(0, move(1));
    await table.connect(p2).submitMove(0, move(4));

    const pot = STAKE * 2n;
    const expectedRake = (pot * 200n) / 10000n;
    const prize = pot - expectedRake;

    await expect(table.connect(p1).submitMove(0, move(2))).to.changeEtherBalances(
      [p1, rake],
      [prize, expectedRake]
    );

    const m = await table.getMatch(0);
    expect(m.status).to.equal(2); // Settled
    expect(m.winner).to.equal(1);
  });

  it("draw on a full board returns each stake, no rake", async function () {
    const { table, triad, rake, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);

    // Board that fills with no winner: 1 2 1 / 1 2 2 / 2 1 1
    // play order alternating p1,p2 producing that layout:
    // p1:0,2,3,7,8  p2:1,4,5,6  (counts 5 vs 4)
    const seq = [
      [p1, 0],
      [p2, 1],
      [p1, 2],
      [p2, 4],
      [p1, 3],
      [p2, 5],
      [p1, 7],
      [p2, 6],
    ];
    for (const [who, c] of seq) await table.connect(who).submitMove(0, move(c));

    await expect(table.connect(p1).submitMove(0, move(8))).to.changeEtherBalances(
      [p1, p2, rake],
      [STAKE, STAKE, 0n] // draw: each player gets their own stake back; rake untouched
    );
    const m = await table.getMatch(0);
    expect(m.winner).to.equal(255); // draw
  });

  // -------------------------------------------------------------- //
  //  Turn / membership reverts                                     //
  // -------------------------------------------------------------- //

  it("reverts non-member and wrong-turn moves", async function () {
    const { table, triad, p1, p2, outsider } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);

    await expect(
      table.connect(outsider).submitMove(0, move(0))
    ).to.be.revertedWithCustomError(table, "NotAMember");

    // p2 moving first is the wrong turn.
    await expect(
      table.connect(p2).submitMove(0, move(0))
    ).to.be.revertedWithCustomError(table, "NotYourTurn");
  });

  // -------------------------------------------------------------- //
  //  Timeout forfeit                                               //
  // -------------------------------------------------------------- //

  it("claimTimeout forfeits the stalled mover after the deadline", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);

    // p1 moves, now it's p2's turn; p2 stalls.
    await table.connect(p1).submitMove(0, move(0));
    await expect(table.claimTimeout(0)).to.be.revertedWithCustomError(
      table,
      "DeadlineNotPassed"
    );

    await time.increase(TIMEOUT + 1);
    // stalled = p2 (turnIndex 1); winner = next index = 0 = p1 → whole pot, no rake split?
    // rake DOES apply to forfeits too.
    const pot = STAKE * 2n;
    const expectedRake = (pot * 200n) / 10000n;
    await expect(table.connect(p2).claimTimeout(0)).to.changeEtherBalances(
      [p1],
      [pot - expectedRake]
    );
    const m = await table.getMatch(0);
    expect(m.status).to.equal(2);
    expect(m.winner).to.equal(1); // p1 (index 0) → 1-based 1
  });

  it("claimTimeout reverts with no timeout configured", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2, 0); // no timeout
    await table.connect(p1).submitMove(0, move(0));
    await expect(table.claimTimeout(0)).to.be.revertedWithCustomError(
      table,
      "NoTimeout"
    );
  });

  // -------------------------------------------------------------- //
  //  Cancel refund                                                 //
  // -------------------------------------------------------------- //

  it("cancelMatch before start refunds every joined player", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    // 3-cap lobby but only 2 join, creator cancels.
    await table
      .connect(p1)
      .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, TIMEOUT, {
        value: STAKE,
      });
    await expect(table.connect(p1).cancelMatch(0)).to.changeEtherBalances(
      [p1, table],
      [STAKE, -STAKE]
    );
    const m = await table.getMatch(0);
    expect(m.status).to.equal(3); // Cancelled
  });

  it("only the creator can cancel, and not after start", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    await table
      .connect(p1)
      .createMatch(await triad.getAddress(), "0x", NATIVE, STAKE, 2, TIMEOUT, {
        value: STAKE,
      });
    await expect(
      table.connect(p2).cancelMatch(0)
    ).to.be.revertedWithCustomError(table, "NotCreator");

    await table.connect(p2).joinMatch(0, { value: STAKE }); // starts
    await expect(
      table.connect(p1).cancelMatch(0)
    ).to.be.revertedWithCustomError(table, "NotOpen");
  });

  // -------------------------------------------------------------- //
  //  Draw offer / accept                                           //
  // -------------------------------------------------------------- //

  it("draw offer + accept ends as a draw and refunds stakes", async function () {
    const { table, triad, p1, p2 } = await loadFixture(deployFixture);
    await openTriad(table, triad, p1, p2);
    await table.connect(p1).submitMove(0, move(0)); // mid-game

    // p2 tries to accept before p1 offered → no offer.
    await table.connect(p2).offerDraw(0);
    await expect(table.connect(p2).acceptDraw(0)).to.be.revertedWithCustomError(
      table,
      "NoDrawOffer"
    );

    await table.connect(p1).offerDraw(0);
    await expect(table.connect(p2).acceptDraw(0)).to.changeEtherBalances(
      [p1, p2],
      [STAKE, STAKE]
    );
    const m = await table.getMatch(0);
    expect(m.winner).to.equal(255);
  });

  // -------------------------------------------------------------- //
  //  Reentrancy on native settlement                               //
  // -------------------------------------------------------------- //

  it("native settlement is reentrancy-safe (attacker cannot re-enter submitMove)", async function () {
    const { table, triad, p2 } = await loadFixture(deployFixture);
    const tableAddr = await table.getAddress();

    const Att = await ethers.getContractFactory("GameTableReentrant");
    const att = await Att.deploy(tableAddr);
    await att.waitForDeployment();

    // Attacker creates the match as player 0 (will play the winning top row).
    await att.create(await triad.getAddress(), "0x", STAKE, 2, TIMEOUT, {
      value: STAKE,
    });
    await table.connect(p2).joinMatch(0, { value: STAKE }); // player 1, auto-starts

    // Drive the attacker to a top-row win: att plays 0,1,2; p2 plays 3,4.
    await att.play(0, move(0));
    await table.connect(p2).submitMove(0, move(3));
    await att.play(0, move(1));
    await table.connect(p2).submitMove(0, move(4));

    // Arm: when the winning payout hits the attacker's receive(), it re-enters submitMove.
    await att.arm(0, move(5));

    const pot = STAKE * 2n;
    const expectedRake = (pot * 200n) / 10000n;
    const prize = pot - expectedRake;

    // The winning move settles and pays the attacker; its re-entry must fail, but the
    // outer settlement still completes and the prize lands.
    await expect(att.play(0, move(2))).to.changeEtherBalances(
      [att, table],
      [prize, -pot]
    );

    expect(await att.reenterAttempted()).to.equal(true);
    expect(await att.reenterSucceeded()).to.equal(false);
    const m = await table.getMatch(0);
    expect(m.status).to.equal(2); // Settled
    expect(m.winner).to.equal(1); // attacker = player index 0
  });
});
