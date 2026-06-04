// Central game + build configuration for Mergestone.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — score-voucher settlement rails active, crypto UI strings allowed.
//   - false : "clean"  build  — settlement path is dead-code-eliminated, NO crypto strings in UI.
//             (Skins stay — palette/glyphs are game design, not a crypto concept.)
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// letting the bundler drop the voucher/attester path entirely from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Stable game identifier, bound into the score voucher / attester payload.
export const GAME_ID = 'mergestone';

// Board / rendering.
export const BOARD = {
  size: 4, // 4×4 grid
  tile: 110, // px per cell
  gap: 12, // px gutter between cells
  pad: 16, // px outer padding inside the board frame
};

export const BOARD_PX = BOARD.pad * 2 + BOARD.size * BOARD.tile + (BOARD.size - 1) * BOARD.gap;
export const GAME_WIDTH = BOARD_PX;
export const GAME_HEIGHT = BOARD_PX + 96; // room for the HUD strip on top

// Gameplay tuning.
export const RULES = {
  spawnTier2Chance: 0.1, // 10% of spawns are tier 2 (value 4), the rest tier 1 (value 2)
  slideMs: 110, // tween duration for a slide
  popMs: 130, // tween duration for a merge pop / spawn pop
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/mergestone/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
