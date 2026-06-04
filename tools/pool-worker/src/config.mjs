// config.mjs — load + validate the worker daemon's runtime config.
//
// Spec: design/compute/switching-worker.md §1 (the `config` module): "coordinator URL,
// wallet/beacon binding, HW profile, lane prefs". Everything here is plain data; no I/O
// beyond reading process.env. Defaults are dev-safe (localhost coordinator, no real key).
//
// REAL vs STUB: the SHAPE of the config (fields the daemon obeys) is real. The default
// wallet address is a publicly-known dev placeholder — a real contributor sets WORKER_ADDR
// to their beacon-bound payout address.

/** Hardware profile hints a contributor can declare; hardware.mjs may override/refine. */
export const HW_KINDS = Object.freeze(['cpu', 'gpu', 'asic', 'fpga']);

/** Lane preference — which lane the switcher leans toward when both are possible. */
export const LANE_PREF = Object.freeze(['task', 'hash', 'auto']);

/** Publicly-known Anvil/Hardhat dev account #0 — DEV ONLY placeholder, never a real key. */
const DEV_WORKER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * Build a frozen config object from an env-like map (defaults to process.env).
 * Pure: pass a custom `env` in tests instead of mutating process.env.
 * @param {Record<string,string|undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const hwProfile = pick(env.PRANA_HW_PROFILE, HW_KINDS, 'cpu');
  const lanePref = pick(env.PRANA_LANE_PREF, LANE_PREF, 'auto');

  const cfg = {
    // --- coordinator (the ONLY write path; see switching-worker.md §1 boundary rule) ---
    coordinatorUrl: env.PRANA_COORDINATOR_URL || 'http://127.0.0.1:8645',

    // --- identity / payout ---
    // workerAddr is the beacon-bound payout address; ALL credit is keyed to it
    // (coordinator.md §2: "keyed by the worker's payout address").
    workerAddr: env.PRANA_WORKER_ADDR || DEV_WORKER_ADDR,
    workerId: env.PRANA_WORKER_ID || 'prana-worker-dev',

    // --- hardware self-declaration (hardware.mjs refines this) ---
    hwProfile, // 'cpu' | 'gpu' | 'asic' | 'fpga'

    // --- lane behaviour ---
    lanePref, // 'task' | 'hash' | 'auto'
    // free-tier mode is TASK-only and never hashes (switching-worker.md §7: Colab/Kaggle
    // ToS prohibit mining). Real flag, honoured by hardware.mjs + switcher.mjs.
    freeTier: bool(env.PRANA_FREE_TIER, false),

    // --- vardiff target cadence (PR9) ---
    // target seconds between accepted HASH shares; vardiff tunes difficulty to hit this.
    vardiffTargetSeconds: num(env.PRANA_VARDIFF_TARGET_SECONDS, 15),

    // --- loop pacing (all timers are .unref()'d so the process can exit) ---
    pollIntervalMs: num(env.PRANA_POLL_INTERVAL_MS, 1000),
    switchCooldownMs: num(env.PRANA_SWITCH_COOLDOWN_MS, 2000), // hysteresis (§3)
    backoffMs: num(env.PRANA_BACKOFF_MS, 3000), // coordinator-down backoff (§7)
  };

  validate(cfg);
  return Object.freeze(cfg);
}

function validate(cfg) {
  if (!/^https?:\/\//.test(cfg.coordinatorUrl)) {
    throw new Error(`config: coordinatorUrl must be http(s) URL, got "${cfg.coordinatorUrl}"`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.workerAddr)) {
    throw new Error(`config: workerAddr must be a 20-byte hex address, got "${cfg.workerAddr}"`);
  }
  if (cfg.vardiffTargetSeconds <= 0) {
    throw new Error('config: vardiffTargetSeconds must be > 0');
  }
}

function pick(v, allowed, dflt) {
  if (v == null) return dflt;
  const lower = String(v).toLowerCase();
  if (!allowed.includes(lower)) {
    throw new Error(`config: expected one of [${allowed.join(', ')}], got "${v}"`);
  }
  return lower;
}

function num(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: expected a number, got "${v}"`);
  return n;
}

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}
