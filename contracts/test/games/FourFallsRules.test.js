const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ---- JS mirror of the Solidity state encoding ------------------------------
// state = (uint8[42] board, uint8 moveCount, int8 lastCell, uint8 lastPlayer)
// board index = row*7 + col, row 0 = bottom, col 0 = left.
const COLS = 7;
const ROWS = 6;
const CELLS = 42;

const coder = ethers.AbiCoder.defaultAbiCoder();
const ST = ["uint8[42]", "uint8", "int8", "uint8"];

function encodeState(board, moveCount, lastCell, lastPlayer) {
  return coder.encode(ST, [board, moveCount, lastCell, lastPlayer]);
}
function decodeState(bytes) {
  const [board, moveCount, lastCell, lastPlayer] = coder.decode(ST, bytes);
  return {
    board: board.map((x) => Number(x)),
    moveCount: Number(moveCount),
    lastCell: Number(lastCell),
    lastPlayer: Number(lastPlayer),
  };
}
function emptyBoard() {
  return new Array(CELLS).fill(0);
}
function idx(row, col) {
  return row * COLS + col;
}
function encodeMove(col) {
  return coder.encode(["uint8"], [col]);
}

// Apply a sequence of column drops alternating P1(idx0), P2(idx1)...
async function play(rules, cols) {
  let state = await rules.initialState("0x", 2);
  let player = 0;
  for (const col of cols) {
    state = await rules.applyMove(state, player, encodeMove(col));
    player = 1 - player;
  }
  return state;
}

describe("FourFallsRules (connect-four)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("FourFallsRules");
    const rules = await F.deploy();
    return { rules };
  }

  it("initial state is empty, ongoing, 2 players only", async () => {
    const { rules } = await loadFixture(deploy);
    const s = await rules.initialState("0x", 2);
    const d = decodeState(s);
    expect(d.board.every((c) => c === 0)).to.equal(true);
    expect(d.moveCount).to.equal(0);
    expect(d.lastCell).to.equal(-1);
    expect(await rules.status(s)).to.equal(0);
    expect(await rules.simultaneous(s)).to.equal(false);
    await expect(rules.initialState("0x", 3)).to.be.revertedWith("FourFalls: 2 players");
  });

  it("metadata", async () => {
    const { rules } = await loadFixture(deploy);
    expect(await rules.gameName()).to.equal("FourFalls");
    expect(await rules.minPlayers()).to.equal(2);
    expect(await rules.maxPlayers()).to.equal(2);
  });

  it("gravity drops to the lowest empty cell of a column", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 drops col 3 twice (interleaved with P2 elsewhere)
    let s = await play(rules, [3, 0, 3]);
    const d = decodeState(s);
    expect(d.board[idx(0, 3)]).to.equal(1); // bottom of col 3 = P1
    expect(d.board[idx(0, 0)]).to.equal(2); // bottom of col 0 = P2
    expect(d.board[idx(1, 3)]).to.equal(1); // stacked above
    expect(d.lastCell).to.equal(idx(1, 3));
    expect(d.lastPlayer).to.equal(1);
    expect(d.moveCount).to.equal(3);
  });

  it("reverts on out-of-range column", async () => {
    const { rules } = await loadFixture(deploy);
    const s = await rules.initialState("0x", 2);
    await expect(rules.applyMove(s, 0, encodeMove(7))).to.be.revertedWith("FourFalls: bad col");
  });

  it("reverts when dropping into a full column", async () => {
    const { rules } = await loadFixture(deploy);
    // Fill col 2 with 6 pieces. Use cols alternating col2 and a sink col so no win triggers
    // first. col2 stacked: P1,P2,P1,P2,P1,P2 — vertical never reaches 4 same colour.
    const s = await play(rules, [2, 2, 2, 2, 2, 2]);
    expect(decodeState(s).board[idx(5, 2)]).to.not.equal(0);
    await expect(rules.applyMove(s, 0, encodeMove(2))).to.be.revertedWith("FourFalls: col full");
  });

  it("horizontal four wins", async () => {
    const { rules } = await loadFixture(deploy);
    // P1: cols 0,1,2,3 on bottom row. P2 sinks into col 6 (row 0) repeatedly.
    const s = await play(rules, [0, 6, 1, 6, 2, 6, 3]);
    expect(await rules.status(s)).to.equal(1);
  });

  it("vertical four wins", async () => {
    const { rules } = await loadFixture(deploy);
    // P1 stacks col 3 four high; P2 plays col 5.
    const s = await play(rules, [3, 5, 3, 5, 3, 5, 3]);
    expect(await rules.status(s)).to.equal(1);
  });

  it("diagonal (up-right) four wins", async () => {
    const { rules } = await loadFixture(deploy);
    // / diagonal for P1 at (0,0),(1,1),(2,2),(3,3). Verified sequence (col 6 = spare sink),
    // win lands exactly on the final P1 drop.
    const cols = [0, 1, 1, 2, 6, 2, 2, 3, 6, 3, 6, 3, 3];
    const st = await play(rules, cols);
    const d = decodeState(st);
    // Verify the diagonal cells are P1
    expect(d.board[idx(0, 0)]).to.equal(1);
    expect(d.board[idx(1, 1)]).to.equal(1);
    expect(d.board[idx(2, 2)]).to.equal(1);
    expect(d.board[idx(3, 3)]).to.equal(1);
    expect(await rules.status(st)).to.equal(1);
  });

  it("diagonal (up-left) four wins", async () => {
    const { rules } = await loadFixture(deploy);
    // \ diagonal for P1: (0,3),(1,2),(2,1),(3,0). Verified sequence, win on final drop.
    const cols = [3, 2, 2, 1, 6, 1, 1, 0, 6, 0, 6, 0, 0];
    const st = await play(rules, cols);
    const d = decodeState(st);
    expect(d.board[idx(0, 3)]).to.equal(1);
    expect(d.board[idx(1, 2)]).to.equal(1);
    expect(d.board[idx(2, 1)]).to.equal(1);
    expect(d.board[idx(3, 0)]).to.equal(1);
    expect(await rules.status(st)).to.equal(1);
  });

  it("full board with no line is a draw (255)", async () => {
    const { rules } = await loadFixture(deploy);
    // Build a known no-win full board directly via encoded state. Generator
    // color = 1 + ((floor(row/2)+col) % 2) tiles 2-high colour blocks so that no
    // horizontal, vertical or diagonal run ever reaches 4 (verified offline).
    const board = emptyBoard();
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        board[idx(row, col)] = 1 + ((Math.floor(row / 2) + col) % 2);
      }
    }
    const s = encodeState(board, CELLS, -1, 1);
    expect(await rules.status(s)).to.equal(255);
  });

  it("status uses last-cell scan after a real move", async () => {
    const { rules } = await loadFixture(deploy);
    const s = await play(rules, [3, 5, 3, 5, 3, 5, 3]); // vertical win for P1
    const d = decodeState(s);
    expect(d.lastCell).to.equal(idx(3, 3));
    expect(await rules.status(s)).to.equal(1);
  });
});
