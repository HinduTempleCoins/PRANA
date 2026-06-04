import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFormation,
  cellPos,
  liveCount,
  liveColumnExtent,
  lowestLiveY,
  stepInterval,
  stepFormation,
  boltHitsSentinel,
  killSentinel,
  rowScoreFor,
  bottomShooters,
  chooseEnemyShot,
  makeCovers,
  boltHitsCover,
  erodeCover,
  stepVerticalBolts,
  clampPlayerX,
  enemyBoltHitsPlayer,
} from '../src/logic/sentinels.js';
import { RULES, GAME_WIDTH, GAME_HEIGHT } from '../src/config.js';

const W = GAME_WIDTH;
const G = RULES.grid;

// --- formation construction ----------------------------------------------------------- //

test('makeFormation builds cols*rows sentinels, all alive, marching right', () => {
  const f = makeFormation(G);
  assert.equal(f.sentinels.length, G.cols * G.rows);
  assert.ok(f.sentinels.every((s) => s.alive));
  assert.equal(f.dir, 1);
  assert.equal(f.offsetX, 0);
  assert.equal(f.offsetY, 0);
});

test('cellPos places col0/row0 at the anchor and steps by cellW/cellH', () => {
  const a = cellPos(0, 0, 0, 0, G);
  assert.equal(a.x, G.sideMargin + G.cellW / 2);
  assert.equal(a.y, G.topMargin);
  const b = cellPos(1, 2, 0, 0, G);
  assert.equal(b.x, a.x + G.cellW);
  assert.equal(b.y, a.y + 2 * G.cellH);
});

test('cellPos applies the formation offset', () => {
  const a = cellPos(0, 0, 10, 20, G);
  assert.equal(a.x, G.sideMargin + G.cellW / 2 + 10);
  assert.equal(a.y, G.topMargin + 20);
});

test('liveCount and liveColumnExtent reflect kills', () => {
  let f = makeFormation(G);
  assert.equal(liveCount(f), G.cols * G.rows);
  const ext0 = liveColumnExtent(f);
  assert.equal(ext0.min, 0);
  assert.equal(ext0.max, G.cols - 1);
  // kill every sentinel in column 0
  f.sentinels.forEach((s, i) => {
    if (s.col === 0) f = killSentinel(f, i);
  });
  assert.equal(liveColumnExtent(f).min, 1); // leftmost live column shifted right
  assert.equal(liveCount(f), G.cols * G.rows - G.rows);
});

test('liveColumnExtent returns null when nothing is alive', () => {
  let f = makeFormation(G);
  f = { ...f, sentinels: f.sentinels.map((s) => ({ ...s, alive: false })) };
  assert.equal(liveColumnExtent(f), null);
  assert.equal(liveCount(f), 0);
});

// --- stepping & acceleration ---------------------------------------------------------- //

test('stepInterval is slowest when full and accelerates as ranks thin', () => {
  let f = makeFormation(G);
  const full = stepInterval(f, G, RULES.step, 1);
  // kill all but one
  f = { ...f, sentinels: f.sentinels.map((s, i) => ({ ...s, alive: i === 0 })) };
  const nearlyEmpty = stepInterval(f, G, RULES.step, 1);
  assert.ok(nearlyEmpty < full);
  assert.ok(nearlyEmpty >= RULES.step.minStepMs);
});

test('stepInterval gets faster on later waves', () => {
  const f = makeFormation(G);
  const w1 = stepInterval(f, G, RULES.step, 1);
  const w3 = stepInterval(f, G, RULES.step, 3);
  assert.ok(w3 < w1);
});

test('stepFormation marches sideways by marchX when clear of the walls', () => {
  const f = makeFormation(G);
  const next = stepFormation(f, G, W);
  assert.equal(next.offsetX, G.marchX); // moved right
  assert.equal(next.offsetY, 0); // no drop
  assert.equal(next.dir, 1);
});

test('stepFormation reverses and drops at the right wall (no sideways move that step)', () => {
  let f = makeFormation(G);
  // push the formation far right so the next step would cross the right margin
  f = { ...f, offsetX: 9999 };
  const next = stepFormation(f, G, W);
  assert.equal(next.dir, -1); // reversed
  assert.equal(next.offsetY, G.dropY); // dropped
  assert.equal(next.offsetX, f.offsetX); // did NOT translate sideways this step
});

