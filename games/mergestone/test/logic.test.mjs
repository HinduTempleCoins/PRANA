import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE,
  tierValue,
  makeRng,
  emptyBoard,
  idx,
  slideLine,
  move,
  emptyCells,
  spawn,
  canMove,
  isGameOver,
  newGame,
  maxTier,
} from '../src/logic/merge.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

// --- tier values ---------------------------------------------------------------------- //

test('tierValue is 2^tier (classic 2048 numbers)', () => {
  assert.equal(tierValue(0), 0);
  assert.equal(tierValue(1), 2);
  assert.equal(tierValue(2), 4);
  assert.equal(tierValue(3), 8);
  assert.equal(tierValue(11), 2048);
});

// --- slideLine: the classic edge cases ------------------------------------------------ //

test('slideLine compacts toward 0 without merging distinct tiers', () => {
  const r = slideLine([1, 0, 2, 0], 4);
  assert.deepEqual(r.line, [1, 2, 0, 0]);
  assert.equal(r.gained, 0);
  assert.equal(r.merges.length, 0);
});

test('slideLine [2,2,2,2] -> [4,4] (two merges, NOT one 8)', () => {
  // tier 1 == value 2; expect two tier-2 stones, no triple-merge.
  const r = slideLine([1, 1, 1, 1], 4);
  assert.deepEqual(r.line, [2, 2, 0, 0]);
  assert.equal(r.merges.length, 2);
  assert.equal(r.gained, tierValue(2) * 2); // 4 + 4 = 8
});

test('slideLine [4,2,2] -> [4,4] (leading stone untouched)', () => {
  // tiers: [2,1,1,_] -> the two tier-1s merge to tier-2; the leading tier-2 stays.
  const r = slideLine([2, 1, 1, 0], 4);
  assert.deepEqual(r.line, [2, 2, 0, 0]);
  assert.equal(r.merges.length, 1);
  assert.equal(r.gained, tierValue(2)); // 4
});

test('slideLine no double-merge chain in one move: [2,2,4] stays one merge', () => {
  // [1,1,2] -> the two 1s merge into a 2, which must NOT then merge with the existing 2.
  const r = slideLine([1, 1, 2, 0], 4);
  assert.deepEqual(r.line, [2, 2, 0, 0]);
  assert.equal(r.merges.length, 1);
});

test('slideLine once-per-move: a freshly merged stone is locked', () => {
  // [1,1,1,1] proves the lock: had the first merged 2 been free, [2,2] would collapse to 4.
  const r = slideLine([1, 1, 1, 1], 4);
  assert.deepEqual(r.line, [2, 2, 0, 0]);
});

test('slideLine on a full no-merge line is a no-op in value', () => {
  const r = slideLine([1, 2, 3, 4], 4);
  assert.deepEqual(r.line, [1, 2, 3, 4]);
  assert.equal(r.gained, 0);
});

// --- move: directionality + change detection ------------------------------------------ //

function setCells(pairs, size = SIZE) {
  const b = emptyBoard(size);
  for (const [x, y, t] of pairs) b[idx(x, y, size)] = t;
  return b;
}

test('move left slides a row to the left edge', () => {
  const b = setCells([[3, 1, 1]]); // single stone at far right of row 1
  const r = move(b, 'left');
  assert.equal(r.board[idx(0, 1)], 1);
  assert.equal(r.board[idx(3, 1)], 0);
  assert.equal(r.moved, true);
});

test('move right slides a row to the right edge', () => {
  const b = setCells([[0, 2, 1]]);
  const r = move(b, 'right');
  assert.equal(r.board[idx(3, 2)], 1);
  assert.equal(r.moved, true);
});

test('move up and down slide columns', () => {
  const up = move(setCells([[2, 3, 1]]), 'up');
  assert.equal(up.board[idx(2, 0)], 1);
  const down = move(setCells([[2, 0, 1]]), 'down');
  assert.equal(down.board[idx(2, 3)], 1);
});

test('move reports moved=false when nothing changes', () => {
  const b = setCells([[0, 0, 1]]); // already at top-left
  const r = move(b, 'left');
  assert.equal(r.moved, false);
  const u = move(b, 'up');
  assert.equal(u.moved, false);
});

