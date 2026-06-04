import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng,
  DEFAULTS,
  PLATFORM,
  speedScale,
  genPlatform,
  fillPlatformsUpTo,
  stepPlatform,
  wrapX,
  landsOn,
  stepPlayer,
  heightFor,
  cameraBottom,
  hasFallen,
  newRun,
  prunePlatforms,
} from '../src/logic/hop.js';
import { normalizeSkin, normalizeSkins } from '../src/data/skins.js';

const CFG = { ...DEFAULTS, steerSpeed: 5 };

// --- seeded prng ---------------------------------------------------------------------- //

test('seeded rng is deterministic and reproducible', () => {
  const a = makeRng(2024);
  const b = makeRng(2024);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

// --- difficulty scaling --------------------------------------------------------------- //

test('speedScale is 1 at the start and rises in clamped steps', () => {
  assert.equal(speedScale(0, CFG), 1);
  assert.ok(speedScale(CFG.speedEvery, CFG) > 1);
  assert.ok(speedScale(CFG.speedEvery * 2, CFG) > speedScale(CFG.speedEvery, CFG));
  assert.equal(speedScale(1e9, CFG), CFG.speedMax); // clamped
});

// --- platform generation -------------------------------------------------------------- //

test('genPlatform places a platform ABOVE prevY within the gap band and in bounds', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 200; i++) {
    const p = genPlatform(1000, rng, CFG, i);
    const gap = 1000 - p.y;
    assert.ok(gap >= CFG.gapMin - 1e-9 && gap <= CFG.gapMax + 1e-9, `gap ${gap}`);
    assert.ok(p.x >= 0 && p.x <= CFG.width - p.w);
    assert.ok([PLATFORM.NORMAL, PLATFORM.MOVING, PLATFORM.CRUMBLE].includes(p.type));
  }
});

test('genPlatform produces all three platform types across many seeds', () => {
  const rng = makeRng(11);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(genPlatform(1000 + i, rng, CFG, i).type);
  assert.ok(seen.has(PLATFORM.NORMAL));
  assert.ok(seen.has(PLATFORM.MOVING));
  assert.ok(seen.has(PLATFORM.CRUMBLE));
});

test('fillPlatformsUpTo ladders upward until the target and advances gen state', () => {
  const rng = makeRng(3);
  const base = { id: 0, x: 100, y: 1000, w: CFG.platformW, h: CFG.platformH, type: PLATFORM.NORMAL, dir: 1, alive: true };
  const res = fillPlatformsUpTo([base], { nextId: 1, topY: 1000 }, 0, rng, CFG);
  assert.ok(res.platforms.length > 1);
  assert.ok(res.state.topY <= 0); // reached the target
  // ids are unique and monotonic
  const ids = res.platforms.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  // every generated platform sits above the one before it (smaller y)
  for (let i = 2; i < res.platforms.length; i++) {
    assert.ok(res.platforms[i].y < res.platforms[i - 1].y);
  }
});

// --- moving platforms ----------------------------------------------------------------- //

test('stepPlatform moves a MOVING platform and bounces off the walls', () => {
  let p = { id: 1, x: CFG.width - CFG.platformW - 1, y: 100, w: CFG.platformW, h: CFG.platformH, type: PLATFORM.MOVING, dir: 1, alive: true };
  // push it to the right wall; it should clamp and flip direction
  for (let i = 0; i < 10; i++) p = stepPlatform(p, CFG, 1);
  assert.ok(p.x <= CFG.width - p.w);
  assert.equal(p.dir, -1);
});

test('stepPlatform leaves NORMAL and dead platforms unchanged', () => {
  const n = { id: 1, x: 50, y: 100, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true };
  assert.deepEqual(stepPlatform(n, CFG, 1), n);
  const dead = { id: 2, x: 50, y: 100, w: 70, h: 16, type: PLATFORM.MOVING, dir: 1, alive: false };
  assert.deepEqual(stepPlatform(dead, CFG, 1), dead);
});

// --- horizontal wrap ------------------------------------------------------------------ //

