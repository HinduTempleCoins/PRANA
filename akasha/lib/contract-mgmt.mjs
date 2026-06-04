/**
 * contract-mgmt.mjs — AK17 (creator systems: contract admin helpers)
 *
 * Safe / OZ-Defender-style admin helpers over a deployed contract. Generic and
 * ABI-driven: it does NOT hard-code a contract; it inspects the contract's ABI
 * (via ethers Interface) to confirm a method exists, then builds the call —
 * either an unsigned tx request `{ to, data }` (for a multisig/Safe/Timelock to
 * execute later) or a direct send through a signer-connected ethers Contract.
 *
 * Covered admin patterns (OpenZeppelin 5.x):
 *   AccessControl  — grantRole / revokeRole / renounceRole, role-id helpers
 *   Ownable        — transferOwnership / renounceOwnership
 *   Ownable2Step   — transferOwnership (pending) + acceptOwnership
 *   Pausable       — pause / unpause (guardian-gated in PausableGuardian)
 *
 * It mirrors abi-form.mjs's `toInterface` so it accepts an Interface, a raw ABI
 * array, a Hardhat artifact `{abi}`, or a single fragment. Build-only functions
 * never touch a network; the optional `*Tx` senders need a signer-connected
 * ethers Contract.
 *
 * Role ids: OZ roles are bytes32. By convention `ROLE = keccak256("ROLE_NAME")`,
 * except DEFAULT_ADMIN_ROLE = 0x00..00. `roleId()` accepts a name, a 0x-bytes32,
 * or the literal 'DEFAULT_ADMIN_ROLE'/'DEFAULT_ADMIN'.
 */

import { Interface, id as keccakId, isAddress, getAddress, isHexString } from 'ethers';

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

/** Coerce input to an ethers Interface (mirrors abi-form.toInterface). */
export function toInterface(abiOrIface) {
  if (abiOrIface instanceof Interface) return abiOrIface;
  if (Array.isArray(abiOrIface)) return new Interface(abiOrIface);
  if (abiOrIface && Array.isArray(abiOrIface.abi)) return new Interface(abiOrIface.abi);
  return new Interface([abiOrIface]);
}

/** True if a function with this name/signature exists in the ABI. */
export function hasFunction(abiOrIface, name) {
  const iface = toInterface(abiOrIface);
  try {
    return iface.getFunction(name) !== null;
  } catch {
    return false;
  }
}

/**
 * Resolve a role identifier to a bytes32.
 *   - 'DEFAULT_ADMIN_ROLE' / 'DEFAULT_ADMIN' -> 0x00..00
 *   - a 0x… 32-byte hex string            -> used verbatim (checksum-insensitive)
 *   - any other string ('MINTER_ROLE')    -> keccak256(name)  (OZ convention)
 * @param {string} role
 * @returns {string} 0x 32-byte role id
 */
export function roleId(role) {
  if (typeof role !== 'string' || role.length === 0) {
    throw new Error('contract-mgmt: role must be a non-empty string');
  }
  if (role === 'DEFAULT_ADMIN_ROLE' || role === 'DEFAULT_ADMIN') return ZERO_BYTES32;
  if (isHexString(role, 32)) return role.toLowerCase();
  return keccakId(role);
}

function reqAddress(label, v) {
  if (!isAddress(v)) throw new Error(`contract-mgmt: ${label} is not a valid address: ${JSON.stringify(v)}`);
  return getAddress(v);
}

// ---- low-level: build an unsigned tx request from ABI + fn + args -----------

/**
 * Encode a call into an unsigned tx request `{ to, data }`. `to` is optional
 * (omit when the target is supplied later, e.g. a Safe batch builder).
 * @param {object} abiOrIface
 * @param {string} fnName
 * @param {any[]} args
 * @param {string} [to]  target contract address
 * @returns {{ to?:string, data:string, function:string, args:any[] }}
 */
export function buildTx(abiOrIface, fnName, args, to) {
  const iface = toInterface(abiOrIface);
  const fn = iface.getFunction(fnName);
  if (!fn) throw new Error(`contract-mgmt: no function ${fnName} in ABI`);
  const data = iface.encodeFunctionData(fn, args);
  const out = { data, function: fn.format('sighash'), args };
  if (to !== undefined) out.to = reqAddress('to', to);
  return out;
}

