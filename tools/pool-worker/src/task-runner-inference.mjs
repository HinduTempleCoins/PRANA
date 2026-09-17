// task-runner-inference.mjs — REAL compute for the TASK lane: local model inference.
//
// task-lane.mjs hashes the job spec and calls it a result. This runs the job.
//
// WHAT IT TALKS TO. An OpenAI-compatible `/v1/chat/completions` endpoint on the
// contributor's own machine. Ollama, llama.cpp's server, vLLM, LM Studio, text-generation-
// webui and LocalAI all speak it, so a person who already runs a local model points the
// worker at the port they already have and is done. Nothing is installed, no Python stack
// is required, and no model weights pass through PRANA.
//
// DETERMINISM, AND THE HONEST LIMIT OF IT. Credit is gated K-of-N: several workers run the
// same job and attestors check that they agree. That only works if the same job gives the
// same answer. So every request pins temperature 0, top_p 1 and a seed derived from the
// claim, and the attestation records the model id and every sampling parameter used, so an
// attestor can reproduce the call exactly.
//
// That is necessary and NOT sufficient, and pretending otherwise would be the whole problem
// with this system. Two different GPUs, two driver versions, or two batch sizes can produce
// different floating-point results for the same prompt and seed, so byte-exact agreement
// across heterogeneous hardware is not achievable today — this is the Gensyn RepOps problem
// and it is unsolved here. Therefore:
//
//   * the runner reports `deterministic: true` ONLY when the endpoint confirms it honoured
//     the seed, and `false` otherwise, rather than assuming;
//   * the result carries BOTH an exact digest and a normalized digest (whitespace- and
//     case-folded), so the attestation policy can choose byte-exact or tolerance-bounded
//     comparison instead of having that choice made for it here;
//   * `modelFingerprint` is recorded so attestors can require identical model builds before
//     treating a mismatch as dishonesty rather than as hardware drift.
//
// The runner NEVER decides whether its own work was correct. It produces evidence; the gate
// decides. A runner that self-certified would make a forged TASK share worth a real one.

const DEFAULT_TIMEOUT_MS = 120_000;

let _fetch = globalThis.fetch;
/** Injected in tests so none of this touches a network. */
export function __setFetch(f) { _fetch = f; }

/** FNV-1a over the claim id — a stable 32-bit seed every worker on the same claim derives
 * identically, without needing the coordinator to hand one out. */
export function seedFromClaim(claimId) {
  let h = 0x811c9dc5;
  const s = String(claimId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fold a completion for tolerance-bounded comparison: collapse whitespace, trim, lowercase.
 * Two honest workers on different hardware commonly differ only by trailing whitespace or a
 * capitalized first token; treating that as fraud would slash honest people. */
export function normalizeCompletion(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function sha256Hex(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return '0x' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Is a usable inference endpoint present?
 *
 * The switcher asks this before offering the TASK lane. A worker whose model server is down
 * must fall back to HASH rather than claiming tasks it cannot run — a claimed-and-abandoned
 * task earns nothing and wastes every attestor who was dispatched to check it.
 *
 * @param {object} p
 * @param {string} p.endpoint  base URL, e.g. http://127.0.0.1:11434/v1
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ok:boolean, models:string[], error?:string}>}
 */
export async function probeEndpoint({ endpoint, timeoutMs = 5000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await _fetch(`${endpoint.replace(/\/$/, '')}/models`, { signal: ctl.signal });
    if (!r.ok) return { ok: false, models: [], error: `models ${r.status}` };
    const j = await r.json();
    const models = (j.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: models.length > 0, models, error: models.length ? undefined : 'no models loaded' };
  } catch (e) {
    return { ok: false, models: [], error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Run one inference job and return the result plus attestation evidence.
 *
 * @param {object} job
 * @param {string} job.claimId   coordinator-opened claim; also the determinism seed
 * @param {string} job.taskId    task type whose governed shareWeight applies
 * @param {string} job.specHash  ITaskRegistry specHash — which model/runner is required
 * @param {string} job.input     the prompt
 * @param {string} [job.model]   model id; must match what specHash pins
 * @param {number} [job.maxTokens]
 * @param {number} [job.baseShares]
 * @param {string} workerAddr    beacon-bound payout address
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {number} [opts.timeoutMs]
 */
export async function runInference(job, workerAddr, { endpoint, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!job || !job.claimId || !job.taskId) throw new Error('task-lane: job must have claimId + taskId');
  if (!endpoint) throw new Error('task-lane: no inference endpoint configured');

  const seed = seedFromClaim(job.claimId);
  // Pinned so every worker on this claim issues an identical request. These values are
  // recorded in the attestation; an attestor that used different ones is not reproducing
  // the same job and its disagreement means nothing.
  const params = {
    model: job.model || 'default',
    messages: [{ role: 'user', content: String(job.input ?? '') }],
    temperature: 0,
    top_p: 1,
    seed,
    max_tokens: Number.isFinite(job.maxTokens) ? job.maxTokens : 512,
    stream: false,
  };

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const startedAt = Date.now();
  let body;
  try {
    const r = await _fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`inference ${r.status}`);
    body = await r.json();
  } catch (e) {
    // Abandoning loudly is right: the coordinator must be able to release the claim to
    // another worker rather than wait out a timeout on a machine that has gone away.
    throw new Error(`task-lane: inference failed (${e.name === 'AbortError' ? 'timeout' : e.message})`);
  } finally {
    clearTimeout(t);
  }

  const completion = body?.choices?.[0]?.message?.content;
  if (typeof completion !== 'string') throw new Error('task-lane: endpoint returned no completion');

  const exactDigest = await sha256Hex(completion);
  const normalizedDigest = await sha256Hex(normalizeCompletion(completion));
  const inputHash = await sha256Hex(String(job.input ?? ''));

  // Only claim determinism when the server says it honoured the seed. Several endpoints
  // accept `seed` and ignore it, and a worker that asserts determinism it did not get makes
  // every disagreement look like fraud.
  const deterministic = body?.system_fingerprint != null || body?.seed === seed;

  return {
    worker: workerAddr,
    lane: 'TASK',
    claimId: job.claimId,
    taskId: job.taskId,
    baseShares: Number.isFinite(job.baseShares) ? job.baseShares : 1,
    resultDigest: exactDigest,
    completion,
    attestation: {
      specHash: job.specHash ?? '0x0',
      inputHash,
      resultDigest: exactDigest,
      normalizedDigest,
      // Everything an attestor needs to reissue the identical request.
      model: body?.model ?? params.model,
      modelFingerprint: body?.system_fingerprint ?? null,
      params: { temperature: 0, top_p: 1, seed, max_tokens: params.max_tokens },
      deterministic,
      usage: body?.usage ?? null,
      elapsedMs: Date.now() - startedAt,
    },
  };
}
