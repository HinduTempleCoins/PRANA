// Pure, side-effect-free Ziggurat Jump logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// World model:
//   - The player (a hopper) auto-bounces: every time it lands ON TOP of a platform while
//     falling, its vertical velocity flips to a fixed upward bounce. There is no jump button.
//   - Horizontal steering is player-controlled (tilt / arrow) and WRAPS around the screen
//     edges (exit right -> enter left).
//   - Platforms are laddered procedurally going UP (decreasing y). Some MOVE side to side,
//     some CRUMBLE once (they vanish right after the first bounce off them).
//   - The camera follows the player's MAX height; score = height climbed. Falling below the
//     bottom of the camera view = game over.
//
// COORDINATES: y increases DOWNWARD (screen space). "Up"/"higher" means SMALLER y. Height
// (the score) is measured as how far the player has risen above the start, i.e. a positive
// number that grows as y decreases.

// --- seeded PRNG (mulberry32) --------------------------------------------------------- //
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default tuning. The PlayScene passes its own merged config; tests use these.
export const DEFAULTS = {
  width: 420, // world/screen width (for wrap)
  height: 680, // camera viewport height
  gravity: 0.45, // px/frame^2 added to vy each step
  bounceVy: -13.2, // upward velocity applied on a landing bounce
  playerW: 34, // hopper width (for horizontal overlap test)
  playerH: 34,
  platformW: 70,
  platformH: 16,
  gapMin: 70, // vertical gap between successive platforms
  gapMax: 120,
  movingChance: 0.22, // fraction of generated platforms that move horizontally
  crumbleChance: 0.16, // fraction that crumble after one bounce
  moveSpeed: 1.6, // px/frame for moving platforms
  // Milestone speed-up: every `speedEvery` units of height, gravity & bounce scale up a bit
  // so the climb gets faster/tenser. Scale is clamped.
  speedEvery: 1200,
  speedStep: 0.06,
  speedMax: 1.6,
};

export const PLATFORM = { NORMAL: 'normal', MOVING: 'moving', CRUMBLE: 'crumble' };

// Difficulty scale from height: 1.0 at the start, rising in steps, clamped.
export function speedScale(height, cfg = DEFAULTS) {
  const steps = Math.floor(Math.max(0, height) / cfg.speedEvery);
  return Math.min(cfg.speedMax, 1 + steps * cfg.speedStep);
}

// --- platform generation -------------------------------------------------------------- //
// Generate ONE platform above `prevY`, using the seeded rng. Pure (returns a new object).
//   id   : monotonic id assigned by the caller's generator state
//   x,y  : top-left-ish anchor; x is the platform's left edge, y its top
//   type : normal | moving | crumble
//   dir  : +1/-1 horizontal travel direction for moving platforms
//   alive: false once a crumble platform has been consumed
export function genPlatform(prevY, rng, cfg = DEFAULTS, id = 0) {
  const gap = cfg.gapMin + rng() * (cfg.gapMax - cfg.gapMin);
  const y = prevY - gap;
  const x = rng() * (cfg.width - cfg.platformW);
  let type = PLATFORM.NORMAL;
  const roll = rng();
  if (roll < cfg.crumbleChance) type = PLATFORM.CRUMBLE;
  else if (roll < cfg.crumbleChance + cfg.movingChance) type = PLATFORM.MOVING;
  const dir = rng() < 0.5 ? -1 : 1;
  return { id, x, y, w: cfg.platformW, h: cfg.platformH, type, dir, alive: true };
}

// Ensure platforms exist up to `targetTopY` (a y SMALLER than the current highest). Returns
// a NEW array (existing platforms preserved). `state` carries { nextId, topY } so callers
// can keep generating upward as the camera rises.
export function fillPlatformsUpTo(platforms, state, targetTopY, rng, cfg = DEFAULTS) {
  const out = platforms.slice();
  let { nextId, topY } = state;
  while (topY > targetTopY) {
    const p = genPlatform(topY, rng, cfg, nextId);
    out.push(p);
    topY = p.y;
    nextId += 1;
  }
  return { platforms: out, state: { nextId, topY } };
}

// Advance a moving platform one frame, wrapping its travel within [0, width-w].
export function stepPlatform(p, cfg = DEFAULTS, scale = 1) {
  if (p.type !== PLATFORM.MOVING || !p.alive) return p;
  let x = p.x + p.dir * cfg.moveSpeed * scale;
  let dir = p.dir;
  if (x < 0) {
    x = 0;
    dir = 1;
  } else if (x > cfg.width - p.w) {
    x = cfg.width - p.w;
    dir = -1;
  }
  return { ...p, x, dir };
}

