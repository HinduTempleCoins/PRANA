import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDES,
  OTHER,
  clamp,
  speedOf,
  setSpeed,
  paddleYBounds,
  movePaddleToward,
  serve,
  moveBall,
  paddleHit,
  bounceOffPaddle,
  goalScored,
  resolveStep,
  aiTrackStep,
  applyPoint,
  matchWinner,
  nextServer,
} from '../src/logic/volley.js';
import { RULES, AI, FIELD } from '../src/config.js';
import { buildAttestRequest, VOUCHER_TYPE, VOUCHER_FIELDS } from '../src/data/scoreVoucher.js';

const W = FIELD.width;
const H = FIELD.height;

// --- helpers --------------------------------------------------------------------------- //

test('clamp / speedOf / setSpeed basics', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.equal(speedOf(3, 4), 5);
  const s = setSpeed(3, 4, 10);
  assert.ok(Math.abs(speedOf(s.vx, s.vy) - 10) < 1e-9);
  // direction preserved
  assert.ok(Math.abs(s.vx / s.vy - 3 / 4) < 1e-9);
});

test('OTHER / SIDES are consistent', () => {
  assert.deepEqual(SIDES, ['left', 'right']);
  assert.equal(OTHER.left, 'right');
  assert.equal(OTHER.right, 'left');
});

// --- paddle movement ------------------------------------------------------------------- //

test('paddleYBounds keeps the paddle fully inside the field', () => {
  const { min, max } = paddleYBounds(80, 480);
  assert.equal(min, 40);
  assert.equal(max, 440);
});

test('movePaddleToward steps at most speed*dt and clamps to the field', () => {
  // far target, capped step
  const y1 = movePaddleToward(240, 0, 460, 0.1, 84, 480); // maxStep 46
  assert.ok(Math.abs(y1 - (240 - 46)) < 1e-9);
  // overshoot clamps at the top bound (42)
  const y2 = movePaddleToward(50, 0, 460, 1, 84, 480);
  assert.equal(y2, 42); // paddleH/2
  // small delta reaches the target exactly
  const y3 = movePaddleToward(240, 250, 460, 1, 84, 480);
  assert.equal(y3, 250);
});

// --- serve ----------------------------------------------------------------------------- //

test('serve launches from center toward the opponent at serveSpeed', () => {
  const left = serve('left', RULES, W, H, FIELD.ballSize, () => 0.5, 0);
  assert.equal(left.x, W / 2);
  assert.equal(left.y, H / 2);
  assert.ok(left.vx > 0, 'left serves rightward');
  assert.ok(Math.abs(speedOf(left.vx, left.vy) - RULES.serveSpeed) < 1e-6);

  const right = serve('right', RULES, W, H, FIELD.ballSize, () => 0.5, 0);
  assert.ok(right.vx < 0, 'right serves leftward');
});

test('serve vertical lean is bounded and deterministic with a fixed rng/dirY', () => {
  const a = serve('left', RULES, W, H, FIELD.ballSize, undefined, 1); // full up-lean
  const b = serve('left', RULES, W, H, FIELD.ballSize, undefined, 1);
  assert.deepEqual(a, b); // deterministic for a fixed dirY
  // angle never exceeds the launch cap (0.6 * maxBounceAngle)
  const ang = Math.atan2(Math.abs(a.vy), Math.abs(a.vx));
  assert.ok(ang <= RULES.maxBounceAngle * 0.6 + 1e-9);
});

// --- ball movement + walls ------------------------------------------------------------- //

test('moveBall advances by velocity*dt', () => {
  const b = moveBall({ x: 100, y: 100, vx: 200, vy: -100, size: 14 }, 0.5, H);
  assert.ok(Math.abs(b.x - 200) < 1e-9);
  assert.ok(Math.abs(b.y - 50) < 1e-9);
});

test('moveBall reflects off the top wall', () => {
  const b = moveBall({ x: 100, y: 5, vx: 0, vy: -300, size: 14 }, 0.1, H);
  assert.ok(b.vy > 0, 'vy flips downward');
  assert.ok(b.y >= b.size / 2);
});

test('moveBall reflects off the bottom wall', () => {
  const b = moveBall({ x: 100, y: H - 5, vx: 0, vy: 300, size: 14 }, 0.1, H);
  assert.ok(b.vy < 0, 'vy flips upward');
  assert.ok(b.y <= H - b.size / 2);
});

// --- paddle collision + english + ramp ------------------------------------------------- //

const leftPaddle = { x: FIELD.margin, y: 240, w: FIELD.paddleW, h: FIELD.paddleH };
const rightPaddle = { x: W - FIELD.margin, y: 240, w: FIELD.paddleW, h: FIELD.paddleH };

