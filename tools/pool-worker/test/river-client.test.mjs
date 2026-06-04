// node:test — river client stub (TASK XX20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinRiver, RiverClient } from '../src/river-client.mjs';

test('joinRiver registers the worker with the coordinator', () => {
  const client = joinRiver('dht://coordinator.local:31337', 'blocks:0-7');
  assert.ok(client instanceof RiverClient);
  assert.equal(client.registered, true);
  assert.equal(client.shardId, 'blocks:0-7');
  assert.equal(client.coordinatorUrl, 'dht://coordinator.local:31337');
});

test('joinRiver validates args', () => {
  assert.throws(() => joinRiver('', 'shard-0'));
  assert.throws(() => joinRiver('dht://x', null));
});

test('heartbeat starts a timer that is unref\'d (does not pin the loop)', () => {
  const client = joinRiver('dht://x', 0, { heartbeatMs: 10 });
  const timer = client.heartbeat();
  // A Timeout exposes hasRef(); after unref() it must report false so it cannot
  // keep the process / test runner alive.
  assert.equal(typeof timer.hasRef, 'function');
  assert.equal(timer.hasRef(), false);
  client.leave(); // clean up the interval
});

test('heartbeat is idempotent and requires joining first', () => {
  const client = joinRiver('dht://x', 1);
  const t1 = client.heartbeat();
  const t2 = client.heartbeat();
  assert.equal(t1, t2); // same timer, not a second interval
  client.leave();
  assert.throws(() => client.heartbeat()); // after leaving, must rejoin
});

test('serveShard returns a deterministic stubbed activation', async () => {
  const client = joinRiver('dht://x', 'blocks:8-15');
  const out = await client.serveShard({ prompt: 'breath' });
  assert.equal(out.served, true);
  assert.equal(out.shardId, 'blocks:8-15');
  assert.equal(out.output, '[shard:blocks:8-15] forward(breath)');
});

test('leave() stops heartbeating and deregisters', () => {
  const client = joinRiver('dht://x', 2, { heartbeatMs: 5 });
  client.heartbeat();
  client.leave();
  assert.equal(client.registered, false);
});
