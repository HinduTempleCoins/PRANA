// hardware.mjs — detect/declare capability; decide which lanes this machine CAN serve.
//
// Spec: design/compute/switching-worker.md §2 (the honest HW map, SS3). The capability
// set {canHash, canTask} is what the switcher is allowed to enter. The daemon must NOT
// pretend a capability it lacks.
//
//   | Unit | canHash (Etchash heartbeat) | canTask (AI/compute) |
//   |------|-----------------------------|----------------------|
//   | gpu  | yes (all-rounder)           | yes                  |
//   | cpu  | weak/often disabled         | yes (light/shard)    |
//   | asic | no (AI ASIC can't hash)*    | yes (fastest task)   |
//   | fpga | yes (can hash)              | limited              |
//
//   * "asic" here follows the spec's AI-ASIC (TPU/Trainium/Inferentia) row: task-only.
//     A hash-ASIC would be hash-only, but the spec's on-ramp table treats ASIC as the
//     AI-accelerator class — task-only. We keep that mapping and note it.
//
// REAL: the capability MAP (profile -> {canHash,canTask}) and the free-tier override.
// STUB: actual hardware probing. detectHardware() does a *best-effort* read of CPU core
//       count via node:os and otherwise trusts the declared profile. There is no real
//       GPU/ASIC autodetect here (would need vendor tooling / CUDA) — clearly stubbed.

import os from 'node:os';

/**
 * Static capability table by declared profile. cpuPower/taskPower are coarse 0..1 hints
 * the switcher/vardiff can use; they are illustrative, not benchmarked.
 */
const PROFILE_CAPS = Object.freeze({
  // gpu: rides the switching engine fully (best on-ramp).
  gpu: { canHash: true, canTask: true, hashPower: 1.0, taskPower: 1.0 },
  // cpu: earns via TASK, hashes poorly (spec: "CPUs earn first" = tasking-side).
  cpu: { canHash: true, canTask: true, hashPower: 0.05, taskPower: 0.3 },
  // asic: AI-accelerator class — task-only, cannot hash Etchash.
  asic: { canHash: false, canTask: true, hashPower: 0.0, taskPower: 1.5 },
  // fpga: can hash; task ability is narrow/specialized.
  fpga: { canHash: true, canTask: false, hashPower: 0.8, taskPower: 0.0 },
});

/**
 * Resolve the capability set for a config.
 * @param {{hwProfile:string, freeTier?:boolean}} cfg
 * @param {object} [deps] injectable for tests: { cpuCount?:()=>number }
 * @returns {{profile:string, canHash:boolean, canTask:boolean, hashPower:number, taskPower:number, cpuCores:number, freeTier:boolean, notes:string[]}}
 */
export function detectHardware(cfg, deps = {}) {
  const cpuCount = deps.cpuCount ?? (() => safeCpuCount());
  const base = PROFILE_CAPS[cfg.hwProfile] ?? PROFILE_CAPS.cpu;
  const cores = cpuCount();
  const notes = [];

  let canHash = base.canHash;
  let canTask = base.canTask;

  // free-tier (Colab/Kaggle) is TASK-only — ToS prohibit mining (§7 / TT1).
  if (cfg.freeTier) {
    if (canHash) notes.push('free-tier: hashing disabled (ToS-compliant, TASK-only)');
    canHash = false;
    canTask = true; // free substrate is for tasking
  }

  // A machine that ends up with NEITHER lane is misconfigured — surface it loudly.
  if (!canHash && !canTask) {
    notes.push('WARNING: no serveable lane for this profile/flags — daemon will only heartbeat');
  }

  return Object.freeze({
    profile: cfg.hwProfile,
    canHash,
    canTask,
    hashPower: base.hashPower,
    taskPower: base.taskPower,
    cpuCores: cores,
    freeTier: !!cfg.freeTier,
    notes,
  });
}

/** STUB-ish: real CPU core count from node:os (the one thing we can honestly detect). */
function safeCpuCount() {
  try {
    const list = os.cpus();
    return Array.isArray(list) && list.length > 0 ? list.length : 1;
  } catch {
    return 1;
  }
}

export const __test__ = { PROFILE_CAPS };