test('paddleHit detects a ball crossing the paddle face while incoming', () => {
  const ball = { x: leftPaddle.x + 6, y: 240, vx: -200, vy: 0, size: 14 };
  assert.equal(paddleHit(ball, leftPaddle, 'left'), true);
  // outgoing ball (vx>0) at the same place is NOT a hit
  assert.equal(paddleHit({ ...ball, vx: 200 }, leftPaddle, 'left'), false);
  // out of vertical range
  assert.equal(paddleHit({ ...ball, y: 10 }, leftPaddle, 'left'), false);
});

test('bounceOffPaddle reverses x, ramps speed, and clamps angle', () => {
  const ball = { x: leftPaddle.x + 4, y: 240, vx: -RULES.serveSpeed, vy: 0, size: 14 };
  const before = speedOf(ball.vx, ball.vy);
  const out = bounceOffPaddle(ball, leftPaddle, 'left', RULES);
  assert.ok(out.vx > 0, 'x direction flips away from the left paddle');
  const after = speedOf(out.vx, out.vy);
  assert.ok(after > before, 'rally speed ramps up');
  assert.ok(Math.abs(after - before * RULES.speedGain) < 1e-6);
  // center hit => near-zero english
  assert.ok(Math.abs(out.vy) < 1, 'center contact has minimal english');
});

test('bounceOffPaddle adds english from an off-center contact', () => {
  const top = { x: leftPaddle.x + 4, y: 240 - FIELD.paddleH / 2, vx: -RULES.serveSpeed, vy: 0, size: 14 };
  const out = bounceOffPaddle(top, leftPaddle, 'left', RULES);
  assert.ok(out.vy < 0, 'a top-edge hit sends the ball upward');
  const bot = { x: leftPaddle.x + 4, y: 240 + FIELD.paddleH / 2, vx: -RULES.serveSpeed, vy: 0, size: 14 };
  const outB = bounceOffPaddle(bot, leftPaddle, 'left', RULES);
  assert.ok(outB.vy > 0, 'a bottom-edge hit sends the ball downward');
});

test('bounceOffPaddle never exceeds maxSpeed', () => {
  let ball = { x: leftPaddle.x + 4, y: 240, vx: -RULES.maxSpeed, vy: 0, size: 14 };
  for (let i = 0; i < 50; i++) {
    const side = ball.vx < 0 ? 'left' : 'right';
    const p = side === 'left' ? leftPaddle : rightPaddle;
    ball = bounceOffPaddle({ ...ball, x: p.x + (side === 'left' ? 4 : -4) }, p, side, RULES);
    assert.ok(speedOf(ball.vx, ball.vy) <= RULES.maxSpeed + 1e-6);
  }
});

test('bounceOffPaddle never produces a near-vertical ball (angle clamp)', () => {
  const top = { x: leftPaddle.x + 4, y: 240 - FIELD.paddleH / 2, vx: -RULES.serveSpeed, vy: 0, size: 14 };
  const out = bounceOffPaddle(top, leftPaddle, 'left', RULES);
  const ang = Math.atan2(Math.abs(out.vy), Math.abs(out.vx));
  assert.ok(ang <= RULES.maxBounceAngle + 1e-9);
});

// --- goal detection -------------------------------------------------------------------- //

test('goalScored reports which side was scored on', () => {
  assert.equal(goalScored({ x: -20, y: 100, size: 14 }, W), 'left');
  assert.equal(goalScored({ x: W + 20, y: 100, size: 14 }, W), 'right');
  assert.equal(goalScored({ x: W / 2, y: 100, size: 14 }, W), null);
});

// --- whole-step resolver --------------------------------------------------------------- //

test('resolveStep bounces off a paddle and reports the hit side', () => {
  const ball = { x: leftPaddle.x + 8, y: 240, vx: -300, vy: 0, size: 14 };
  const r = resolveStep(ball, 0.03, { left: leftPaddle, right: rightPaddle }, RULES, W, H);
  assert.equal(r.hit, 'left');
  assert.ok(r.ball.vx > 0);
  assert.equal(r.scoredOn, null);
});

test('resolveStep reports a goal when the ball leaves the field', () => {
  const ball = { x: 5, y: 240, vx: -400, vy: 0, size: 14 };
  const r = resolveStep(ball, 0.1, { left: { ...leftPaddle, y: 50 }, right: rightPaddle }, RULES, W, H);
  assert.equal(r.scoredOn, 'left'); // missed the (repositioned) left paddle
});

// --- AI: beatable by design ------------------------------------------------------------ //

test('aiTrackStep does not move inside the reaction deadzone', () => {
  const p = { x: rightPaddle.x, y: 240, w: FIELD.paddleW, h: FIELD.paddleH };
  // ball incoming, target within reactionGap of center => HOLD
  const ball = { x: 400, y: 240 + AI.reactionGap - 1, vx: 200, vy: 0, size: 14 };
  const y = aiTrackStep(p, ball, 'right', AI, 0.016, FIELD.paddleH, H);
  assert.equal(y, 240, 'paddle holds within the deadzone');
});

