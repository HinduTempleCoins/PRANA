import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { pranaChain, publicClient, walletClient, chainConfig } from '../src/provider.js';

// Publicly-known Anvil/Hardhat dev key #0 — DEV ONLY, no funds at risk.
const knownKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

test('pranaChain has correct id and native currency symbol', () => {
  assert.equal(pranaChain.id, 108369);
  assert.equal(pranaChain.nativeCurrency.symbol, 'PRANA');
  assert.equal(pranaChain.nativeCurrency.name, 'PRANA');
  assert.equal(pranaChain.nativeCurrency.decimals, 18);
});

test('chainConfig returns the plain chain config object', () => {
  const cfg = chainConfig();
  assert.equal(cfg.id, 108369);
  assert.equal(cfg.name, 'PRANA');
  assert.equal(cfg.nativeCurrency.symbol, 'PRANA');
  assert.deepEqual(cfg.rpcUrls.default.http, ['http://127.0.0.1:8545']);
});

test('publicClient constructs and exposes chain id, no network call', () => {
  const client = publicClient();
  assert.equal(client.chain.id, 108369);
});

test('walletClient binds account address, no network call', () => {
  const account = privateKeyToAccount(knownKey);
  const client = walletClient(account);
  assert.ok(client.account.address);
  assert.equal(client.account.address, account.address);
  assert.equal(client.chain.id, 108369);
});
