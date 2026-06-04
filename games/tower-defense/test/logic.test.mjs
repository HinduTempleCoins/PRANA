import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance,
  nearestInRange,
  shotDamage,
  applyDamage,
  waveSpec,
} from '../src/logic/targeting.js';
import { normalizeTower, normalizeTowers } from '../src/data/towers.js';
import { rarityFromGenome } from '../src/data/rarity.js';

test('distance is euclidean', () => {
  assert.equal(distance(0, 0, 3, 4), 5);
});

test('nearestInRange picks the closest in-range living enemy', () => {
  const tower = { x: 0, y: 0, stats: { range: 100 } };
  const enemies = [
    { x: 90, y: 0, hp: 10, alive: true }, // in range, far
    { x: 30, y: 0, hp: 10, alive: true }, // in range, near  <-- expected
    { x: 200, y: 0, hp: 10, alive: true }, // out of range
  ];
  assert.equal(nearestInRange(tower, enemies), enemies[1]);
});

test('nearestInRange ignores dead / zero-hp enemies', () => {
  const tower = { x: 0, y: 0, stats: { range: 100 } };
  const enemies = [
    { x: 10, y: 0, hp: 0, alive: true },
    { x: 20, y: 0, hp: 5, alive: false },
    { x: 50, y: 0, hp: 5, alive: true }, // only valid one
  ];
  assert.equal(nearestInRange(tower, enemies), enemies[2]);
});

test('nearestInRange returns null when nothing in range', () => {
  const tower = { x: 0, y: 0, stats: { range: 10 } };
  assert.equal(nearestInRange(tower, [{ x: 999, y: 0, hp: 5, alive: true }]), null);
});

test('shotDamage scales with level', () => {
  assert.equal(shotDamage({ damage: 10, level: 1 }), 10);
  // level 3: +2 * ceil(10*0.1=1) = +2
  assert.equal(shotDamage({ damage: 10, level: 3 }), 12);
});

test('applyDamage clamps and flags kills', () => {
  assert.deepEqual(applyDamage(10, 3), { hp: 7, killed: false });
  assert.deepEqual(applyDamage(5, 5), { hp: 0, killed: true });
  assert.deepEqual(applyDamage(2, 10), { hp: 0, killed: true });
});

test('waveSpec scales difficulty upward', () => {
  const w1 = waveSpec(1);
  const w5 = waveSpec(5);
  assert.ok(w5.count > w1.count);
  assert.ok(w5.hp > w1.hp);
  assert.ok(w5.speed > w1.speed);
});

test('normalizeTower enforces the canonical NFT-trait shape', () => {
  const t = normalizeTower({
    tokenId: 7,
    name: 'X',
    rarity: 'Epic',
    stats: { damage: 5, range: 100, fireRate: 1, level: 2, xp: 9 },
  });
  assert.equal(t.tokenId, 7);
  assert.equal(t.rarity, 'Epic');
  assert.deepEqual(Object.keys(t.stats).sort(), ['damage', 'fireRate', 'level', 'range', 'xp']);
});

test('normalizeTower rejects missing numeric stats', () => {
  assert.throws(() => normalizeTower({ stats: { damage: 5 } }));
});

test('normalizeTowers maps a list', () => {
  const list = normalizeTowers([
    { tokenId: 0, name: 'A', rarity: 'Common', stats: { damage: 1, range: 1, fireRate: 1, level: 1, xp: 0 } },
  ]);
  assert.equal(list.length, 1);
});

test('rarityFromGenome buckets deterministically', () => {
  assert.equal(rarityFromGenome(0n), 'Common');
  assert.equal(rarityFromGenome(99n), 'Legendary');
  assert.equal(rarityFromGenome(0n), rarityFromGenome(100n)); // periodic
});
