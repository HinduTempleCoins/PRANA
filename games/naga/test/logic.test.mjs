import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRS,
  OPPOSITE,
  isReversal,
  resolveDirection,
  nextHead,
  cellsEqual,
  hitsBody,
  step,
  spawnFood,
  multiplierFor,
  orbScore,
  stepInterval,
  initialBody,
} from '../src/logic/snake.js';
import { RULES } from '../src/config.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

// --- direction handling --------------------------------------------------------------- //

test('OPPOSITE pairs and isReversal agree', () => {
  for (const [d, o] of Object.entries(OPPOSITE)) {
    assert.equal(isReversal(d, o), true);
    assert.equal(isReversal(d, d), false);
  }
});

test('resolveDirection rejects 180° reversal but keeps perpendicular turns', () => {
  assert.equal(resolveDirection('right', 'left'), 'right'); // reversal rejected
  assert.equal(resolveDirection('right', 'up'), 'up'); // perpendicular ok
  assert.equal(resolveDirection('up', 'down'), 'up'); // reversal rejected
  assert.equal(resolveDirection('up', 'unknown'), 'up'); // garbage ignored
  assert.equal(resolveDirection('up', null), 'up');
});

// --- head movement: wrap vs solid wall ------------------------------------------------ //

test('nextHead moves by the direction vector', () => {
  const { head } = nextHead({ x: 5, y: 5 }, 'right', 24, 18, true);
  assert.deepEqual(head, { x: 6, y: 5 });
});

test('nextHead wraps around edges when wrap=true', () => {
  assert.deepEqual(nextHead({ x: 23, y: 5 }, 'right', 24, 18, true).head, { x: 0, y: 5 });
  assert.deepEqual(nextHead({ x: 0, y: 5 }, 'left', 24, 18, true).head, { x: 23, y: 5 });
  assert.deepEqual(nextHead({ x: 5, y: 0 }, 'up', 24, 18, true).head, { x: 5, y: 17 });
  assert.deepEqual(nextHead({ x: 5, y: 17 }, 'down', 24, 18, true).head, { x: 5, y: 0 });
  assert.equal(nextHead({ x: 23, y: 5 }, 'right', 24, 18, true).outOfBounds, false);
});

test('nextHead flags out-of-bounds when wrap=false (solid walls)', () => {
  const r = nextHead({ x: 23, y: 5 }, 'right', 24, 18, false);
  assert.equal(r.outOfBounds, true);
  assert.deepEqual(r.head, { x: 24, y: 5 });
  assert.equal(nextHead({ x: 0, y: 0 }, 'left', 24, 18, false).outOfBounds, true);
  assert.equal(nextHead({ x: 5, y: 5 }, 'right', 24, 18, false).outOfBounds, false);
});

// --- collision helpers ---------------------------------------------------------------- //

test('cellsEqual + hitsBody, with and without ignoring the tail', () => {
  assert.equal(cellsEqual({ x: 1, y: 2 }, { x: 1, y: 2 }), true);
  const body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
  assert.equal(hitsBody({ x: 4, y: 5 }, body), true);
  assert.equal(hitsBody({ x: 3, y: 5 }, body), true); // tail counted by default
  assert.equal(hitsBody({ x: 3, y: 5 }, body, true), false); // tail ignored
  assert.equal(hitsBody({ x: 9, y: 9 }, body), false);
});

// --- step: move, grow, die ------------------------------------------------------------ //

test('step moves the snake and drops the tail when not eating', () => {
  const state = { body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: null });
  assert.equal(r.alive, true);
  assert.equal(r.ate, false);
  assert.equal(r.grew, false);
  assert.equal(r.body.length, 3); // length unchanged
  assert.deepEqual(r.body[0], { x: 6, y: 5 }); // new head
  assert.deepEqual(r.body[r.body.length - 1], { x: 4, y: 5 }); // tail advanced
});

test('step grows by one and retains the tail when eating an orb', () => {
  const state = { body: [{ x: 5, y: 5 }, { x: 4, y: 5 }], dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: { x: 6, y: 5 } });
  assert.equal(r.ate, true);
  assert.equal(r.grew, true);
  assert.equal(r.body.length, 3); // grew by one
  assert.deepEqual(r.body[0], { x: 6, y: 5 });
  assert.deepEqual(r.body[r.body.length - 1], { x: 4, y: 5 }); // tail retained
});

test('step detects self-collision and kills the snake', () => {
  // Moving up from the head lands on a NON-tail body segment -> fatal.
  const body = [
    { x: 5, y: 5 }, // head
    { x: 5, y: 4 }, // directly above the head — head will move into this segment
    { x: 6, y: 4 },
    { x: 6, y: 5 },
    { x: 6, y: 6 },
    { x: 5, y: 6 }, // tail (not the collision cell)
  ];
  const state = { body, dir: 'up', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: null });
  assert.equal(r.dead, true);
  assert.equal(r.alive, false);
});

