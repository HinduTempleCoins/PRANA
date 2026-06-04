// Tests for lib/contract-mgmt.mjs — ABI-driven admin tx builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id as keccakId } from 'ethers';
import {
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
  adminCapabilities,
  hasFunction,
  grantRole,
  pause,
} from '../lib/contract-mgmt.mjs';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NEW_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TARGET = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// A representative OZ-5.x AccessControl + Pausable + Ownable2Step ABI.
const ABI = [
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function renounceRole(bytes32 role, address callerConfirmation)',
  'function transferOwnership(address newOwner)',
  'function renounceOwnership()',
  'function acceptOwnership()',
  'function pause()',
  'function unpause()',
];
const iface = new Interface(ABI);

// ---- roleId -----------------------------------------------------------------

test('roleId: DEFAULT_ADMIN_ROLE is bytes32 zero', () => {
  assert.equal(roleId('DEFAULT_ADMIN_ROLE'), ZERO_BYTES32);
  assert.equal(roleId('DEFAULT_ADMIN'), ZERO_BYTES32);
});

test('roleId: a named role is keccak256(name)', () => {
  assert.equal(roleId('MINTER_ROLE'), keccakId('MINTER_ROLE'));
  assert.equal(roleId('GUARDIAN_ROLE'), keccakId('GUARDIAN_ROLE'));
});

test('roleId: an explicit bytes32 is passed through (lower-cased)', () => {
  const r = '0x' + 'ab'.repeat(32);
  assert.equal(roleId(r.toUpperCase().replace('0X', '0x')), r);
});

// ---- AccessControl builders -------------------------------------------------

test('buildGrantRole encodes grantRole(role, account) with target', () => {
  const tx = buildGrantRole(ABI, 'MINTER_ROLE', ACCOUNT, TARGET);
  assert.equal(tx.to, TARGET);
  assert.equal(tx.function, 'grantRole(bytes32,address)');
  // decode the calldata back and check the args
  const decoded = iface.decodeFunctionData('grantRole', tx.data);
  assert.equal(decoded[0], keccakId('MINTER_ROLE'));
  assert.equal(decoded[1], ACCOUNT);
});

test('buildRevokeRole encodes revokeRole(role, account)', () => {
  const tx = buildRevokeRole(ABI, 'MINTER_ROLE', ACCOUNT);
  assert.equal(tx.to, undefined); // no target supplied
  const decoded = iface.decodeFunctionData('revokeRole', tx.data);
  assert.equal(decoded[0], keccakId('MINTER_ROLE'));
  assert.equal(decoded[1], ACCOUNT);
});

test('buildRenounceRole uses caller confirmation address as 2nd arg', () => {
  const tx = buildRenounceRole(ABI, 'DEFAULT_ADMIN_ROLE', ACCOUNT, TARGET);
  const decoded = iface.decodeFunctionData('renounceRole', tx.data);
  assert.equal(decoded[0], ZERO_BYTES32);
  assert.equal(decoded[1], ACCOUNT);
});

// ---- Ownable / pausable builders --------------------------------------------

test('buildTransferOwnership encodes transferOwnership(newOwner)', () => {
  const tx = buildTransferOwnership(ABI, NEW_OWNER, TARGET);
  assert.equal(tx.function, 'transferOwnership(address)');
  const decoded = iface.decodeFunctionData('transferOwnership', tx.data);
  assert.equal(decoded[0], NEW_OWNER);
});

test('buildRenounceOwnership / acceptOwnership / pause / unpause are zero-arg', () => {
  assert.equal(buildRenounceOwnership(ABI).data, iface.encodeFunctionData('renounceOwnership', []));
  assert.equal(buildAcceptOwnership(ABI).data, iface.encodeFunctionData('acceptOwnership', []));
  assert.equal(buildPause(ABI).data, iface.encodeFunctionData('pause', []));
  assert.equal(buildUnpause(ABI).data, iface.encodeFunctionData('unpause', []));
});

// ---- validation -------------------------------------------------------------

test('buildTx rejects a missing function and a bad target', () => {
  assert.throws(() => buildTx(ABI, 'doesNotExist', []), /no function doesNotExist/);
  assert.throws(() => buildGrantRole(ABI, 'X', '0xnotanaddress'), /not a valid address/);
  assert.throws(() => buildGrantRole(ABI, 'X', ACCOUNT, '0xbad'), /not a valid address/);
});

// ---- capability detection ---------------------------------------------------

test('adminCapabilities detects AC + ownable2Step + pausable from the ABI', () => {
  const caps = adminCapabilities(ABI);
  assert.deepEqual(caps, {
    accessControl: true,
    ownable: true,
    ownable2Step: true,
    pausable: true,
  });
});

test('adminCapabilities on a plain Ownable contract', () => {
  const ownableOnly = ['function transferOwnership(address newOwner)', 'function renounceOwnership()'];
  const caps = adminCapabilities(ownableOnly);
  assert.equal(caps.accessControl, false);
  assert.equal(caps.ownable, true);
  assert.equal(caps.ownable2Step, false);
  assert.equal(caps.pausable, false);
});

test('hasFunction works on a Hardhat-artifact shape', () => {
  assert.equal(hasFunction({ abi: ABI }, 'pause'), true);
  assert.equal(hasFunction({ abi: ABI }, 'nope'), false);
});

// ---- live senders (mocked contract) -----------------------------------------

test('grantRole / pause dispatch through a signer-connected contract', async () => {
  const calls = [];
  const fakeContract = {
    getFunction(name) {
      return (...args) => {
        calls.push({ name, args });
        return Promise.resolve({ hash: '0xdeadbeef' });
      };
    },
  };
  const r1 = await grantRole(fakeContract, 'MINTER_ROLE', ACCOUNT);
  assert.equal(r1.hash, '0xdeadbeef');
  assert.deepEqual(calls[0], { name: 'grantRole', args: [keccakId('MINTER_ROLE'), ACCOUNT] });

  await pause(fakeContract);
  assert.deepEqual(calls[1], { name: 'pause', args: [] });
});

test('live senders reject a non-contract', async () => {
  await assert.rejects(() => grantRole({}, 'X', ACCOUNT), /ethers Contract is required/);
});
