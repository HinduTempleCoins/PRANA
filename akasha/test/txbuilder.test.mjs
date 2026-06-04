// Tests for lib/txbuilder.mjs — no live node, a scriptable FakeProvider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTx, signTx, dryRun, detectFees, decodeRevert } from '../lib/txbuilder.mjs';
import { Wallet, Interface } from 'ethers';

const FROM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// Hand-encode an Error(string) revert payload to feed the decoder.
const errIface = new Interface(['function Error(string)']);
const REVERT_BOOM = errIface.encodeFunctionData('Error', ['boom!']);

// A FakeProvider answering eth_* via a table; supports the ethers send() shape.
class FakeProvider {
  constructor(table) {
    this.table = table;
    this.calls = [];
  }
  async send(method, params) {
    this.calls.push({ method, params });
    const entry = this.table[method];
    if (entry === undefined) return null;
    if (typeof entry === 'function') return entry(params);
    return entry;
  }
}

// --- fee detection: 1559 vs legacy ------------------------------------------

test('detectFees: post-London block (baseFeePerGas) → EIP-1559 plan', async () => {
  const p = new FakeProvider({
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, // 1 gwei
    eth_maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
  });
  const fees = await detectFees(p);
  assert.equal(fees.type, 2);
  assert.equal(fees.baseFeePerGas, 1_000_000_000n);
  assert.equal(fees.maxPriorityFeePerGas, 1_000_000_000n);
  // maxFee = 2*base + priority = 3 gwei
  assert.equal(fees.maxFeePerGas, 3_000_000_000n);
});

test('detectFees: pre-London block (no baseFee) → legacy gasPrice', async () => {
  const p = new FakeProvider({
    eth_getBlockByNumber: { number: '0x1' }, // no baseFeePerGas
    eth_gasPrice: '0x77359400', // 2 gwei
  });
  const fees = await detectFees(p);
  assert.equal(fees.type, 1);
  assert.equal(fees.gasPrice, 2_000_000_000n);
});

test('detectFees: 1559 with no eth_maxPriorityFeePerGas falls back to default 1 gwei', async () => {
  const p = new FakeProvider({
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: () => {
      throw new Error('method not found');
    },
  });
  const fees = await detectFees(p);
  assert.equal(fees.type, 2);
  assert.equal(fees.maxPriorityFeePerGas, 1_000_000_000n);
});

// --- buildTx ----------------------------------------------------------------

test('buildTx: 1559 chain fills nonce, gasLimit (with 1.2x margin) and fee fields', async () => {
  const p = new FakeProvider({
    eth_getTransactionCount: '0x5', // nonce 5
    eth_estimateGas: '0x5208', // 21000
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x3b9aca00',
  });
  const tx = await buildTx({ from: FROM, to: TO, value: 1000n }, p);
  assert.equal(tx.nonce, 5);
  assert.equal(tx.type, 2);
  assert.equal(tx.gasLimit, (21000n * 12n) / 10n); // 25200
  assert.equal(tx.maxFeePerGas, 3_000_000_000n);
  assert.equal(tx.maxPriorityFeePerGas, 1_000_000_000n);
  assert.equal(tx.chainId, 108369);
  assert.equal(tx.value, 1000n);
});

test('buildTx: legacy chain fills gasPrice, type 0', async () => {
  const p = new FakeProvider({
    eth_getTransactionCount: '0x0',
    eth_estimateGas: '0x5208',
    eth_getBlockByNumber: { number: '0x1' }, // no baseFee
    eth_gasPrice: '0x77359400',
  });
  const tx = await buildTx({ from: FROM, to: TO, value: 0n }, p);
  assert.equal(tx.type, 0);
  assert.equal(tx.gasPrice, 2_000_000_000n);
  assert.equal(tx.maxFeePerGas, undefined);
});

test('buildTx: explicit gasLimit override skips estimateGas', async () => {
  const p = new FakeProvider({
    eth_getTransactionCount: '0x0',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x3b9aca00',
  });
  const tx = await buildTx({ from: FROM, to: TO }, p, { gasLimit: 99999n });
  assert.equal(tx.gasLimit, 99999n);
  assert.ok(!p.calls.some((c) => c.method === 'eth_estimateGas'));
});

// --- signTx -----------------------------------------------------------------

test('signTx: produces a raw signed tx via an ethers Wallet, strips `from`', async () => {
  // Anvil key #0 — matches FROM.
  const wallet = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const tx = {
    from: FROM,
    to: TO,
    value: 1n,
    data: '0x',
    nonce: 0,
    gasLimit: 21000n,
    chainId: 108369,
    type: 2,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  const raw = await signTx(wallet, tx);
  assert.ok(typeof raw === 'string' && raw.startsWith('0x02')); // typed (1559) tx envelope
});

// --- dryRun + revert decode -------------------------------------------------

test('decodeRevert: hand-encoded Error(string) payload', () => {
  assert.equal(decodeRevert(REVERT_BOOM), 'boom!');
  assert.equal(decodeRevert('0x'), null);
  assert.equal(decodeRevert(null), null);
});

test('dryRun: success path returns ok + gasEstimate', async () => {
  const p = new FakeProvider({
    eth_call: '0x', // empty success
    eth_estimateGas: '0x5208',
  });
  const res = await dryRun({ from: FROM, to: TO, value: 0n, data: '0x' }, p);
  assert.equal(res.ok, true);
  assert.equal(res.gasEstimate, 21000n);
});

test('dryRun: eth_call throws with revert data on err.data → decoded reason', async () => {
  const p = new FakeProvider({
    eth_call: () => {
      const e = new Error('execution reverted');
      e.data = REVERT_BOOM;
      throw e;
    },
  });
  const res = await dryRun({ from: FROM, to: TO, data: '0x1234' }, p);
  assert.equal(res.ok, false);
  assert.equal(res.revertReason, 'boom!');
  assert.equal(res.returnData, REVERT_BOOM);
});

test('dryRun: eth_call returns revert payload inline (no throw) → treated as revert', async () => {
  const p = new FakeProvider({
    eth_call: REVERT_BOOM, // node returns the Error(string) data without throwing
  });
  const res = await dryRun({ from: FROM, to: TO, data: '0x' }, p);
  assert.equal(res.ok, false);
  assert.equal(res.revertReason, 'boom!');
});

test('dryRun: revert data nested under err.error.data is extracted', async () => {
  const p = new FakeProvider({
    eth_call: () => {
      const e = new Error('execution reverted');
      e.error = { data: REVERT_BOOM };
      throw e;
    },
  });
  const res = await dryRun({ from: FROM, to: TO, data: '0x' }, p);
  assert.equal(res.ok, false);
  assert.equal(res.revertReason, 'boom!');
});
