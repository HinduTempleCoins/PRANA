// Tests for the pure JSON-RPC response mappers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantityToBig,
  quantityToNumber,
  mapBlockSummary,
  mapBlockDetail,
  mapTransaction,
  mapTxWithReceipt,
  classifyAddress,
  mapAddressInfo,
} from '../src/lib/rpcMappers.js';

test('quantity coercion', () => {
  assert.equal(quantityToBig('0x10'), 16n);
  assert.equal(quantityToBig(null), null);
  assert.equal(quantityToBig('garbage'), null);
  assert.equal(quantityToNumber('0x10'), 16);
  assert.equal(quantityToNumber(null), null);
  // too big for Number
  assert.equal(quantityToNumber('0xffffffffffffffffffff'), null);
});

const rawBlock = {
  number: '0x2a',
  hash: '0xblockhash',
  parentHash: '0xparent',
  timestamp: '0x6131a000',
  gasUsed: '0x5208',
  gasLimit: '0x1c9c380',
  baseFeePerGas: '0x7',
  miner: '0xminer',
  transactions: ['0xtx1', '0xtx2', '0xtx3'],
};

test('mapBlockSummary', () => {
  const b = mapBlockSummary(rawBlock);
  assert.equal(b.number, 42);
  assert.equal(b.numberBig, 42n);
  assert.equal(b.txCount, 3);
  assert.equal(b.gasUsed, 21000n);
  assert.equal(b.baseFeePerGas, 7n);
  assert.equal(b.miner, '0xminer');
  assert.equal(mapBlockSummary(null), null);
});

test('mapBlockDetail with hash-only txs', () => {
  const d = mapBlockDetail(rawBlock);
  assert.equal(d.txsAreObjects, false);
  assert.deepEqual(d.transactions, ['0xtx1', '0xtx2', '0xtx3']);
});

test('mapBlockDetail with full tx objects', () => {
  const d = mapBlockDetail({
    ...rawBlock,
    transactions: [{ hash: '0xtxA', from: '0xa', to: '0xb', value: '0x0' }],
  });
  assert.equal(d.txsAreObjects, true);
  assert.equal(d.transactions[0].hash, '0xtxA');
  assert.equal(d.transactions[0].from, '0xa');
});

test('mapTransaction', () => {
  const tx = mapTransaction({
    hash: '0xh',
    from: '0xf',
    to: '0xt',
    value: '0xde0b6b3a7640000',
    nonce: '0x3',
    gas: '0x5208',
    blockNumber: '0x2a',
    input: '0x',
    type: '0x2',
  });
  assert.equal(tx.value, 10n ** 18n);
  assert.equal(tx.nonce, 3);
  assert.equal(tx.blockNumber, 42);
  assert.equal(tx.type, 2);
  // contract creation: to null
  assert.equal(mapTransaction({ hash: '0xh', to: null }).to, null);
});

test('mapTxWithReceipt status mapping', () => {
  const txRaw = { hash: '0xh', from: '0xf', to: '0xt', value: '0x0', blockNumber: '0x1' };
  assert.equal(mapTxWithReceipt(txRaw, { status: '0x1', gasUsed: '0x5208' }).status, 'success');
  assert.equal(mapTxWithReceipt(txRaw, { status: '0x0' }).status, 'failed');
  // pending: no block, no receipt
  assert.equal(mapTxWithReceipt({ hash: '0xh', to: '0xt', value: '0x0' }, null).status, 'pending');
  // receipt carries gasUsed + contractAddress
  const r = mapTxWithReceipt(txRaw, { status: '0x1', gasUsed: '0x5208', contractAddress: '0xnew' });
  assert.equal(r.gasUsed, 21000n);
  assert.equal(r.contractAddress, '0xnew');
});

test('classifyAddress', () => {
  assert.equal(classifyAddress('0x'), 'eoa');
  assert.equal(classifyAddress(''), 'eoa');
  assert.equal(classifyAddress('0x6080604052'), 'contract');
  assert.equal(classifyAddress(null), 'unknown');
});

test('mapAddressInfo', () => {
  const info = mapAddressInfo({
    address: '0xabc',
    balanceWei: '0xde0b6b3a7640000',
    code: '0x6080604052',
    txCount: '0x5',
  });
  assert.equal(info.balance, 10n ** 18n);
  assert.equal(info.kind, 'contract');
  assert.equal(info.codeSize, 5);
  assert.equal(info.txCount, 5);
  // EOA
  assert.equal(mapAddressInfo({ address: '0xabc', balanceWei: '0x0', code: '0x', txCount: '0x0' }).kind, 'eoa');
});