// ---- AccessControl ----------------------------------------------------------

/** Build grantRole(role, account) tx. */
export function buildGrantRole(abiOrIface, role, account, to) {
  return buildTx(abiOrIface, 'grantRole', [roleId(role), reqAddress('account', account)], to);
}

/** Build revokeRole(role, account) tx. */
export function buildRevokeRole(abiOrIface, role, account, to) {
  return buildTx(abiOrIface, 'revokeRole', [roleId(role), reqAddress('account', account)], to);
}

/**
 * Build renounceRole(role, callerConfirmation) tx. In OZ 5.x the second arg MUST
 * equal the caller's own address — pass the address that will send the tx.
 */
export function buildRenounceRole(abiOrIface, role, callerConfirmation, to) {
  return buildTx(
    abiOrIface,
    'renounceRole',
    [roleId(role), reqAddress('callerConfirmation', callerConfirmation)],
    to,
  );
}

// ---- Ownable / Ownable2Step -------------------------------------------------

/** Build transferOwnership(newOwner) tx. */
export function buildTransferOwnership(abiOrIface, newOwner, to) {
  return buildTx(abiOrIface, 'transferOwnership', [reqAddress('newOwner', newOwner)], to);
}

/** Build renounceOwnership() tx (irreversible — leaves the contract ownerless). */
export function buildRenounceOwnership(abiOrIface, to) {
  return buildTx(abiOrIface, 'renounceOwnership', [], to);
}

/** Build acceptOwnership() tx (Ownable2Step — called by the pending owner). */
export function buildAcceptOwnership(abiOrIface, to) {
  return buildTx(abiOrIface, 'acceptOwnership', [], to);
}

// ---- Pausable ---------------------------------------------------------------

/** Build pause() tx. */
export function buildPause(abiOrIface, to) {
  return buildTx(abiOrIface, 'pause', [], to);
}

/** Build unpause() tx. */
export function buildUnpause(abiOrIface, to) {
  return buildTx(abiOrIface, 'unpause', [], to);
}

// ---- direct senders (need a signer-connected ethers Contract) ---------------

async function send(contract, fnName, args) {
  if (!contract || typeof contract.getFunction !== 'function') {
    throw new Error('contract-mgmt: a signer-connected ethers Contract is required');
  }
  const method = contract.getFunction(fnName);
  return method(...args);
}

/** grantRole(role, account) via a live contract. Returns the TransactionResponse. */
export function grantRole(contract, role, account) {
  return send(contract, 'grantRole', [roleId(role), reqAddress('account', account)]);
}

/** revokeRole(role, account) via a live contract. */
export function revokeRole(contract, role, account) {
  return send(contract, 'revokeRole', [roleId(role), reqAddress('account', account)]);
}

/** transferOwnership(newOwner) via a live contract. */
export function transferOwnership(contract, newOwner) {
  return send(contract, 'transferOwnership', [reqAddress('newOwner', newOwner)]);
}

/** pause() via a live contract. */
export function pause(contract) {
  return send(contract, 'pause', []);
}

/** unpause() via a live contract. */
export function unpause(contract) {
  return send(contract, 'unpause', []);
}

/**
 * Report which admin surfaces a contract's ABI exposes — drives the wallet UI to
 * only show the buttons the contract actually supports.
 * @returns {{accessControl:boolean, ownable:boolean, ownable2Step:boolean, pausable:boolean}}
 */
export function adminCapabilities(abiOrIface) {
  const iface = toInterface(abiOrIface);
  const has = (n) => hasFunction(iface, n);
  return {
    accessControl: has('grantRole') && has('revokeRole'),
    ownable: has('transferOwnership'),
    ownable2Step: has('transferOwnership') && has('acceptOwnership'),
    pausable: has('pause') && has('unpause'),
  };
}

export default {
  toInterface,
  hasFunction,
  roleId,
  buildTx,
  buildGrantRole,
  buildRevokeRole,
  buildRenounceRole,
  buildTransferOwnership,
  buildRenounceOwnership,
  buildAcceptOwnership,
  buildPause,
  buildUnpause,
  grantRole,
  revokeRole,
  transferOwnership,
  pause,
  unpause,
  adminCapabilities,
};
