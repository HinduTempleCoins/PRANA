import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapScalar,
  wrapPos,
  integratePos,
  wrapDelta,
  wrapDistance,
  circlesOverlap,
  stepShip,
  spawnBolt,
  stepBolts,
  makeShard,
  stepShards,
  splitShard,
  resolveBoltShardHits,
  shipShardCollision,
  saucerAimHeading,
  saucerFire,
  largeShardsForWave,
  spawnWave,
  shardScore,
  _resetShardSeq,
} from '../src/logic/shards.js';
import { RULES } from '../src/config.js';

const W = 720;
const H = 540;

// --- wrap / vector helpers ------------------------------------------------------------ //

test('wrapScalar folds into [0,size)', () => {
  assert.equal(wrapScalar(5, 10), 5);
  assert.equal(wrapScalar(-1, 10), 9);
  assert.equal(wrapScalar(10, 10), 0);
  assert.equal(wrapScalar(23, 10), 3);
});

test('wrapPos wraps both axes', () => {
  assert.deepEqual(wrapPos({ x: -5, y: H + 7 }, W, H), { x: W - 5, y: 7 });
});

test('integratePos advances then wraps', () => {
  const p = integratePos({ x: W - 10, y: 5 }, { x: 100, y: 0 }, 1, W, H);
  assert.ok(Math.abs(p.x - 90) < 1e-9); // wrapped around the right edge
  assert.equal(p.y, 5);
});

test('wrapDelta returns the shortest signed delta across the seam', () => {
  // From x=710 to x=10 on a 720 field: short way is +20, not -700.
  assert.equal(wrapDelta(710, 10, 720), 20);
  assert.equal(wrapDelta(10, 710, 720), -20);
  assert.equal(wrapDelta(100, 200, 720), 100);
});

test('wrapDistance is short across the seam', () => {
  const d = wrapDistance({ x: 715, y: 5 }, { x: 5, y: 5 }, W, H);
  assert.ok(Math.abs(d - 10) < 1e-9);
});

test('circlesOverlap respects radii and the torus', () => {
  assert.equal(circlesOverlap({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5, W, H), true); // 8 <= 10
  assert.equal(circlesOverlap({ x: 0, y: 0 }, 5, { x: 12, y: 0 }, 5, W, H), false); // 12 > 10
  // across the seam: x=2 and x=W-2 are 4 apart
  assert.equal(circlesOverlap({ x: 2, y: 0 }, 2, { x: W - 2, y: 0 }, 2, W, H), true);
});

// --- ship physics --------------------------------------------------------------------- //

test('stepShip rotates left/right by turnRate*dt', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, angle: 0 };
  const left = stepShip(ship, { rotateLeft: true }, RULES.ship, 0.5, W, H);
  assert.ok(left.angle < 0); // left decreases angle
  const right = stepShip(ship, { rotateRight: true }, RULES.ship, 0.5, W, H);
  assert.ok(right.angle > 0);
});

test('stepShip thrust adds velocity along the facing', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, angle: 0 }; // facing +x
  const s = stepShip(ship, { thrust: true }, RULES.ship, 0.1, W, H);
  assert.ok(s.vel.x > 0); // accelerated rightward
  assert.ok(Math.abs(s.vel.y) < 1e-6);
});

test('stepShip drag bleeds velocity when coasting', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 100, y: 0 }, angle: 0 };
  const s = stepShip(ship, {}, RULES.ship, 1, W, H);
  assert.ok(s.vel.x < 100); // drag reduced speed
  assert.ok(s.vel.x > 0);
});

test('stepShip clamps to maxSpeed', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 9999, y: 0 }, angle: 0 };
  const s = stepShip(ship, { thrust: true }, RULES.ship, 0.1, W, H);
  assert.ok(Math.hypot(s.vel.x, s.vel.y) <= RULES.ship.maxSpeed + 1e-6);
});

test('stepShip integrates position and wraps', () => {
  const ship = { pos: { x: W - 1, y: 10 }, vel: { x: 200, y: 0 }, angle: 0 };
  const s = stepShip(ship, {}, RULES.ship, 0.1, W, H);
  assert.ok(s.pos.x >= 0 && s.pos.x < W);
});

test('stepShip is pure (does not mutate input)', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 5, y: 5 }, angle: 0 };
  const snap = JSON.stringify(ship);
  stepShip(ship, { thrust: true, rotateLeft: true }, RULES.ship, 0.1, W, H);
  assert.equal(JSON.stringify(ship), snap);
});