test('stepFormation reverses and drops at the left wall', () => {
  let f = makeFormation(G);
  f = { ...f, offsetX: -9999, dir: -1 };
  const next = stepFormation(f, G, W);
  assert.equal(next.dir, 1);
  assert.equal(next.offsetY, G.dropY);
});

test('stepFormation is pure (no input mutation)', () => {
  const f = makeFormation(G);
  const snap = JSON.stringify(f);
  stepFormation(f, G, W);
  assert.equal(JSON.stringify(f), snap);
});

test('lowestLiveY tracks the deepest live row', () => {
  let f = makeFormation(G);
  const deep = lowestLiveY(f, G);
  assert.equal(deep, cellPos(0, G.rows - 1, 0, 0, G).y);
  // kill the whole bottom row -> lowest live y rises by one cell
  f.sentinels.forEach((s, i) => {
    if (s.row === G.rows - 1) f = killSentinel(f, i);
  });
  assert.equal(lowestLiveY(f, G), cellPos(0, G.rows - 2, 0, 0, G).y);
});

// --- bolt vs sentinel ----------------------------------------------------------------- //

test('boltHitsSentinel returns the index of an overlapped live sentinel, else -1', () => {
  const f = makeFormation(G);
  const target = cellPos(2, 1, 0, 0, G);
  const idx = boltHitsSentinel({ x: target.x, y: target.y }, 3, f, G);
  assert.ok(idx >= 0);
  assert.equal(f.sentinels[idx].col, 2);
  assert.equal(f.sentinels[idx].row, 1);
  // far away misses
  assert.equal(boltHitsSentinel({ x: -100, y: -100 }, 3, f, G), -1);
});

test('boltHitsSentinel ignores dead sentinels', () => {
  let f = makeFormation(G);
  const target = cellPos(2, 1, 0, 0, G);
  const idx = boltHitsSentinel({ x: target.x, y: target.y }, 3, f, G);
  f = killSentinel(f, idx);
  assert.equal(boltHitsSentinel({ x: target.x, y: target.y }, 3, f, G), -1);
});

test('killSentinel is pure and only flips the one index', () => {
  const f = makeFormation(G);
  const snap = JSON.stringify(f);
  const f2 = killSentinel(f, 5);
  assert.equal(JSON.stringify(f), snap); // original untouched
  assert.equal(f2.sentinels[5].alive, false);
  assert.equal(liveCount(f2), liveCount(f) - 1);
});

test('rowScoreFor reads the tier table and clamps past the end', () => {
  assert.equal(rowScoreFor(0, RULES.rowScore), RULES.rowScore[0]);
  assert.equal(rowScoreFor(1, RULES.rowScore), RULES.rowScore[1]);
  assert.equal(rowScoreFor(999, RULES.rowScore), RULES.rowScore[RULES.rowScore.length - 1]);
});

test('top rows are worth at least as much as lower rows', () => {
  for (let r = 1; r < RULES.rowScore.length; r++) {
    assert.ok(RULES.rowScore[r - 1] >= RULES.rowScore[r]);
  }
});

// --- enemy firing --------------------------------------------------------------------- //

test('bottomShooters returns the lowest live sentinel per column', () => {
  const f = makeFormation(G);
  const shooters = bottomShooters(f, G);
  assert.equal(shooters.size, G.cols); // every column has a shooter
  for (const [, idx] of shooters) {
    assert.equal(f.sentinels[idx].row, G.rows - 1); // bottom row on a full grid
  }
});

test('bottomShooters skips emptied columns and rises to the next live row', () => {
  let f = makeFormation(G);
  // remove the bottom sentinel of column 3
  f.sentinels.forEach((s, i) => {
    if (s.col === 3 && s.row === G.rows - 1) f = killSentinel(f, i);
  });
  const shooters = bottomShooters(f, G);
  const idx = shooters.get(3);
  assert.equal(f.sentinels[idx].row, G.rows - 2); // next one up now shoots
});

