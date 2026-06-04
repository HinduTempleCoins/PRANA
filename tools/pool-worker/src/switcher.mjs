// switcher.mjs — THE auto-switch arbiter (hash <-> task).
//
// Spec: design/compute/switching-worker.md §0, §3 + §15 graceful degradation. Keep the unit
// NEVER IDLE: when TASK jobs are available -> do TASK (serves Hathor's anchor demand, the
// higher-value lane); when none -> fall back to HASH so the chain stays lit; switch back to
// TASK when demand returns. Both lanes pool at EQUAL weight, so the worker is indifferent to
// pay — the bias toward TASK only exists to serve anchor demand first.
//
// REAL + unit-testable: decideLane() is a PURE function of (capabilities, taskAvailable,
// lanePref, current state, cooldown elapsed, inFlightTask). The Switcher class adds the
// hysteresis clock so bursty queues don't thrash. NO timers, NO I/O here — the caller owns
// the loop and supplies `now`.

/** Lane states. IDLE = no serveable lane (ASIC w/ no task, or misconfig) -> heartbeat only. */
export const LANE = Object.freeze({ TASK: 'TASK', HASH: 'HASH', IDLE: 'IDLE' });

/**
 * Pure decision: which lane should the worker be in for this tick?
 *
 * Rules (in order):
 *  1. If a task is in flight, STAY on TASK — never preempt mid-task (a half-done task earns
 *     nothing, §3). This overrides everything below.
 *  2. lanePref 'hash' + canHash -> HASH (operator forced hash-only).
 *  3. Task available AND canTask -> prefer TASK, BUT respect cooldown when *switching from
 *     HASH* (hysteresis: don't flip HASH->TASK until cooldown elapsed). lanePref 'task'
 *     also lands here; 'auto' is task-first by spec.
 *  4. No task (or can't task) AND canHash -> HASH (graceful degradation — never idle).
 *  5. Otherwise IDLE (no serveable lane) -> caller heartbeats + polls.
 *
 * @param {object} p
 * @param {{canHash:boolean, canTask:boolean}} p.cap
 * @param {boolean} p.taskAvailable   did the coordinator offer a task this tick?
 * @param {'task'|'hash'|'auto'} p.lanePref
 * @param {'TASK'|'HASH'|'IDLE'} p.current     current lane
 * @param {boolean} p.cooldownElapsed has the switch cooldown passed since the last switch?
 * @param {boolean} [p.inFlightTask]  is a task currently mid-run? (no preemption)
 * @returns {'TASK'|'HASH'|'IDLE'}
 */
export function decideLane({
  cap,
  taskAvailable,
  lanePref,
  current,
  cooldownElapsed,
  inFlightTask = false,
}) {
  // 1. never preempt an in-flight task.
  if (inFlightTask && cap.canTask) return LANE.TASK;

  // 2. operator forced hash-only.
  if (lanePref === 'hash' && cap.canHash) return LANE.HASH;

  const wantTask = taskAvailable && cap.canTask;

  if (wantTask) {
    // 3. hysteresis: only flip HASH->TASK once the cooldown has elapsed. If we're already
    //    TASK (or IDLE, or coming from a non-hash state), enter TASK immediately.
    if (current === LANE.HASH && !cooldownElapsed) {
      // still cooling down from a recent switch — keep hashing this tick.
      return cap.canHash ? LANE.HASH : LANE.TASK;
    }
    return LANE.TASK;
  }

  // 4. graceful degradation: no task -> hash if we can (never idle).
  if (cap.canHash) {
    // hysteresis the other way: only flip TASK->HASH once cooldown elapsed, so a brief gap
    // in task supply doesn't bounce us off TASK. If already HASH/IDLE, go HASH.
    if (current === LANE.TASK && !cooldownElapsed) return LANE.TASK;
    return LANE.HASH;
  }

  // 5. nothing serveable.
  return LANE.IDLE;
}

/**
 * Stateful wrapper that tracks the current lane + the timestamp of the last switch so the
 * caller doesn't have to. Inject `now` (a () => ms function) so tests are deterministic and
 * no real timers are involved.
 */
export class Switcher {
  /**
   * @param {object} opts
   * @param {{canHash:boolean, canTask:boolean}} opts.cap
   * @param {'task'|'hash'|'auto'} opts.lanePref
   * @param {number} opts.cooldownMs hysteresis window
   * @param {() => number} [opts.now] clock (default Date.now)
   */
  constructor({ cap, lanePref, cooldownMs, now = Date.now }) {
    this.cap = cap;
    this.lanePref = lanePref;
    this.cooldownMs = Math.max(0, cooldownMs);
    this._now = now;
    this.current = LANE.IDLE;
    this._lastSwitchAt = -Infinity; // so the first decision can switch freely
  }

  /**
   * Decide + record the lane for this tick.
   * @param {object} ctx
   * @param {boolean} ctx.taskAvailable
   * @param {boolean} [ctx.inFlightTask]
   * @returns {{lane:'TASK'|'HASH'|'IDLE', switched:boolean}}
   */
  tick({ taskAvailable, inFlightTask = false }) {
    const t = this._now();
    const cooldownElapsed = t - this._lastSwitchAt >= this.cooldownMs;

    const lane = decideLane({
      cap: this.cap,
      taskAvailable,
      lanePref: this.lanePref,
      current: this.current,
      cooldownElapsed,
      inFlightTask,
    });

    const switched = lane !== this.current;
    if (switched) {
      this.current = lane;
      this._lastSwitchAt = t;
    }
    return { lane, switched };
  }
}
