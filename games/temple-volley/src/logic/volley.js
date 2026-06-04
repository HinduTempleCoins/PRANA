// Pure, side-effect-free Pong physics for Temple Volley. Imported by PlayScene AND
// exercised by node --test. No Phaser imports — fully testable in plain node.
//
// Geometry conventions:
//   - The field is a rectangle [0,width] x [0,height]; y grows DOWNWARD.
//   - LEFT paddle defends x≈margin; RIGHT paddle defends x≈width-margin.
//   - A paddle is described by { x, y, h } where (x,y) is its CENTER and h its height.
//   - The ball is { x, y, vx, vy, size } where (x,y) is its CENTER, v in px/sec.
//   - "side" is 'left' | 'right' — which player a paddle / serve belongs to.

export const SIDES = ['left', 'right'];
export const OTHER = { left: 'right', right: 'left' };

// Clamp helper.
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Speed (magnitude) of a velocity vector.
export function speedOf(vx, vy) {
  return Math.hypot(vx, vy);
}

// Re-scale a velocity to a target speed, preserving direction. If the vector is zero,
// returns it unchanged (degenerate — a serve never starts from zero).
export function setSpeed(vx, vy, target) {
  const s = speedOf(vx, vy);
  if (s === 0) return { vx, vy };
  const k = target / s;
  return { vx: vx * k, vy: vy * k };
}

// Vertical travel limits for a paddle CENTER so the paddle stays fully inside the field.
export function paddleYBounds(paddleH, fieldH) {
  const half = paddleH / 2;
  return { min: half, max: fieldH - half };
}

// Move a paddle center toward `targetY` at up to `speed` px/sec over `dt` seconds,
// clamped to the field. Returns the new center y. Pure (used by both human-hold and AI).
export function movePaddleToward(y, targetY, speed, dt, paddleH, fieldH) {
  const { min, max } = paddleYBounds(paddleH, fieldH);
  const maxStep = speed * dt;
  const delta = targetY - y;
  const step = clamp(delta, -maxStep, maxStep);
  return clamp(y + step, min, max);
}

// Build a fresh serve from `side` toward the opponent. `dirY` in [-1,1] seeds a mild
// vertical lean; `rng` (default Math.random) randomizes it when not supplied.
// The ball launches from field center. Returns a ball object.
export function serve(side, rules, fieldW, fieldH, ballSize, rng = Math.random, dirY = null) {
  const dy = dirY == null ? rng() * 2 - 1 : dirY; // [-1,1]
  const towardRight = side === 'left'; // left side serves the ball rightward
  // Compose an initial direction with a capped launch angle.
  const angle = clamp(dy, -1, 1) * (rules.maxBounceAngle * 0.6);
  const vx = (towardRight ? 1 : -1) * Math.cos(angle);
  const vy = Math.sin(angle);
  const v = setSpeed(vx, vy, rules.serveSpeed);
  return {
    x: fieldW / 2,
    y: fieldH / 2,
    vx: v.vx,
    vy: v.vy,
    size: ballSize,
  };
}

// Advance the ball by `dt` seconds and resolve TOP/BOTTOM wall bounces (elastic).
// Returns a NEW ball; does not mutate. Paddle/scoring resolution is separate (resolveStep).
export function moveBall(ball, dt, fieldH) {
  let { x, y, vx, vy, size } = ball;
  x += vx * dt;
  y += vy * dt;
  const half = size / 2;
  if (y - half < 0) {
    y = half;
    vy = Math.abs(vy);
  } else if (y + half > fieldH) {
    y = fieldH - half;
    vy = -Math.abs(vy);
  }
  return { x, y, vx, vy, size };
}

// Does the ball overlap a paddle's vertical span at its defended x-plane?
// `approaching` guards against re-colliding while leaving the paddle.
export function paddleHit(ball, paddle, side) {
  const half = ball.size / 2;
  const pHalf = paddle.h / 2;
  const yOverlap = ball.y + half >= paddle.y - pHalf && ball.y - half <= paddle.y + pHalf;
  if (!yOverlap) return false;
  if (side === 'left') {
    // ball moving left, crossing the paddle's right face
    return ball.vx < 0 && ball.x - half <= paddle.x + paddle.w / 2 && ball.x >= paddle.x - paddle.w;
  }
  return ball.vx > 0 && ball.x + half >= paddle.x - paddle.w / 2 && ball.x <= paddle.x + paddle.w;
}

