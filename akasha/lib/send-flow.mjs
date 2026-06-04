/**
 * send-flow.mjs — Q9 + Z4
 *
 * A headless state machine for the wallet "send" screen. It wraps the lower-level
 * txbuilder.mjs (buildTx / dryRun / sendAndWait) in an explicit, UI-friendly
 * lifecycle the React shell can drive without re-implementing tx logic:
 *
 *   idle → simulating → ready → sending → confirmed
 *                  └──────────────────────→ failed   (from any active step)
 *
 * Transitions:
 *   create(req)                      → idle      (req captured, not yet simulated)
 *   simulate()  [idle|failed|ready]  → simulating → ready | failed
 *   send()      [ready]              → sending    → confirmed | failed
 *   reset()                          → idle       (clears summary/error, keeps req)
 *
 * `simulate()` produces a human-readable summary the UI renders verbatim:
 *   { to, valuePretty, gasEstimate, gasLimit, feeEstimate, feePretty, revertReason? }
 *
 * Guards (run during simulate, surfaced as a failed state with `.error`):
 *   - `to` is a valid EIP-55 address (checksum enforced via ethers getAddress)
 *   - the dryRun did not revert (revertReason decoded from txbuilder)
 *   - balance >= value + maxFee*gasLimit  (insufficient-funds guard)
 *   - nonce: a pending nonce lower than the latest-confirmed count signals a
 *     conflict (a stuck/duplicate tx); we flag it rather than silently overwrite.
 *
 * Coupling matches the rest of lib/: an ethers-style `provider` (send/request)
 * and an injected ethers `Wallet`/`Signer` for the actual broadcast. txbuilder
 * does the RPC; this module only sequences + summarizes + guards.
 */

import { formatEther, getAddress, isAddress } from 'ethers';
import { buildTx, dryRun, sendAndWait, decodeRevert } from './txbuilder.mjs';

export const STATES = Object.freeze({
  IDLE: 'idle',
  SIMULATING: 'simulating',
  READY: 'ready',
  SENDING: 'sending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
});

async function rpc(provider, method, params = []) {
  if (typeof provider?.send === 'function') return provider.send(method, params);
  if (typeof provider?.request === 'function') return provider.request({ method, params });
  throw new Error('provider must expose send(method, params) or request({method,params})');
}

