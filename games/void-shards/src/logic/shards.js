// Pure, side-effect-free Void Shards logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// Coordinate space is a continuous wrap-around torus of size (W, H). Positions are floats.
// Velocities are px/sec; the caller integrates with a dt in SECONDS.

// --- vector / wrap helpers ------------------------------------------------------------ //

// Wrap a scalar into [0, size) (toroidal play field — leave one edge, re-enter the other).
export function wrapScalar(v, size) {
  return ((v % size) + size) % size;
}

// Wrap a position object onto the torus. PURE: returns a new {x,y}.
export function wrapPos(pos, w, h) {
  return { x: wrapScalar(pos.x, w), y: wrapScalar(pos.y, h) };
}

// Integrate a position by a velocity over dt seconds, then wrap. PURE.
export function integratePos(pos, vel, dt, w, h) {
  return wrapPos({ x: pos.x + vel.x * dt, y: pos.y + vel.y * dt }, w, h);
}

// Shortest toroidal delta from a -> b on one axis (so wrap-around collisions work: an object
// at the right edge is "close" to one at the left edge).
export function wrapDelta(a, b, size) {
  let d = b - a;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

// Toroidal distance between two points.
export function wrapDistance(a, b, w, h) {
  const dx = wrapDelta(a.x, b.x, w);
  const dy = wrapDelta(a.y, b.y, h);
  return Math.hypot(dx, dy);
}

// Circle/circle overlap on the torus. Used for every collision in the game.
export function circlesOverlap(a, ra, b, rb, w, h) {
  return wrapDistance(a, b, w, h) <= ra + rb;
}

// --- ship physics --------------------------------------------------------------------- //

// Apply one physics step to a ship. PURE: returns a NEW ship state.
//   ship = { pos:{x,y}, vel:{x,y}, angle }   (angle in radians, 0 = +x / pointing right)
//   input = { rotateLeft, rotateRight, thrust }   (booleans)
//   cfg = RULES.ship, dt = seconds, w/h = field size
export function stepShip(ship, input, cfg, dt, w, h) {
  let angle = ship.angle;
  if (input.rotateLeft) angle -= cfg.turnRate * dt;
  if (input.rotateRight) angle += cfg.turnRate * dt;

  let vx = ship.vel.x;
  let vy = ship.vel.y;
  if (input.thrust) {
    vx += Math.cos(angle) * cfg.thrust * dt;
    vy += Math.sin(angle) * cfg.thrust * dt;
  }

  // Space drag: bleed a fraction of velocity per second so the ship is controllable.
  // drag is the fraction RETAINED per second; raise to dt for frame-rate independence.
  const keep = Math.pow(cfg.drag, dt);
  vx *= keep;
  vy *= keep;

  // Clamp to max speed.
  const speed = Math.hypot(vx, vy);
  if (speed > cfg.maxSpeed) {
    const s = cfg.maxSpeed / speed;
    vx *= s;
    vy *= s;
  }

  const pos = integratePos(ship.pos, { x: vx, y: vy }, dt, w, h);
  return { pos, vel: { x: vx, y: vy }, angle };
}

// Spawn a bolt from the ship nose, traveling along the ship's facing.
export function spawnBolt(ship, cfg, now) {
  return {
    pos: {
      x: ship.pos.x + Math.cos(ship.angle) * (cfg.radius ?? 0),
      y: ship.pos.y + Math.sin(ship.angle) * (cfg.radius ?? 0),
    },
    vel: { x: Math.cos(ship.angle) * cfg.speed, y: Math.sin(ship.angle) * cfg.speed },
    born: now,
    radius: cfg.radius,
  };
}

// Advance a list of bolts, dropping any that have outlived `lifeMs`. PURE: returns a new array.
export function stepBolts(bolts, cfg, dt, now, w, h) {
  const out = [];
  for (const b of bolts) {
    if (now - b.born >= cfg.lifeMs) continue;
    out.push({ ...b, pos: integratePos(b.pos, b.vel, dt, w, h) });
  }
  return out;
}

// --- shards --------------------------------------------------------------------------- //

let _shardSeq = 0;
// Test-only: reset the id sequence so ids are deterministic across test cases.
export function _resetShardSeq() {
  _shardSeq = 0;
}

// Build one shard of a given size tier at a position with a velocity heading.
export function makeShard(size, pos, heading, rulesShards) {
  const tier = rulesShards[size];
  return {
    id: ++_shardSeq,
    size,
    radius: tier.radius,
    pos: { x: pos.x, y: pos.y },
    vel: { x: Math.cos(heading) * tier.speed, y: Math.sin(heading) * tier.speed },
  };
}

// Advance shards (drift + wrap). PURE: returns a new array.
export function stepShards(shards, dt, w, h) {
  return shards.map((s) => ({ ...s, pos: integratePos(s.pos, s.vel, dt, w, h) }));
}

// Split a shard that was hit into its child tier. Returns an array of children (possibly
// empty for a small shard). Children inherit the parent position and fan out by `spreadRng`
// (a function returning [0,1)) so the split looks like a real fracture, not a clone.
export function splitShard(shard, rulesShards, spreadRng = Math.random) {
  const tier = rulesShards[shard.size];
  if (!tier.splitsInto || tier.splitCount <= 0) return [];
  const childSize = tier.splitsInto;
  const children = [];
  // Base heading is the parent's travel direction; children fan symmetrically around it.
  const baseHeading = Math.atan2(shard.vel.y, shard.vel.x);
  for (let i = 0; i < tier.splitCount; i++) {
    // Spread children out: alternate sides, plus a little jitter.
    const side = i % 2 === 0 ? 1 : -1;
    const fan = (0.5 + spreadRng() * 0.6) * side; // ~0.5..1.1 rad each side
    const heading = baseHeading + fan;
    children.push(makeShard(childSize, shard.pos, heading, rulesShards));
  }
  return children;
}

// Resolve all bolt/shard collisions for one frame. PURE — returns a result object; does not
// mutate inputs. A bolt is consumed by the FIRST shard it overlaps; that shard splits.
//   returns { shards, bolts, destroyed:[{size, pos}], scored }
export function resolveBoltShardHits(bolts, shards, rulesShards, w, h, spreadRng = Math.random) {
  const liveBolts = [];
  let working = shards.slice();
  const destroyed = [];
  let scored = 0;

  for (const bolt of bolts) {
    let hitIndex = -1;
    for (let i = 0; i < working.length; i++) {
      if (circlesOverlap(bolt.pos, bolt.radius, working[i].pos, working[i].radius, w, h)) {
        hitIndex = i;
        break;
      }
    }
    if (hitIndex === -1) {
      liveBolts.push(bolt);
      continue;
    }
    const shard = working[hitIndex];
    scored += rulesShards[shard.size].score;
    destroyed.push({ size: shard.size, pos: { x: shard.pos.x, y: shard.pos.y } });
    const children = splitShard(shard, rulesShards, spreadRng);
    // Replace the hit shard with its children.
    working = working.slice(0, hitIndex).concat(children, working.slice(hitIndex + 1));
    // Bolt is consumed (not pushed to liveBolts).
  }

  return { shards: working, bolts: liveBolts, destroyed, scored };
}

// Does the ship collide with ANY shard (or any single hostile circle)? Returns the index of
// the first colliding shard, or -1. Used for the life-loss check.
export function shipShardCollision(ship, shipRadius, shards, w, h) {
  for (let i = 0; i < shards.length; i++) {
    if (circlesOverlap(ship.pos, shipRadius, shards[i].pos, shards[i].radius, w, h)) return i;
  }
  return -1;
}

// --- saucer --------------------------------------------------------------------------- //

// Heading from the saucer toward the ship (toroidal), plus a spread jitter so it isn't a
// perfect sniper. `jitterRng` returns [0,1); spread is the max +/- radian deviation.
export function saucerAimHeading(saucerPos, shipPos, spread, w, h, jitterRng = Math.random) {
  const dx = wrapDelta(saucerPos.x, shipPos.x, w);
  const dy = wrapDelta(saucerPos.y, shipPos.y, h);
  const base = Math.atan2(dy, dx);
  return base + (jitterRng() * 2 - 1) * spread;
}

// A saucer fires a small spread of bolts toward the ship: one on-aim, two flanking.
export function saucerFire(saucerPos, shipPos, cfg, now, w, h, jitterRng = Math.random) {
  const aim = saucerAimHeading(saucerPos, shipPos, cfg.spread, w, h, jitterRng);
  const offsets = [-0.18, 0, 0.18];
  return offsets.map((off) => ({
    pos: { x: saucerPos.x, y: saucerPos.y },
    vel: { x: Math.cos(aim + off) * cfg.boltSpeed, y: Math.sin(aim + off) * cfg.boltSpeed },
    born: now,
    radius: 3,
    hostile: true,
  }));
}

// --- wave setup ----------------------------------------------------------------------- //

// Number of large shards for a wave (1-indexed). Wave 1 = startLarge; +increment each wave.
export function largeShardsForWave(wave, rules) {
  return rules.startLargeShards + (wave - 1) * rules.shardsPerWaveIncrement;
}

// Build a wave's worth of large shards, spawned around the edges (never on top of the ship
// at field center). `rng` returns [0,1). PURE-ish: uses the provided rng, no globals beyond
// the shard id sequence.
export function spawnWave(wave, rules, w, h, rng = Math.random) {
  const count = largeShardsForWave(wave, rules);
  const shards = [];
  const cx = w / 2;
  const cy = h / 2;
  const safe = 110; // keep-away radius from the ship's spawn at center
  for (let i = 0; i < count; i++) {
    let pos;
    let guard = 0;
    do {
      pos = { x: rng() * w, y: rng() * h };
      guard++;
    } while (Math.hypot(pos.x - cx, pos.y - cy) < safe && guard < 50);
    const heading = rng() * Math.PI * 2;
    shards.push(makeShard('large', pos, heading, rules.shards));
  }
  return shards;
}

// Score helper: points for destroying a shard of `size`.
export function shardScore(size, rulesShards) {
  return rulesShards[size].score;
}
