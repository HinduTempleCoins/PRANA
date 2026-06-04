import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCanonicalJSON,
  fromCanonicalJSON,
  trackHash,
  simplifyPoints,
  pointsToLines,
  emptyTrack,
} from '../src/logic/track.js';
import { LINE_NORMAL, LINE_BOOST } from '../src/logic/physics.js';

const sampleTrack = () => ({
  v: 1,
  lines: [
    [0, 0, 100, 50, LINE_NORMAL],
    [100, 50, 200, 50, LINE_BOOST],
  ],
  start: [0, -10],
  finish: [200, 50],
});

test('canonical JSON has deterministic key + element order', () => {
  const json = toCanonicalJSON(sampleTrack());
  assert.equal(
    json,
    '{"v":1,"lines":[[0,0,100,50,"n"],[100,50,200,50,"b"]],"start":[0,-10],"finish":[200,50]}',
  );
});

test('canonical JSON rounds coordinates to integers (hash insensitive to float noise)', () => {
  const a = trackHash({ ...sampleTrack(), lines: [[0.2, 0.4, 100.1, 49.9, LINE_NORMAL], [100, 50, 200, 50, LINE_BOOST]] });
  const b = trackHash(sampleTrack());
  assert.equal(a, b, 'sub-pixel float jitter must not change the hash');
});

test('serialize -> parse round-trips to the same canonical string', () => {
  const t = sampleTrack();
  const json = toCanonicalJSON(t);
  const back = fromCanonicalJSON(json);
  assert.equal(toCanonicalJSON(back), json);
});

test('same track => same hash (stability)', () => {
  assert.equal(trackHash(sampleTrack()), trackHash(sampleTrack()));
});

test('hash is a 0x + 64 hex string (keccak256)', () => {
  assert.match(trackHash(sampleTrack()), /^0x[0-9a-f]{64}$/);
});

test('REORDERED lines => DIFFERENT hash (canonical means NO sorting — by design)', () => {
  const t = sampleTrack();
  const reordered = { ...t, lines: [t.lines[1], t.lines[0]] };
  assert.notEqual(
    trackHash(t),
    trackHash(reordered),
    'draw order is content; reordering must change the hash',
  );
});

test('changing a line type changes the hash', () => {
  const t = sampleTrack();
  const flipped = { ...t, lines: [[0, 0, 100, 50, LINE_BOOST], t.lines[1]] };
  assert.notEqual(trackHash(t), trackHash(flipped));
});

test('empty track hashes deterministically', () => {
  assert.equal(trackHash(emptyTrack()), trackHash(emptyTrack()));
  assert.match(trackHash(emptyTrack()), /^0x[0-9a-f]{64}$/);
});

test('simplifyPoints drops points closer than the threshold but keeps first + last', () => {
  const pts = [
    [0, 0],
    [2, 0], // too close (dist 2 < 8) -> dropped
    [3, 0], // too close -> dropped
    [20, 0], // far enough -> kept
    [21, 0], // too close to prev kept -> dropped
    [50, 0], // far -> kept (also it's the last anyway)
  ];
  const out = simplifyPoints(pts, 8);
  assert.deepEqual(out[0], [0, 0], 'keeps first');
  assert.deepEqual(out[out.length - 1], [50, 0], 'keeps last');
  assert.ok(out.length < pts.length, 'removed near-duplicate points');
  assert.ok(out.length >= 3, 'kept the genuinely spaced points');
});

test('simplifyPoints leaves 2-point lists untouched', () => {
  const pts = [[0, 0], [1, 0]];
  assert.deepEqual(simplifyPoints(pts, 8), pts);
});

test('pointsToLines builds N-1 segments of the given type', () => {
  const lines = pointsToLines([[0, 0], [10, 0], [20, 0]], LINE_BOOST);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [0, 0, 10, 0, LINE_BOOST]);
  assert.deepEqual(lines[1], [10, 0, 20, 0, LINE_BOOST]);
});