test('wrapX wraps the player around both screen edges', () => {
  assert.equal(wrapX(-1, 420), 419);
  assert.equal(wrapX(420, 420), 0);
  assert.equal(wrapX(421, 420), 1);
  assert.equal(wrapX(200, 420), 200);
});

// --- landing detection ---------------------------------------------------------------- //

test('landsOn requires a downward crossing of the platform top AND horizontal overlap', () => {
  const p = { id: 1, x: 100, y: 300, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true };
  // feet cross 300 from above, centered over the platform -> lands
  assert.equal(landsOn(290, 305, 130, p, CFG), true);
  // no crossing (feet stay above) -> no land
  assert.equal(landsOn(280, 295, 130, p, CFG), false);
  // crossing but horizontally off to the side -> no land
  assert.equal(landsOn(290, 305, 10, p, CFG), false);
});

test('landsOn ignores dead (crumbled) platforms', () => {
  const p = { id: 1, x: 100, y: 300, w: 70, h: 16, type: PLATFORM.CRUMBLE, dir: 1, alive: false };
  assert.equal(landsOn(290, 305, 130, p, CFG), false);
});

// --- player step / bounce ------------------------------------------------------------- //

test('stepPlayer applies gravity and does not bounce in open air', () => {
  const player = { x: 200, y: 100, vy: 0 };
  const r = stepPlayer(player, [], { dx: 0 }, CFG, 1);
  assert.equal(r.bounced, false);
  assert.ok(r.player.vy > 0); // gravity pulled it down
  assert.ok(r.player.y > 100); // moved down
});

test('stepPlayer auto-bounces ONLY from above when falling onto a platform', () => {
  // platform top at y=300; player feet just above, moving down fast
  const p = { id: 7, x: 180, y: 300, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true };
  const player = { x: 210, y: 300 - CFG.playerH - 2, vy: 10 };
  const r = stepPlayer(player, [p], { dx: 0 }, CFG, 1);
  assert.equal(r.bounced, true);
  assert.equal(r.landedId, 7);
  assert.ok(r.player.vy < 0); // launched upward
  assert.equal(r.player.y, 300 - CFG.playerH); // feet snapped to top
});

test('stepPlayer does NOT bounce while moving upward through a platform', () => {
  const p = { id: 7, x: 180, y: 300, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true };
  // player rising (vy < 0) with feet below the platform top -> pass through
  const player = { x: 210, y: 320, vy: -12 };
  const r = stepPlayer(player, [p], { dx: 0 }, CFG, 1);
  assert.equal(r.bounced, false);
});

test('stepPlayer crumble platform is consumed (alive=false) after the bounce', () => {
  const p = { id: 9, x: 180, y: 300, w: 70, h: 16, type: PLATFORM.CRUMBLE, dir: 1, alive: true };
  const player = { x: 210, y: 300 - CFG.playerH - 2, vy: 10 };
  const r = stepPlayer(player, [p], { dx: 0 }, CFG, 1);
  assert.equal(r.bounced, true);
  const after = r.platforms.find((q) => q.id === 9);
  assert.equal(after.alive, false);
});

test('stepPlayer steering wraps horizontally', () => {
  const player = { x: CFG.width - 1, y: 100, vy: 0 };
  const r = stepPlayer(player, [], { dx: 1 }, CFG, 1);
  assert.ok(r.player.x < CFG.width); // wrapped around the right edge
  assert.ok(r.player.x < player.x); // wrapped to the left side
});

test('stepPlayer is pure: it does not mutate inputs', () => {
  const p = { id: 9, x: 180, y: 300, w: 70, h: 16, type: PLATFORM.CRUMBLE, dir: 1, alive: true };
  const player = { x: 210, y: 260, vy: 10 };
  const ps = [p];
  const snapPlayer = JSON.stringify(player);
  const snapPs = JSON.stringify(ps);
  stepPlayer(player, ps, { dx: 1 }, CFG, 1);
  assert.equal(JSON.stringify(player), snapPlayer);
  assert.equal(JSON.stringify(ps), snapPs);
});

