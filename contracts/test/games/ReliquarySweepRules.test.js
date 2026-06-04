const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ───────────────────────── Merkle helpers (mirror the Solidity leaf scheme) ────────────────
// Leaf: keccak256(bytes.concat(keccak256(abi.encode(
//          uint8 cellIndex, bool isMine, uint8 adjacentCount, bytes32 salt)))).
const coder = ethers.AbiCoder.defaultAbiCoder();

function leafHash(cell, isMine, adj, salt) {
  const inner = ethers.keccak256(
    coder.encode(["uint8", "bool", "uint8", "bytes32"], [cell, isMine, adj, salt])
  );
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}
function buildTree(leaves) {
  let layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  function proof(index) {
    const p = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const pair = idx ^ 1;
      if (pair < layer.length) p.push(layer[pair]);
      idx = Math.floor(idx / 2);
    }
    return p;
  }
  return { root: layers[layers.length - 1][0], proof };
}

// Build a committed board. `mineSet` = Set of mine cell indices. Adjacent counts computed from it.
// `adjOverride` (optional) = map cell -> count, to commit a deliberately-inconsistent board.
function commitBoard(width, height, mineSet, adjOverride) {
  const total = width * height;
  const isMine = (c) => mineSet.has(c);
  function realAdj(c) {
    const x = c % width;
    const y = Math.floor(c / width);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (isMine(ny * width + nx)) n++;
      }
    }
    return n;
  }
  const cells = [];
  const salts = [];
  const leaves = [];
  for (let c = 0; c < total; c++) {
    const m = isMine(c);
    const adj = adjOverride && adjOverride[c] !== undefined ? adjOverride[c] : realAdj(c);
    const salt = ethers.id(`board-salt-${c}`);
    cells.push({ isMine: m, adj });
    salts.push(salt);
    leaves.push(leafHash(c, m, adj, salt));
  }
  const tree = buildTree(leaves);
  const reveal = (c) => coder.encode(
    ["bool", "uint8", "bytes32", "bytes32[]"],
    [cells[c].isMine, cells[c].adj, salts[c], tree.proof(c)]
  );
  return { root: tree.root, cells, reveal, total };
}

const encConfig = (w, h, mines, minCells) => coder.encode(["uint8", "uint8", "uint8", "uint8"], [w, h, mines, minCells]);
const encRoot = (root) => coder.encode(["bytes32"], [root]);
const encPick = (cell, cashOut) => coder.encode(["uint8", "bool"], [cell, cashOut]);