// Apply a paddle bounce: reflect horizontally, add ENGLISH from the contact offset, ramp
// the rally speed, and clamp the bounce angle. Returns a NEW ball.
//   contactOffset = (ball.y - paddle.y) / (paddle.h/2)  in roughly [-1,1]
export function bounceOffPaddle(ball, paddle, side, rules) {
  const half = ball.size / 2;
  const pHalf = paddle.h / 2;
  const offset = clamp((ball.y - paddle.y) / pHalf, -1, 1);

  // Horizontal direction flips to point away from this paddle.
  const dirX = side === 'left' ? 1 : -1;

  const speed = clamp(speedOf(ball.vx, ball.vy) * rules.speedGain, 0, rules.maxSpeed);

  // Compose new direction: forward + english-scaled vertical, then clamp the angle.
  let angle = Math.atan2(offset * rules.english, 1); // english tilts the launch
  angle = clamp(angle, -rules.maxBounceAngle, rules.maxBounceAngle);
  const vx = dirX * Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;

  // Nudge the ball just off the paddle face so it can't immediately re-trigger paddleHit.
  let x = ball.x;
  if (side === 'left') x = Math.max(x, paddle.x + paddle.w / 2 + half + 0.5);
  else x = Math.min(x, paddle.x - paddle.w / 2 - half - 0.5);

  return { x, y: ball.y, vx, vy, size: ball.size };
}

// Has the ball passed a goal line? Returns 'left' | 'right' (the side that was SCORED ON)
// or null. Scoring on 'left' means the RIGHT player earns the point.
export function goalScored(ball, fieldW) {
  const half = ball.size / 2;
  if (ball.x + half < 0) return 'left'; // crossed the left wall
  if (ball.x - half > fieldW) return 'right'; // crossed the right wall
  return null;
}

// Whole-step resolver used by the scene AND tests: move the ball, resolve wall + paddle
// bounces, and detect a point. Pure — returns { ball, hit, scoredOn }.
//   paddles = { left: {x,y,w,h}, right: {x,y,w,h} }
export function resolveStep(ball, dt, paddles, rules, fieldW, fieldH) {
  let b = moveBall(ball, dt, fieldH);
  let hit = null;

  if (paddleHit(b, paddles.left, 'left')) {
    b = bounceOffPaddle(b, paddles.left, 'left', rules);
    hit = 'left';
  } else if (paddleHit(b, paddles.right, 'right')) {
    b = bounceOffPaddle(b, paddles.right, 'right', rules);
    hit = 'right';
  }

  const scoredOn = goalScored(b, fieldW);
  return { ball: b, hit, scoredOn };
}

// --- AI -------------------------------------------------------------------------------- //
//
// The AI tracks the ball with a CAPPED speed and a reaction DEADZONE so it is beatable:
//   1. Only react when the ball is heading toward the AI (vx sign matches its side).
//   2. Aim for the ball's current y plus a small slack band (errorBias) — not pixel-perfect.
//   3. If the target is within reactionGap of the paddle center, HOLD (no move) — the
//      deadzone that lets well-placed near-center shots sneak by.
//   4. Move at AI.trackSpeed, which is below the ball's late-rally speed and at/under the
//      human paddle speed — a sharp enough angle simply outruns the paddle.
//
// Returns the AI paddle's new center y for this frame.
export function aiTrackStep(paddle, ball, side, ai, dt, paddleH, fieldH) {
  const incoming = side === 'left' ? ball.vx < 0 : ball.vx > 0;
  if (!incoming) {
    // Ball moving away: drift gently back toward center (not perfectly), so it isn't
    // pre-positioned. This recentering is itself slow and beatable.
    return movePaddleToward(paddle.y, fieldH / 2, ai.trackSpeed * 0.5, dt, paddleH, fieldH);
  }

  // Aim point: the ball's y with a bounded slack so tracking isn't perfect.
  const target = ball.y;
  const delta = target - paddle.y;

  // Deadzone: ignore small corrections (human-like hesitation; lets center-ish shots pass).
  if (Math.abs(delta) <= ai.reactionGap) {
    return paddle.y;
  }

  // Aim for the band edge (target +/- errorBias toward the paddle) rather than dead-center,
  // so the AI under-corrects slightly and can be beaten with placement.
  const aim = target - Math.sign(delta) * Math.min(ai.errorBias, Math.abs(delta));
  return movePaddleToward(paddle.y, aim, ai.trackSpeed, dt, paddleH, fieldH);
}

// --- scoring --------------------------------------------------------------------------- //

// Apply a point: scoring-on `scoredOn` credits the OTHER side. Returns a NEW score object.
export function applyPoint(score, scoredOn) {
  const scorer = OTHER[scoredOn];
  return { ...score, [scorer]: score[scorer] + 1 };
}

// Is the match decided? Returns the winning side or null. (First to winScore; no deuce —
// straight first-to-N, as specified.)
export function matchWinner(score, rules) {
  if (score.left >= rules.winScore && score.left > score.right) return 'left';
  if (score.right >= rules.winScore && score.right > score.left) return 'right';
  return null;
}

// Serve alternation: after a point, the side that was SCORED ON serves next (loser serves),
// keeping rallies fair and giving the trailing player the restart.
export function nextServer(scoredOn) {
  return scoredOn; // the side scored-on serves the next ball
}
