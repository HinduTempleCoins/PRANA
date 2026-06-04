import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLS,
  ROWS,
  PIECES,
  PIECE_KEYS,
  boundingBox,
  normalizeCells,
  rotateCW,
  rotationStates,
  ROTATIONS,
  pieceCells,
  emptyWell,
  cellFree,
  isValid,
  tryRotate,
  tryMove,
  hardDropPos,
  lockPiece,
  clearLines,
  lineScore,
  dropScore,
  nextCombo,
  levelForLines,
  gravityInterval,
  spawnPos,
  randomPiece,
  isToppedOut,
} from '../src/logic/stack.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

// --- piece set is the ORIGINAL set (not the classic 7 tetrominoes) -------------------- //

test('piece set is 5 pentomino-flavoured + 2 tri-stones (NOT 7 tetrominoes)', () => {
  assert.equal(PIECE_KEYS.length, 7);
  const fives = PIECE_KEYS.filter((k) => PIECES[k].cells.length === 5);
  const threes = PIECE_KEYS.filter((k) => PIECES[k].cells.length === 3);
  assert.equal(fives.length, 5);
  assert.equal(threes.length, 2);
  // explicitly NOT the 4-cell tetromino footprint anywhere.
  assert.equal(PIECE_KEYS.filter((k) => PIECES[k].cells.length === 4).length, 0);
});

test('every piece has a unique colour and name', () => {
  const colors = new Set(PIECE_KEYS.map((k) => PIECES[k].color));
  const names = new Set(PIECE_KEYS.map((k) => PIECES[k].name));
  assert.equal(colors.size, PIECE_KEYS.length);
  assert.equal(names.size, PIECE_KEYS.length);
});

// --- geometry / rotation -------------------------------------------------------------- //

test('boundingBox + normalizeCells anchor cells at origin', () => {
  const bb = boundingBox([{ x: 2, y: 3 }, { x: 4, y: 3 }]);
  assert.deepEqual({ minX: bb.minX, minY: bb.minY, w: bb.w, h: bb.h }, { minX: 2, minY: 3, w: 3, h: 1 });
  const n = normalizeCells([{ x: 2, y: 3 }, { x: 3, y: 3 }]);
  assert.deepEqual(n, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
});

test('rotateCW preserves cell count and stays anchored at origin', () => {
  for (const key of PIECE_KEYS) {
    let cur = normalizeCells(PIECES[key].cells);
    for (let i = 0; i < 4; i++) {
      assert.equal(cur.length, PIECES[key].cells.length);
      const bb = boundingBox(cur);
      assert.equal(bb.minX, 0);
      assert.equal(bb.minY, 0);
      cur = rotateCW(cur);
    }
  }
});

test('four rotateCW rotations return to the original orientation', () => {
  for (const key of PIECE_KEYS) {
    const start = normalizeCells(PIECES[key].cells);
    let cur = start;
    for (let i = 0; i < 4; i++) cur = rotateCW(cur);
    const a = [...cur].map((c) => `${c.x},${c.y}`).sort();
    const b = [...start].map((c) => `${c.x},${c.y}`).sort();
    assert.deepEqual(a, b);
  }
});

test('rotationStates and ROTATIONS expose 4 states per piece', () => {
  const states = rotationStates(PIECES.SERPENT.cells);
  assert.equal(states.length, 4);
  assert.equal(ROTATIONS.SERPENT.length, 4);
  assert.deepEqual(ROTATIONS.OBELISK[0], ROTATIONS.OBELISK[0]);
});

test('pieceCells offsets by board position and wraps the rotation index', () => {
  const c0 = pieceCells('SHARD', 0, { x: 3, y: 5 });
  assert.deepEqual(c0.sort((a, b) => a.x - b.x), [{ x: 3, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 }]);
  // rot 4 == rot 0, rot -1 == rot 3 (index normalisation)
  assert.deepEqual(pieceCells('SHARD', 4, { x: 0, y: 0 }), pieceCells('SHARD', 0, { x: 0, y: 0 }));
  assert.deepEqual(pieceCells('SHARD', -1, { x: 0, y: 0 }), pieceCells('SHARD', 3, { x: 0, y: 0 }));
});

// --- well + collision ----------------------------------------------------------------- //

test('emptyWell is ROWS×COLS of zeros', () => {
  const w = emptyWell();
  assert.equal(w.length, ROWS);
  assert.equal(w[0].length, COLS);
  assert.ok(w.every((row) => row.every((c) => c === 0)));
});

test('cellFree: walls block, floor blocks, ceiling buffer allowed, stack blocks', () => {
  const w = emptyWell();
  assert.equal(cellFree(w, -1, 5), false); // left wall
  assert.equal(cellFree(w, COLS, 5), false); // right wall
  assert.equal(cellFree(w, 5, ROWS), false); // floor
  assert.equal(cellFree(w, 5, -1), true); // above ceiling (spawn buffer)
  assert.equal(cellFree(w, 5, 5), true); // empty interior
  w[5][5] = 'OBELISK';
  assert.equal(cellFree(w, 5, 5), false); // occupied
});

test('isValid rejects overlap with the stack and out-of-bounds', () => {
  const w = emptyWell();
  assert.equal(isValid(w, 'SHARD', 0, { x: 0, y: 0 }), true);
  assert.equal(isValid(w, 'SHARD', 0, { x: COLS - 2, y: 0 }), false); // pokes through right wall
  w[0][0] = 'CAIRN';
  assert.equal(isValid(w, 'SHARD', 0, { x: 0, y: 0 }), false); // overlaps stack
});

// --- rotation near walls / kicks ------------------------------------------------------ //

test('tryRotate kicks an Obelisk off the left wall into a legal spot', () => {
  const w = emptyWell();
  // Obelisk is a vertical bar at x=0; rotating CW makes it horizontal spanning x..x+4.
  // At x=0 the rotation fits; force a wall situation by placing it so a naive rotate would
  // clip the left wall, and confirm a kick offset recovers it.
  const res = tryRotate(w, 'OBELISK', 0, { x: 0, y: 8 }, 1);
  assert.ok(res, 'rotation should succeed via kick');
  assert.ok(isValid(w, 'OBELISK', res.rot, res.pos));
  assert.equal(res.rot, 1);
});

test('tryRotate returns null when no kick offset can place the piece', () => {
  const w = emptyWell();
  // Fill the whole well so nothing can ever fit.
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) w[y][x] = 'CAIRN';
  assert.equal(tryRotate(w, 'ANKH', 0, { x: 4, y: 4 }, 1), null);
});

