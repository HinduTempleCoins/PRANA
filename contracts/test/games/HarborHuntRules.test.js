const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BOARD = 100;
const DIM = 10;
const abi = ethers.AbiCoder.defaultAbiCoder();

// ── Leaf + tree helpers (mirror the Solidity encoding exactly) ──────────────
//   leaf = keccak256(abi.encode(uint8 cellIndex, bool isShip, bytes32 perCellSalt))
function cellLeaf(cellIndex, isShip, salt) {
  return ethers.keccak256(
    abi.encode(["uint8", "bool", "bytes32"], [cellIndex, isShip, salt])
  );
}
// OZ-compatible commutative pair hash, matching _hashPair (abi.encode(a,b), sorted).
function hashPair(a, b) {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(abi.encode(["bytes32", "bytes32"], [x, y]));
}
const ZERO = ethers.ZeroHash;

// Build the fixed 128-leaf tree over cell leaves 0..99, zero-padded — mirrors _computeRoot.
function buildTree(isShipArr, salts) {
  let level = [];
  for (let i = 0; i < 128; i++) {
    level.push(i < BOARD ? cellLeaf(i, isShipArr[i], salts[i]) : ZERO);
  }
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPair(level[i], level[i + 1]));
    }
    level = next;
    layers.push(level);
  }
  return { root: level[0], layers };
}
// Proof for a given cell index against the 128-leaf tree.
function proofFor(layers, cellIndex) {
  const proof = [];
  let idx = cellIndex;
  for (let l = 0; l < layers.length - 1; l++) {
    const sib = idx ^ 1;
    proof.push(layers[l][sib]);
    idx >>= 1;
  }
  return proof;
}

// Deterministic salts for a board.
function makeSalts(tag) {
  const s = [];
  for (let i = 0; i < BOARD; i++) {
    s.push(ethers.keccak256(ethers.toUtf8Bytes(`${tag}:${i}`)));
  }
  return s;
}

// A legal standard fleet [5,4,3,3,2] = 17 cells, all horizontal on separate rows.
function legalBoard() {
  const ship = new Array(BOARD).fill(false);
  const place = (row, col, len) => {
    for (let k = 0; k < len; k++) ship[row * DIM + (col + k)] = true;
  };
  place(0, 0, 5);
  place(2, 0, 4);
  place(4, 0, 3);
  place(6, 0, 3);
  place(8, 0, 2);
  return ship;
}

// Encode a SETUP move (just the root).
function setupMove(root) {
  return abi.encode(["bytes32"], [root]);
}
// Encode a BATTLE move.
function battleMove(hasAnswer, isShip, salt, proof, myShot) {
  return abi.encode(
    ["bool", "bool", "bytes32", "bytes32[]", "uint8"],
    [hasAnswer, isShip, salt, proof, myShot]
  );
}