test('step does NOT count the vacating tail as a self-collision when not eating', () => {
  // Head about to move into the cell the tail currently occupies — legal, tail vacates it.
  const body = [
    { x: 5, y: 5 }, // head
    { x: 5, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: 5 }, // tail; head moving right lands here
  ];
  const state = { body, dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: null });
  assert.equal(r.dead, false);
  assert.equal(r.alive, true);
  assert.deepEqual(r.body[0], { x: 6, y: 5 });
});

test('step into the SAME tail cell IS fatal when that move also eats (tail retained)', () => {
  const body = [
    { x: 5, y: 5 }, // head
    { x: 5, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: 5 }, // tail; head lands here
  ];
  const state = { body, dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: { x: 6, y: 5 } });
  assert.equal(r.dead, true); // ate => tail retained => collision
});

test('step kills on solid-wall contact when wrap=false', () => {
  const state = { body: [{ x: 23, y: 5 }, { x: 22, y: 5 }], dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: false, food: null });
  assert.equal(r.dead, true);
  assert.equal(r.outOfBounds, true);
});

test('step wraps instead of dying when wrap=true at the edge', () => {
  const state = { body: [{ x: 23, y: 5 }, { x: 22, y: 5 }], dir: 'right', alive: true };
  const r = step(state, { cols: 24, rows: 18, wrap: true, food: null });
  assert.equal(r.dead, false);
  assert.deepEqual(r.body[0], { x: 0, y: 5 });
});

test('step is pure: it does not mutate the input state', () => {
  const body = [{ x: 5, y: 5 }, { x: 4, y: 5 }];
  const state = { body, dir: 'right', alive: true };
  const snapshot = JSON.stringify(state);
  step(state, { cols: 24, rows: 18, wrap: true, food: null });
  assert.equal(JSON.stringify(state), snapshot);
});

// --- food spawning -------------------------------------------------------------------- //

test('spawnFood never lands on the snake and stays in bounds', () => {
  const body = initialBody(24, 18, 4);
  let seed = 1;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 200; i++) {
    const f = spawnFood(body, 24, 18, rng);
    assert.ok(f.x >= 0 && f.x < 24 && f.y >= 0 && f.y < 18);
    assert.equal(hitsBody(f, body), false);
  }
});

test('spawnFood returns null on a full board', () => {
  const cols = 3;
  const rows = 2;
  const body = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) body.push({ x, y });
  assert.equal(spawnFood(body, cols, rows), null);
});

// --- scoring + speed ------------------------------------------------------------------ //

test('multiplierFor rises at length milestones', () => {
  assert.equal(multiplierFor(0, 5), 1);
  assert.equal(multiplierFor(4, 5), 1);
  assert.equal(multiplierFor(5, 5), 2);
  assert.equal(multiplierFor(9, 5), 2);
  assert.equal(multiplierFor(10, 5), 3);
  assert.equal(multiplierFor(25, 5), 6);
});

test('orbScore applies the multiplier', () => {
  assert.equal(orbScore(10, 1), 10);
  assert.equal(orbScore(10, 3), 30);
});

test('stepInterval ramps down with length and clamps to the floor', () => {
  const slow = stepInterval(RULES.startLength, RULES);
  const faster = stepInterval(RULES.startLength + 10, RULES);
  assert.equal(slow, RULES.baseStepMs);
  assert.ok(faster < slow);
  // Huge length clamps to the floor, never below.
  assert.equal(stepInterval(RULES.startLength + 1000, RULES), RULES.minStepMs);
});

test('initialBody is centered, head-first, and legal-length', () => {
  const body = initialBody(24, 18, 4);
  assert.equal(body.length, 4);
  assert.deepEqual(body[0], { x: 12, y: 9 }); // head at center
  assert.deepEqual(body[3], { x: 9, y: 9 }); // tail trails left
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic item shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Aether Serpent',
    head: 'round',
    palette: { head: '#aabbcc', body: '#112233', glow: '#ffffff' },
  });
  assert.equal(s.itemId, 30000);
  assert.equal(s.head, 'round');
  assert.deepEqual(Object.keys(s.palette).sort(), ['body', 'glow', 'head']);
});

test('normalizeSkin rejects out-of-range (non-cosmetic) item ids', () => {
  assert.throws(() => normalizeSkin({ itemId: 20000, name: 'X', palette: { head: '#ffffff', body: '#000000', glow: '#ffffff' } }));
});

test('normalizeSkin rejects malformed palette', () => {
  assert.throws(() => normalizeSkin({ itemId: 30001, name: 'X', palette: { head: '#fff' } }));
});

test('normalizeSkins maps and indexes a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { head: '#ffffff', body: '#000000', glow: '#ffffff' } },
    { itemId: 30001, name: 'B', head: 'diamond', palette: { head: '#ffffff', body: '#000000', glow: '#ffffff' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].head, 'diamond');
});
