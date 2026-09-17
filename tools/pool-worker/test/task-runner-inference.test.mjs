// Tests for real TASK-lane compute. No network: fetch is injected.
//
// What these pin is the part that decides whether an honest worker gets paid or slashed —
// the request every worker on a claim must issue identically, and the evidence the gate
// uses to tell hardware drift apart from fraud.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __setFetch, runInference, probeEndpoint, seedFromClaim, normalizeCompletion,
} from '../src/task-runner-inference.mjs';

const ADDR = '0xd0f70C197138f70cDB90317c07feecCE6A2bF2ef';
const EP = 'http://127.0.0.1:11434/v1';

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj };
}

function completionBody(content, extra = {}) {
  return {
    model: 'qwen2.5:7b',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
    ...extra,
  };
}

const JOB = { claimId: 'claim-1', taskId: 'task-a', specHash: '0xspec', input: 'what is 2+2?' };

// Every worker on the same claim must derive the same seed without being told one, or the
// same job produces different sampling and honest workers disagree.
test('the seed is derived from the claim id and is stable', () => {
  assert.equal(seedFromClaim('claim-1'), seedFromClaim('claim-1'));
  assert.notEqual(seedFromClaim('claim-1'), seedFromClaim('claim-2'));
  assert.ok(Number.isInteger(seedFromClaim('x')) && seedFromClaim('x') >= 0);
});

test('the request pins determinism and carries the derived seed', async () => {
  let sent = null;
  __setFetch(async (_url, opts) => { sent = JSON.parse(opts.body); return jsonResponse(completionBody('4')); });
  await runInference(JOB, ADDR, { endpoint: EP });
  assert.equal(sent.temperature, 0, 'any sampling temperature breaks K-of-N agreement');
  assert.equal(sent.top_p, 1);
  assert.equal(sent.seed, seedFromClaim('claim-1'));
  assert.equal(sent.stream, false);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'what is 2+2?' }]);
});

test('the result carries both digests so the gate can pick its comparison', async () => {
  __setFetch(async () => jsonResponse(completionBody('  The Answer IS 4.  ')));
  const r = await runInference(JOB, ADDR, { endpoint: EP });
  assert.equal(r.lane, 'TASK');
  assert.equal(r.worker, ADDR);
  assert.equal(r.claimId, 'claim-1');
  assert.match(r.resultDigest, /^0x[0-9a-f]{64}$/);
  assert.match(r.attestation.normalizedDigest, /^0x[0-9a-f]{64}$/);
  assert.notEqual(r.resultDigest, r.attestation.normalizedDigest);
});

// Two honest workers on different hardware commonly differ only by trailing whitespace or a
// capitalized first token. Byte-exact comparison would slash both of them.
test('normalization folds the differences that are not disagreements', async () => {
  const a = normalizeCompletion('The answer is 4.');
  const b = normalizeCompletion('  the Answer   is 4.  \n');
  assert.equal(a, b);
  assert.notEqual(normalizeCompletion('the answer is 4'), normalizeCompletion('the answer is 5'));
});

test('two workers running the same claim produce the same digests', async () => {
  __setFetch(async () => jsonResponse(completionBody('4')));
  const one = await runInference(JOB, ADDR, { endpoint: EP });
  const two = await runInference(JOB, '0x' + '2'.repeat(40), { endpoint: EP });
  assert.equal(one.resultDigest, two.resultDigest, 'agreement is the whole basis of K-of-N credit');
  assert.equal(one.attestation.params.seed, two.attestation.params.seed);
});

// An endpoint that accepts `seed` and ignores it makes every honest disagreement look like
// fraud. Claiming determinism we did not get is worse than admitting we cannot tell.
test('determinism is reported, not assumed', async () => {
  __setFetch(async () => jsonResponse(completionBody('4')));
  const unconfirmed = await runInference(JOB, ADDR, { endpoint: EP });
  assert.equal(unconfirmed.attestation.deterministic, false);

  __setFetch(async () => jsonResponse(completionBody('4', { system_fingerprint: 'fp_abc' })));
  const confirmed = await runInference(JOB, ADDR, { endpoint: EP });
  assert.equal(confirmed.attestation.deterministic, true);
  assert.equal(confirmed.attestation.modelFingerprint, 'fp_abc');
});

// Attestors must be able to reissue the identical request, or their disagreement means
// nothing about whether the worker was honest.
test('the attestation records everything needed to reproduce the call', async () => {
  __setFetch(async () => jsonResponse(completionBody('4')));
  const { attestation: a } = await runInference({ ...JOB, maxTokens: 64 }, ADDR, { endpoint: EP });
  assert.equal(a.specHash, '0xspec');
  assert.equal(a.model, 'qwen2.5:7b');
  assert.deepEqual(a.params, { temperature: 0, top_p: 1, seed: seedFromClaim('claim-1'), max_tokens: 64 });
  assert.match(a.inputHash, /^0x[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(a.elapsedMs));
});

// A runner that certified its own work would make a forged TASK share worth a real one.
test('the runner never certifies itself', async () => {
  __setFetch(async () => jsonResponse(completionBody('4')));
  const r = await runInference(JOB, ADDR, { endpoint: EP });
  for (const k of ['verified', 'valid', 'approved', 'attested']) {
    assert.equal(k in r, false, `runner must not assert ${k}`);
    assert.equal(k in r.attestation, false, `attestation must not assert ${k}`);
  }
});

// Failing loudly lets the coordinator release the claim to someone else instead of waiting
// out a machine that has gone away.
test('a failed or empty inference throws rather than returning a share', async () => {
  __setFetch(async () => jsonResponse({}, false, 503));
  await assert.rejects(() => runInference(JOB, ADDR, { endpoint: EP }), /inference failed/);

  __setFetch(async () => jsonResponse({ choices: [] }));
  await assert.rejects(() => runInference(JOB, ADDR, { endpoint: EP }), /no completion/);

  __setFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => runInference(JOB, ADDR, { endpoint: EP }), /timeout/);
});

test('a job without a claim or task id is refused', async () => {
  await assert.rejects(() => runInference({ claimId: 'c' }, ADDR, { endpoint: EP }), /claimId \+ taskId/);
  await assert.rejects(() => runInference(JOB, ADDR, { endpoint: '' }), /no inference endpoint/);
});

// The switcher asks this before offering TASK. A worker that claims tasks it cannot run
// earns nothing and wastes every attestor dispatched to check it.
test('probe reports honestly so the switcher can fall back to HASH', async () => {
  __setFetch(async () => jsonResponse({ data: [{ id: 'qwen2.5:7b' }] }));
  assert.deepEqual(await probeEndpoint({ endpoint: EP }), { ok: true, models: ['qwen2.5:7b'], error: undefined });

  __setFetch(async () => jsonResponse({ data: [] }));
  const empty = await probeEndpoint({ endpoint: EP });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no models loaded');

  __setFetch(async () => { throw new Error('ECONNREFUSED'); });
  const down = await probeEndpoint({ endpoint: EP });
  assert.equal(down.ok, false);
  assert.match(down.error, /ECONNREFUSED/);
});
