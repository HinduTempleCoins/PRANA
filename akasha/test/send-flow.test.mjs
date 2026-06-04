// Tests for lib/send-flow.mjs — mock provider + signer, no live node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, parseEther } from 'ethers';
import { createSendFlow, STATES } from '../lib/send-flow.mjs';

// anvil key #0 == FROM
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FROM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const errIface = new Interface(['function Error(string)']);
const REVERT_BOOM = errIface.encodeFunctionData('Error', ['boom!']);

// FakeProvider answering eth_* from a table (function entries are called).
class FakeProvider {
  constructor(table) {
    this.table = table;
    this.calls = [];
  }
  async send(method, params) {
    this.calls.push({ method, params });
    const entry = this.table[method];
    if (entry === undefined) return null;
    return typeof entry === 'function' ? entry(params) : entry;
  }
}

// A healthy 1559 chain with `balance` PRANA and gasPrice ~1 gwei base.
function baseTable(overrides = {}) {
  return {
    eth_getTransactionCount: ({}) => '0x0', // nonce 0, latest 0 (no conflict)
    eth_estimateGas: '0x5208', // 21000
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' }, // 1 gwei
    eth_maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
    eth_call: '0x', // dryRun success
    eth_getBalance: '0xde0b6b3a7640000', // 1 ETH/PRANA
    ...overrides,
  };
}

function flow(table, reqOverrides = {}) {
  const provider = new FakeProvider(table);
  const signer = new Wallet(PK);
  const f = createSendFlow({
    provider,
    signer,
    request: { from: FROM, to: TO, value: parseEther('0.1'), ...reqOverrides },
    opts: { confirmations: 0 },
  });
  return { provider, signer, f };
}

test('happy path: idle → simulating → ready → sending → confirmed', async () => {
  const { f, provider } = flow(baseTable());
  assert.equal(f.state, STATES.IDLE);

  const summary = await f.simulate();
  assert.equal(f.state, STATES.READY);
  assert.equal(summary.to, TO);
  assert.equal(summary.valuePretty, '0.1 PRANA');
  assert.equal(summary.gasEstimate, 21000n);
  assert.equal(summary.feeType, 'eip1559');
  // fee = gasLimit (25200) * maxFee (3 gwei)
  assert.equal(summary.feeEstimate, 25200n * 3_000_000_000n);
  assert.ok(summary.revertReason === undefined);

  // give the broadcast a receipt so confirmations:0 returns immediately
  provider.table.eth_sendRawTransaction = '0xhash';
  const res = await f.send();
  assert.equal(f.state, STATES.CONFIRMED);
  assert.equal(res.hash, '0xhash');
});

test('revert decode: dryRun revert → failed with decoded reason', async () => {
  const { f } = flow(
    baseTable({
      eth_call: () => {
        const e = new Error('execution reverted');
        e.data = REVERT_BOOM;
        throw e;
      },
    }),
  );
  const out = await f.simulate();
  assert.equal(out, null);
  assert.equal(f.state, STATES.FAILED);
  assert.match(f.error.message, /would revert: boom!/);
  assert.equal(f.error.revertReason, 'boom!');
});

test('insufficient funds: value + fee exceeds balance → failed', async () => {
  const { f } = flow(
    baseTable({ eth_getBalance: '0x2386f26fc10000' }), // 0.01 PRANA < 0.1 + fee
  );
  const out = await f.simulate();
  assert.equal(out, null);
  assert.equal(f.state, STATES.FAILED);
  assert.equal(f.error.code, 'INSUFFICIENT_FUNDS');
  assert.match(f.error.message, /insufficient funds/);
});

test('nonce conflict: latest count ahead of pending nonce → failed', async () => {
  const { f } = flow(
    baseTable({
      eth_getTransactionCount: (params) => (params[1] === 'latest' ? '0x5' : '0x3'),
    }),
  );
  const out = await f.simulate();
  assert.equal(out, null);
  assert.equal(f.state, STATES.FAILED);
  assert.equal(f.error.code, 'NONCE_CONFLICT');
});

test('bad recipient address fails the address guard', async () => {
  const { f } = flow(baseTable(), { to: '0x1234' });
  await f.simulate();
  assert.equal(f.state, STATES.FAILED);
  assert.match(f.error.message, /invalid recipient/);
});

test('send() before a successful simulate throws', async () => {
  const { f } = flow(baseTable());
  await assert.rejects(() => f.send(), /simulate\(\) must succeed/);
});

test('reset() returns to idle and clears summary/error', async () => {
  const { f } = flow(baseTable());
  await f.simulate();
  assert.equal(f.state, STATES.READY);
  f.reset();
  assert.equal(f.state, STATES.IDLE);
  assert.equal(f.summary, null);
  assert.equal(f.error, null);
});

test('subscribe receives state-change snapshots', async () => {
  const { f } = flow(baseTable());
  const seen = [];
  const off = f.subscribe((snap) => seen.push(snap.state));
  await f.simulate();
  off();
  assert.deepEqual(seen, [STATES.SIMULATING, STATES.READY]);
});

test('mined-but-reverted receipt (status 0x0) → failed', async () => {
  const { f, provider } = flow(baseTable());
  await f.simulate();
  provider.table.eth_sendRawTransaction = '0xhash';
  // confirmations default 1 path is opts.confirmations:0 here, so force a receipt
  // by switching to confirmations >=1 via a fresh flow.
  const provider2 = new FakeProvider(
    baseTable({
      eth_sendRawTransaction: '0xhash',
      eth_getTransactionReceipt: { blockNumber: '0x1', status: '0x0' },
      eth_blockNumber: '0x1',
    }),
  );
  const f2 = createSendFlow({
    provider: provider2,
    signer: new Wallet(PK),
    request: { from: FROM, to: TO, value: parseEther('0.1') },
    opts: { confirmations: 1, pollMs: 1, timeoutMs: 2000 },
  });
  await f2.simulate();
  const res = await f2.send();
  assert.equal(res, null);
  assert.equal(f2.state, STATES.FAILED);
  assert.equal(f2.error.code, 'REVERTED');
});
