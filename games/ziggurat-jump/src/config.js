// Central game + build configuration for Ziggurat Jump.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — score-voucher settlement rails active, crypto UI strings allowed.
//   - false : "clean"  build  — settlement path is dead-code-eliminated, NO crypto strings in UI.
//             (Skins stay — palette/trails are game design, not a crypto concept.)
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// letting the bundler drop the voucher/attester path entirely from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Stable game identifier, bound into the score voucher / attester payload.
export const GAME_ID = 'ziggurat-jump';

export const GAME_WIDTH = 420;
export const GAME_HEIGHT = 680;

// Gameplay tuning — merged into the pure-logic DEFAULTS in hop.js. (Keep width/height in
// sync with GAME_WIDTH/HEIGHT so wrap + camera math match the canvas.)
export const RULES = {
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  gravity: 0.45,
  bounceVy: -13.2,
  steerSpeed: 5.2, // px/frame horizontal steering
  playerW: 34,
  playerH: 34,
  platformW: 72,
  platformH: 16,
  gapMin: 72,
  gapMax: 118,
  movingChance: 0.22,
  crumbleChance: 0.16,
  moveSpeed: 1.6,
  speedEvery: 1200, // height units between difficulty steps
  speedStep: 0.06,
  speedMax: 1.6,
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/ziggurat-jump/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