// --- bolts ---------------------------------------------------------------------------- //

test('spawnBolt fires from the nose along the facing', () => {
  const ship = { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, angle: 0 };
  const b = spawnBolt(ship, RULES.bolt, 1000);
  assert.ok(b.vel.x > 0 && Math.abs(b.vel.y) < 1e-6);
  assert.equal(b.born, 1000);
});

test('stepBolts drops expired bolts and advances the rest', () => {
  const bolts = [
    { pos: { x: 10, y: 10 }, vel: { x: 100, y: 0 }, born: 0, radius: 3 },
    { pos: { x: 20, y: 20 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 },
  ];
  const now = RULES.bolt.lifeMs + 1; // both expired
  const out = stepBolts(bolts, RULES.bolt, 0.1, now, W, H);
  assert.equal(out.length, 0);
  const out2 = stepBolts(bolts, RULES.bolt, 0.1, 10, W, H);
  assert.equal(out2.length, 2);
  assert.ok(out2[0].pos.x > 10); // advanced
});

// --- shards: split tables ------------------------------------------------------------- //

test('makeShard sets size/radius/velocity from the tier', () => {
  _resetShardSeq();
  const s = makeShard('large', { x: 100, y: 100 }, 0, RULES.shards);
  assert.equal(s.size, 'large');
  assert.equal(s.radius, RULES.shards.large.radius);
  assert.ok(Math.abs(Math.hypot(s.vel.x, s.vel.y) - RULES.shards.large.speed) < 1e-6);
});

test('splitShard: large -> 2 medium', () => {
  _resetShardSeq();
  const large = makeShard('large', { x: 100, y: 100 }, 0, RULES.shards);
  const kids = splitShard(large, RULES.shards, () => 0.5);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.size === 'medium'));
});

test('splitShard: medium -> 2 small', () => {
  _resetShardSeq();
  const med = makeShard('medium', { x: 100, y: 100 }, 0, RULES.shards);
  const kids = splitShard(med, RULES.shards, () => 0.5);
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.size === 'small'));
});

test('splitShard: small -> nothing (terminal)', () => {
  _resetShardSeq();
  const small = makeShard('small', { x: 100, y: 100 }, 0, RULES.shards);
  assert.equal(splitShard(small, RULES.shards).length, 0);
});

test('split children inherit the parent position', () => {
  _resetShardSeq();
  const large = makeShard('large', { x: 222, y: 111 }, 1, RULES.shards);
  const kids = splitShard(large, RULES.shards, () => 0.5);
  for (const k of kids) {
    assert.equal(k.pos.x, 222);
    assert.equal(k.pos.y, 111);
  }
});

test('stepShards drifts every shard and wraps', () => {
  _resetShardSeq();
  const s = makeShard('small', { x: W - 1, y: 10 }, 0, RULES.shards); // moving +x fast
  const moved = stepShards([s], 1, W, H);
  assert.ok(moved[0].pos.x >= 0 && moved[0].pos.x < W);
});

// --- collisions ----------------------------------------------------------------------- //

test('resolveBoltShardHits: a bolt splits the shard it hits and scores its tier', () => {
  _resetShardSeq();
  const large = makeShard('large', { x: 100, y: 100 }, 0, RULES.shards);
  const bolt = { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 };
  const res = resolveBoltShardHits([bolt], [large], RULES.shards, W, H, () => 0.5);
  assert.equal(res.scored, RULES.shards.large.score);
  assert.equal(res.bolts.length, 0); // bolt consumed
  assert.equal(res.shards.length, 2); // split into 2 medium
  assert.ok(res.shards.every((s) => s.size === 'medium'));
  assert.equal(res.destroyed.length, 1);
});

