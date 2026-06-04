const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ---- JS mirror of the Solidity encoding ------------------------------------
// state = (uint8[32] sq, uint8 sideToMove, uint8 noProgress)
//   sq value: 0 empty · 1 man-P1 · 2 man-P2 · 3 king-P1 · 4 king-P2
//   square s -> (row, col): row = s/4 (row0 top). even rows col=2*(s%4)+1, odd rows col=2*(s%4).
//   P1 starts high rows, moves UP (toward row0); P2 starts low rows, moves DOWN.
const N = 32;
const coder = ethers.AbiCoder.defaultAbiCoder();
const ST = ["uint8[32]", "uint8", "uint8"];

function encodeState(sq, side, noProgress) {
  return coder.encode(ST, [sq, side, noProgress]);
}
function decodeState(bytes) {
  const [sq, side, noProgress] = coder.decode(ST, bytes);
  return { sq: sq.map((x) => Number(x)), side: Number(side), noProgress: Number(noProgress) };
}
function emptyBoard() {
  return new Array(N).fill(0);
}
function encodeMove(path) {
  return coder.encode(["uint8[]"], [path]);
}
// Dark-square indices used below are computed from (row,col) via the documented mapping:
//   even rows: col = 2*(s%4)+1 ; odd rows: col = 2*(s%4) ; row = s/4 (row 0 = top).