function toBig(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

/** Per-gas price the fee ceiling should be computed against. */
function maxGasPrice(tx) {
  if (tx.type === 2) return tx.maxFeePerGas;
  return tx.gasPrice;
}

/**
 * Create a send-flow controller.
 *
 * @param {object} deps
 * @param {object} deps.provider           ethers-style provider (send/request)
 * @param {object} deps.signer             ethers Wallet/Signer (for send())
 * @param {{to?:string,value?:bigint|string|number,data?:string,from:string}} deps.request
 * @param {object} [deps.opts]             { chainId?, gasLimit?, confirmations?, pollMs?, timeoutMs? }
 */
export function createSendFlow({ provider, signer, request, opts = {} }) {
  if (!provider) throw new Error('send-flow: provider is required');
  if (!request || typeof request !== 'object') throw new Error('send-flow: request is required');
  if (!request.from) throw new Error('send-flow: request.from is required');

  let state = STATES.IDLE;
  let summary = null;
  let error = null;
  let builtTx = null;
  let result = null; // { hash, receipt } on confirm

  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) fn(snapshot());
  };
  const setState = (s) => {
    state = s;
    emit();
  };

  function snapshot() {
    return { state, summary, error, tx: builtTx, result };
  }

  // ---- simulate ------------------------------------------------------------

  async function simulate() {
    if (state === STATES.SENDING || state === STATES.SIMULATING) {
      throw new Error(`send-flow: cannot simulate from "${state}"`);
    }
    error = null;
    summary = null;
    builtTx = null;
    setState(STATES.SIMULATING);

    try {
      // Guard: recipient address. A bad/zero address fails fast and clearly.
      // (data-only / contract-creation sends may have a null `to`.)
      let to = null;
      if (request.to != null) {
        if (typeof request.to !== 'string' || !isAddress(request.to)) {
          throw new Error(`invalid recipient address: ${request.to}`);
        }
        to = getAddress(request.to);
      }
      const from = getAddress(request.from);
      const value = toBig(request.value);

      // Build the full tx (nonce, gas, fees) via txbuilder.
      const tx = await buildTx({ ...request, from, to, value }, provider, {
        chainId: opts.chainId,
        gasLimit: opts.gasLimit,
      });

      // Guard: simulate execution; surface a decoded revert reason.
      const sim = await dryRun(tx, provider);
      if (!sim.ok) {
        const reason = sim.revertReason ?? decodeRevert(sim.returnData) ?? sim.error ?? 'execution reverted';
        const e = new Error(`transaction would revert: ${reason}`);
        e.revertReason = reason;
        e.returnData = sim.returnData;
        throw e;
      }
      // Prefer the dryRun gas estimate when present (it re-checked at `latest`).
      const gasEstimate = sim.gasEstimate != null ? toBig(sim.gasEstimate) : tx.gasLimit;

      // Fee ceiling = gasLimit * maxGasPrice. The UI shows this as the worst case.
      const perGas = maxGasPrice(tx);
      const feeEstimate = tx.gasLimit * perGas;

      // Guard: balance must cover value + worst-case fee.
      const balance = toBig(await rpc(provider, 'eth_getBalance', [from, 'pending']));
      if (balance < value + feeEstimate) {
        const e = new Error(
          `insufficient funds: balance ${formatEther(balance)} < value ${formatEther(value)} + max fee ${formatEther(feeEstimate)}`,
        );
        e.code = 'INSUFFICIENT_FUNDS';
        throw e;
      }

      // Guard: nonce conflict. If the latest-confirmed count exceeds our pending
      // nonce, another tx already consumed it (replacement/stuck). Flag it.
      const confirmedCount = Number(toBig(await rpc(provider, 'eth_getTransactionCount', [from, 'latest'])));
      if (confirmedCount > tx.nonce) {
        const e = new Error(
          `nonce conflict: tx nonce ${tx.nonce} is already used (account is at ${confirmedCount})`,
        );
        e.code = 'NONCE_CONFLICT';
        throw e;
      }

      builtTx = tx;
      summary = {
        to,
        from,
        value,
        valuePretty: `${formatEther(value)} PRANA`,
        nonce: tx.nonce,
        gasEstimate,
        gasLimit: tx.gasLimit,
        feeEstimate,
        feePretty: `${formatEther(feeEstimate)} PRANA`,
        feeType: tx.type === 2 ? 'eip1559' : 'legacy',
      };
      setState(STATES.READY);
      return summary;
    } catch (err) {
      error = { message: err?.message ?? String(err), code: err?.code, revertReason: err?.revertReason };
      setState(STATES.FAILED);
      return null;
    }
  }

  // ---- send ----------------------------------------------------------------

  async function send() {
    if (state !== STATES.READY || !builtTx) {
      throw new Error('send-flow: simulate() must succeed (state "ready") before send()');
    }
    if (!signer || typeof signer.signTransaction !== 'function') {
      throw new Error('send-flow: an ethers Wallet/Signer is required to send');
    }
    error = null;
    setState(STATES.SENDING);
    try {
      result = await sendAndWait(signer, builtTx, provider, {
        confirmations: opts.confirmations,
        pollMs: opts.pollMs,
        timeoutMs: opts.timeoutMs,
      });
      // A mined-but-reverted tx has receipt.status === '0x0'.
      if (result.receipt && result.receipt.status != null && toBig(result.receipt.status) === 0n) {
        const e = new Error(`transaction reverted on-chain (hash ${result.hash})`);
        e.code = 'REVERTED';
        throw e;
      }
      setState(STATES.CONFIRMED);
      return result;
    } catch (err) {
      error = { message: err?.message ?? String(err), code: err?.code, hash: result?.hash };
      setState(STATES.FAILED);
      return null;
    }
  }

  function reset() {
    summary = null;
    error = null;
    builtTx = null;
    result = null;
    setState(STATES.IDLE);
  }

  return {
    get state() {
      return state;
    },
    get summary() {
      return summary;
    },
    get error() {
      return error;
    },
    get tx() {
      return builtTx;
    },
    get result() {
      return result;
    },
    snapshot,
    simulate,
    send,
    reset,
    /** Subscribe to state changes; returns an unsubscribe fn. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export default { createSendFlow, STATES };