test('resolveBoltShardHits: a small shard hit leaves no children', () => {
  _resetShardSeq();
  const small = makeShard('small', { x: 50, y: 50 }, 0, RULES.shards);
  const bolt = { pos: { x: 50, y: 50 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 };
  const res = resolveBoltShardHits([bolt], [small], RULES.shards, W, H);
  assert.equal(res.shards.length, 0);
  assert.equal(res.scored, RULES.shards.small.score);
});

test('resolveBoltShardHits: a missing bolt survives and nothing scores', () => {
  _resetShardSeq();
  const large = makeShard('large', { x: 100, y: 100 }, 0, RULES.shards);
  const bolt = { pos: { x: 400, y: 400 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 };
  const res = resolveBoltShardHits([bolt], [large], RULES.shards, W, H);
  assert.equal(res.scored, 0);
  assert.equal(res.bolts.length, 1);
  assert.equal(res.shards.length, 1);
});

test('resolveBoltShardHits: each bolt consumes only ONE shard', () => {
  _resetShardSeq();
  const a = makeShard('small', { x: 100, y: 100 }, 0, RULES.shards);
  const b = makeShard('small', { x: 101, y: 100 }, 0, RULES.shards); // overlapping
  const bolt = { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 };
  const res = resolveBoltShardHits([bolt], [a, b], RULES.shards, W, H);
  assert.equal(res.shards.length, 1); // only one destroyed
  assert.equal(res.scored, RULES.shards.small.score);
});

test('resolveBoltShardHits does not mutate inputs', () => {
  _resetShardSeq();
  const large = makeShard('large', { x: 100, y: 100 }, 0, RULES.shards);
  const shards = [large];
  const bolts = [{ pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, born: 0, radius: 3 }];
  const snapS = JSON.stringify(shards);
  const snapB = JSON.stringify(bolts);
  resolveBoltShardHits(bolts, shards, RULES.shards, W, H, () => 0.5);
  assert.equal(JSON.stringify(shards), snapS);
  assert.equal(JSON.stringify(bolts), snapB);
});

test('shipShardCollision finds an overlapping shard, else -1', () => {
  _resetShardSeq();
  const ship = { pos: { x: 100, y: 100 } };
  const near = makeShard('large', { x: 110, y: 100 }, 0, RULES.shards); // within radius
  const far = makeShard('large', { x: 400, y: 400 }, 0, RULES.shards);
  assert.equal(shipShardCollision(ship, RULES.ship.radius, [far, near], W, H), 1);
  assert.equal(shipShardCollision(ship, RULES.ship.radius, [far], W, H), -1);
});

// --- saucer --------------------------------------------------------------------------- //

test('saucerAimHeading points toward the ship (no jitter)', () => {
  const heading = saucerAimHeading({ x: 100, y: 100 }, { x: 200, y: 100 }, 0, W, H, () => 0.5);
  assert.ok(Math.abs(heading) < 1e-6); // straight +x
});

test('saucerAimHeading aims across the seam (shortest path)', () => {
  // saucer near right edge, ship near left edge -> should aim +x (across seam), not -x.
  const heading = saucerAimHeading({ x: W - 10, y: 100 }, { x: 10, y: 100 }, 0, W, H, () => 0.5);
  assert.ok(Math.abs(heading) < 1e-6);
});

test('saucerFire returns a 3-bolt spread aimed at the ship', () => {
  const shots = saucerFire({ x: 100, y: 100 }, { x: 200, y: 100 }, RULES.saucer, 0, W, H, () => 0.5);
  assert.equal(shots.length, 3);
  assert.ok(shots.every((s) => s.hostile === true));
  // middle bolt roughly on-aim (+x dominant)
  assert.ok(shots[1].vel.x > 0);
});

// --- waves ---------------------------------------------------------------------------- //

test('largeShardsForWave adds one per wave', () => {
  assert.equal(largeShardsForWave(1, RULES), RULES.startLargeShards);
  assert.equal(largeShardsForWave(2, RULES), RULES.startLargeShards + 1);
  assert.equal(largeShardsForWave(5, RULES), RULES.startLargeShards + 4);
});

test('spawnWave produces the right count of large shards, none on the ship', () => {
  _resetShardSeq();
  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const shards = spawnWave(3, RULES, W, H, rng);
  assert.equal(shards.length, largeShardsForWave(3, RULES));
  assert.ok(shards.every((s) => s.size === 'large'));
  const cx = W / 2;
  const cy = H / 2;
  for (const s of shards) {
    assert.ok(Math.hypot(s.pos.x - cx, s.pos.y - cy) >= 100); // outside the safe ring (approx)
  }
});

test('shardScore returns the tier score', () => {
  assert.equal(shardScore('large', RULES.shards), 20);
  assert.equal(shardScore('medium', RULES.shards), 50);
  assert.equal(shardScore('small', RULES.shards), 100);
});