// --- player physics ------------------------------------------------------------------- //

// Horizontal wrap: keep x within [0, width) by wrapping the player center.
export function wrapX(x, width) {
  return ((x % width) + width) % width;
}

// Does the falling player (cx center-x, py top-y, vy>0) land on platform p THIS step?
// Landing requires: moving downward, the player's feet cross the platform top between the
// previous and next position, and horizontal overlap. We treat the player by its center x.
export function landsOn(prevFeet, nextFeet, cx, p, cfg = DEFAULTS) {
  if (!p.alive) return false;
  const top = p.y;
  // feet must cross the platform top from above to below this step
  if (!(prevFeet <= top && nextFeet >= top)) return false;
  // horizontal overlap between player box and platform
  const halfW = cfg.playerW / 2;
  const left = cx - halfW;
  const right = cx + halfW;
  return right >= p.x && left <= p.x + p.w;
}

// Step the player one frame given input dx in {-1,0,1} (steering) and the platform list.
// PURE: returns { player, bounced, landedId, platforms } (platforms may change if a crumble
// platform was consumed). Does NOT mutate inputs.
//
// player = { x (center), y (top), vy }
export function stepPlayer(player, platforms, input, cfg = DEFAULTS, scale = 1) {
  const dx = (input.dx || 0) * (cfg.steerSpeed || 5);
  let x = wrapX(player.x + dx, cfg.width);
  let vy = player.vy + cfg.gravity * scale;
  const prevFeet = player.y + cfg.playerH;
  let y = player.y + vy;
  let nextFeet = y + cfg.playerH;

  let bounced = false;
  let landedId = null;
  let outPlatforms = platforms;

  // Only consider landings while moving downward.
  if (vy > 0) {
    for (const p of platforms) {
      if (landsOn(prevFeet, nextFeet, x, p, cfg)) {
        // snap feet to platform top and bounce
        y = p.y - cfg.playerH;
        nextFeet = p.y;
        vy = cfg.bounceVy * scale;
        bounced = true;
        landedId = p.id;
        if (p.type === PLATFORM.CRUMBLE) {
          // consume: mark this platform dead (new array; pure)
          outPlatforms = platforms.map((q) => (q.id === p.id ? { ...q, alive: false } : q));
        }
        break; // one landing per step
      }
    }
  }

  return {
    player: { x, y, vy },
    bounced,
    landedId,
    platforms: outPlatforms,
  };
}

// --- height / score ------------------------------------------------------------------- //

// Height climbed = how far the player has risen above the start y (never negative).
// startY is the player's initial top-y; rising means y decreases, so height = startY - y.
export function heightFor(startY, y) {
  return Math.max(0, Math.round(startY - y));
}

// Camera (viewport) follows the player's MAX height. The camera top-y is the smallest y the
// player has reached minus a lead margin; returns the y-coordinate of the camera's BOTTOM
// edge, below which a fall is fatal.
export function cameraBottom(maxClimbY, cfg = DEFAULTS) {
  // camera top tracks the player's highest point with the player kept ~40% down the screen
  const cameraTop = maxClimbY - cfg.height * 0.4;
  return cameraTop + cfg.height;
}

// Is the player below the camera bottom (fallen out of view) => game over.
export function hasFallen(playerTopY, maxClimbY, cfg = DEFAULTS) {
  return playerTopY > cameraBottom(maxClimbY, cfg);
}

// --- initial state -------------------------------------------------------------------- //

// Build a fresh run: a starting platform under the player + the first ladder of platforms
// above it, all from the seeded rng. Returns { player, platforms, genState, startY }.
export function newRun(rng = Math.random, cfg = DEFAULTS) {
  const startY = cfg.height - 120; // player starts near the bottom
  const player = { x: cfg.width / 2, y: startY, vy: cfg.bounceVy }; // first bounce launches up
  // a guaranteed solid platform directly beneath the player so the run always starts cleanly
  const base = {
    id: 0,
    x: cfg.width / 2 - cfg.platformW / 2,
    y: startY + cfg.playerH,
    w: cfg.platformW,
    h: cfg.platformH,
    type: PLATFORM.NORMAL,
    dir: 1,
    alive: true,
  };
  const filled = fillPlatformsUpTo([base], { nextId: 1, topY: base.y }, -cfg.height, rng, cfg);
  return { player, platforms: filled.platforms, genState: filled.state, startY };
}

// Drop platforms that have fallen well below the camera (memory hygiene). PURE.
export function prunePlatforms(platforms, cullBelowY) {
  return platforms.filter((p) => p.y <= cullBelowY);
}
