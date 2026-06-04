import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng,
  clamp,
  gapCenterFor,
  gapSequence,
  flap,
  gravityStep,
  outOfVertical,
  hitsPillar,
  passedPillar,
  scrollSpeed,
  scrollPillars,
  stepWorld,
  initialState,
} from '../src/logic/flight.js';
import { RULES, GAME_HEIGHT } from '../src/config.js';
import { buildAttestRequest, VOUCHER_TYPE, VOUCHER_FIELDS } from '../src/data/scoreVoucher.js';

const PLAY_H = RULES.groundY;
const BIRD_X = RULES.birdX;

// --- seeded PRNG ----------------------------------------------------------------------- //

test('makeRng is deterministic for a given seed', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

test('makeRng yields values in [0,1) and differs across seeds', () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
  const x = makeRng(1)();
  const y = makeRng(2)();
  assert.notEqual(x, y);
});

test('clamp clamps', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

// --- gap sequence ---------------------------------------------------------------------- //

test('gapCenterFor stays within the legal gap band', () => {
  const lo = RULES.gapMinFrac * PLAY_H;
  const hi = RULES.gapMaxFrac * PLAY_H;
  for (const draw of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const c = gapCenterFor(draw, RULES, PLAY_H);
    assert.ok(c >= lo - 1e-9 && c <= hi + 1e-9, `draw ${draw} -> ${c} in [${lo},${hi}]`);
  }
});

test('gapSequence is reproducible for a seed and varies the centers', () => {
  const a = gapSequence(999, 20, RULES, PLAY_H);
  const b = gapSequence(999, 20, RULES, PLAY_H);
  assert.deepEqual(a, b); // same seed => identical run
  assert.equal(a.length, 20);
  // not all identical (the RNG actually moves the gap around)
  const unique = new Set(a.map((v) => v.toFixed(3)));
  assert.ok(unique.size > 5, 'gap centers should vary');
  // a different seed gives a different sequence
  const c = gapSequence(1000, 20, RULES, PLAY_H);
  assert.notDeepEqual(a, c);
});

// --- bird physics ---------------------------------------------------------------------- //

test('flap sets the upward impulse (replaces velocity, does not stack)', () => {
  assert.equal(flap(0, RULES), RULES.flapImpulse);
  assert.equal(flap(500, RULES), RULES.flapImpulse); // falling fast -> still the same impulse
  assert.equal(flap(-200, RULES), RULES.flapImpulse);
  assert.ok(RULES.flapImpulse < 0, 'impulse is upward (negative y)');
});

test('gravityStep accelerates downward and integrates position', () => {
  const r = gravityStep(100, 0, 0.1, RULES);
  assert.ok(r.vy > 0, 'gains downward velocity');
  assert.ok(Math.abs(r.vy - RULES.gravity * 0.1) < 1e-6);
  assert.ok(r.y > 100, 'moves down');
});

test('gravityStep clamps to terminal fall speed', () => {
  let y = 100;
  let vy = RULES.maxFallSpeed - 10;
  for (let i = 0; i < 20; i++) {
    const r = gravityStep(y, vy, 0.1, RULES);
    y = r.y;
    vy = r.vy;
    assert.ok(vy <= RULES.maxFallSpeed + 1e-9);
  }
  assert.equal(vy, RULES.maxFallSpeed);
});

test('a flap then gravity nets an upward move over a short step', () => {
  const vy = flap(300, RULES);
  const r = gravityStep(300, vy, 1 / 60, RULES);
  assert.ok(r.y < 300, 'the bird rose this frame');
});

// --- vertical bounds ------------------------------------------------------------------- //

test('outOfVertical detects ceiling and ground contact', () => {
  assert.equal(outOfVertical(RULES.birdR - 1, RULES), true); // into ceiling
  assert.equal(outOfVertical(RULES.groundY - RULES.birdR + 1, RULES), true); // into ground
  assert.equal(outOfVertical(GAME_HEIGHT / 2, RULES), false); // mid-air safe
});

// --- pillar collision + scoring -------------------------------------------------------- //

const mkPair = (x, gapCenter) => ({ x, gapCenter, passed: false });

test('hitsPillar: safe inside the gap, fatal outside it', () => {
  const pair = mkPair(BIRD_X - RULES.pillarW / 2, PLAY_H / 2); // overlapping the bird x
  // dead-center of the gap => safe
  assert.equal(hitsPillar(BIRD_X, PLAY_H / 2, RULES.birdR, pair, RULES), false);
  // way above the gap => hits the top pillar
  assert.equal(hitsPillar(BIRD_X, pair.gapCenter - RULES.gapHeight, RULES.birdR, pair, RULES), true);
  // way below => hits the bottom pillar
  assert.equal(hitsPillar(BIRD_X, pair.gapCenter + RULES.gapHeight, RULES.birdR, pair, RULES), true);
});

test('hitsPillar respects the bird radius at the gap edges', () => {
  const pair = mkPair(BIRD_X - RULES.pillarW / 2, PLAY_H / 2);
  const gapTop = pair.gapCenter - RULES.gapHeight / 2;
  // bird center exactly birdR below gapTop => its top edge just touches gapTop => safe
  assert.equal(hitsPillar(BIRD_X, gapTop + RULES.birdR, RULES.birdR, pair, RULES), false);
  // bird center just above that => its top edge crosses into the pillar => fatal
  assert.equal(hitsPillar(BIRD_X, gapTop + RULES.birdR - 2, RULES.birdR, pair, RULES), true);
});

test('hitsPillar ignores a pair the bird does not horizontally overlap', () => {
  const far = mkPair(BIRD_X + 400, PLAY_H / 2);
  assert.equal(hitsPillar(BIRD_X, 0, RULES.birdR, far, RULES), false); // even way off-gap, no x overlap
});

test('passedPillar flips once the pair clears the bird x', () => {
  assert.equal(passedPillar(BIRD_X, mkPair(BIRD_X + 10, 0), RULES), false);
  assert.equal(passedPillar(BIRD_X, mkPair(BIRD_X - RULES.pillarW - 1, 0), RULES), true);
});

// --- scroll speed ramp ----------------------------------------------------------------- //

test('scrollSpeed ramps gently and clamps to the max', () => {
  assert.equal(scrollSpeed(0, RULES), RULES.baseScrollSpeed);
  assert.ok(scrollSpeed(10, RULES) > scrollSpeed(0, RULES));
  assert.equal(scrollSpeed(0, RULES) + 10 * RULES.speedRampPerPoint, scrollSpeed(10, RULES));
  assert.equal(scrollSpeed(100000, RULES), RULES.maxScrollSpeed); // clamped
});

test('scrollPillars moves every pair left by speed*dt without mutating', () => {
  const pillars = [mkPair(300, 100), mkPair(540, 200)];
  const snapshot = JSON.stringify(pillars);
  const out = scrollPillars(pillars, 200, 0.5);
  assert.equal(JSON.stringify(pillars), snapshot, 'input not mutated');
  assert.equal(out[0].x, 200);
  assert.equal(out[1].x, 440);
});

// --- whole-world step ------------------------------------------------------------------ //

test('stepWorld scores a point when a pillar is newly cleared (once)', () => {
  let state = {
    y: PLAY_H / 2,
    vy: 0,
    score: 0,
    pillars: [mkPair(BIRD_X - RULES.pillarW + 1, PLAY_H / 2)], // about to clear
    dead: false,
  };
  // big scroll so the pair clears the bird this frame
  state = stepWorld(state, { flapped: false }, 0.2, RULES, BIRD_X);
  assert.equal(state.score, 1, 'awarded one point');
  assert.equal(state.pillars[0].passed, true);
  // next frames don't re-award the same pair
  const after = stepWorld(state, { flapped: false }, 0.2, RULES, BIRD_X);
  assert.equal(after.score, 1);
});

test('stepWorld kills the bird on a pillar collision', () => {
  const state = {
    y: 5, // near the ceiling, well above a centered gap
    vy: 0,
    score: 0,
    pillars: [mkPair(BIRD_X - RULES.pillarW / 2, PLAY_H / 2)],
    dead: false,
  };
  const r = stepWorld(state, { flapped: false }, 1 / 60, RULES, BIRD_X);
  assert.equal(r.dead, true);
});

test('stepWorld kills the bird on ground contact', () => {
  const state = {
    y: RULES.groundY - RULES.birdR - 1,
    vy: RULES.maxFallSpeed,
    score: 0,
    pillars: [],
    dead: false,
  };
  const r = stepWorld(state, { flapped: false }, 0.1, RULES, BIRD_X);
  assert.equal(r.dead, true);
});

test('stepWorld is a no-op once dead (frozen state)', () => {
  const dead = { y: 100, vy: 0, score: 3, pillars: [], dead: true };
  const r = stepWorld(dead, { flapped: true }, 0.1, RULES, BIRD_X);
  assert.equal(r, dead);
});

test('stepWorld: a flap on a falling bird arrests the descent this frame', () => {
  const state = { y: 200, vy: 400, score: 0, pillars: [], dead: false };
  const r = stepWorld(state, { flapped: true }, 1 / 60, RULES, BIRD_X);
  assert.ok(r.vy < 0, 'velocity is now upward after the flap');
  assert.ok(r.y < 200, 'and the bird rose this frame');
});

// --- initial state --------------------------------------------------------------------- //

test('initialState lays out pairs at the right spacing, bird centered, score 0', () => {
  const gaps = gapSequence(42, 4, RULES, PLAY_H);
  const s = initialState(RULES, gaps, 600);
  assert.equal(s.score, 0);
  assert.equal(s.dead, false);
  assert.equal(s.y, RULES.startY);
  assert.equal(s.pillars.length, 4);
  assert.equal(s.pillars[0].x, 600);
  assert.equal(s.pillars[1].x, 600 + RULES.pillarSpacing);
  assert.deepEqual(s.pillars.map((p) => p.gapCenter), gaps);
});

// --- a full survivable-then-fatal mini run --------------------------------------------- //

test('a centered bird flapping to stay level passes pillars whose gap is centered', () => {
  // All gaps centered at PLAY_H/2; bird flaps to hold roughly level => should pass, not die.
  const gaps = new Array(3).fill(PLAY_H / 2);
  let state = initialState(RULES, gaps, BIRD_X + 40);
  for (let i = 0; i < 600 && !state.dead; i++) {
    // flap whenever drifting below center to hold the line
    const flapNow = state.y > PLAY_H / 2;
    state = stepWorld(state, { flapped: flapNow }, 1 / 60, RULES, BIRD_X);
  }
  assert.ok(state.score >= 1, `passed at least one pillar (score=${state.score}, dead=${state.dead})`);
});

// --- voucher payload shape (logic-level) ----------------------------------------------- //

test('VOUCHER_TYPE / fields match the documented faucet shape', () => {
  assert.match(VOUCHER_TYPE, /^Voucher\(address player,uint256 amount,bytes32 scoreRef,uint256 deadline,uint256 nonce\)$/);
  assert.deepEqual(VOUCHER_FIELDS, ['player', 'amount', 'scoreRef', 'deadline', 'nonce']);
});

test('buildAttestRequest carries gameId + seed so the attester can replay the run', () => {
  const req = buildAttestRequest({ player: '0xabc', score: 17, runHash: '0xdead', seed: 12345 });
  assert.equal(req.gameId, 'ibis-flight');
  assert.equal(req.seed, 12345);
  assert.equal(req.score, 17);
});
