// Tests for lib/abi-form.mjs — pure form-model + coercion + execute dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import {
  formModels,
  formModelForFunction,
  coerceValue,
  coerceArgs,
  execute,
  toInterface,
} from '../lib/abi-form.mjs';

const ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
  'function setFlag(bool on)',
  'function setData(bytes payload)',
  'function setHash(bytes32 h)',
  'function sum(uint256[] xs) pure returns (uint256)',
];

const ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ADDR_LC = ADDR.toLowerCase();

// --- model generation -------------------------------------------------------

test('formModels: reads sort before writes, alphabetical within group', () => {
  const models = formModels(ABI);
  const names = models.map((m) => m.name);
  // reads: balanceOf, sum ; writes: mint, setData, setFlag, setHash, transfer
  assert.deepEqual(names, ['balanceOf', 'sum', 'mint', 'setData', 'setFlag', 'setHash', 'transfer']);
  const reads = models.filter((m) => m.readonly).map((m) => m.name);
  assert.deepEqual(reads, ['balanceOf', 'sum']);
});

test('formModelForFunction: components + selectors', () => {
  const m = formModelForFunction(ABI, 'transfer');
  assert.equal(m.name, 'transfer');
  assert.equal(m.readonly, false);
  assert.equal(m.payable, false);
  assert.equal(m.inputs[0].component, 'address');
  assert.equal(m.inputs[1].component, 'number');
  assert.equal(m.outputs[0].component, 'bool');
  assert.match(m.selector, /^0x[0-9a-f]{8}$/);
  assert.equal(m.signature, 'transfer(address,uint256)');
});

test('component hints: bool / bytes / bytesN / array', () => {
  assert.equal(formModelForFunction(ABI, 'setFlag').inputs[0].component, 'bool');
  assert.equal(formModelForFunction(ABI, 'setData').inputs[0].component, 'bytes');
  assert.equal(formModelForFunction(ABI, 'setHash').inputs[0].component, 'bytes');
  const sum = formModelForFunction(ABI, 'sum');
  // arrays render as JSON-entry text fields in the UI.
  assert.equal(sum.inputs[0].component, 'text');
  assert.equal(sum.inputs[0].isArray, true);
});

test('field validate(): ok and error branches', () => {
  const m = formModelForFunction(ABI, 'transfer');
  assert.deepEqual(m.inputs[0].validate(ADDR), { ok: true });
  const bad = m.inputs[0].validate('not-an-address');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid address/);
  assert.deepEqual(m.inputs[1].validate('1000'), { ok: true });
  assert.equal(m.inputs[1].validate('1.5').ok, false);
});

// --- coercion ---------------------------------------------------------------

test('coerceValue: uint accepts decimal, hex, number, bigint', () => {
  const u = (s) => coerceValue(toInterface(ABI).getFunction('mint').inputs[1], s);
  assert.equal(u('100'), 100n);
  assert.equal(u('0xff'), 255n);
  assert.equal(u(42), 42n);
  assert.equal(u(7n), 7n);
  assert.throws(() => u(''), /empty/);
  assert.throws(() => u('abc'));
});

test('coerceValue: address checksums, bool, bytesN length-checked', () => {
  const ptAddr = toInterface(ABI).getFunction('mint').inputs[0];
  assert.equal(coerceValue(ptAddr, ADDR_LC), ADDR);

  const ptBool = toInterface(ABI).getFunction('setFlag').inputs[0];
  assert.equal(coerceValue(ptBool, 'true'), true);
  assert.equal(coerceValue(ptBool, 0), false);
  assert.throws(() => coerceValue(ptBool, 'maybe'), /invalid bool/);

  const ptHash = toInterface(ABI).getFunction('setHash').inputs[0];
  const good = '0x' + '11'.repeat(32);
  assert.equal(coerceValue(ptHash, good), good);
  assert.throws(() => coerceValue(ptHash, '0x1122'), /exactly 32 bytes/);
});

test('coerceValue: arrays from JS array or JSON string', () => {
  const pt = toInterface(ABI).getFunction('sum').inputs[0];
  assert.deepEqual(coerceValue(pt, [1, '2', '0x3']), [1n, 2n, 3n]);
  assert.deepEqual(coerceValue(pt, '[4,5]'), [4n, 5n]);
});

test('coerceArgs: by-name object and positional array agree', () => {
  const m = formModelForFunction(ABI, 'transfer');
  const byName = coerceArgs(m, { to: ADDR_LC, amount: '5' });
  const byPos = coerceArgs(m, [ADDR_LC, '5']);
  assert.deepEqual(byName, [ADDR, 5n]);
  assert.deepEqual(byPos, [ADDR, 5n]);
});

// --- execute dispatch -------------------------------------------------------

function fakeContract(iface) {
  const log = [];
  return {
    log,
    interface: iface,
    getFunction(sig) {
      const fn = (...args) => {
        log.push({ kind: 'send', sig, args });
        return Promise.resolve({ hash: '0xsent' });
      };
      fn.staticCall = (...args) => {
        log.push({ kind: 'static', sig, args });
        return Promise.resolve(123n);
      };
      return fn;
    },
  };
}

test('execute: read goes through staticCall (no send)', async () => {
  const iface = toInterface(ABI);
  const c = fakeContract(iface);
  const out = await execute(c, 'balanceOf', { owner: ADDR_LC });
  assert.equal(out, 123n);
  assert.equal(c.log.length, 1);
  assert.equal(c.log[0].kind, 'static');
  assert.deepEqual(c.log[0].args, [ADDR]);
});

test('execute: write sends a tx with coerced args + overrides', async () => {
  const iface = toInterface(ABI);
  const c = fakeContract(iface);
  const res = await execute(c, 'transfer', { to: ADDR_LC, amount: '5' }, { overrides: { gasLimit: 21000n } });
  assert.deepEqual(res, { hash: '0xsent' });
  assert.equal(c.log[0].kind, 'send');
  assert.deepEqual(c.log[0].args, [ADDR, 5n, { gasLimit: 21000n }]);
});

test('execute: rejects a non-Contract', async () => {
  await assert.rejects(() => execute({}, 'transfer', {}), /Contract is required/);
});

test('toInterface: accepts Interface, array, and { abi } artifact', () => {
  const iface = new Interface(ABI);
  assert.equal(toInterface(iface), iface);
  assert.ok(toInterface(ABI) instanceof Interface);
  assert.ok(toInterface({ abi: ABI }) instanceof Interface);
});