describe("CrownsRules (English draughts / checkers)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("CrownsRules");
    const rules = await F.deploy();
    return { rules };
  }

  it("initial state: 12 men each side, P1 to move, ongoing", async () => {
    const { rules } = await loadFixture(deploy);
    const s = await rules.initialState("0x", 2);
    const d = decodeState(s);
    expect(d.sq.filter((v) => v === 2).length).to.equal(12); // P2 top
    expect(d.sq.filter((v) => v === 1).length).to.equal(12); // P1 bottom
    expect(d.side).to.equal(1);
    expect(d.noProgress).to.equal(0);
    expect(await rules.status(s)).to.equal(0);
    expect(await rules.simultaneous(s)).to.equal(false);
    await expect(rules.initialState("0x", 3)).to.be.revertedWith("Crowns: 2 players");
  });

  it("metadata", async () => {
    const { rules } = await loadFixture(deploy);
    expect(await rules.gameName()).to.equal("Crowns");
    expect(await rules.minPlayers()).to.equal(2);
    expect(await rules.maxPlayers()).to.equal(2);
  });

  it("simple forward man move (no capture available)", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 man at sq20 (row5,col0) steps up to sq16 (row4,col1). No captures on board.
    const sq = emptyBoard();
    sq[20] = 1;
    sq[0] = 2; // give P2 a piece far away so the game isn't already decided
    const s = encodeState(sq, 1, 0);
    const out = await rules.applyMove(s, 0, encodeMove([20, 16]));
    const d = decodeState(out);
    expect(d.sq[20]).to.equal(0);
    expect(d.sq[16]).to.equal(1);
    expect(d.side).to.equal(2); // turn rotates
    expect(d.noProgress).to.equal(0); // man move resets counter
  });

  it("rejects a backward move by a man", async () => {
    const { rules } = await loadFixture(deploy);
    const sq = emptyBoard();
    sq[16] = 1; // P1 man at row4
    sq[0] = 2;
    const s = encodeState(sq, 1, 0);
    // moving DOWN (toward row5) is backward for a P1 man -> sq20 (row5,col0)
    await expect(rules.applyMove(s, 0, encodeMove([16, 20]))).to.be.revertedWith(
      "Crowns: bad step"
    );
  });

  it("mandatory capture: a non-capturing move reverts when a capture exists", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 man at sq17 (4,3) CAN capture P2 at sq13 (3,2) landing sq8 (2,1).
    // Also a free P1 man at sq20 that could step — but capture is forced.
    const sq = emptyBoard();
    sq[17] = 1;
    sq[13] = 2;
    sq[20] = 1;
    const s = encodeState(sq, 1, 0);
    await expect(rules.applyMove(s, 0, encodeMove([20, 16]))).to.be.revertedWith(
      "Crowns: must capture"
    );
  });

  it("single capture removes the jumped enemy", async () => {
    const { rules } = await loadFixture(deploy);
    const sq = emptyBoard();
    sq[17] = 1; // P1 (4,3)
    sq[13] = 2; // P2 (3,2)
    const s = encodeState(sq, 1, 0);
    const out = await rules.applyMove(s, 0, encodeMove([17, 8])); // land (2,1)
    const d = decodeState(out);
    expect(d.sq[17]).to.equal(0);
    expect(d.sq[13]).to.equal(0); // captured
    expect(d.sq[8]).to.equal(1);
    expect(d.side).to.equal(2);
  });

  it("multi-jump chain submitted as one move; crowns at the end", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 sq17 (4,3) jumps sq13 (3,2)->land sq8 (2,1), then jumps sq5 (1,2)->land sq1 (0,3).
    // Landing on row0 crowns the P1 man to a king (value 3).
    const sq = emptyBoard();
    sq[17] = 1;
    sq[13] = 2;
    sq[5] = 2;
    const s = encodeState(sq, 1, 0);
    const out = await rules.applyMove(s, 0, encodeMove([17, 8, 1]));
    const d = decodeState(out);
    expect(d.sq[13]).to.equal(0);
    expect(d.sq[5]).to.equal(0);
    expect(d.sq[17]).to.equal(0);
    expect(d.sq[1]).to.equal(3); // crowned king-P1
    expect(d.side).to.equal(2);
  });

  it("partial jump chain reverts when more captures remain", async () => {
    const { rules } = await loadFixture(deploy);
    const sq = emptyBoard();
    sq[17] = 1;
    sq[13] = 2;
    sq[5] = 2;
    const s = encodeState(sq, 1, 0);
    // stopping at sq8 leaves another capture (over sq5) available -> incomplete
    await expect(rules.applyMove(s, 0, encodeMove([17, 8]))).to.be.revertedWith(
      "Crowns: chain incomplete"
    );
  });

  it("man kings on reaching the back rank via a simple move", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 man at sq4 (1,0) steps up to sq0 (0,1) -> crowned.
    const sq = emptyBoard();
    sq[4] = 1;
    sq[31] = 2; // P2 piece elsewhere
    const s = encodeState(sq, 1, 0);
    const out = await rules.applyMove(s, 0, encodeMove([4, 0]));
    const d = decodeState(out);
    expect(d.sq[0]).to.equal(3); // king-P1
  });

  it("king moves diagonally in both directions", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 king at sq13 (3,2). A backward (down) step to sq16 (4,1) is legal for a king.
    const sq = emptyBoard();
    sq[13] = 3;
    sq[0] = 2;
    const s = encodeState(sq, 1, 0);
    const out = await rules.applyMove(s, 0, encodeMove([13, 16])); // moving DOWN
    const d = decodeState(out);
    expect(d.sq[13]).to.equal(0);
    expect(d.sq[16]).to.equal(3); // still a king (not on a back rank)
    expect(d.noProgress).to.equal(1); // king (non-man) non-capture move does NOT reset
  });

  it("win when the side to move has no legal move", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 has a single man at sq0 (0,1): it is on the top edge, a man cannot move up
    // further and cannot move backward -> no legal move. P2 has a piece, so P2 wins.
    const sq = emptyBoard();
    sq[0] = 1;
    sq[31] = 2;
    const s = encodeState(sq, 1, 0);
    expect(await rules.status(s)).to.equal(2); // opponent (P2) wins
  });

  it("win when the opponent has no pieces", async () => {
    const { rules } = await loadFixture(deploy);
    // It is P2's turn but P2 has no pieces -> P1 wins.
    const sq = emptyBoard();
    sq[20] = 1;
    const s = encodeState(sq, 2, 0);
    expect(await rules.status(s)).to.equal(1);
  });

  it("40-ply no-progress counter yields a draw", async () => {
    const { rules } = await loadFixture(deploy);
    // Two kings far apart, both sides have moves -> not decided -> counter rules.
    const sq = emptyBoard();
    sq[12] = 3; // P1 king
    sq[3] = 4; // P2 king
    const s = encodeState(sq, 1, 40);
    expect(await rules.status(s)).to.equal(255);
    // one below the threshold is still ongoing
    const s2 = encodeState(sq, 1, 39);
    expect(await rules.status(s2)).to.equal(0);
  });

  it("king non-capture move advances the no-progress counter (not reset)", async () => {
    const { rules } = await loadFixture(deploy);
    const sq = emptyBoard();
    sq[13] = 3;
    sq[0] = 2;
    const s = encodeState(sq, 1, 7);
    const out = await rules.applyMove(s, 0, encodeMove([13, 8])); // king up, no capture
    expect(decodeState(out).noProgress).to.equal(8);
  });
});
