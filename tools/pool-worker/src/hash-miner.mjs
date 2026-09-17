// hash-miner.mjs — REAL Etchash hashing, by supervising a miner the contributor already has.
//
// This is the production half of the HASH lane. `hash-lane.mjs` keeps the synthetic
// `mineOne()` for tests and for dev runs with no hardware; this module is what actually
// puts a GPU to work.
//
// WHY SUPERVISE INSTEAD OF IMPLEMENTING ETCHASH. A correct Etchash in pure JS is about
// 300 lines and would run at tens of hashes per second against a network difficulty near
// 190,000 — real, and useless. Meanwhile every person with a GPU already runs lolMiner,
// T-Rex, GMiner or SRBMiner, those are the binaries PRANA's own mining guide tells them
// to install, and they are already fast. So the worker's job is not to hash; it is to
// start and stop the miner the contributor already trusts, and to report what it did.
//
// This is also what makes "GPUs go to AI work when it exists and mine when it doesn't"
// true for a real machine: the switcher flips lane, this stops the miner process, the
// card is free for the task lane, and it starts again when task demand drops. The
// contributor sets it up once and never thinks about lanes.
//
// BOUNDARY: this module starts a process and reads its stdout. It never holds a key, never
// signs anything, and never talks to the chain. The miner connects to the pool's stratum
// with a payout ADDRESS only, which is public by construction.
//
// SUPPORTED MINERS. Detection is by the shape of the accepted-share line each one prints,
// because that is stable across versions in a way that CLI flags are not:
//
//   lolMiner   "Accepted    #123  ..."          T-Rex   "OK  123/124  ..."
//   GMiner     "Share accepted ..."             SRBMiner "Accepted ..."
//   nsfminer   "Accepted  ..."                  testminer "SUBMIT RESPONSE <- {"result":true"
//
// If a miner prints something this does not recognise, shares still happen — the pool sees
// them — but this module undercounts, and undercounting is reported as such rather than
// silently treated as zero hashrate.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Accepted-share patterns, in the order they are tried. Deliberately loose: a miner that
 * renames its columns should still match on the word plus a number. */
const ACCEPT_PATTERNS = [
  /\bSUBMIT RESPONSE <- \{"result":true/i, // testminer (this repo's own)
  /\bshare\s+accepted\b/i, // GMiner
  /\baccepted\b\s*#?\s*\d+/i, // lolMiner, nsfminer, SRBMiner
  /\bOK\b\s+\d+\s*\/\s*\d+/, // T-Rex
];

const REJECT_PATTERNS = [
  /\brejected\b/i,
  /\bstale\s+share\b/i,
  /\binvalid\s+share\b/i,
];

/** Hashrate lines, e.g. "23.4 MH/s", "1,024 kH/s", "980 H/s". */
const RATE_RE = /([\d.,]+)\s*(H|KH|MH|GH|TH)\/s/i;
const RATE_MULT = { H: 1, KH: 1e3, MH: 1e6, GH: 1e9, TH: 1e12 };

/**
 * Parse one line of miner output.
 * Exported so the patterns can be tested against real captured output without spawning
 * anything — the parsing is the part that rots as miners change their formatting.
 * @param {string} line
 * @returns {{accepted:boolean, rejected:boolean, hashrate:number|null}}
 */
export function parseMinerLine(line) {
  const rejected = REJECT_PATTERNS.some((re) => re.test(line));
  // A rejection line often also contains the word "accepted" in a running tally
  // ("accepted 10, rejected 1"), so a rejection wins.
  const accepted = !rejected && ACCEPT_PATTERNS.some((re) => re.test(line));

  let hashrate = null;
  const m = RATE_RE.exec(line);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) hashrate = n * RATE_MULT[m[2].toUpperCase()];
  }
  return { accepted, rejected, hashrate };
}

/**
 * Build the argv for a known miner. Kept in one place so the guide at
 * witness.melek.salon/mine and the worker cannot drift apart.
 *
 * @param {object} p
 * @param {string} p.binary     path to the miner executable
 * @param {string} p.kind       'lolminer' | 'trex' | 'gminer' | 'srbminer' | 'testminer' | 'custom'
 * @param {string} p.pool       host:port of the stratum
 * @param {string} p.workerAddr 0x payout address
 * @param {string} [p.workerName]
 * @param {string[]} [p.extraArgs]
 */
