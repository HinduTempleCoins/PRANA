// Central game + build configuration for River Crossing.
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
export const GAME_ID = 'river-crossing';

// Grid / rendering.
export const GRID = {
  cols: 13,
  rows: 13,
  tile: 44, // px per cell
};

export const GAME_WIDTH = GRID.cols * GRID.tile; // 572
export const GAME_HEIGHT = GRID.rows * GRID.tile; // 572

// Gameplay tuning.
export const RULES = {
  lives: 3, // runs end when all lives are spent
  runSeconds: 60, // per-run timer (seconds); reaching 0 ends the run
  alcoveCount: 5, // far-bank slots, each fillable once
  pointsPerRow: 10, // score per net-new row advanced toward the goal
  alcoveBase: 50, // base bonus for filling an alcove
  alcoveBonus: 25, // extra per alcove already filled this sweep (combo feel)
  tierClearBonus: 250, // bonus for filling all alcoves (advances difficulty tier)
  seed: 0xc0ffee, // base seed for deterministic lane layout (re-derived per tier)
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/river-crossing/voucher' — null => fixture.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
