// Central game + build configuration for Temple Volley.
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
export const GAME_ID = 'temple-volley';

// Rendering.
export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 480;

// Field / paddle / ball geometry, in pixels.
export const FIELD = {
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  margin: 28, // gap between a paddle's outer face and the wall it defends
  paddleW: 14,
  paddleH: 84,
  paddleSpeed: 460, // px/sec a HUMAN paddle travels (keyboard hold)
  ballSize: 14,
};

// Gameplay tuning. All physics constants the pure logic reads live here.
export const RULES = {
  winScore: 11, // first to 11 wins
  serveSpeed: 320, // px/sec the ball leaves a serve at
  speedGain: 1.045, // ball speed multiplier applied on every paddle hit (rally ramp)
  maxSpeed: 980, // hard ceiling on ball speed so it stays trackable
  // "English": how strongly the contact point on the paddle bends the bounce angle.
  // 1.0 => a hit at the paddle edge adds a full unit of vertical velocity (relative to speed).
  english: 0.9,
  maxBounceAngle: 1.05, // radians (~60°) — clamp so the ball never goes near-vertical forever
};

// AI tuning — the whole point is a BEATABLE opponent.
//   trackSpeed  : px/sec cap on the AI paddle — DELIBERATELY below the ball's late-rally
//                 speed and at/under human paddleSpeed, so a sharp angle can outrun it.
//   reactionGap : vertical deadzone (px). If the ball's predicted Y is within this band of
//                 the paddle center, the AI does NOT move — creates human-like hesitation and
//                 lets near-center shots through occasionally.
//   errorBias   : px of aim error the AI tolerates (it aims for center +/- a slack band),
//                 so it does not pixel-perfect-track and can be beaten with placement.
export const AI = {
  trackSpeed: 360, // < FIELD.paddleSpeed (460) and < maxSpeed — capped on purpose
  reactionGap: 22, // deadzone half-height
  errorBias: 16, // aim slack
};

// Settlement endpoint (crypto build only). The off-chain attester signs the EIP-712
// voucher server-side; the GAME NEVER HOLDS KEYS. Leave null to use the bundled fixture
// response. Injected at runtime by the (private) wallet/attester workspace.
export const SETTLEMENT = {
  attesterUrl: null, // e.g. 'https://attester.example/temple-volley/voucher' — null => fixture.
  player: null, // player wallet address (0x…) the voucher pays out to.
};