export function minerArgs({ binary, kind, pool, workerAddr, workerName = 'prana', extraArgs = [] }) {
  const user = `${workerAddr}.${workerName}`;
  switch (kind) {
    case 'lolminer':
      return [binary, '--algo', 'ETCHASH', '--pool', `stratum+tcp://${pool}`, '--user', user, ...extraArgs];
    case 'trex':
      return [binary, '-a', 'etchash', '-o', `stratum+tcp://${pool}`, '-u', workerAddr, '-w', workerName, ...extraArgs];
    case 'gminer':
      return [binary, '--algo', 'etchash', '--server', pool, '--user', user, ...extraArgs];
    case 'srbminer':
      return [binary, '--algorithm', 'etchash', '--pool', pool, '--wallet', workerAddr, '--worker', workerName, ...extraArgs];
    case 'testminer':
      // This repo's own Go miner: <binary> host:port 0xaddr /path/to/dag
      return [binary, pool, workerAddr, ...extraArgs];
    case 'custom':
      // The operator supplies every argument; {POOL} and {ADDR} are substituted.
      return [binary, ...extraArgs.map((a) => a.replace('{POOL}', pool).replace('{ADDR}', workerAddr))];
    default:
      throw new Error(`hash-miner: unknown miner kind "${kind}"`);
  }
}

/**
 * Supervises one miner process.
 *
 * Events: 'share' ({worker, lane, difficulty, nonce}), 'rejected', 'hashrate' (number),
 * 'line' (raw), 'exit' ({code, signal}), 'error'.
 *
 * The share objects it emits carry the same shape hash-lane.mjs produces, so the
 * coordinator submission path is identical whether the share came from a real GPU or from
 * the dev stub. `difficulty` is what the pool assigned; the coordinator re-validates and
 * normalizes regardless, so a miner misreporting it cannot inflate credit.
 */
export class HashMiner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.binary
   * @param {string} opts.kind
   * @param {string} opts.pool        host:port
   * @param {string} opts.workerAddr
   * @param {string} [opts.workerName]
   * @param {string[]} [opts.extraArgs]
   * @param {number} [opts.difficulty] pool-assigned share difficulty, for the share shape
   * @param {(cmd:string,args:string[],o:object)=>any} [opts.spawnFn] injected for tests
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.spawnFn = opts.spawnFn || spawn;
    this.proc = null;
    this.accepted = 0;
    this.rejected = 0;
    this.hashrate = 0;
    this.startedAt = null;
    this._buf = '';
  }

  get running() {
    return this.proc !== null;
  }

  /** Start the miner. Idempotent: starting a running miner is a no-op, not an error,
   * because the switcher may ask for HASH on consecutive ticks. */
  start() {
    if (this.proc) return;
    const [cmd, ...args] = minerArgs(this.opts);
    this.startedAt = Date.now();
    const proc = this.spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;

    const onData = (chunk) => this._ingest(String(chunk));
    proc.stdout?.on('data', onData);
    // Several miners write their share lines to stderr.
    proc.stderr?.on('data', onData);

    proc.on('error', (e) => {
      this.proc = null;
      this.emit('error', e);
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.emit('exit', { code, signal });
    });
  }

  /**
   * Stop the miner and free the card for the TASK lane.
   *
   * SIGTERM first so the miner can close its stratum connection cleanly — a miner killed
   * outright leaves the pool holding a dead session and counting the worker as connected,
   * which makes the pool's own hashrate figures wrong for a while. SIGKILL only if it does
   * not go.
   * @param {number} [graceMs]
   */
  async stop(graceMs = 4000) {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        resolve('killed');
      }, graceMs);
      timer.unref?.();
    });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
    this.proc = null;
  }

  /** Buffer partial lines: miner output arrives in arbitrary chunks and a share line split
   * across two chunks would otherwise be missed, undercounting exactly when the card is
   * busiest. */
  _ingest(text) {
    this._buf += text;
    const lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      this.emit('line', line);
      const { accepted, rejected, hashrate } = parseMinerLine(line);
      if (hashrate !== null) {
        this.hashrate = hashrate;
        this.emit('hashrate', hashrate);
      }
      if (rejected) {
        this.rejected++;
        this.emit('rejected', line);
      } else if (accepted) {
        this.accepted++;
        this.emit('share', {
          worker: this.opts.workerAddr,
          lane: 'HASH',
          difficulty: this.opts.difficulty ?? 0,
          solveSeconds: null, // real miner: the pool timed it, we did not
          meetsTarget: true, // the pool accepted it; that is the definition
          nonce: null, // carried by the pool's own record, not parsed back out
          source: this.opts.kind,
        });
      }
    }
  }

  /** What the daemon reports upward. `undercounting` is true when the miner is plainly
   * working but no accepted-share line has ever matched, which means the patterns above
   * need a case for this miner rather than that the card is idle. */
  stats() {
    const uptimeSec = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      running: this.running,
      kind: this.opts.kind,
      accepted: this.accepted,
      rejected: this.rejected,
      hashrate: this.hashrate,
      uptimeSec,
      undercounting: this.hashrate > 0 && this.accepted === 0 && uptimeSec > 600,
    };
  }
}