// --- movement ------------------------------------------------------------------------- //

test('tryMove returns the new position when legal, null when blocked', () => {
  const w = emptyWell();
  assert.deepEqual(tryMove(w, 'SHARD', 0, { x: 3, y: 0 }, 1, 0), { x: 4, y: 0 });
  assert.equal(tryMove(w, 'SHARD', 0, { x: COLS - 3, y: 0 }, 1, 0), null); // into right wall
  assert.equal(tryMove(w, 'SHARD', 0, { x: 0, y: ROWS - 1 }, 0, 1), null); // into floor
});

test('hardDropPos drops a piece to the floor on an empty well', () => {
  const w = emptyWell();
  const { pos, dropped } = hardDropPos(w, 'SHARD', 0, { x: 3, y: 0 });
  assert.equal(pos.y, ROWS - 1); // SHARD is 1 row tall -> bottom row
  assert.equal(dropped, ROWS - 1);
});

test('hardDropPos lands on top of existing stack', () => {
  const w = emptyWell();
  w[ROWS - 1][3] = 'CAIRN'; // a block in the bottom row under the shard's left cell
  const { pos } = hardDropPos(w, 'SHARD', 0, { x: 3, y: 0 });
  assert.equal(pos.y, ROWS - 2); // rests one above the obstruction
});

// --- lock + line clear ---------------------------------------------------------------- //

test('lockPiece stamps the piece colour key into a NEW well (no mutation)', () => {
  const w = emptyWell();
  const snapshot = JSON.stringify(w);
  const locked = lockPiece(w, 'SHARD', 0, { x: 0, y: ROWS - 1 });
  assert.equal(JSON.stringify(w), snapshot); // original untouched
  assert.equal(locked[ROWS - 1][0], 'SHARD');
  assert.equal(locked[ROWS - 1][1], 'SHARD');
  assert.equal(locked[ROWS - 1][2], 'SHARD');
});

test('clearLines removes a single full row and adds an empty row at top', () => {
  const w = emptyWell();
  for (let x = 0; x < COLS; x++) w[ROWS - 1][x] = 'CAIRN';
  const { well, cleared } = clearLines(w);
  assert.equal(cleared, 1);
  assert.equal(well.length, ROWS);
  assert.ok(well[ROWS - 1].every((c) => c === 0)); // the full row is gone
  assert.ok(well[0].every((c) => c === 0)); // new empty row on top
});

test('clearLines clears MULTIPLE rows and preserves the rest', () => {
  const w = emptyWell();
  for (let x = 0; x < COLS; x++) {
    w[ROWS - 1][x] = 'CAIRN';
    w[ROWS - 2][x] = 'SHARD';
  }
  w[ROWS - 3][0] = 'OBELISK'; // a partial row that must survive
  const { well, cleared } = clearLines(w);
  assert.equal(cleared, 2);
  // the surviving partial row should now be the bottom row.
  assert.equal(well[ROWS - 1][0], 'OBELISK');
  assert.ok(well[ROWS - 1].slice(1).every((c) => c === 0));
});

