// Central game + build configuration.
//
// EE4: CRYPTO_BUILD is the single switch that distinguishes the two shippable builds.
//   - true  : "crypto" build  — wallet/NFT chain loader active, crypto UI strings allowed.
//   - false : "clean"  build  — chain loader is a no-op, NO crypto/NFT/wallet strings in UI.
//             (Rarity stays — it is purely game design, not a crypto concept.)
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// which lets the bundler dead-code-eliminate the chain loader from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// Grid / rendering.
export const GRID = {
  cols: 16,
  rows: 12,
  tile: 48, // px per cell
};

export const GAME_WIDTH = GRID.cols * GRID.tile; // 768
export const GAME_HEIGHT = GRID.rows * GRID.tile; // 576

// Economy / difficulty.
export const STARTING_LIVES = 20;
export const STARTING_GOLD = 200;

// EE3: optional RPC endpoint for the chain loader. Leave null for the fixture path.
// When CRYPTO_BUILD is false this is ignored entirely. The deployed NFT contract address
// and player address are injected by the (private) wallet workspace at runtime; here we
// only keep the loose-coupling seam.
export const CHAIN = {
  rpcUrl: null, // e.g. 'http://127.0.0.1:8545' — null => always use the fixture.
  nftAddress: null, // MutableStatNFT / tower-collection address.
  ownerAddress: null, // player wallet address to load owned towers for.
};
