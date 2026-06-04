import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD,
  BRICKS,
  ROW_HP,
  buildBricks,
  aliveCount,
  MAX_BOUNCE_ANGLE,
  paddleOffset,
  paddleBounce,
  speedOf,
  reflectWalls,
  fellOff,
  brickHitAxis,
  damageBrick,
  reflect,
  brickScore,
  clearBonus,
  BASE_BALL_SPEED,
  MAX_BALL_SPEED,
  ballSpeedForLevel,
  rescaleVelocity,
  POWERUPS,
  maybeDropPowerup,
  widenPaddle,
  splitBall,
  clampPaddle,
} from '../src/logic/bounce.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- brick field ---------------------------------------------------------------------- //

test('buildBricks produces an 8×6 field with HP tiers by row', () => {
  const bricks = buildBricks();
  assert.equal(bricks.length, BRICKS.cols * BRICKS.rows); // 48
  // every brick alive at full hp matching its row tier
  for (const b of bricks) {
    assert.equal(b.alive, true);
    assert.equal(b.hp, ROW_HP[b.row]);
    assert.equal(b.maxHp, ROW_HP[b.row]);
  }
  // top row is the toughest tier (3), bottom row the softest (1)
  assert.equal(bricks.find((b) => b.row === 0).hp, 3);
  assert.equal(bricks.find((b) => b.row === 5).hp, 1);
});

test('bricks tile across the field width inside the side margins, no overlap', () => {
  const bricks = buildBricks();
  const row0 = bricks.filter((b) => b.row === 0).sort((a, b) => a.col - b.col);
  assert.ok(row0[0].x >= BRICKS.sideMargin - 1e-6);
  const last = row0[row0.length - 1];
  assert.ok(last.x + last.w <= FIELD.w - BRICKS.sideMargin + 1e-6);
  // adjacent bricks are gap apart, not overlapping
  assert.ok(approx(row0[1].x - (row0[0].x + row0[0].w), BRICKS.gap));
});

test('aliveCount tracks destroyed bricks', () => {
  const bricks = buildBricks();
  assert.equal(aliveCount(bricks), 48);
  bricks[0].alive = false;
  bricks[5].alive = false;
  assert.equal(aliveCount(bricks), 46);
});

// --- paddle english (bounce angle) ---------------------------------------------------- //

test('paddleOffset is 0 at centre, ±1 at the edges, clamped beyond', () => {
  assert.ok(approx(paddleOffset(100, 60, 80), 0)); // centre = 60+40
  assert.ok(approx(paddleOffset(60, 60, 80), -1)); // left edge
  assert.ok(approx(paddleOffset(140, 60, 80), 1)); // right edge
  assert.equal(paddleOffset(0, 60, 80), -1); // beyond -> clamped
  assert.equal(paddleOffset(999, 60, 80), 1);
});

test('paddleBounce: centre hit goes straight up, edges angle outward, speed preserved', () => {
  const speed = 400;
  const center = paddleBounce(speed, 0);
  assert.ok(approx(center.vx, 0));
  assert.ok(center.vy < 0); // upward
  assert.ok(approx(speedOf(center.vx, center.vy), speed));

  const right = paddleBounce(speed, 1);
  assert.ok(right.vx > 0); // steers right
  assert.ok(right.vy < 0);
  assert.ok(approx(speedOf(right.vx, right.vy), speed));
  // at the very edge the angle equals MAX_BOUNCE_ANGLE off vertical
  assert.ok(approx(Math.atan2(right.vx, -right.vy), MAX_BOUNCE_ANGLE));

  const left = paddleBounce(speed, -1);
  assert.ok(left.vx < 0); // steers left
});

// --- wall reflection ------------------------------------------------------------------ //

test('reflectWalls bounces off left/right/top and clamps the position', () => {
  const r = 8;
  // left wall
  let res = reflectWalls({ x: 2, y: 100 }, { vx: -200, vy: 50 }, r, FIELD);
  assert.equal(res.pos.x, r);
  assert.ok(res.vel.vx > 0);
  assert.equal(res.hit, true);
  // right wall
  res = reflectWalls({ x: FIELD.w - 2, y: 100 }, { vx: 200, vy: 50 }, r, FIELD);
  assert.equal(res.pos.x, FIELD.w - r);
  assert.ok(res.vel.vx < 0);
  // top wall
  res = reflectWalls({ x: 100, y: 2 }, { vx: 30, vy: -200 }, r, FIELD);
  assert.equal(res.pos.y, r);
  assert.ok(res.vel.vy > 0);
  // no wall
  res = reflectWalls({ x: 400, y: 300 }, { vx: 100, vy: 100 }, r, FIELD);
  assert.equal(res.hit, false);
});

test('fellOff only true once the ball clears the bottom edge', () => {
  assert.equal(fellOff({ x: 400, y: FIELD.h - 5 }, 8, FIELD), false);
  assert.equal(fellOff({ x: 400, y: FIELD.h + 20 }, 8, FIELD), true);
});

// --- brick collision + HP ------------------------------------------------------------- //

test('brickHitAxis returns null when the ball does not overlap the brick', () => {
  const brick = { x: 100, y: 100, w: 80, h: 28, alive: true };
  assert.equal(brickHitAxis({ x: 400, y: 400 }, 8, brick), null);
});

test('brickHitAxis reflects on Y for a hit from below/above, X from the side', () => {
  const brick = { x: 100, y: 100, w: 80, h: 28, alive: true };
  // ball centred under the brick, just touching the bottom edge -> vertical reflection
  const fromBelow = brickHitAxis({ x: 140, y: 100 + 28 + 5 }, 8, brick);
  assert.equal(fromBelow, 'y');
  // ball at the side, vertically centred on the brick -> horizontal reflection
  const fromSide = brickHitAxis({ x: 100 - 5, y: 114 }, 8, brick);
  assert.equal(fromSide, 'x');
});

