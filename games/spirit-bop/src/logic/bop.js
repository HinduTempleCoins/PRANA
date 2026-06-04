// Pure, side-effect-free Spirit Bop logic. Imported by PlayScene AND exercised by
// node --test. No Phaser imports here on purpose — keeps it fully testable in plain node.
//
// Whack-a-mole reflex game on a 3×3 grid of mounds (index 0..8). Spirits pop up on a
// seeded schedule that ACCELERATES over the round; each spawn stays up for a HIT WINDOW
// that SHRINKS over the round. Tap a spirit while it is up to bop it (score + combo). A
// rare friendly LANTERN spirit must NOT be bopped — bopping it is a penalty and breaks the
// combo. Round length is fixed (60s by default).

export const MOUNDS = 9; // 3x3

export const KIND = { SPIRIT: 'spirit', LANTERN: 'lantern' };

// --- deterministic RNG ----------------------------------------------------------------- //
// mulberry32 — a given seed reproduces the exact same spawn schedule.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- difficulty ramps ------------------------------------------------------------------ //
// Spawn interval (ms between pops) shrinks linearly from base toward a floor as the round
// progresses. `t` is elapsed fraction in [0,1].
export function spawnInterval(t, rules) {
  const clamped = clamp01(t);
  const ms = rules.baseSpawnMs - clamped * (rules.baseSpawnMs - rules.minSpawnMs);
  return Math.max(rules.minSpawnMs, Math.round(ms));
}

// Hit window (ms a spirit stays boppable) shrinks from base toward a floor over the round.
export function hitWindow(t, rules) {
  const clamped = clamp01(t);
  const ms = rules.baseWindowMs - clamped * (rules.baseWindowMs - rules.minWindowMs);
  return Math.max(rules.minWindowMs, Math.round(ms));
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- spawn scheduler ------------------------------------------------------------------- //
// Precompute the whole round's spawn schedule deterministically from a seed. Each entry:
//   { at, mound, kind, window }   (at = ms from round start; window = boppable duration)
// Spawns never overlap on the SAME mound (a mound's previous spawn must have ended).
//
// rules = { roundMs, baseSpawnMs, minSpawnMs, baseWindowMs, minWindowMs, lanternChance }
export function buildSchedule(seed, rules) {
  const rng = makeRng(seed);
  const out = [];
  const moundFreeAt = new Array(MOUNDS).fill(0); // earliest time each mound is free again
  let at = rules.baseSpawnMs; // first pop after one interval

  while (at < rules.roundMs) {
    const t = at / rules.roundMs;
    const window = hitWindow(t, rules);

    // choose a mound currently free (fall back to least-busy if all busy).
    const free = [];
    for (let m = 0; m < MOUNDS; m++) if (moundFreeAt[m] <= at) free.push(m);
    let mound;
    if (free.length > 0) {
      mound = free[Math.floor(rng() * free.length)];
    } else {
      mound = 0;
      for (let m = 1; m < MOUNDS; m++) if (moundFreeAt[m] < moundFreeAt[mound]) mound = m;
    }

    const kind = rng() < rules.lanternChance ? KIND.LANTERN : KIND.SPIRIT;
    out.push({ at, mound, kind, window });
    moundFreeAt[mound] = at + window;

    at += spawnInterval(t, rules);
  }
  return out;
}

// --- hit-window check ------------------------------------------------------------------ //
// Is a tap on `mound` at time `now` a valid hit on `spawn`? True only while the spawn is up
// (its window has not closed) and on the matching mound. Pure.
export function isHit(spawn, mound, now) {
  return spawn.mound === mound && now >= spawn.at && now < spawn.at + spawn.window;
}

// Given the active spawns and a tap, find the spawn that the tap lands on (or null). A tap
// resolves against the single spawn currently up on that mound.
export function resolveTap(activeSpawns, mound, now) {
  for (const s of activeSpawns) {
    if (isHit(s, mound, now)) return s;
  }
  return null;
}

// --- combo math ------------------------------------------------------------------------ //
// Combo bonus for a hit at the current combo count (count AFTER incrementing). A small
// escalating bonus that rewards streaks; capped so it can't run away.
export function comboBonus(comboCount, rules) {
  if (comboCount <= 1) return 0;
  const steps = Math.min(comboCount - 1, rules.comboCap);
  return steps * rules.comboStep;
}

// Score for a single clean bop (base hit value, before combo bonus).
export function hitScore(rules) {
  return rules.hitPoints;
}

// --- scoring state machine ------------------------------------------------------------- //
// Fold a single resolved action into the running score state. PURE — returns a NEW state.
//
// state  = { score, combo, hits, misses, lanternHits }
// action = { type: 'hit' } | { type: 'lantern' } | { type: 'miss' }
//   'hit'     : valid bop on a spirit -> + hitPoints + comboBonus, combo++.
//   'lantern' : bopped the friendly lantern -> penalty, combo resets to 0.
//   'miss'    : tapped empty mound / spirit already sank -> combo resets, miss++.
export function applyAction(state, action, rules) {
  const s = { ...state };
  if (action.type === 'hit') {
    s.combo += 1;
    s.hits += 1;
    s.score += hitScore(rules) + comboBonus(s.combo, rules);
  } else if (action.type === 'lantern') {
    s.lanternHits += 1;
    s.combo = 0;
    s.score = Math.max(0, s.score - rules.lanternPenalty);
  } else if (action.type === 'miss') {
    s.combo = 0;
    s.misses += 1;
  }
  return s;
}

export function initialState() {
  return { score: 0, combo: 0, hits: 0, misses: 0, lanternHits: 0 };
}

// Classify a tap into an action against the live spawns. Returns { type, spawn }.
//   - hit on a spirit       -> 'hit'
//   - hit on a lantern      -> 'lantern'
//   - nothing up there      -> 'miss'
export function classifyTap(activeSpawns, mound, now) {
  const spawn = resolveTap(activeSpawns, mound, now);
  if (!spawn) return { type: 'miss', spawn: null };
  return { type: spawn.kind === KIND.LANTERN ? 'lantern' : 'hit', spawn };
}
