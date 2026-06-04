import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, recoverTransactionAddress } from 'viem';

import { buildTransfer, signTransfer } from '../src/txsigner.js';

// Well-known Anvil/Hardhat test account #0 (DEV ONLY).
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Anvil account #1

test('buildTransfer sets the correct to / value / chainId', () => {
  const tx = buildTransfer({ to: TO, valueEth: '1.5', nonce: 0 });
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.to, TO);
  assert.equal(tx.value, parseEther('1.5'));
  assert.equal(tx.chainId, 108369); // PRANA default
  assert.equal(tx.nonce, 0);
  assert.equal(tx.gas, 21000n);
});

test('buildTransfer honors an explicit chainId', () => {
  const tx = buildTransfer({ to: TO, valueEth: '1', nonce: 3, chainId: 1 });
  assert.equal(tx.chainId, 1);
});

test('signTransfer produces a tx that recovers to the signer address', async () => {
  const serializedTransaction = await signTransfer({
    privateKey: TEST_KEY,
    to: TO,
    valueEth: '2',
    nonce: 0,
  });

  assert.match(serializedTransaction, /^0x02/); // EIP-1559 typed envelope

  const recovered = await recoverTransactionAddress({ serializedTransaction });
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
});

test('signTransfer respects custom fee and gas params', async () => {
  const serializedTransaction = await signTransfer({
    privateKey: TEST_KEY,
    to: TO,
    valueEth: '0.01',
    nonce: 7,
    chainId: 108369,
    maxFeePerGasGwei: '5',
    maxPriorityFeePerGasGwei: '2',
    gas: 30000n,
  });

  const recovered = await recoverTransactionAddress({ serializedTransaction });
  assert.equal(recovered.toLowerCase(), TEST_ADDRESS.toLowerCase());
});
