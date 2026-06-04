// Central game + build configuration for Ibis Flight.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — score-voucher settlement rails active, crypto UI strings allowed.
//   - false : "clean"  build  — settlement path is dead-code-eliminated, NO crypto strings in UI.
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js).
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Stable game identifier, bound into the score voucher / attester payload.
export const GAME_ID = 'ibis-flight';

// Rendering.
export const GAME_WIDTH = 480;
export const GAME_HEIGHT = 640;

// Physics + world tuning. All numbers the pure logic reads live here, in pixels / seconds.
export const RULES = {
  // The ibis (player). x is fixed; only y moves.
  birdX: 130,
  birdR: 16, // collision radius (circle)
  startY: GAME_HEIGHT * 0.4,

  gravity: 1500, // px/sec^2 pulling the bird DOWN
  flapImpulse: -480, // px/sec instantaneous upward velocity on a flap
  maxFallSpeed: 760, // terminal velocity (down) so a long drop stays survivable

  // Pillars (approaching pairs the bird threads).
  pillarW: 64,
  gapHeight: 168, // vertical opening between the top & bottom pillar of a pair
  pillarSpacing: 240, // horizontal distance between successive pillar pairs
  baseScrollSpeed: 170, // px/sec the world scrolls left at score 0
  speedRampPerPoint: 4, // px/sec added to scroll speed per pillar passed
  maxScrollSpeed: 320, // cap so it ramps GENTLY and stays playable

  // Where a gap CENTER may sit, as a fraction of the play height. Keeps gaps off the
  // extreme top/bottom so every pair is fairly threadable.
  gapMinFrac: 0.18,
  gapMaxFrac: 0.82,

  groundY: GAME_HEIGHT - 28, // floor; touching it (or the ceiling) is death
  ceilingY: 0,
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/ibis-flight/voucher' — null => fixture.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