test('aiTrackStep tracks an incoming ball but capped at trackSpeed', () => {
  const p = { x: rightPaddle.x, y: 100, w: FIELD.paddleW, h: FIELD.paddleH };
  const ball = { x: 400, y: 400, vx: 200, vy: 0, size: 14 };
  const dt = 0.1;
  const y = aiTrackStep(p, ball, 'right', AI, dt, FIELD.paddleH, H);
  const moved = y - p.y;
  assert.ok(moved > 0, 'moves toward the ball');
  assert.ok(moved <= AI.trackSpeed * dt + 1e-9, 'never moves faster than trackSpeed');
});

test('AI trackSpeed is capped below the human paddle speed AND ball maxSpeed (beatable)', () => {
  // This is the core "beatable" invariant: a fast, sharply-angled ball outruns the AI paddle.
  assert.ok(AI.trackSpeed < FIELD.paddleSpeed, 'AI is no faster than a human paddle');
  assert.ok(AI.trackSpeed < RULES.maxSpeed, 'late-rally ball can outrun the AI');
  assert.ok(AI.reactionGap > 0, 'AI has a non-zero hesitation deadzone');
});

test('aiTrackStep drifts toward center (slowly) when the ball is leaving', () => {
  const p = { x: rightPaddle.x, y: 60, w: FIELD.paddleW, h: FIELD.paddleH };
  const ball = { x: 400, y: 400, vx: -200, vy: 0, size: 14 }; // moving AWAY from right
  const dt = 0.1;
  const y = aiTrackStep(p, ball, 'right', AI, dt, FIELD.paddleH, H);
  assert.ok(y > p.y, 'drifts back toward center');
  assert.ok(y - p.y <= AI.trackSpeed * 0.5 * dt + 1e-9, 'recentering is slow (half trackSpeed)');
});

test('aiTrackStep never leaves the field', () => {
  let p = { x: rightPaddle.x, y: 240, w: FIELD.paddleW, h: FIELD.paddleH };
  const { min, max } = paddleYBounds(FIELD.paddleH, H);
  for (let i = 0; i < 200; i++) {
    const ball = { x: 400, y: i % 2 ? 0 : H, vx: 200, vy: 0, size: 14 };
    p = { ...p, y: aiTrackStep(p, ball, 'right', AI, 0.05, FIELD.paddleH, H) };
    assert.ok(p.y >= min - 1e-9 && p.y <= max + 1e-9);
  }
});

// --- scoring + match flow -------------------------------------------------------------- //

test('applyPoint credits the side that did NOT get scored on', () => {
  const s = applyPoint({ left: 3, right: 4 }, 'left'); // scored on left => right scores
  assert.deepEqual(s, { left: 3, right: 5 });
});

test('matchWinner needs winScore and a lead (straight first-to-N)', () => {
  assert.equal(matchWinner({ left: 11, right: 5 }, RULES), 'left');
  assert.equal(matchWinner({ left: 5, right: 11 }, RULES), 'right');
  assert.equal(matchWinner({ left: 10, right: 9 }, RULES), null);
  assert.equal(matchWinner({ left: 11, right: 11 }, RULES), null); // tie at the cap: undecided
});

test('nextServer hands the serve to the side that was scored on (loser serves)', () => {
  assert.equal(nextServer('left'), 'left');
  assert.equal(nextServer('right'), 'right');
});

test('full rally ramp: a sustained rally never exceeds maxSpeed and stays trackable', () => {
  let ball = serve('left', RULES, W, H, FIELD.ballSize, () => 0.5, 0.3);
  for (let i = 0; i < 60; i++) {
    const side = ball.vx < 0 ? 'left' : 'right';
    const p = side === 'left' ? leftPaddle : rightPaddle;
    ball = bounceOffPaddle({ ...ball, x: p.x + (side === 'left' ? 4 : -4), y: p.y }, p, side, RULES);
    assert.ok(speedOf(ball.vx, ball.vy) <= RULES.maxSpeed + 1e-6);
  }
  assert.ok(speedOf(ball.vx, ball.vy) >= RULES.serveSpeed, 'speed grew over the rally');
});

// --- voucher payload shape (logic-level) ----------------------------------------------- //

test('VOUCHER_TYPE / fields match the documented faucet shape', () => {
  assert.match(VOUCHER_TYPE, /^Voucher\(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce\)$/);
  assert.deepEqual(VOUCHER_FIELDS, ['player', 'amount', 'scoreRef', 'deadline', 'nonce']);
});

test('buildAttestRequest carries gameId + mode so the attester can gate non-vs-ai runs', () => {
  const req = buildAttestRequest({ player: '0xabc', score: 11, runHash: '0x1234', mode: 'vs-ai' });
  assert.equal(req.gameId, 'temple-volley');
  assert.equal(req.mode, 'vs-ai');
  assert.equal(req.score, 11);
});
