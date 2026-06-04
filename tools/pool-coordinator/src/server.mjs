// server.mjs — the node:http surface workers talk to. NO express; built-ins only.
//
// Spec: coordinator.md §2 (share-collection API, worker⇄coordinator). The on-the-wire shapes
// MUST match the sibling worker (pool-worker), which POSTs to /submit-share with
//   { workerId, lane, proof|result, difficulty }   (+ account, nonce, attestation).
//
// Endpoints:
//   POST /submit-share  W→C  submit a HASH or TASK share. Validated, deduped (TASK jobs),
//                            accumulated into the open epoch. → { ok, accepted, units, reason? }
//   GET  /job           W→C  pull an available AI job + claim it for the worker. → { jobId, spec }
//   GET  /stats         *    difficulty, connected workers, current epoch, job/share counts.
//   GET  /health        *    liveness.
//
// This module is pure plumbing over the (testable) core modules; it owns NO business logic
// beyond request parsing + wiring. createServer() returns the http.Server WITHOUT listening so
// a test (or index.mjs) controls the lifecycle.

import http from 'node:http';

/**
 * @param {object} deps
 * @param {object} deps.config        from loadConfig().
 * @param {object} deps.validator     { validateShare } module (share-validator.mjs).
 * @param {object} deps.jobRegistry   JobRegistry instance.
 * @param {object} deps.batcher       EpochBatcher instance.
 * @param {(line:string)=>void} [deps.log]
 * @returns {{server: import('node:http').Server, state: object}}
 */
export function createServer({ config, validator, jobRegistry, batcher, log = () => {} }) {
  // lightweight liveness/metrics state (the "connected workers" + difficulty for /stats).
  const state = {
    seenWorkers: new Map(), // workerId → lastSeenMs (heartbeat-ish: any request refreshes it)
    accepted: 0,
    rejected: 0,
    startedAt: Date.now(),
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[server] unhandled: ${err?.message || err}`);
      sendJson(res, 500, { ok: false, error: 'internal' });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, coin: config.coin.symbol });
    }
    if (req.method === 'GET' && path === '/stats') {
      return sendJson(res, 200, buildStats());
    }
    if (req.method === 'GET' && path === '/job') {
      return handleJob(url, res);
    }
    if (req.method === 'POST' && path === '/submit-share') {
      return handleSubmitShare(req, res);
    }
    return sendJson(res, 404, { ok: false, error: 'not-found' });
  }

  // ----------------------- GET /job -----------------------
  function handleJob(url, res) {
    const worker = url.searchParams.get('account') || url.searchParams.get('worker');
    if (!isAddress(worker)) {
      return sendJson(res, 400, { ok: false, reason: 'bad-account' });
    }
    touch(url.searchParams.get('workerId'));
    const job = jobRegistry.nextOpenJob();
    if (!job) {
      // graceful degradation (PR3): no AI demand ⇒ tell the worker to hash instead.
      return sendJson(res, 200, { ok: true, job: null, fallbackLane: 'hash' });
    }
    const claim = jobRegistry.claimJob(job.jobId, worker);
    if (!claim.ok) {
      // raced with another worker; tell it to retry/hash.
      return sendJson(res, 200, { ok: true, job: null, fallbackLane: 'hash', reason: claim.reason });
    }
    return sendJson(res, 200, {
      ok: true,
      job: { jobId: job.jobId, spec: job.spec },
      // K-of-N attestation parameters the worker must satisfy on result return.
      attest: { k: config.attestK, n: config.attestN },
    });
  }

  // ----------------------- POST /submit-share -----------------------
  async function handleSubmitShare(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      state.rejected++;
      return sendJson(res, 400, { ok: false, accepted: false, reason: `bad-json:${e.message}` });
    }
    touch(body?.workerId);

    const result = validator.validateShare(body, {
      minDifficulty: 1, // coordinator's vardiff floor (PR9; share normalized against it)
      attestK: config.attestK,
      attestN: config.attestN,
    });

    if (!result.ok) {
      state.rejected++;
      return sendJson(res, 200, { ok: true, accepted: false, reason: result.reason });
    }

    if (result.lane === 'hash') {
      batcher.addHashShare(result);
      state.accepted++;
      return sendJson(res, 200, {
        ok: true,
        accepted: true,
        lane: 'hash',
        units: result.normalized,
        epoch: batcher.epochAt(nowSec()),
      });
    }

    // lane === 'task': dedup the job across coordinators (local mirror of JobClaimLedger), then
    // record the verified completion for settlement via creditVerified.
    const jobId = body.jobId;
    if (isBytes32(jobId)) {
      // settle the local claim so the same job can't be re-credited here; cross-coordinator
      // finality also happens on-chain via JobClaimLedger.settle in the settler (settle.mjs).
      const s = jobRegistry.settleJob(jobId);
      if (!s.ok && s.reason === 'already-settled') {
        state.rejected++;
        return sendJson(res, 200, { ok: true, accepted: false, reason: 'job-already-settled' });
      }
    }
    batcher.addTaskCompletion({
      account: result.account,
      claimId: result.claimId,
      taskId: body.taskId ?? defaultTaskId(),
      baseShares: result.normalized,
    });
    state.accepted++;
    return sendJson(res, 200, {
      ok: true,
      accepted: true,
      lane: 'task',
      claimId: result.claimId,
      epoch: batcher.epochAt(nowSec()),
    });
  }

  // ----------------------- /stats body -----------------------
  function buildStats() {
    const ACTIVE_MS = 60_000;
    const now = Date.now();
    let connected = 0;
    for (const last of state.seenWorkers.values()) if (now - last <= ACTIVE_MS) connected++;
    return {
      ok: true,
      coin: { key: config.coin.key, symbol: config.coin.symbol, chainId: config.coin.chainId },
      coordinatorId: config.coordinatorId,
      difficulty: config.shareDifficulty,
      epochLengthSeconds: config.epochLengthSeconds,
      currentEpoch: batcher.epochAt(nowSec()),
      pendingEpochs: batcher.pendingEpochs(),
      connectedWorkers: connected,
      knownWorkers: state.seenWorkers.size,
      shares: { accepted: state.accepted, rejected: state.rejected },
      jobs: jobRegistry.counts(),
      uptimeMs: now - state.startedAt,
    };
  }

  function touch(workerId) {
    if (typeof workerId === 'string' && workerId.length) {
      state.seenWorkers.set(workerId, Date.now());
    }
  }

  return { server, state };
}

// ----------------------------- helpers -----------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    const LIMIT = 1 << 20; // 1 MiB cap — refuse oversized bodies
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      buf += c;
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isBytes32(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function defaultTaskId() {
  // a generic "AI inference" task-type id placeholder (TaskRegistry id in prod).
  return '0x' + '00'.repeat(31) + '01';
}
