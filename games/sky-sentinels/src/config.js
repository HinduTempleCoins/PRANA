// Central game + build configuration for Sky Sentinels.
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
export const GAME_ID = 'sky-sentinels';

export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 600;

// Gameplay tuning.
export const RULES = {
  lives: 3,

  // Player ship slides along the bottom band.
  player: {
    y: GAME_HEIGHT - 40, // fixed vertical line the player rides
    width: 40,
    height: 18,
    speed: 320, // px/sec horizontal
    margin: 16, // keep-away from the side walls
    cooldownMs: 360, // min time between player shots
    boltSpeed: 460, // px/sec upward
  },

  // The sentinel grid. ORIGINAL designs: geometric sigils (see BootScene), not classic
  // alien bitmaps — a deliberate trade-dress departure from the 1978 arcade fixed-shooter.
  grid: {
    cols: 8,
    rows: 5,
    cellW: 52, // horizontal spacing between sentinel centers
    cellH: 44, // vertical spacing
    marchX: 16, // px the formation jumps sideways per step
    dropY: 22, // px the formation drops when it reverses at a wall
    sentinelRadius: 16, // collision radius per sentinel
    topMargin: 70, // y of the top row at wave start
    sideMargin: 40, // formation keep-away from the walls (triggers reverse+drop)
  },

  // Formation step timing: faster as ranks thin. Interval scales with the fraction of
  // sentinels still alive, between baseStepMs (full grid) and minStepMs (one left).
  step: {
    baseStepMs: 620, // ms between formation steps when the grid is full
    minStepMs: 90, // floor when nearly empty (frantic)
    waveSpeedup: 0.86, // each cleared wave multiplies baseStepMs by this (faster waves)
  },

  // Sentinel bolts (they drop downward toward the player).
  enemyBolt: {
    speed: 220, // px/sec downward
    width: 4,
    height: 14,
    // chance, per formation step, that a random column's lowest sentinel fires
    dropChancePerStep: 0.55,
    maxOnScreen: 4,
  },

  // Destructible cover arcs sitting between the player and the grid.
  cover: {
    count: 3, // number of cover arcs
    cells: 4, // erosion "health" cells per arc (chip away from hits)
    y: GAME_HEIGHT - 110, // vertical line the cover sits on
    width: 72, // visual width of each arc
    radius: 28, // collision radius for bolt hits
  },

  // Score by row tier (top rows worth more — they're farther/harder).
  // rowScore[0] = top row. Any row index beyond the array uses the last value.
  rowScore: [40, 30, 20, 10, 10],

  // Wave-clear / lose conditions.
  // If the formation descends to this y, the sentinels have "landed" -> game over.
  landingY: GAME_HEIGHT - 96,
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/sky-sentinels/voucher' — null => fixture response.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
