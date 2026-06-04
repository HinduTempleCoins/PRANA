// Central game + build configuration for PRANA Ley Rider.
//
// CRYPTO_BUILD is the single switch that distinguishes the two shippable builds:
//   - true  : "crypto" build  — settlement rails (runVoucher) active, may reference the
//             attester endpoint and on-chain run references.
//   - false : "clean"  build  — runVoucher is a no-op and the whole settlement path is
//             dead-code-eliminated; NO crypto/wallet/voucher strings ship in the bundle.
//             (The track-hash logic stays in BOTH builds — it is a pure content hash used
//              for local de-duplication / best-time keys, not inherently a crypto concept.)
//
// At build time Vite replaces `__CRYPTO_BUILD__` with a literal (see vite.config.js),
// enabling dead-code elimination of the settlement path from the clean build.
// `typeof` guard keeps this importable from plain `node --test` where the define is absent.
export const CRYPTO_BUILD =
  typeof __CRYPTO_BUILD__ !== 'undefined' ? __CRYPTO_BUILD__ : false;

// --- rendering -------------------------------------------------------------------------- //
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 600;

// --- physics tuning (see logic/physics.js; all in px and seconds) ----------------------- //
// These are the "feel" knobs. Documented in the README.
export const PHYSICS = {
  gravity: 1400, // px/s^2 downward — gives a snappy, arcade-y fall
  airDamping: 0.0008, // per-frame velocity bleed in air (quadratic-ish drag proxy)
  friction: 0.02, // tangential slowdown while in contact with a normal line (0..1 per step)
  boostFriction: -0.06, // NEGATIVE on boost lines => net tangential acceleration
  boostImpulse: 22, // extra px/s added per step along a boost segment's tangent
  collisionRadius: 9, // rider body radius — also the collision capture distance
  restitution: 0.0, // no bounce: line-rider sleds slide, they don't trampoline
  maxSpeed: 2600, // hard clamp so a long boost chain can't explode the integrator
  fallMargin: 400, // px below the lowest track point => run is "over" (fell off the world)
  spawnDrop: 24, // rider spawns this many px above the start flag, then drops onto the line
};

// --- draw tuning ------------------------------------------------------------------------ //
export const DRAW = {
  minPointDist: 8, // polyline simplification: ignore drag points closer than this (px)
  eraseRadius: 16, // pointer radius for the eraser tool
};

// Stable game id used in settlement vouchers + the future TrackRegistry / leaderboard.
export const GAME_ID = 'ley-rider';

// Settlement endpoint (crypto build only). Null => fixture-stubbed poster (offline-safe).
// The real attester URL + player address are injected by the (private) wallet workspace;
// here we only keep the loose-coupling seam. Ignored entirely in the clean build.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/leyrider' — null => fixture stub
  player: null, // player address the voucher will be bound to
};
