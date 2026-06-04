import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stepRider,
  nearestContact,
  closestPointOnSegment,
  isOffWorld,
  reachedFinish,
  lowestTrackY,
  LINE_NORMAL,
  LINE_BOOST,
} from '../src/logic/physics.js';

// A physics config tuned for the tests (mirrors config.js defaults closely).
const P = {
  gravity: 1400,
  airDamping: 0.0008,
  friction: 0.02,
  boostFriction: -0.06,
  boostImpulse: 22,
  collisionRadius: 9,
  restitution: 0.0,
  maxSpeed: 2600,
  fallMargin: 400,
  spawnDrop: 24,
};

const step = (rider, lines, n, dt = 1 / 120) => {
  let r = rider;
  for (let i = 0; i < n; i++) {
    const next = stepRider(r, lines, dt, P);
    r = { x: next.x, y: next.y, vx: next.vx, vy: next.vy, contact: next.contact };
  }
  return r;
};

test('closestPointOnSegment clamps to endpoints', () => {
  // Point past B -> clamps to B (t=1).
  const cp = closestPointOnSegment(200, 0, 0, 0, 100, 0);
  assert.equal(cp.x, 100);
  assert.equal(cp.t, 1);
});

test('nearestContact finds a flat line below the body and gives an upward normal', () => {
  const lines = [[0, 100, 200, 100, LINE_NORMAL]];
  const c = nearestContact(100, 95, lines, P.collisionRadius); // body 5px above the line
  assert.ok(c, 'should find contact within radius');
  assert.ok(c.ny < 0, 'normal should point upward (toward the body)');
  assert.equal(c.type, LINE_NORMAL);
});

test('gravity accelerates a free rider downward', () => {
  const r = step({ x: 0, y: 0, vx: 0, vy: 0 }, [], 60); // 0.5s of fall, no track
  assert.ok(r.vy > 0, 'velocity should be downward');
  assert.ok(r.y > 0, 'position should have moved down');
  // ~ v = g*t = 1400*0.5 = 700 (minus a little air drag).
  assert.ok(r.vy > 600 && r.vy < 700, `vy ${r.vy} in expected band`);
});

test('rider rests on a flat line (does not sink, vertical velocity stays bounded)', () => {
  const lines = [[-500, 300, 500, 300, LINE_NORMAL]];
  // Spawn just above the line and let it settle for a full second.
  const r = step({ x: 0, y: 300 - P.collisionRadius, vx: 0, vy: 0 }, lines, 120);
  // Should stay pinned at the surface (y ~ 300 - radius), not fall through.
  assert.ok(Math.abs(r.y - (300 - P.collisionRadius)) < 3, `y ${r.y} near surface`);
  // No runaway downward velocity — normal resolution kills the inward component each step.
  assert.ok(Math.abs(r.vy) < 30, `vy ${r.vy} bounded on flat rest`);
});

test('rider accelerates DOWN a slope (gains tangential speed)', () => {
  // 45-degree slope going down-right.
  const lines = [[0, 0, 800, 800, LINE_NORMAL]];
  const r = step({ x: 100, y: 100 - 2, vx: 0, vy: 0 }, lines, 90);
  const speed = Math.hypot(r.vx, r.vy);
  assert.ok(r.vx > 0 && r.vy > 0, 'moving down-right along the slope');
  assert.ok(speed > 100, `gained speed on slope: ${speed}`);
});

test('boost line adds tangential impulse vs an identical normal line', () => {
  const mk = (type) => [[0, 0, 800, 800, type]];
  const start = { x: 100, y: 100 - 2, vx: 30, vy: 30 }; // already sliding down-right
  const normal = step({ ...start }, mk(LINE_NORMAL), 30);
  const boost = step({ ...start }, mk(LINE_BOOST), 30);
  const sN = Math.hypot(normal.vx, normal.vy);
  const sB = Math.hypot(boost.vx, boost.vy);
  assert.ok(sB > sN, `boost (${sB.toFixed(1)}) faster than normal (${sN.toFixed(1)})`);
});

test('speed is clamped to maxSpeed', () => {
  const fast = stepRider({ x: 0, y: 0, vx: 5000, vy: 5000 }, [], 1 / 120, P);
  assert.ok(Math.hypot(fast.vx, fast.vy) <= P.maxSpeed + 1e-6);
});

test('lowestTrackY / isOffWorld detect falling off the world', () => {
  const lines = [[0, 100, 100, 200, LINE_NORMAL]];
  assert.equal(lowestTrackY(lines), 200);
  assert.equal(isOffWorld(200 + P.fallMargin - 1, lines, P), false);
  assert.equal(isOffWorld(200 + P.fallMargin + 1, lines, P), true);
});

test('reachedFinish triggers within capture radius', () => {
  assert.equal(reachedFinish(100, 100, [105, 100], 18), true);
  assert.equal(reachedFinish(100, 100, [200, 100], 18), false);
  assert.equal(reachedFinish(100, 100, null, 18), false);
});
