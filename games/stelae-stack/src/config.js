// Central game + build configuration for Stelae Stack.
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
export const GAME_ID = 'stelae-stack';

// Grid / rendering. A 10×20 well plus a 6-cell-wide HUD/preview gutter on the right.
export const GRID = {
  cols: 10,
  rows: 20,
  tile: 26, // px per cell
  gutter: 6, // extra columns to the right for HUD + next-piece preview
};

export const GAME_WIDTH = (GRID.cols + GRID.gutter) * GRID.tile; // 416
export const GAME_HEIGHT = GRID.rows * GRID.tile; // 520

// Gameplay tuning.
export const RULES = {
  linesPerLevel: 10, // gentle gravity ramp: level up every N cleared lines
  baseGravityMs: 800, // fall interval at level 0
  gravityPerLevel: 60, // ms shaved off the fall interval per level
  minGravityMs: 100, // floor on the fall interval
  softDropMs: 40, // fall interval while soft-dropping (down held)
  lockDelayMs: 280, // grace time after landing before the piece locks
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/stelae-stack/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