describe("ReliquarySweepRules (committer-vs-guesser minesweeper)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("ReliquarySweepRules");
    const rules = await F.deploy();
    return { rules };
  }

  it("initialState rejects non-2 players and bad dimensions/mine counts", async () => {
    const { rules } = await loadFixture(deploy);
    await expect(rules.initialState("0x", 3)).to.be.revertedWithCustomError(rules, "UnsupportedPlayerCount");
    await expect(rules.initialState(encConfig(0, 8, 10, 10), 2)).to.be.revertedWithCustomError(rules, "InvalidConfig");
    await expect(rules.initialState(encConfig(17, 8, 10, 10), 2)).to.be.revertedWithCustomError(rules, "InvalidConfig");
    await expect(rules.initialState(encConfig(3, 3, 9, 1), 2)).to.be.revertedWithCustomError(rules, "InvalidConfig"); // mines == total
    await expect(rules.initialState(encConfig(3, 3, 0, 1), 2)).to.be.revertedWithCustomError(rules, "InvalidConfig");
  });

  it("happy path: sweeper clears every safe cell ⇒ sweeper wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    // 3x3 board, single mine at cell 0. Safe cells: 1..8 (8 cells).
    const board = commitBoard(3, 3, new Set([0]));
    let state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    for (let c = 1; c <= 8; c++) {
      state = await rules.applyMove(state, 1, encPick(c, false));
      state = await rules.applyMove(state, 0, board.reveal(c));
    }
    expect(await rules.status(state)).to.equal(2n); // all safe cells cleared
  });

  it("hitting a mine ⇒ setter wins (status 1)", async () => {
    const { rules } = await loadFixture(deploy);
    const board = commitBoard(3, 3, new Set([4])); // mine in the centre
    let state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    state = await rules.applyMove(state, 1, encPick(4, false)); // pick the mine
    state = await rules.applyMove(state, 0, board.reveal(4));
    expect(await rules.status(state)).to.equal(1n);
  });

  it("cash-out: sweeper banks some safe cells then cashes out ⇒ sweeper wins (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    const board = commitBoard(3, 3, new Set([0]));
    let state = await rules.initialState(encConfig(3, 3, 1, 10), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    // bank two safe cells
    for (const c of [1, 2]) {
      state = await rules.applyMove(state, 1, encPick(c, false));
      state = await rules.applyMove(state, 0, board.reveal(c));
    }
    // cash out
    state = await rules.applyMove(state, 1, encPick(0, true));
    expect(await rules.status(state)).to.equal(2n);
  });

  it("FRAUD: committed board with an impossible adjacent count ⇒ setter forfeits (status 2)", async () => {
    const { rules } = await loadFixture(deploy);
    // 3x3, one mine at corner 0. Cell 8 (opposite corner) has 0 mine neighbours; force its
    // committed count to 3 — impossible since only ≤3 neighbours and none can be the corner mine.
    // After enough neighbours of cell 8 are revealed safe, its candidate pool shrinks below 3.
    const board = commitBoard(3, 3, new Set([0]), { 8: 3 });
    let state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    // Cell 8's neighbours are 4,5,7. Reveal 4,5,7 as safe (true counts), shrinking 8's candidate
    // pool to 0, then reveal 8 with its impossible committed count 3 ⇒ contradiction.
    for (const c of [4, 5, 7]) {
      state = await rules.applyMove(state, 1, encPick(c, false));
      state = await rules.applyMove(state, 0, board.reveal(c));
      expect(await rules.status(state)).to.equal(0n);
    }
    state = await rules.applyMove(state, 1, encPick(8, false));
    state = await rules.applyMove(state, 0, board.reveal(8));
    expect(await rules.status(state)).to.equal(2n); // setter fraud ⇒ sweeper wins
  });

  it("picking an out-of-range or already-revealed cell reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const board = commitBoard(3, 3, new Set([0]));
    let state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    await expect(rules.applyMove(state, 1, encPick(9, false))).to.be.revertedWithCustomError(
      rules,
      "CellOutOfRange"
    );
    state = await rules.applyMove(state, 1, encPick(1, false));
    state = await rules.applyMove(state, 0, board.reveal(1));
    await expect(rules.applyMove(state, 1, encPick(1, false))).to.be.revertedWithCustomError(
      rules,
      "CellAlreadyRevealed"
    );
  });

  it("a reveal with a bad proof reverts", async () => {
    const { rules } = await loadFixture(deploy);
    const board = commitBoard(3, 3, new Set([0]));
    let state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    state = await rules.applyMove(state, 0, encRoot(board.root));
    state = await rules.applyMove(state, 1, encPick(1, false));
    // Claim isMine=true for a safe cell with the safe cell's proof ⇒ leaf mismatch.
    const bad = coder.encode(["bool", "uint8", "bytes32", "bytes32[]"], [true, 0, ethers.id("board-salt-1"), []]);
    await expect(rules.applyMove(state, 0, bad)).to.be.revertedWithCustomError(rules, "BadProof");
  });

  it("wrong player ordering reverts (sweeper cannot set the root)", async () => {
    const { rules } = await loadFixture(deploy);
    const board = commitBoard(3, 3, new Set([0]));
    const state = await rules.initialState(encConfig(3, 3, 1, 1), 2);
    await expect(rules.applyMove(state, 1, encRoot(board.root))).to.be.revertedWithCustomError(rules, "NotYourTurn");
  });

  it("default config (empty bytes) yields an 8x8 / 10-mine board", async () => {
    const { rules } = await loadFixture(deploy);
    const state = await rules.initialState("0x", 2);
    // Setter sets a root and a pick works ⇒ board initialised. Just assert no revert and phase flow.
    const board = commitBoard(8, 8, new Set([0]));
    let st = await rules.applyMove(state, 0, encRoot(board.root));
    st = await rules.applyMove(st, 1, encPick(63, false));
    st = await rules.applyMove(st, 0, board.reveal(63));
    expect(await rules.status(st)).to.equal(0n);
  });
});