test('chooseEnemyShot returns null when the dice exceed the drop chance', () => {
  const f = makeFormation(G);
  // rng() first call returns 1 (> any chance < 1) -> no shot
  assert.equal(chooseEnemyShot(f, G, 0.5, () => 1), null);
});

test('chooseEnemyShot returns a bottom-row origin when it fires', () => {
  const f = makeFormation(G);
  const seq = [0, 0]; // pass the dice, pick column 0
  let k = 0;
  const rng = () => seq[k++ % seq.length];
  const origin = chooseEnemyShot(f, G, 1, rng);
  assert.ok(origin);
  // origin y should be the bottom row's y
  assert.equal(origin.y, cellPos(0, G.rows - 1, 0, 0, G).y);
});

// --- cover (destructible arcs) -------------------------------------------------------- //

test('makeCovers makes the configured count with full health', () => {
  const covers = makeCovers(RULES.cover, W);
  assert.equal(covers.length, RULES.cover.count);
  assert.ok(covers.every((c) => c.cells === RULES.cover.cells));
  // centers strictly inside the field and increasing
  for (let i = 1; i < covers.length; i++) assert.ok(covers[i].x > covers[i - 1].x);
});

test('boltHitsCover hits an intact cover, ignores a destroyed one', () => {
  let covers = makeCovers(RULES.cover, W);
  const c0 = covers[0];
  assert.equal(boltHitsCover({ x: c0.x, y: c0.y }, 3, covers, RULES.cover), 0);
  // destroy cover 0
  covers = covers.map((c, i) => (i === 0 ? { ...c, cells: 0 } : c));
  assert.equal(boltHitsCover({ x: c0.x, y: c0.y }, 3, covers, RULES.cover), -1);
  // a far bolt hits nothing
  assert.equal(boltHitsCover({ x: -50, y: -50 }, 3, covers, RULES.cover), -1);
});

test('erodeCover chips one cell, never below zero, pure', () => {
  const covers = makeCovers(RULES.cover, W);
  const snap = JSON.stringify(covers);
  const once = erodeCover(covers, 1);
  assert.equal(JSON.stringify(covers), snap); // original untouched
  assert.equal(once[1].cells, RULES.cover.cells - 1);
  // erode to zero and beyond
  let c = covers;
  for (let i = 0; i < RULES.cover.cells + 3; i++) c = erodeCover(c, 0);
  assert.equal(c[0].cells, 0);
});

// --- bolts / player ------------------------------------------------------------------- //

test('stepVerticalBolts advances by vy*dt and culls off-field bolts', () => {
  const bolts = [
    { x: 10, y: 100, vy: -200 }, // moving up
    { x: 20, y: GAME_HEIGHT - 5, vy: 300 }, // moving down, will leave the field (past H+20)
  ];
  const out = stepVerticalBolts(bolts, 0.1, GAME_HEIGHT);
  // first survives and moved up (100 - 200*0.1 = 80, still on-field)
  const up = out.find((b) => b.x === 10);
  assert.ok(up && up.y < 100);
  // second left the field
  assert.equal(out.find((b) => b.x === 20), undefined);
});

test('clampPlayerX keeps the ship within the margins', () => {
  const lo = RULES.player.margin + RULES.player.width / 2;
  const hi = W - RULES.player.margin - RULES.player.width / 2;
  assert.equal(clampPlayerX(-999, RULES.player, W), lo);
  assert.equal(clampPlayerX(99999, RULES.player, W), hi);
  assert.equal(clampPlayerX(W / 2, RULES.player, W), W / 2);
});

test('enemyBoltHitsPlayer is true inside the ship box, false outside', () => {
  const px = 300;
  assert.equal(enemyBoltHitsPlayer({ x: px, y: RULES.player.y }, px, RULES.player), true);
  assert.equal(
    enemyBoltHitsPlayer({ x: px + RULES.player.width, y: RULES.player.y }, px, RULES.player),
    false,
  );
  assert.equal(enemyBoltHitsPlayer({ x: px, y: RULES.player.y - 100 }, px, RULES.player), false);
});
