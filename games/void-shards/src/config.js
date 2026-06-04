// Central game + build configuration for Void Shards.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — score-voucher settlement rails active, crypto UI strings allowed.
//   - false : "clean"  build  — settlement path is dead-code-eliminated, NO crypto strings in UI.
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// letting the bundler drop the voucher/attester path entirely from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Stable game identifier, bound into the score voucher / attester payload.
export const GAME_ID = 'void-shards';

// Play field (a continuous, wrap-around 2D space — no grid).
export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 540;

// Gameplay tuning. All distances are pixels, all rates per-second (we integrate by dt).
export const RULES = {
  lives: 3,
  respawnInvulnMs: 2200, // brief invulnerability window after a respawn

  // Ship physics (Newtonian: thrust adds velocity, drag bleeds it, nothing stops you but space).
  ship: {
    radius: 12,
    turnRate: 4.2, // radians/sec while rotating
    thrust: 260, // px/sec^2 forward acceleration under thrust
    drag: 0.6, // velocity retained fraction per second (0..1); space-friction so you don't drift forever
    maxSpeed: 360, // px/sec speed cap
  },

  // Bolts the ship fires.
  bolt: {
    speed: 480, // px/sec
    radius: 3,
    lifeMs: 900, // despawn after this (caps range so it isn't infinite)
    cooldownMs: 220, // min time between shots
    max: 5, // max simultaneous player bolts on screen
  },

  // Shard sizes: large -> 2 medium -> 2 small -> gone. Each tier scores differently.
  shards: {
    large: { radius: 42, speed: 60, score: 20, splitsInto: 'medium', splitCount: 2 },
    medium: { radius: 24, speed: 95, score: 50, splitsInto: 'small', splitCount: 2 },
    small: { radius: 13, speed: 135, score: 100, splitsInto: null, splitCount: 0 },
  },

  // Waves.
  startLargeShards: 4,
  shardsPerWaveIncrement: 1, // +1 large shard each new wave

  // Saucer (occasional hostile that aims at the ship and fires a small spread).
  saucer: {
    radius: 16,
    speed: 90,
    score: 200,
    fireIntervalMs: 1500,
    boltSpeed: 240,
    spread: 0.22, // radians of aim jitter (so it's beatable, not a sniper)
    spawnIntervalMs: 18000, // roughly every N ms a saucer may appear
    boltLifeMs: 2600,
  },

  pointsSafetyMargin: 0, // reserved
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/void-shards/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
