import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import {
  signMessage,
  verifyMsg,
  signTyped,
  verifyTyped,
} from '../src/signer.js';

// Well-known test key (Anvil/Hardhat account #0) — DEV ONLY.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WRONG_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const account = privateKeyToAccount(TEST_KEY);

test('signMessage / verifyMsg — recovers right address, rejects wrong', async () => {
  const message = 'akasha login challenge: nonce 42';
  const signature = await signMessage(account, message);

  assert.equal(
    await verifyMsg(account.address, message, signature),
    true,
    'should verify true for the signing address',
  );
  assert.equal(
    await verifyMsg(WRONG_ADDRESS, message, signature),
    false,
    'should verify false for a different address',
  );
});

test('signTyped / verifyTyped — EIP-712 Login payload', async () => {
  const typedData = {
    domain: {
      name: 'Akasha',
      version: '1',
      chainId: 108369,
    },
    types: {
      Login: [
        { name: 'user', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'Login',
    message: {
      user: account.address,
      nonce: 1234n,
    },
  };

  const signature = await signTyped(account, typedData);

  assert.equal(
    await verifyTyped(account.address, typedData, signature),
    true,
    'should verify true for the signing address',
  );
  assert.equal(
    await verifyTyped(WRONG_ADDRESS, typedData, signature),
    false,
    'should verify false for a different address',
  );
});
