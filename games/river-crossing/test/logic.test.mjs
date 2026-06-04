import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS,
  LANE,
  makeRng,
  buildBoard,
  computeAlcoves,
  advanceOffset,
  occupiedColumns,
  stepPlayer,
  carry,
  evaluateCell,
  forwardScore,
  alcoveScore,
  allAlcovesFilled,
  newAlcoveState,
} from '../src/logic/crossing.js';
import { RULES } from '../src/config.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

// --- seeded RNG / determinism --------------------------------------------------------- //

test('makeRng is deterministic for a given seed', () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

test('makeRng produces values in [0,1)', () => {
  const r = makeRng(7);
  for (let i = 0; i < 500; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

test('buildBoard is a pure function of (seed, tier)', () => {
  const a = buildBoard(13, 13, 0, RULES.seed);
  const b = buildBoard(13, 13, 0, RULES.seed);
  assert.deepEqual(a, b);
  const c = buildBoard(13, 13, 1, RULES.seed);
  assert.notDeepEqual(a.lanes, c.lanes); // different tier -> different layout
});

// --- board structure ------------------------------------------------------------------ //

test('buildBoard has a goal row, a start bank, and road+water bands', () => {
  const board = buildBoard(13, 13, 0, RULES.seed);
  assert.equal(board.lanes[board.goalRow].kind, LANE.GOAL);
  assert.equal(board.lanes[board.startRow].kind, LANE.BANK);
  const kinds = new Set(board.lanes.map((l) => l.kind));
  assert.ok(kinds.has(LANE.ROAD));
  assert.ok(kinds.has(LANE.WATER));
});

test('road/water lanes carry obstacles, a direction, and a positive speed', () => {
  const board = buildBoard(13, 13, 2, RULES.seed);
  for (const lane of board.lanes) {
    if (lane.kind === LANE.ROAD || lane.kind === LANE.WATER) {
      assert.ok(Array.isArray(lane.obstacles));
      assert.ok(lane.dir === 1 || lane.dir === -1);
      assert.ok(lane.speed > 0);
    }
  }
});

test('higher tiers drift faster (speed scales up)', () => {
  const sum = (tier) =>
    buildBoard(13, 13, tier, RULES.seed).lanes
      .filter((l) => l.speed)
      .reduce((a, l) => a + l.speed, 0);
  assert.ok(sum(3) > sum(0));
});

test('computeAlcoves yields 5 in-bounds, sorted, unique columns', () => {
  const al = computeAlcoves(13);
  assert.equal(al.length, 5);
  for (const x of al) assert.ok(x >= 0 && x < 13);
  assert.deepEqual([...al].sort((a, b) => a - b), al);
  assert.equal(new Set(al).size, 5);
});

// --- drift / occupancy ---------------------------------------------------------------- //

test('advanceOffset advances road/water lanes and leaves banks alone', () => {
  const road = { kind: LANE.ROAD, dir: 1, speed: 2, obstacles: [] };
  assert.equal(advanceOffset(0, road, 0.5), 1); // 2 cells/s * 0.5s
  const bank = { kind: LANE.BANK };
  assert.equal(advanceOffset(5, bank, 1), 5); // unchanged
});

test('occupiedColumns wraps obstacle spans into [0, cols)', () => {
  const lane = { kind: LANE.ROAD, dir: 1, speed: 1, obstacles: [{ x: 0, len: 2 }] };
  const occ0 = occupiedColumns(lane, 0, 13);
  assert.ok(occ0.has(0) && occ0.has(1));
  // shift by 12 with dir +1 -> columns wrap to 12 and 0
  const occ = occupiedColumns(lane, 12, 13);
  assert.ok(occ.has(12) && occ.has(0));
  for (const c of occ) assert.ok(c >= 0 && c < 13);
});

test('occupiedColumns honors lane direction sign', () => {
  const right = { kind: LANE.ROAD, dir: 1, speed: 1, obstacles: [{ x: 5, len: 1 }] };
  const left = { kind: LANE.ROAD, dir: -1, speed: 1, obstacles: [{ x: 5, len: 1 }] };
  assert.ok(occupiedColumns(right, 2, 13).has(7));
  assert.ok(occupiedColumns(left, 2, 13).has(3));
});

// --- stepping / clamping -------------------------------------------------------------- //

test('stepPlayer moves by the direction vector and clamps to the board', () => {
  assert.deepEqual(stepPlayer({ x: 5, y: 5 }, 'up', 13, 13), { x: 5, y: 4 });
  assert.deepEqual(stepPlayer({ x: 5, y: 5 }, 'right', 13, 13), { x: 6, y: 5 });
  // clamp at edges
  assert.deepEqual(stepPlayer({ x: 0, y: 0 }, 'left', 13, 13), { x: 0, y: 0 });
  assert.deepEqual(stepPlayer({ x: 12, y: 12 }, 'down', 13, 13), { x: 12, y: 12 });
  // unknown dir = no move
  assert.deepEqual(stepPlayer({ x: 5, y: 5 }, 'nope', 13, 13), { x: 5, y: 5 });
});

// --- log-ride carry ------------------------------------------------------------------- //

test('carry drifts the rider sideways with the log direction', () => {
  const lane = { kind: LANE.WATER, dir: 1 };
  const r = carry({ x: 5, y: 3 }, lane, 2, 13);
  assert.deepEqual(r.pos, { x: 7, y: 3 });
  assert.equal(r.sweptOff, false);
});

test('carry flags sweptOff when the rider is carried off the board edge', () => {
  const lane = { kind: LANE.WATER, dir: 1 };
  const r = carry({ x: 12, y: 3 }, lane, 3, 13);
  assert.equal(r.sweptOff, true);
  const l = carry({ x: 0, y: 3 }, { kind: LANE.WATER, dir: -1 }, 2, 13);
  assert.equal(l.sweptOff, true);
});

test('carry is a no-op on non-water lanes', () => {
  const r = carry({ x: 5, y: 3 }, { kind: LANE.ROAD, dir: 1 }, 4, 13);
  assert.deepEqual(r.pos, { x: 5, y: 3 });
  assert.equal(r.sweptOff, false);
});

// --- fate evaluation ------------------------------------------------------------------ //

test('evaluateCell: bank is always safe', () => {
  const r = evaluateCell({ x: 4, y: 12 }, { kind: LANE.BANK }, new Set(), []);
  assert.equal(r.outcome, 'safe');
});

test('evaluateCell: road cell is dead under a vehicle, safe otherwise', () => {
  const lane = { kind: LANE.ROAD };
  assert.equal(evaluateCell({ x: 3, y: 5 }, lane, new Set([3]), []).outcome, 'dead');
  assert.equal(evaluateCell({ x: 3, y: 5 }, lane, new Set([4]), []).outcome, 'safe');
});

test('evaluateCell: water is riding ON a log, dead in open water', () => {
  const lane = { kind: LANE.WATER };
  assert.equal(evaluateCell({ x: 6, y: 4 }, lane, new Set([6]), []).outcome, 'riding');
  assert.equal(evaluateCell({ x: 6, y: 4 }, lane, new Set([2]), []).outcome, 'dead');
});

test('evaluateCell: goal fills an empty alcove, dead on wall or taken alcove', () => {
  const lane = { kind: LANE.GOAL, alcoves: [2, 6, 10] };
  const filled = [false, false, false];
  const hit = evaluateCell({ x: 6, y: 0 }, lane, new Set(), filled);
  assert.equal(hit.outcome, 'goal');
  assert.equal(hit.alcoveIndex, 1);
  // between alcoves = wall
  assert.equal(evaluateCell({ x: 4, y: 0 }, lane, new Set(), filled).outcome, 'dead');
  // already filled
  assert.equal(evaluateCell({ x: 2, y: 0 }, lane, new Set(), [true, false, false]).outcome, 'dead');
});

// --- scoring -------------------------------------------------------------------------- //

test('forwardScore rewards only net-new forward progress', () => {
  // rows decrease toward the goal
  assert.equal(forwardScore(12, 11, 10), 10); // advanced one row
  assert.equal(forwardScore(11, 9, 10), 20); // advanced two rows
  assert.equal(forwardScore(9, 11, 10), 0); // moved backward, no points
  assert.equal(forwardScore(9, 9, 10), 0); // no net progress
});

test('alcoveScore grows with alcoves already filled this sweep', () => {
  assert.equal(alcoveScore(0, 50, 25), 50);
  assert.equal(alcoveScore(1, 50, 25), 75);
  assert.equal(alcoveScore(4, 50, 25), 150);
});

test('allAlcovesFilled / newAlcoveState', () => {
  const s = newAlcoveState(5);
  assert.equal(s.length, 5);
  assert.equal(allAlcovesFilled(s), false);
  s.fill(true);
  assert.equal(allAlcovesFilled(s), true);
  assert.equal(allAlcovesFilled([]), false); // empty isn't "all filled"
});

// --- a small integration walk --------------------------------------------------------- //

test('a forward sweep accrues forward score across rows', () => {
  const board = buildBoard(13, 13, 0, RULES.seed);
  let pos = { x: 6, y: board.startRow };
  let best = board.startRow;
  let score = 0;
  while (pos.y > board.goalRow) {
    pos = stepPlayer(pos, 'up', 13, 13);
    const g = forwardScore(best, pos.y, RULES.pointsPerRow);
    if (g > 0) {
      score += g;
      best = pos.y;
    }
  }
  // advanced startRow rows total
  assert.equal(score, board.startRow * RULES.pointsPerRow);
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic item shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Prana Spark',
    shape: 'round',
    palette: { body: '#aabbcc', accent: '#112233', glow: '#ffffff' },
  });
  assert.equal(s.itemId, 30000);
  assert.equal(s.shape, 'round');
  assert.deepEqual(Object.keys(s.palette).sort(), ['accent', 'body', 'glow']);
});

test('normalizeSkin rejects out-of-range (non-cosmetic) item ids', () => {
  assert.throws(() =>
    normalizeSkin({ itemId: 20000, name: 'X', palette: { body: '#ffffff', accent: '#000000', glow: '#ffffff' } }),
  );
});

test('normalizeSkin rejects malformed palette', () => {
  assert.throws(() => normalizeSkin({ itemId: 30001, name: 'X', palette: { body: '#fff' } }));
});

test('normalizeSkins maps and indexes a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { body: '#ffffff', accent: '#000000', glow: '#ffffff' } },
    { itemId: 30001, name: 'B', shape: 'diamond', palette: { body: '#ffffff', accent: '#000000', glow: '#ffffff' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].shape, 'diamond');
});

// keep DIRS referenced (exported helper sanity)
test('DIRS has four cardinal unit vectors', () => {
  assert.deepEqual(DIRS.up, { x: 0, y: -1 });
  assert.deepEqual(DIRS.down, { x: 0, y: 1 });
  assert.deepEqual(DIRS.left, { x: -1, y: 0 });
  assert.deepEqual(DIRS.right, { x: 1, y: 0 });
});
