// node:test — InferenceRouter fallthrough (TASK XX19). Backends are injected
// stubs, so no network/models; fully deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InferenceRouter, createRouter } from '../src/router.mjs';
import {
  makeRiverBackend,
  makeFreeApiBackend,
  makeCloudBackend,
  PRIORITY,
} from '../src/backends.mjs';
import { TokenBucket } from '../src/ratelimit.mjs';

test('respects priority: river is tried before cloud even if listed last', async () => {
  const cloud = makeCloudBackend('cloud-1');
  const river = makeRiverBackend('river-1');
  // Pass cloud FIRST in the array; priority must still pick river.
  const router = new InferenceRouter([cloud, river]);
  const res = await router.infer('hi');
  assert.equal(res.servedBy, 'river-1');
  assert.equal(res.kind, 'river');
});

test('falls through on infer() failure to the next backend', async () => {
  const river = makeRiverBackend('river-1', { fail: true }); // throws in infer()
  const free = makeFreeApiBackend('free-1');
  const router = new InferenceRouter([river, free]);
  const res = await router.infer('hi');
  assert.equal(res.servedBy, 'free-1'); // fell through past the failing river node
  // trail records the river failure then the free-api success
  assert.equal(res.attempts[0].backend, 'river-1');
  assert.equal(res.attempts[0].outcome, 'failed');
  assert.equal(res.attempts.at(-1).outcome, 'success');
});

test('skips unhealthy backends', async () => {
  const river = makeRiverBackend('river-1', { healthy: false }); // healthCheck -> false
  const cloud = makeCloudBackend('cloud-1');
  const router = new InferenceRouter([river, cloud]);
  const res = await router.infer('hi');
  assert.equal(res.servedBy, 'cloud-1');
  assert.equal(res.attempts[0].outcome, 'unhealthy');
});

test('skips a throwing healthCheck as unhealthy', async () => {
  const bad = {
    name: 'bad',
    kind: 'river',
    priority: PRIORITY.RIVER,
    async healthCheck() {
      throw new Error('coordinator unreachable');
    },
    async infer() {
      throw new Error('should never be called');
    },
  };
  const cloud = makeCloudBackend('cloud-1');
  const router = new InferenceRouter([bad, cloud]);
  const res = await router.infer('hi');
  assert.equal(res.servedBy, 'cloud-1');
});

test('falls through a ratelimited (empty-bucket) free-api backend', async () => {
  // Empty bucket -> router must skip without calling infer().
  const emptyBucket = new TokenBucket({ capacity: 1, refillPerSec: 0 });
  assert.equal(emptyBucket.tryRemove(1), true); // drain it
  const free = makeFreeApiBackend('free-1', { bucket: emptyBucket });
  const cloud = makeCloudBackend('cloud-1');
  const router = new InferenceRouter([free, cloud]);
  const res = await router.infer('hi');
  assert.equal(res.servedBy, 'cloud-1');
  assert.equal(res.attempts[0].outcome, 'ratelimited');
});

test('full ladder fallthrough: river fail -> free ratelimited -> cloud serves', async () => {
  const river = makeRiverBackend('river-1', { fail: true, priority: PRIORITY.RIVER });
  const emptyBucket = new TokenBucket({ capacity: 1, refillPerSec: 0 });
  emptyBucket.tryRemove(1);
  const free = makeFreeApiBackend('free-1', {
    bucket: emptyBucket,
    priority: PRIORITY.FREE_API,
  });
  const cloud = makeCloudBackend('cloud-1', { priority: PRIORITY.CLOUD });
  const router = createRouter([free, cloud, river]); // out of order on purpose
  const res = await router.infer('hello');
  assert.equal(res.servedBy, 'cloud-1');
  assert.deepEqual(
    res.attempts.map((a) => [a.backend, a.outcome]),
    [
      ['river-1', 'failed'],
      ['free-1', 'ratelimited'],
      ['cloud-1', 'success'],
    ],
  );
});

test('throws AggregateError when every backend is exhausted', async () => {
  const river = makeRiverBackend('river-1', { fail: true });
  const cloud = makeCloudBackend('cloud-1', { fail: true });
  const router = new InferenceRouter([river, cloud]);
  await assert.rejects(
    () => router.infer('hi'),
    (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.attempts.length, 2);
      assert.ok(err.attempts.every((a) => a.outcome === 'failed'));
      return true;
    },
  );
});

test('free-api token bucket is actually charged per successful request', async () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSec: 0 });
  const free = makeFreeApiBackend('free-1', { bucket });
  const cloud = makeCloudBackend('cloud-1');
  const router = new InferenceRouter([free, cloud]);
  // first two requests served by free-api, draining the bucket
  assert.equal((await router.infer('a')).servedBy, 'free-1');
  assert.equal((await router.infer('b')).servedBy, 'free-1');
  // third: bucket empty -> falls through to cloud
  assert.equal((await router.infer('c')).servedBy, 'cloud-1');
});

test('onAttempt observability hook fires per attempt', async () => {
  const events = [];
  const river = makeRiverBackend('river-1', { fail: true });
  const cloud = makeCloudBackend('cloud-1');
  const router = new InferenceRouter([river, cloud], {
    onAttempt: (e) => events.push(`${e.backend}:${e.outcome}`),
  });
  await router.infer('hi');
  assert.deepEqual(events, ['river-1:failed', 'cloud-1:success']);
});

test('rejects empty backend list', () => {
  assert.throws(() => new InferenceRouter([]));
});
