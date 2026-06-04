// Central game + build configuration for Naga.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — score-voucher settlement rails active, crypto UI strings allowed.
//   - false : "clean"  build  — settlement path is dead-code-eliminated, NO crypto strings in UI.
//             (Skins stay — palette/cosmetics are game design, not a crypto concept.)
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// letting the bundler drop the voucher/attester path entirely from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Stable game identifier, bound into the score voucher / attester payload.
export const GAME_ID = 'naga';

// Grid / rendering.
export const GRID = {
  cols: 24,
  rows: 18,
  tile: 28, // px per cell
};

export const GAME_WIDTH = GRID.cols * GRID.tile; // 672
export const GAME_HEIGHT = GRID.rows * GRID.tile; // 504

// Gameplay tuning.
export const RULES = {
  // true  => classic-plus wrap-around (snake re-enters the opposite edge).
  // false => solid walls (touching an edge ends the run).
  wrap: true,
  startLength: 4, // initial segment count (including head)
  baseStepMs: 130, // ms per movement step at length === startLength
  minStepMs: 60, // floor on step time as the snake speeds up
  speedRampPerSegment: 2.2, // ms shaved off the step time per segment grown
  pointsPerOrb: 10, // base score per orb (before multiplier)
  multiplierEvery: 5, // +1x multiplier per N segments grown (length milestones)
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/naga/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
