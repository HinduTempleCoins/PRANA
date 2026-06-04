import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUNDS,
  KIND,
  makeRng,
  spawnInterval,
  hitWindow,
  buildSchedule,
  isHit,
  resolveTap,
  comboBonus,
  hitScore,
  applyAction,
  initialState,
  classifyTap,
} from '../src/logic/bop.js';
import { RULES } from '../src/config.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

// --- seeded RNG / determinism --------------------------------------------------------- //

test('makeRng is deterministic for a given seed', () => {
  const a = makeRng(99);
  const b = makeRng(99);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

test('makeRng values stay in [0,1)', () => {
  const r = makeRng(3);
  for (let i = 0; i < 500; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

// --- difficulty ramps ----------------------------------------------------------------- //

test('spawnInterval shrinks over the round and clamps to the floor', () => {
  const start = spawnInterval(0, RULES);
  const mid = spawnInterval(0.5, RULES);
  const end = spawnInterval(1, RULES);
  assert.equal(start, RULES.baseSpawnMs);
  assert.ok(mid < start);
  assert.equal(end, RULES.minSpawnMs);
  // beyond 1 stays clamped, never below floor
  assert.equal(spawnInterval(5, RULES), RULES.minSpawnMs);
  assert.equal(spawnInterval(-2, RULES), RULES.baseSpawnMs);
});

test('hitWindow shrinks over the round and clamps to the floor', () => {
  assert.equal(hitWindow(0, RULES), RULES.baseWindowMs);
  assert.ok(hitWindow(0.5, RULES) < RULES.baseWindowMs);
  assert.equal(hitWindow(1, RULES), RULES.minWindowMs);
  assert.equal(hitWindow(9, RULES), RULES.minWindowMs);
});

// --- scheduler ------------------------------------------------------------------------ //

test('buildSchedule is deterministic for a given seed', () => {
  const a = buildSchedule(1234, RULES);
  const b = buildSchedule(1234, RULES);
  assert.deepEqual(a, b);
  const c = buildSchedule(5678, RULES);
  assert.notDeepEqual(a, c);
});

test('schedule entries are well-formed, in-round, time-ordered, accelerating', () => {
  const sched = buildSchedule(42, RULES);
  assert.ok(sched.length > 0);
  let prevAt = -1;
  for (const s of sched) {
    assert.ok(s.at >= 0 && s.at < RULES.roundMs);
    assert.ok(s.mound >= 0 && s.mound < MOUNDS);
    assert.ok(s.kind === KIND.SPIRIT || s.kind === KIND.LANTERN);
    assert.ok(s.window >= RULES.minWindowMs && s.window <= RULES.baseWindowMs);
    assert.ok(s.at >= prevAt); // non-decreasing
    prevAt = s.at;
  }
  // accelerating: later half packs more spawns into equal time than the earlier half.
  const half = RULES.roundMs / 2;
  const early = sched.filter((s) => s.at < half).length;
  const late = sched.filter((s) => s.at >= half).length;
  assert.ok(late > early);
});

test('schedule never overlaps two live spawns on the same mound', () => {
  const sched = buildSchedule(7, RULES);
  const lastEnd = new Array(MOUNDS).fill(-1);
  for (const s of sched) {
    assert.ok(s.at >= lastEnd[s.mound], `mound ${s.mound} overlap at ${s.at}`);
    lastEnd[s.mound] = s.at + s.window;
  }
});

test('schedule contains some lanterns but they are the minority', () => {
  const sched = buildSchedule(2026, RULES);
  const lanterns = sched.filter((s) => s.kind === KIND.LANTERN).length;
  assert.ok(lanterns > 0);
  assert.ok(lanterns < sched.length / 2);
});

// --- hit-window check ----------------------------------------------------------------- //

test('isHit is true only on the right mound within the window', () => {
  const spawn = { at: 1000, mound: 4, kind: KIND.SPIRIT, window: 500 };
  assert.equal(isHit(spawn, 4, 1000), true); // at open edge
  assert.equal(isHit(spawn, 4, 1499), true); // just inside
  assert.equal(isHit(spawn, 4, 1500), false); // window closed (exclusive)
  assert.equal(isHit(spawn, 4, 999), false); // before it pops
  assert.equal(isHit(spawn, 3, 1100), false); // wrong mound
});

test('resolveTap returns the live spawn on the tapped mound or null', () => {
  const spawns = [
    { at: 0, mound: 1, kind: KIND.SPIRIT, window: 500 },
    { at: 0, mound: 5, kind: KIND.LANTERN, window: 500 },
  ];
  assert.equal(resolveTap(spawns, 1, 100).mound, 1);
  assert.equal(resolveTap(spawns, 5, 100).kind, KIND.LANTERN);
  assert.equal(resolveTap(spawns, 8, 100), null); // nothing up there
  assert.equal(resolveTap(spawns, 1, 600), null); // window closed
});

// --- combo math ----------------------------------------------------------------------- //

test('comboBonus is zero until a streak forms, then escalates and caps', () => {
  assert.equal(comboBonus(0, RULES), 0);
  assert.equal(comboBonus(1, RULES), 0);
  assert.equal(comboBonus(2, RULES), RULES.comboStep);
  assert.equal(comboBonus(3, RULES), 2 * RULES.comboStep);
  // caps at comboCap steps
  const capped = comboBonus(RULES.comboCap + 50, RULES);
  assert.equal(capped, RULES.comboCap * RULES.comboStep);
});

test('hitScore returns the base hit value', () => {
  assert.equal(hitScore(RULES), RULES.hitPoints);
});

// --- scoring state machine ------------------------------------------------------------ //

test('applyAction: a hit adds points + combo bonus and increments combo', () => {
  let s = initialState();
  s = applyAction(s, { type: 'hit' }, RULES); // combo 1 -> no bonus
  assert.equal(s.score, RULES.hitPoints);
  assert.equal(s.combo, 1);
  assert.equal(s.hits, 1);
  s = applyAction(s, { type: 'hit' }, RULES); // combo 2 -> + comboStep
  assert.equal(s.combo, 2);
  assert.equal(s.score, RULES.hitPoints * 2 + RULES.comboStep);
});

test('applyAction: a lantern bop penalizes and resets the combo', () => {
  let s = initialState();
  s = applyAction(s, { type: 'hit' }, RULES);
  s = applyAction(s, { type: 'hit' }, RULES);
  const before = s.score;
  s = applyAction(s, { type: 'lantern' }, RULES);
  assert.equal(s.combo, 0);
  assert.equal(s.lanternHits, 1);
  assert.equal(s.score, Math.max(0, before - RULES.lanternPenalty));
});

test('applyAction: score never goes negative on a lantern penalty', () => {
  let s = initialState();
  s = applyAction(s, { type: 'lantern' }, RULES);
  assert.equal(s.score, 0);
});

test('applyAction: a miss resets the combo and counts a miss', () => {
  let s = initialState();
  s = applyAction(s, { type: 'hit' }, RULES);
  s = applyAction(s, { type: 'hit' }, RULES);
  s = applyAction(s, { type: 'miss' }, RULES);
  assert.equal(s.combo, 0);
  assert.equal(s.misses, 1);
});

test('applyAction is pure: it does not mutate the input state', () => {
  const s = initialState();
  const snap = JSON.stringify(s);
  applyAction(s, { type: 'hit' }, RULES);
  assert.equal(JSON.stringify(s), snap);
});

// --- classifyTap ---------------------------------------------------------------------- //

test('classifyTap distinguishes hit, lantern, and miss', () => {
  const spawns = [
    { at: 0, mound: 2, kind: KIND.SPIRIT, window: 400 },
    { at: 0, mound: 6, kind: KIND.LANTERN, window: 400 },
  ];
  assert.equal(classifyTap(spawns, 2, 100).type, 'hit');
  assert.equal(classifyTap(spawns, 6, 100).type, 'lantern');
  assert.equal(classifyTap(spawns, 0, 100).type, 'miss'); // empty mound
  assert.equal(classifyTap(spawns, 2, 500).type, 'miss'); // window closed
});

test('a clean three-hit streak plus one lantern slip nets the expected score', () => {
  let s = initialState();
  s = applyAction(s, { type: 'hit' }, RULES); // 10
  s = applyAction(s, { type: 'hit' }, RULES); // +10 +2 = 22
  s = applyAction(s, { type: 'hit' }, RULES); // +10 +4 = 36
  assert.equal(s.score, 36);
  assert.equal(s.combo, 3);
  s = applyAction(s, { type: 'lantern' }, RULES); // 36 - 25 = 11, combo reset
  assert.equal(s.score, 11);
  assert.equal(s.combo, 0);
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic item shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Prana Wisp',
    face: 'round',
    palette: { spirit: '#aabbcc', accent: '#112233', lantern: '#ffffff' },
  });
  assert.equal(s.itemId, 30000);
  assert.equal(s.face, 'round');
  assert.deepEqual(Object.keys(s.palette).sort(), ['accent', 'lantern', 'spirit']);
});

test('normalizeSkin rejects out-of-range (non-cosmetic) item ids', () => {
  assert.throws(() =>
    normalizeSkin({ itemId: 20000, name: 'X', palette: { spirit: '#ffffff', accent: '#000000', lantern: '#ffffff' } }),
  );
});

test('normalizeSkin rejects malformed palette', () => {
  assert.throws(() => normalizeSkin({ itemId: 30001, name: 'X', palette: { spirit: '#fff' } }));
});

test('normalizeSkins maps and indexes a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { spirit: '#ffffff', accent: '#000000', lantern: '#ffffff' } },
    { itemId: 30001, name: 'B', face: 'wisp', palette: { spirit: '#ffffff', accent: '#000000', lantern: '#ffffff' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].face, 'wisp');
});
