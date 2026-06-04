// Pure, side-effect-free flight physics for Ibis Flight. Imported by PlayScene AND
// exercised by node --test. No Phaser imports — fully testable in plain node.
//
// Conventions:
//   - y grows DOWNWARD; the bird's x is fixed (the world scrolls left past it).
//   - A "pillar pair" is { x, gapCenter, passed } — one vertical opening centered at
//     gapCenter, spanning [gapCenter - gapHeight/2, gapCenter + gapHeight/2]; everything
//     above and below is solid pillar. `x` is the pair's left edge; it decreases over time.

// --- seeded PRNG (mulberry32) ---------------------------------------------------------- //
// Deterministic so the gap sequence is reproducible and unit-testable. Same seed => same run.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Map a rng() draw in [0,1) onto a legal gap-center y for the given play height.
export function gapCenterFor(draw, rules, playHeight) {
  const lo = rules.gapMinFrac * playHeight;
  const hi = rules.gapMaxFrac * playHeight;
  return lo + clamp(draw, 0, 0.999999) * (hi - lo);
}

// Build a deterministic sequence of `count` gap centers from a seed. Pure + reproducible:
// the SAME seed always yields the SAME gaps, so a run can be replayed/verified off-chain.
export function gapSequence(seed, count, rules, playHeight) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(gapCenterFor(rng(), rules, playHeight));
  }
  return out;
}

// --- bird physics ---------------------------------------------------------------------- //

// Apply a flap: replace vertical velocity with the upward impulse (an instantaneous set,
// not an additive nudge — classic one-tap feel, so rapid taps don't stack into a rocket).
export function flap(vy, rules) {
  return rules.flapImpulse;
}

// Integrate gravity over `dt` seconds. Returns { y, vy }, clamped to terminal fall speed.
// Pure — does not mutate. Ceiling/ground death is decided separately (see `outOfVertical`).
export function gravityStep(y, vy, dt, rules) {
  let nvy = vy + rules.gravity * dt;
  if (nvy > rules.maxFallSpeed) nvy = rules.maxFallSpeed;
  const ny = y + nvy * dt;
  return { y: ny, vy: nvy };
}

// Has the bird hit the ceiling or the ground? (Circle vs the two horizontal limits.)
export function outOfVertical(y, rules) {
  if (y - rules.birdR <= rules.ceilingY) return true;
  if (y + rules.birdR >= rules.groundY) return true;
  return false;
}

// --- pillar collision ------------------------------------------------------------------ //

// The bird (circle at fixed x, radius r) vs one pillar pair. Returns true on contact.
// Collision only matters while the pair horizontally overlaps the bird; vertically the bird
// must be OUTSIDE the gap span to hit.
export function hitsPillar(birdX, birdY, birdR, pair, rules) {
  const left = pair.x;
  const right = pair.x + rules.pillarW;
  // Horizontal overlap of the bird's circle with the pillar column.
  const xOverlap = birdX + birdR >= left && birdX - birdR <= right;
  if (!xOverlap) return false;
  const gapTop = pair.gapCenter - rules.gapHeight / 2;
  const gapBottom = pair.gapCenter + rules.gapHeight / 2;
  // Inside the gap (with the bird's radius respected) => safe.
  const insideGap = birdY - birdR >= gapTop && birdY + birdR <= gapBottom;
  return !insideGap;
}

// Has the bird fully cleared a pair this frame? True once the pair's right edge passes the
// bird's x (used to award one point per pillar passed). `pair.passed` should gate re-award.
export function passedPillar(birdX, pair, rules) {
  return pair.x + rules.pillarW < birdX;
}

// Current scroll speed for a score, ramping GENTLY and clamped to a max.
export function scrollSpeed(score, rules) {
  return Math.min(rules.maxScrollSpeed, rules.baseScrollSpeed + score * rules.speedRampPerPoint);
}

// Advance every pair left by speed*dt. Returns a NEW array (pure).
export function scrollPillars(pillars, speed, dt) {
  const dx = speed * dt;
  return pillars.map((p) => ({ ...p, x: p.x - dx }));
}

// --- whole-step resolver --------------------------------------------------------------- //
//
// Advance one frame of the world: integrate the bird, scroll pillars, award points for
// newly-cleared pairs, and detect death (ground/ceiling OR pillar). PURE — returns a new
// state. Pillar spawning/recycling (a render concern) is left to the scene; this resolves
// physics + scoring against whatever pairs are currently present.
//
// state = { y, vy, score, pillars:[{x,gapCenter,passed}], dead }
// input = { flapped:boolean }
export function stepWorld(state, input, dt, rules, birdX) {
  if (state.dead) return state;

  // Bird: a flap overrides velocity this frame, then gravity integrates.
  let vy = input.flapped ? flap(state.vy, rules) : state.vy;
  const g = gravityStep(state.y, vy, dt, rules);
  const y = g.y;
  vy = g.vy;

  // Scroll the world.
  const speed = scrollSpeed(state.score, rules);
  let pillars = scrollPillars(state.pillars, speed, dt);

  // Score: one point per pair newly cleared this frame.
  let score = state.score;
  pillars = pillars.map((p) => {
    if (!p.passed && passedPillar(birdX, p, rules)) {
      score += 1;
      return { ...p, passed: true };
    }
    return p;
  });

  // Death: ground/ceiling, then any overlapping pillar.
  let dead = outOfVertical(y, rules);
  if (!dead) {
    for (const p of pillars) {
      if (hitsPillar(birdX, y, rules.birdR, p, rules)) {
        dead = true;
        break;
      }
    }
  }

  return { y, vy, score, pillars, dead };
}

// Build the initial bird/world state. `gaps` is a precomputed gapSequence; the first pairs
// are laid out off the right edge at `pillarSpacing` intervals starting at `firstX`.
export function initialState(rules, gaps, firstX) {
  const pillars = gaps.map((gapCenter, i) => ({
    x: firstX + i * rules.pillarSpacing,
    gapCenter,
    passed: false,
  }));
  return {
    y: rules.startY,
    vy: 0,
    score: 0,
    pillars,
    dead: false,
  };
}