test('brickHitAxis ignores dead bricks', () => {
  const brick = { x: 100, y: 100, w: 80, h: 28, alive: false };
  assert.equal(brickHitAxis({ x: 140, y: 114 }, 8, brick), null);
});

test('damageBrick decrements HP and destroys at zero', () => {
  const brick = { hp: 3, maxHp: 3, alive: true };
  let r = damageBrick(brick);
  assert.deepEqual(r, { destroyed: false, hp: 2 });
  r = damageBrick(brick);
  assert.deepEqual(r, { destroyed: false, hp: 1 });
  r = damageBrick(brick);
  assert.deepEqual(r, { destroyed: true, hp: 0 });
  assert.equal(brick.alive, false);
});

test('reflect flips the requested axis only', () => {
  assert.deepEqual(reflect({ vx: 3, vy: 5 }, 'x'), { vx: -3, vy: 5 });
  assert.deepEqual(reflect({ vx: 3, vy: 5 }, 'y'), { vx: 3, vy: -5 });
  assert.deepEqual(reflect({ vx: 3, vy: 5 }, null), { vx: 3, vy: 5 });
});

// --- scoring -------------------------------------------------------------------------- //

test('brickScore scales with tier and level', () => {
  assert.equal(brickScore({ maxHp: 1 }, 0), 50);
  assert.equal(brickScore({ maxHp: 3 }, 0), 150);
  assert.equal(brickScore({ maxHp: 3 }, 1), 300); // level 1 (0-indexed) doubles
});

test('clearBonus scales with level', () => {
  assert.equal(clearBonus(0), 1000);
  assert.equal(clearBonus(2), 3000);
});

// --- level scaling (speed +10% per level, clamped) ------------------------------------ //

test('ballSpeedForLevel ramps +10% per level and clamps to the max', () => {
  assert.ok(approx(ballSpeedForLevel(0), BASE_BALL_SPEED));
  assert.ok(approx(ballSpeedForLevel(1), BASE_BALL_SPEED * 1.1));
  assert.ok(ballSpeedForLevel(2) > ballSpeedForLevel(1));
  assert.equal(ballSpeedForLevel(100), MAX_BALL_SPEED); // clamps
});

test('rescaleVelocity sets the magnitude while preserving direction', () => {
  const v = rescaleVelocity({ vx: 3, vy: 4 }, 100); // |(3,4)| = 5
  assert.ok(approx(speedOf(v.vx, v.vy), 100));
  assert.ok(approx(v.vx, 60));
  assert.ok(approx(v.vy, 80));
  // degenerate zero velocity shoots straight up at the target speed
  const up = rescaleVelocity({ vx: 0, vy: 0 }, 200);
  assert.deepEqual(up, { vx: 0, vy: -200 });
});

// --- powerups ------------------------------------------------------------------------- //

test('maybeDropPowerup respects the drop chance and picks a valid type', () => {
  // rng always 0 => below chance, then first branch (<0.5) => WIDE
  assert.equal(maybeDropPowerup(() => 0, 0.12), POWERUPS.WIDE);
  // a sequence: first call decides drop (0.05<0.12 => drop), second decides type (0.9 => MULTI)
  const seq = [0.05, 0.9];
  let i = 0;
  assert.equal(maybeDropPowerup(() => seq[i++], 0.12), POWERUPS.MULTI);
  // rng above chance => no drop
  assert.equal(maybeDropPowerup(() => 0.99, 0.12), null);
});

test('widenPaddle grows the paddle but caps at the max', () => {
  assert.equal(widenPaddle(120, 1.5, 240), 180);
  assert.equal(widenPaddle(200, 1.5, 240), 240); // capped
});

test('splitBall fans two extra balls at the same speed', () => {
  const base = { vx: 0, vy: -400 };
  const [a, b] = splitBall(base);
  assert.ok(approx(speedOf(a.vx, a.vy), 400));
  assert.ok(approx(speedOf(b.vx, b.vy), 400));
  // the two extras diverge (different vx signs around straight-up)
  assert.ok(a.vx !== b.vx);
});

test('clampPaddle keeps the paddle inside the field', () => {
  assert.equal(clampPaddle(-50, 120, FIELD), 0);
  assert.equal(clampPaddle(FIELD.w, 120, FIELD), FIELD.w - 120);
  assert.equal(clampPaddle(300, 120, FIELD), 300);
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic palette shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Prana Cyan',
    palette: { bg: '#05080f', paddle: '#62d0ff', ball: '#bff0ff' },
  });
  assert.equal(s.itemId, 30000);
  assert.deepEqual(Object.keys(s.palette).sort(), ['ball', 'bg', 'paddle']);
});

test('normalizeSkin rejects out-of-range (non-cosmetic) item ids', () => {
  assert.throws(() => normalizeSkin({ itemId: 20000, name: 'X', palette: { bg: '#000000', paddle: '#111111', ball: '#ffffff' } }));
});

test('normalizeSkin rejects a malformed palette', () => {
  assert.throws(() => normalizeSkin({ itemId: 30001, name: 'X', palette: { bg: '#000' } }));
});

test('normalizeSkins maps a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { bg: '#000000', paddle: '#111111', ball: '#ffffff' } },
    { itemId: 30001, name: 'B', palette: { bg: '#010101', paddle: '#121212', ball: '#eeeeee' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].name, 'B');
});
