// index.mjs — wire it all: load config -> detect hardware -> main loop.
//
// Spec: design/compute/switching-worker.md §1 (`main`: lifecycle, config load, graceful
// shutdown) + §3 (the decision loop). The loop: switcher picks a lane -> do work (hash or
// task stub) -> submit the share to the coordinator via the RPC client. Never idle.
//
// REAL: the control flow + the share->submission shapes. STUB: the actual PoW (hash-lane)
// and AI compute (task-lane), and there is no live coordinator unless one is running.
//
// TIMERS: the only timer is the loop's setTimeout, created with .unref() so the process
// (and node:test) can exit cleanly. The loop also stops on SIGINT/SIGTERM.

import { loadConfig } from './config.mjs';
import { detectHardware } from './hardware.mjs';
import { VardiffController } from './vardiff.mjs';
import { Switcher, LANE } from './switcher.mjs';
import { mineOne, toSubmission as hashSubmission } from './hash-lane.mjs';
import { runTask, toSubmission as taskSubmission } from './task-lane.mjs';
import { CoordinatorClient } from './coordinator-rpc.mjs';

// Governed vardiff bounds. In the real daemon these are READ from
// HashTaskWeightConfig.min/maxDifficulty() via a read-only RPC (chainview). Here they are
// sane dev defaults; clearly a stub for the on-chain read.
const VARDIFF_BOUNDS = { minDifficulty: 1, maxDifficulty: 1_000_000 };

/**
 * Build a runnable daemon. Returns { start, stop } so tests/embedders can drive it without
 * the process-level signal handlers. All collaborators are injectable.
 * @param {object} [overrides]
 */
export function createDaemon(overrides = {}) {
  const cfg = overrides.config ?? loadConfig();
  const hw = overrides.hardware ?? detectHardware(cfg);
  const log = overrides.log ?? makeLogger(cfg.workerId);

  const coordinator =
    overrides.coordinator ??
    new CoordinatorClient({
      url: cfg.coordinatorUrl,
      workerAddr: cfg.workerAddr,
      workerId: cfg.workerId,
    });

  const vardiff =
    overrides.vardiff ??
    new VardiffController({
      targetSeconds: cfg.vardiffTargetSeconds,
      minDifficulty: VARDIFF_BOUNDS.minDifficulty,
      maxDifficulty: VARDIFF_BOUNDS.maxDifficulty,
    });

  const switcher =
    overrides.switcher ??
    new Switcher({ cap: hw, lanePref: cfg.lanePref, cooldownMs: cfg.switchCooldownMs });

  // injectable clock + scheduler for deterministic tests.
  const setTimer = overrides.setTimer ?? defaultSetTimer;

  let running = false;
  let inFlightTask = false;
  let timer = null;

  /** One iteration of the decision loop. Exposed for step-wise testing. */
  async function tickOnce() {
    // 1. ask the coordinator whether a task is available (non-blocking claim attempt).
    let task = null;
    if (hw.canTask) {
      const r = await coordinator.tryClaimTask(hw);
      if (r.ok && r.data && r.data.task) task = r.data.task;
      else if (!r.ok) log.warn(`coordinator unreachable: ${r.error} — backing off`);
    }

    // 2. arbiter decides the lane (task-first, hash fallback, hysteresis).
    const { lane, switched } = switcher.tick({
      taskAvailable: !!task,
      inFlightTask,
    });
    if (switched) log.info(`switched -> ${lane}`);

    // 3. do the work for the chosen lane and submit.
    if (lane === LANE.TASK && task) {
      inFlightTask = true;
      try {
        const result = runTask(task, cfg.workerAddr); // STUB compute
        const sub = taskSubmission(result);
        const r = await coordinator.submitTaskResult(sub);
        log.info(
          `TASK submitted claim=${sub.claimId} base=${sub.baseShares} ` +
            `(verify async; credit via TaskLaneCreditor.creditVerified)` +
            (r.ok ? '' : ` [submit failed: ${r.error}]`),
        );
      } finally {
        inFlightTask = false;
      }
    } else if (lane === LANE.HASH) {
      const difficulty = vardiff.currentTarget();
      const share = mineOne({ difficulty, hashPower: hw.hashPower, workerAddr: cfg.workerAddr });
      if (share.meetsTarget) {
        const sub = hashSubmission(share);
        const r = await coordinator.submitHashShare(sub);
        // feed vardiff the observed solve time so cadence converges to target.
        vardiff.observe(share.solveSeconds);
        log.info(
          `HASH share diff=${difficulty.toFixed(0)} solve=${share.solveSeconds.toFixed(2)}s ` +
            `-> nextDiff=${vardiff.currentTarget().toFixed(0)}` +
            (r.ok ? '' : ` [submit failed: ${r.error}]`),
        );
      }
    } else {
      // IDLE: no serveable lane (e.g. ASIC with no task) — heartbeat + poll, never spin.
      await coordinator.heartbeat();
    }

    return lane;
  }

  function scheduleNext(delayMs) {
    if (!running) return;
    timer = setTimer(loop, delayMs);
    // belt-and-suspenders: unref any real timer so it never blocks process exit.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function loop() {
    if (!running) return;
    let delay = cfg.pollIntervalMs;
    try {
      await tickOnce();
    } catch (err) {
      log.error(`loop error: ${String(err?.message || err)}`);
      delay = cfg.backoffMs; // back off on unexpected error (§7)
    }
    scheduleNext(delay);
  }

  function start() {
    if (running) return;
    running = true;
    log.info(
      `starting: profile=${hw.profile} canHash=${hw.canHash} canTask=${hw.canTask} ` +
        `lanePref=${cfg.lanePref} coordinator=${cfg.coordinatorUrl}`,
    );
    hw.notes.forEach((n) => log.info(`hw: ${n}`));
    // kick the loop immediately (no initial delay).
    scheduleNext(0);
  }

  function stop() {
    running = false;
    if (timer && typeof timer.clear === 'function') timer.clear();
  }

  return { start, stop, tickOnce, get running() { return running; }, config: cfg, hardware: hw };
}

/** Default scheduler: setTimeout returning an object with .unref()/.clear(). */
function defaultSetTimer(fn, ms) {
  const h = setTimeout(fn, ms);
  if (typeof h.unref === 'function') h.unref();
  return { unref: () => h.unref?.(), clear: () => clearTimeout(h) };
}

function makeLogger(id) {
  const tag = `[pool-worker ${id}]`;
  return {
    info: (m) => console.log(`${tag} ${m}`),
    warn: (m) => console.warn(`${tag} ${m}`),
    error: (m) => console.error(`${tag} ${m}`),
  };
}

// Run directly: `node src/index.mjs` (or `npm start`).
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const daemon = createDaemon();
  const shutdown = () => {
    console.log('\n[pool-worker] shutting down…');
    daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  daemon.start();
}