describe("HarborHuntRules (hidden-board battleship)", function () {
  async function deploy() {
    const F = await ethers.getContractFactory("HarborHuntRules");
    const rules = await F.deploy();

    const p1Salts = makeSalts("p1");
    const p2Salts = makeSalts("p2");
    const p1Board = legalBoard();
    const p2Board = legalBoard();
    const t1 = buildTree(p1Board, p1Salts);
    const t2 = buildTree(p2Board, p2Salts);
    return { rules, p1Salts, p2Salts, p1Board, p2Board, t1, t2 };
  }

  it("computeRoot/challengeFleet accept a legal board and matching root", async () => {
    const { rules, p1Board, p1Salts, t1 } = await loadFixture(deploy);
    const root = await rules.computeRoot(p1Board, p1Salts);
    expect(root).to.equal(t1.root);
    expect(await rules.challengeFleet(root, p1Board, p1Salts)).to.equal(true);
  });

  it("challengeFleet rejects a root that doesn't match the board", async () => {
    const { rules, p1Board, p1Salts } = await loadFixture(deploy);
    await expect(
      rules.challengeFleet(ethers.ZeroHash, p1Board, p1Salts)
    ).to.be.revertedWithCustomError(rules, "BadFleet");
  });

  it("challengeFleet rejects a wrong-size fleet (overlap shrinks ship count)", async () => {
    const { rules } = await loadFixture(deploy);
    // Only 16 ship cells (last ship length 1 → illegal), still 5 origins? Build a bad board:
    const bad = new Array(BOARD).fill(false);
    const place = (r, c, len) => {
      for (let k = 0; k < len; k++) bad[r * DIM + (c + k)] = true;
    };
    place(0, 0, 5);
    place(2, 0, 4);
    place(4, 0, 3);
    place(6, 0, 3);
    place(8, 0, 1); // lone cell — illegal ship
    const salts = makeSalts("bad");
    const root = await rules.computeRoot(bad, salts);
    await expect(
      rules.challengeFleet(root, bad, salts)
    ).to.be.revertedWithCustomError(rules, "BadFleet");
  });

  it("challengeFleet rejects a bent (crossing) ship", async () => {
    const { rules } = await loadFixture(deploy);
    const bad = legalBoard();
    // Make the size-5 ship at row0 bend: add a vertical arm at its origin.
    bad[1 * DIM + 0] = true; // cell (1,0) below origin (0,0) → crossing at origin
    const salts = makeSalts("bent");
    const root = await rules.computeRoot(bad, salts);
    await expect(
      rules.challengeFleet(root, bad, salts)
    ).to.be.revertedWithCustomError(rules, "BadFleet");
  });

  it("plays a full game: alternating shots with truthful reveals to 17 hits → shooter wins", async () => {
    const { rules, p1Salts, p2Salts, p1Board, p2Board, t1, t2 } =
      await loadFixture(deploy);

    // SETUP (simultaneous): both commit roots.
    let state = await rules.initialState("0x", 2);
    expect(await rules.simultaneous(state)).to.equal(true);
    state = await rules.applyMove(state, 0, setupMove(t1.root));
    state = await rules.applyMove(state, 1, setupMove(t2.root));
    expect(await rules.simultaneous(state)).to.equal(false); // now BATTLE
    expect(await rules.status(state)).to.equal(0);

    // p1 wants to win: fire at all 17 of p2's ship cells. p2 fires harmless misses at water.
    const p2ShipCells = [];
    for (let i = 0; i < BOARD; i++) if (p2Board[i]) p2ShipCells.push(i);
    // A water cell on p1's board for p2 to keep missing into (use a high empty cell each time).
    const p1WaterCells = [];
    for (let i = 0; i < BOARD; i++) if (!p1Board[i]) p1WaterCells.push(i);

    // First move: p1 fires (no pending answer).
    state = await rules.applyMove(
      state,
      0,
      battleMove(false, false, ZERO, [], p2ShipCells[0])
    );

    let p1Idx = 1; // next p1 shot index into p2ShipCells
    let p2Idx = 0; // next p2 shot index into p1WaterCells
    // Now alternate: p2 answers p1's pending shot (truthfully: ship) then fires a miss;
    // p1 answers p2's miss (truthfully: water) then fires the next ship cell.
    while (true) {
      // p2's move: answer pending cell (p1 fired at a p2 ship cell → isShip true).
      const pend2 = p2ShipCells[p1Idx - 1];
      state = await rules.applyMove(
        state,
        1,
        battleMove(true, true, p2Salts[pend2], proofFor(t2.layers, pend2), p1WaterCells[p2Idx])
      );
      if ((await rules.status(state)) !== 0n) break;
      p2Idx++;

      // p1's move: answer pending cell (p2 fired at p1 water → isShip false), then next ship.
      const pend1 = p1WaterCells[p2Idx - 1];
      state = await rules.applyMove(
        state,
        0,
        battleMove(
          true,
          false,
          p1Salts[pend1],
          proofFor(t1.layers, pend1),
          p2ShipCells[p1Idx]
        )
      );
      p1Idx++;
      if ((await rules.status(state)) !== 0n) break;
    }

    expect(await rules.status(state)).to.equal(1); // p1 won (1-based)
  });

  it("fraud: lying about a hit (claiming water on a ship cell) → liar forfeits", async () => {
    const { rules, p2Salts, p2Board, t1, t2 } = await loadFixture(deploy);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, setupMove(t1.root));
    state = await rules.applyMove(state, 1, setupMove(t2.root));

    // p1 fires at a known p2 ship cell.
    const shipCell = p2Board.findIndex((v) => v === true);
    state = await rules.applyMove(
      state,
      0,
      battleMove(false, false, ZERO, [], shipCell)
    );

    // p2 LIES: hasAnswer=true but claims answerIsShip=false for a real ship cell. The proof
    // was generated for the TRUE leaf (cell, isShip=true, salt); the contract recomputes the
    // leaf from the claimed (cell, false, salt), so verification fails → p2 forfeits, p1 wins.
    state = await rules.applyMove(
      state,
      1,
      battleMove(true, false /*lie: claim water*/, p2Salts[shipCell], proofFor(t2.layers, shipCell), 50)
    );
    expect(await rules.status(state)).to.equal(1);
  });

  it("missing answer when a shot is pending reverts", async () => {
    const { rules, t1, t2, p2Board } = await loadFixture(deploy);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, setupMove(t1.root));
    state = await rules.applyMove(state, 1, setupMove(t2.root));
    const shipCell = p2Board.findIndex((v) => v === true);
    state = await rules.applyMove(
      state,
      0,
      battleMove(false, false, ZERO, [], shipCell)
    );
    // p2 must answer but sends hasAnswer=false → MissingAnswer.
    await expect(
      rules.applyMove(state, 1, battleMove(false, false, ZERO, [], 55))
    ).to.be.revertedWithCustomError(rules, "MissingAnswer");
  });

  it("firing out of turn reverts", async () => {
    const { rules, t1, t2 } = await loadFixture(deploy);
    let state = await rules.initialState("0x", 2);
    state = await rules.applyMove(state, 0, setupMove(t1.root));
    state = await rules.applyMove(state, 1, setupMove(t2.root));
    // p1 fires first; p2's turn now. p1 tries to move again → NotYourTurn.
    state = await rules.applyMove(state, 0, battleMove(false, false, ZERO, [], 0));
    await expect(
      rules.applyMove(state, 0, battleMove(true, false, ZERO, [], 1))
    ).to.be.revertedWithCustomError(rules, "NotYourTurn");
  });
});
