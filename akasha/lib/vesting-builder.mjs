/**
 * vesting-builder.mjs — AK16 (creator systems: vesting / streaming builder)
 *
 * Headless builder for the two streaming/vesting primitives in the contracts:
 *
 *  1. VestingFactory.createVesting(token, beneficiary, start, cliffSeconds,
 *     duration, total) -> TokenVesting
 *       - linear vest with an OPTIONAL cliff.
 *       - cliff is RELATIVE (`cliffSeconds`, seconds AFTER start); the child
 *         contract stores the absolute cliff = start + cliffSeconds.
 *       - constraints (from TokenVesting's constructor): duration > 0,
 *         cliffSeconds <= duration, total > 0, beneficiary != 0, token != 0.
 *       - funded by safeTransferFrom(msg.sender, ...): the caller must approve the
 *         factory for `total` first.
 *
 *  2. StreamingPayments.createStream(recipient, token, total, start, stop)
 *       - Sablier-style constant-rate stream between `start` and `stop`.
 *       - constraints (from createStream): recipient != 0 / != contract,
 *         total > 0, stop > start, AND total % (stop - start) == 0 (the stream
 *         must be evenly divisible per second so the per-second math is exact).
 *       - funded by safeTransferFrom(msg.sender, ...): approve the contract first.
 *
 * This module VALIDATES the schedule and returns the positional args + an
 * abi-form-friendly value map for each. It binds nothing to a network — the
 * caller supplies the deployed VestingFactory / StreamingPayments contract.
 *
 * Times are unix seconds. Amounts are token base units (wei).
 */

import { getAddress, isAddress, getBigInt } from 'ethers';

const ZERO = '0x0000000000000000000000000000000000000000';

function reqAddress(label, v) {
  if (!isAddress(v)) throw new Error(`vesting: ${label} is not a valid address: ${JSON.stringify(v)}`);
  const a = getAddress(v);
  if (a === ZERO) throw new Error(`vesting: ${label} must not be the zero address`);
  return a;
}

function reqUint(label, v) {
  let n;
  try {
    n = getBigInt(v);
  } catch {
    throw new Error(`vesting: ${label} is not a valid integer: ${JSON.stringify(v)}`);
  }
  if (n < 0n) throw new Error(`vesting: ${label} must be >= 0`);
  return n;
}

const U64_MAX = (1n << 64n) - 1n;
function reqUint64(label, v) {
  const n = reqUint(label, v);
  if (n > U64_MAX) throw new Error(`vesting: ${label} exceeds uint64`);
  return n;
}

// ---- linear vesting (VestingFactory.createVesting) --------------------------

/**
 * Build + validate params for VestingFactory.createVesting.
 *
 * @param {object} p
 * @param {string} p.token         ERC-20 address being vested
 * @param {string} p.beneficiary   recipient address
 * @param {bigint|number|string} p.start         unix start (seconds)
 * @param {bigint|number|string} p.cliffSeconds  seconds after start before anything vests (0 = no cliff)
 * @param {bigint|number|string} p.duration      seconds from start to fully vested
 * @param {bigint|number|string} p.total         total token base units to vest
 * @returns {{
 *   kind:'vesting',
 *   method:'createVesting',
 *   args:[string,string,bigint,bigint,bigint,bigint],
 *   values:object,        // keyed for abi-form
 *   cliffTimestamp:bigint,// absolute = start + cliffSeconds (what the child stores)
 *   endTimestamp:bigint,  // start + duration
 *   requiresApproval:{ token:string, spender:'factory', amount:bigint },
 * }}
 */
export function buildVesting(p) {
  if (!p || typeof p !== 'object') throw new Error('vesting: params object required');
  const token = reqAddress('token', p.token);
  const beneficiary = reqAddress('beneficiary', p.beneficiary);
  const start = reqUint64('start', p.start);
  const cliffSeconds = reqUint64('cliffSeconds', p.cliffSeconds ?? 0);
  const duration = reqUint64('duration', p.duration);
  const total = reqUint('total', p.total);

  if (duration === 0n) throw new Error('vesting: duration must be > 0');
  if (cliffSeconds > duration) throw new Error('vesting: cliffSeconds must be <= duration');
  if (total === 0n) throw new Error('vesting: total must be > 0');
  if (start + duration > U64_MAX) throw new Error('vesting: start + duration overflows uint64');

  return {
    kind: 'vesting',
    method: 'createVesting',
    args: [token, beneficiary, start, cliffSeconds, duration, total],
    values: { token, beneficiary, start, cliffSeconds, duration, total },
    cliffTimestamp: start + cliffSeconds,
    endTimestamp: start + duration,
    requiresApproval: { token, spender: 'factory', amount: total },
  };
}

// ---- constant-rate stream (StreamingPayments.createStream) ------------------

/**
 * Build + validate params for StreamingPayments.createStream.
 *
 * @param {object} p
 * @param {string} p.recipient
 * @param {string} p.token
 * @param {bigint|number|string} p.total  total token base units; MUST be evenly
 *                                         divisible by (stop - start)
 * @param {bigint|number|string} p.start  unix start (seconds)
 * @param {bigint|number|string} p.stop   unix stop (seconds), strictly > start
 * @param {string} [p.streamingContract]  optional: bound contract address, to
 *                                         reject recipient == contract early
 * @returns {{
 *   kind:'stream',
 *   method:'createStream',
 *   args:[string,string,bigint,bigint,bigint],
 *   values:object,
 *   ratePerSecond:bigint,  // total / (stop - start)
 *   duration:bigint,       // stop - start
 *   requiresApproval:{ token:string, spender:'streaming', amount:bigint },
 * }}
 */
export function buildStream(p) {
  if (!p || typeof p !== 'object') throw new Error('stream: params object required');
  const recipient = reqAddress('recipient', p.recipient);
  const token = reqAddress('token', p.token);
  const total = reqUint('total', p.total);
  const start = reqUint64('start', p.start);
  const stop = reqUint64('stop', p.stop);

  if (total === 0n) throw new Error('stream: total must be > 0');
  if (stop <= start) throw new Error('stream: stop must be > start');
  const duration = stop - start;
  if (total % duration !== 0n) {
    throw new Error(`stream: total (${total}) must be evenly divisible by duration (${duration}) for exact per-second math`);
  }
  if (p.streamingContract && isAddress(p.streamingContract)) {
    if (getAddress(p.streamingContract) === recipient) {
      throw new Error('stream: recipient must not be the streaming contract');
    }
  }

  return {
    kind: 'stream',
    method: 'createStream',
    // NOTE: createStream's arg order is (recipient, token, total, start, stop)
    args: [recipient, token, total, start, stop],
    values: { recipient, token, total, start, stop },
    ratePerSecond: total / duration,
    duration,
    requiresApproval: { token, spender: 'streaming', amount: total },
  };
}

export default {
  buildVesting,
  buildStream,
};