test('move accumulates score across multiple merging rows', () => {
  const b = setCells([
    [0, 0, 1], [1, 0, 1], // row 0: 2+2 -> merges to a 4
    [0, 1, 1], [1, 1, 1], // row 1: 2+2 -> merges to a 4
  ]);
  const r = move(b, 'left');
  assert.equal(r.gained, tierValue(2) * 2);
  assert.equal(r.merges.length, 2);
});

test('move is pure: input board is not mutated', () => {
  const b = setCells([[3, 1, 1]]);
  const snapshot = JSON.stringify(b);
  move(b, 'left');
  assert.equal(JSON.stringify(b), snapshot);
});

// --- spawning (seeded) ---------------------------------------------------------------- //

test('emptyCells lists exactly the zero cells', () => {
  const b = setCells([[0, 0, 1], [1, 1, 2]]);
  assert.equal(emptyCells(b).length, SIZE * SIZE - 2);
});

test('spawn places into an empty cell with tier 1 or 2', () => {
  const rng = makeRng(42);
  let board = emptyBoard();
  for (let i = 0; i < 10; i++) {
    const res = spawn(board, rng);
    assert.ok(res, 'should spawn while space remains');
    assert.ok(res.tier === 1 || res.tier === 2);
    assert.equal(board[res.cell], 0); // was empty before
    board = res.board;
  }
});

test('spawn 90/10 split roughly holds with a seeded rng', () => {
  const rng = makeRng(7);
  let t2 = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    // fresh single-empty board each time to isolate the tier roll
    const b = emptyBoard();
    for (let c = 1; c < b.length; c++) b[c] = 1; // leave cell 0 empty
    const res = spawn(b, rng);
    if (res.tier === 2) t2 += 1;
  }
  const frac = t2 / N;
  assert.ok(frac > 0.05 && frac < 0.16, `tier-2 fraction ~10%, got ${frac}`);
});

test('spawn returns null on a full board', () => {
  const b = new Array(SIZE * SIZE).fill(1);
  assert.equal(spawn(b, makeRng(1)), null);
});

test('seeded rng is deterministic and reproducible', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

// --- game-over check ------------------------------------------------------------------ //

test('canMove is true when any empty cell exists', () => {
  const b = setCells([[0, 0, 1]]);
  assert.equal(canMove(b), true);
});

test('canMove is true on a full board with an adjacent pair', () => {
  // full board, but two equal neighbors exist -> a merge move is available.
  const b = [
    1, 2, 1, 2,
    2, 1, 2, 1,
    1, 2, 1, 2,
    2, 1, 1, 3, // the two 1s at the end are adjacent -> mergeable
  ];
  assert.equal(canMove(b), true);
  assert.equal(isGameOver(b), false);
});

test('isGameOver is true on a full board with no adjacent equals', () => {
  // a checkerboard of alternating tiers where no neighbor matches.
  const b = [
    1, 2, 1, 2,
    2, 3, 2, 3,
    1, 2, 1, 2,
    2, 3, 2, 3,
  ];
  assert.equal(canMove(b), false);
  assert.equal(isGameOver(b), true);
});

// --- new game ------------------------------------------------------------------------- //

test('newGame seeds two stones deterministically', () => {
  const a = newGame(makeRng(99));
  const b = newGame(makeRng(99));
  assert.deepEqual(a, b);
  const filled = a.filter((t) => t !== 0);
  assert.equal(filled.length, 2);
  for (const t of filled) assert.ok(t === 1 || t === 2);
});

test('maxTier returns the highest stone tier', () => {
  assert.equal(maxTier(setCells([[0, 0, 1], [1, 0, 5], [2, 0, 3]])), 5);
  assert.equal(maxTier(emptyBoard()), 0);
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic item shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Granite Runes',
    glyph: 'rune',
    palette: { stone: '#445566', edge: '#aabbcc', glow: '#ffffff' },
  });
  assert.equal(s.itemId, 30000);
  assert.equal(s.glyph, 'rune');
  assert.deepEqual(Object.keys(s.palette).sort(), ['edge', 'glow', 'stone']);
});

test('normalizeSkin rejects out-of-range item ids', () => {
  assert.throws(() => normalizeSkin({ itemId: 100, name: 'X', palette: { stone: '#fff', edge: '#fff', glow: '#fff' } }));
});

test('normalizeSkins maps a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { stone: '#445566', edge: '#aabbcc', glow: '#ffffff' } },
    { itemId: 30001, name: 'B', glyph: 'sigil', palette: { stone: '#445566', edge: '#aabbcc', glow: '#ffffff' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].glyph, 'sigil');
});