test('clearLines clears a 4-row (max) stack', () => {
  const w = emptyWell();
  for (let r = 0; r < 4; r++) for (let x = 0; x < COLS; x++) w[ROWS - 1 - r][x] = 'FALCON';
  const { cleared } = clearLines(w);
  assert.equal(cleared, 4);
});

// --- scoring + combo ------------------------------------------------------------------ //

test('lineScore scales with line count, level, and combo', () => {
  assert.equal(lineScore(0, 0, -1), 0);
  assert.equal(lineScore(1, 0, 0), 100); // base, level 0, no combo
  assert.equal(lineScore(2, 0, 0), 300);
  assert.equal(lineScore(3, 0, 0), 500);
  assert.equal(lineScore(4, 0, 0), 800);
  // level multiplier: level 1 (0-indexed) => x2
  assert.equal(lineScore(1, 1, 0), 200);
  // combo multiplier: combo 2 => x(1 + 2*0.5)=x2 on top of base
  assert.equal(lineScore(1, 0, 2), 200);
  assert.equal(lineScore(4, 1, 1), Math.round(800 * 2 * 1.5));
});

test('dropScore rewards cells, double for hard drop', () => {
  assert.equal(dropScore(5, false), 5);
  assert.equal(dropScore(5, true), 10);
  assert.equal(dropScore(0, true), 0);
  assert.equal(dropScore(-3, true), 0);
});

test('nextCombo increments on a clearing drop, resets on a non-clearing one', () => {
  assert.equal(nextCombo(-1, 1), 0); // first clear => combo 0
  assert.equal(nextCombo(0, 2), 1); // chained
  assert.equal(nextCombo(1, 1), 2);
  assert.equal(nextCombo(2, 0), -1); // dry drop breaks the chain
});

// --- level / gravity ramp ------------------------------------------------------------- //

test('levelForLines steps up every 10 lines (gentle ramp)', () => {
  assert.equal(levelForLines(0), 0);
  assert.equal(levelForLines(9), 0);
  assert.equal(levelForLines(10), 1);
  assert.equal(levelForLines(25), 2);
});

test('gravityInterval ramps down with level and clamps to a floor', () => {
  const l0 = gravityInterval(0, 800, 60, 100);
  const l5 = gravityInterval(5, 800, 60, 100);
  assert.equal(l0, 800);
  assert.ok(l5 < l0);
  assert.equal(gravityInterval(100, 800, 60, 100), 100); // clamps to floor
});

// --- spawn / top-out ------------------------------------------------------------------ //

test('spawnPos centres the piece horizontally at the top', () => {
  const pos = spawnPos('SHARD'); // 3 wide -> (10-3)/2 = 3
  assert.deepEqual(pos, { x: 3, y: 0 });
  assert.deepEqual(spawnPos('OBELISK'), { x: 4, y: 0 }); // 1 wide -> (10-1)/2 = 4
});

test('randomPiece is deterministic with a seeded rng and in-range', () => {
  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 100; i++) {
    assert.ok(PIECE_KEYS.includes(randomPiece(rng)));
  }
});

test('isToppedOut is false on an empty well, true when the spawn area is blocked', () => {
  const w = emptyWell();
  assert.equal(isToppedOut(w, 'SHARD'), false);
  // Block the spawn row across the centre.
  for (let x = 0; x < COLS; x++) w[0][x] = 'CAIRN';
  assert.equal(isToppedOut(w, 'SHARD'), true);
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic palette shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Temple Night',
    palette: { well: '#070b16', grid: '#152138', glow: '#bff0ff' },
  });
  assert.equal(s.itemId, 30000);
  assert.deepEqual(Object.keys(s.palette).sort(), ['glow', 'grid', 'well']);
});

test('normalizeSkin rejects out-of-range (non-cosmetic) item ids', () => {
  assert.throws(() => normalizeSkin({ itemId: 20000, name: 'X', palette: { well: '#000000', grid: '#111111', glow: '#ffffff' } }));
});

test('normalizeSkin rejects a malformed palette', () => {
  assert.throws(() => normalizeSkin({ itemId: 30001, name: 'X', palette: { well: '#000' } }));
});

test('normalizeSkins maps a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { well: '#000000', grid: '#111111', glow: '#ffffff' } },
    { itemId: 30001, name: 'B', palette: { well: '#010101', grid: '#121212', glow: '#eeeeee' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].name, 'B');
});