// --- height / camera / fall ----------------------------------------------------------- //

test('heightFor measures rise above start, never negative', () => {
  assert.equal(heightFor(600, 600), 0);
  assert.equal(heightFor(600, 100), 500); // rose 500px
  assert.equal(heightFor(600, 700), 0); // below start clamps to 0
});

test('cameraBottom and hasFallen track the max height', () => {
  const maxClimbY = 100; // highest point reached
  const bottom = cameraBottom(maxClimbY, CFG);
  assert.ok(hasFallen(bottom + 1, maxClimbY, CFG)); // below the view -> fallen
  assert.ok(!hasFallen(maxClimbY, maxClimbY, CFG)); // at the top -> not fallen
});

// --- new run -------------------------------------------------------------------------- //

test('newRun seeds a base platform under the player plus a ladder above', () => {
  const a = newRun(makeRng(50), CFG);
  const b = newRun(makeRng(50), CFG);
  assert.deepEqual(a.platforms, b.platforms); // deterministic from the seed
  // base platform exists right beneath the player
  const base = a.platforms.find((p) => p.id === 0);
  assert.ok(base);
  assert.ok(base.y > a.player.y); // base is below the player (larger y)
  assert.ok(a.platforms.length > 1); // ladder generated above
});

test('prunePlatforms drops platforms fallen below the cull line', () => {
  const ps = [
    { id: 0, x: 0, y: 1000, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true },
    { id: 1, x: 0, y: 100, w: 70, h: 16, type: PLATFORM.NORMAL, dir: 1, alive: true },
  ];
  const kept = prunePlatforms(ps, 500);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 1);
});

// --- integration: a few bounces actually climb --------------------------------------- //

test('a simulated run gains height over a sequence of bounces', () => {
  const cfg = CFG;
  const run = newRun(makeRng(77), cfg);
  let { player, platforms } = run;
  let maxClimbY = player.y;
  const genState = run.genState;
  const rng = makeRng(123);
  for (let frame = 0; frame < 2000; frame++) {
    const scale = speedScale(heightFor(run.startY, maxClimbY), cfg);
    platforms = platforms.map((p) => stepPlatform(p, cfg, scale));
    const r = stepPlayer(player, platforms, { dx: 0 }, cfg, scale);
    player = r.player;
    platforms = r.platforms;
    if (player.y < maxClimbY) maxClimbY = player.y;
    // keep ladder filled as we rise
    const f = fillPlatformsUpTo(platforms, genState, maxClimbY - cfg.height, rng, cfg);
    platforms = f.platforms;
    genState.nextId = f.state.nextId;
    genState.topY = f.state.topY;
    if (hasFallen(player.y, maxClimbY, cfg)) break;
  }
  assert.ok(heightFor(run.startY, maxClimbY) > 0, 'player should have climbed some height');
});

// --- skin data normalizer ------------------------------------------------------------- //

test('normalizeSkin enforces the cosmetic item shape', () => {
  const s = normalizeSkin({
    itemId: 30000,
    name: 'Lapis Hopper',
    trail: 'spark',
    palette: { body: '#223355', edge: '#88bbee', glow: '#cfe8ff' },
  });
  assert.equal(s.itemId, 30000);
  assert.equal(s.trail, 'spark');
  assert.deepEqual(Object.keys(s.palette).sort(), ['body', 'edge', 'glow']);
});

test('normalizeSkin rejects out-of-range item ids', () => {
  assert.throws(() => normalizeSkin({ itemId: 1, name: 'X', palette: { body: '#fff', edge: '#fff', glow: '#fff' } }));
});

test('normalizeSkins maps a list', () => {
  const list = normalizeSkins([
    { itemId: 30000, name: 'A', palette: { body: '#223355', edge: '#88bbee', glow: '#cfe8ff' } },
    { itemId: 30001, name: 'B', trail: 'ribbon', palette: { body: '#223355', edge: '#88bbee', glow: '#cfe8ff' } },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].trail, 'ribbon');
});
