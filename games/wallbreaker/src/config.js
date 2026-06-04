// Central game + build configuration for Wallbreaker.
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
export const GAME_ID = 'wallbreaker';

// Field / rendering. The abstract play-field (logic units) matches the canvas 1:1 here.
export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 600;

// Gameplay tuning.
export const RULES = {
  lives: 3,
  ballRadius: 8,
  paddleWidth: 120,
  paddleHeight: 16,
  paddleY: 560, // top edge of the paddle
  powerupChance: 0.12, // probability a broken brick drops a powerup
  powerupFallSpeed: 180, // field-units/s a powerup capsule falls
  widePaddleMs: 12000, // wide-paddle powerup duration
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/wallbreaker/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
