// Central game + build configuration for Spirit Bop.
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
export const GAME_ID = 'spirit-bop';

// Grid / rendering. A 3×3 board of mounds.
export const GRID = {
  cols: 3,
  rows: 3,
  cell: 150, // px per mound cell
  pad: 24, // outer padding
};

export const GAME_WIDTH = GRID.cols * GRID.cell + GRID.pad * 2; // 498
export const GAME_HEIGHT = GRID.rows * GRID.cell + GRID.pad * 2 + 60; // 558 (HUD strip)

// Gameplay tuning.
export const RULES = {
  roundMs: 60000, // 60-second rounds
  baseSpawnMs: 1100, // ms between pops at round start (accelerates)
  minSpawnMs: 360, // floor on spawn interval at the end of the round
  baseWindowMs: 1000, // ms a spirit stays boppable at round start (shrinks)
  minWindowMs: 420, // floor on the hit window at the end of the round
  lanternChance: 0.16, // probability a given spawn is the friendly lantern (don't bop!)
  hitPoints: 10, // base points per clean bop
  comboStep: 2, // extra points per combo step
  comboCap: 10, // combo bonus stops escalating past this many in a streak
  lanternPenalty: 25, // points lost (clamped at 0) for bopping the lantern
  seed: 0x5be17, // base seed for the deterministic spawn schedule
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/spirit-bop/voucher' — null => fixture.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
