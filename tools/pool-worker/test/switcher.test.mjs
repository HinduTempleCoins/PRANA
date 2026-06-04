// switcher.test.mjs — unit tests for the auto-switch arbiter.
//
// Tested behaviour (switching-worker.md §0, §3, §15):
//  - prefers TASK when a task is available (higher-value / anchor demand).
//  - gracefully DEGRADES to HASH when no task is available (never idle).
//  - RECOVERS to TASK when demand returns (after hysteresis cooldown).
//  - never preempts an in-flight task.
//  - capability honesty: a hash-only unit never enters TASK; a task-only unit (ASIC) goes
//    IDLE when no task rather than pretending to hash.
//
// Uses an injectable clock so cooldown/hysteresis is deterministic — no real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLane, Switcher, LANE } from '../src/switcher.mjs';

const GPU = { canHash: true, canTask: true }; // all-rounder
const CPU = { canHash: true, canTask: true };
const ASIC = { canHash: false, canTask: true }; // AI accelerator, task-only
const HASHER = { canHash: true, canTask: false }; // fpga / hash-only

// ---- pure decideLane ----

test('decideLane prefers TASK when a task is available (auto)', () => {
  const lane = decideLane({
    cap: GPU,
    taskAvailable: true,
    lanePref: 'auto',
    current: LANE.IDLE,
    cooldownElapsed: true,
  });
  assert.equal(lane, LANE.TASK);
});

test('decideLane degrades to HASH when no task available', () => {
  const lane = decideLane({
    cap: GPU,
    taskAvailable: false,
    lanePref: 'auto',
    current: LANE.TASK,
    cooldownElapsed: true,
  });
  assert.equal(lane, LANE.HASH);
});

test('decideLane never preempts an in-flight task', () => {
  const lane = decideLane({
    cap: GPU,
    taskAvailable: false, // task supply dropped...
    lanePref: 'auto',
    current: LANE.TASK,
    cooldownElapsed: true,
    inFlightTask: true, // ...but a task is mid-run -> stay TASK
  });
  assert.equal(lane, LANE.TASK);
});

test('decideLane respects lanePref=hash (operator forced)', () => {
  const lane = decideLane({
    cap: GPU,
    taskAvailable: true, // task offered, but operator forced hash-only
    lanePref: 'hash',
    current: LANE.HASH,
    cooldownElapsed: true,
  });
  assert.equal(lane, LANE.HASH);
});

test('decideLane: hash-only unit never enters TASK', () => {
  const lane = decideLane({
    cap: HASHER,
    taskAvailable: true,
    lanePref: 'auto',
    current: LANE.HASH,
    cooldownElapsed: true,
  });
  assert.equal(lane, LANE.HASH);
});

test('decideLane: task-only unit (ASIC) goes IDLE when no task', () => {
  const lane = decideLane({
    cap: ASIC,
    taskAvailable: false,
    lanePref: 'auto',
    current: LANE.TASK,
    cooldownElapsed: true,
  });
  assert.equal(lane, LANE.IDLE, 'ASIC cannot hash -> heartbeat/idle, not fake hashing');
});

// ---- stateful Switcher with injected clock: prefer -> degrade -> recover ----

test('Switcher: prefer TASK, degrade to HASH, recover to TASK (full cycle)', () => {
  let now = 0;
  const sw = new Switcher({ cap: GPU, lanePref: 'auto', cooldownMs: 100, now: () => now });

  // t=0: task available -> TASK
  assert.deepEqual(sw.tick({ taskAvailable: true }), { lane: LANE.TASK, switched: true });

  // task supply drops. Within cooldown we hold TASK (hysteresis avoids thrash).
  now = 50;
  assert.deepEqual(sw.tick({ taskAvailable: false }), { lane: LANE.TASK, switched: false });

  // after cooldown elapses, degrade to HASH (never idle).
  now = 200;
  assert.deepEqual(sw.tick({ taskAvailable: false }), { lane: LANE.HASH, switched: true });

  // demand returns. Within cooldown we stay HASH...
  now = 250;
  assert.deepEqual(sw.tick({ taskAvailable: true }), { lane: LANE.HASH, switched: false });

  // ...then recover to TASK once cooldown passes.
  now = 400;
  assert.deepEqual(sw.tick({ taskAvailable: true }), { lane: LANE.TASK, switched: true });
});

test('Switcher: never idle for a GPU while tasks fluctuate', () => {
  let now = 0;
  const sw = new Switcher({ cap: GPU, lanePref: 'auto', cooldownMs: 0, now: () => now });
  // cooldown 0 => switches immediately; lane is always a working lane, never IDLE.
  for (const avail of [true, false, true, true, false, false, true]) {
    now += 10;
    const { lane } = sw.tick({ taskAvailable: avail });
    assert.notEqual(lane, LANE.IDLE);
    assert.equal(lane, avail ? LANE.TASK : LANE.HASH);
  }
});

test('Switcher: ASIC parks at IDLE only when no task, works on TASK otherwise', () => {
  let now = 0;
  const sw = new Switcher({ cap: ASIC, lanePref: 'auto', cooldownMs: 0, now: () => now });
  now = 10;
  assert.equal(sw.tick({ taskAvailable: false }).lane, LANE.IDLE);
  now = 20;
  assert.equal(sw.tick({ taskAvailable: true }).lane, LANE.TASK);
});
