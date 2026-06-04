// Tests for lib/provider-1193.mjs — EIP-1193 provider shim.
// No live node: an in-memory MockUpstream + MockSignerBackend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WalletProvider,
  ProviderRpcError,
  PRANA_CHAIN_ID_HEX,
  ERROR_CODES,
} from '../lib/provider-1193.mjs';

const ACCT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Anvil #0 checksummed

// --- mocks ------------------------------------------------------------------

class MockUpstream {
  constructor() {
    this.calls = [];
    this.responses = {
      eth_getBalance: '0xde0b6b3a7640000', // 1 ETH
      eth_sendRawTransaction: '0xdeadbeef',
      eth_blockNumber: '0x10',
    };
  }
  async send(method, params) {
    this.calls.push({ method, params });
    if (method in this.responses) return this.responses[method];
    return null;
  }
}

class MockSignerBackend {
  constructor(accounts = [ACCT]) {
    this._accounts = accounts;
    this.signedTxs = [];
    this.signedMessages = [];
    this.signedTyped = [];
  }
  async getAccounts() {
    return this._accounts;
  }
  async signTransaction(tx) {
    this.signedTxs.push(tx);
    return '0xrawsignedtx';
  }
  async personalSign(message, address) {
    this.signedMessages.push({ message, address });
    return '0xsig';
  }
  async signTypedDataV4(address, typedData) {
    this.signedTyped.push({ address, typedData });
    return '0xtypedsig';
  }
}

function makeProvider({ approve } = {}) {
  const upstream = new MockUpstream();
  const signer = new MockSignerBackend();
  const provider = new WalletProvider({ upstream, signer, approve });
  return { provider, upstream, signer };
}

// --- state reads ------------------------------------------------------------

test('eth_chainId returns PRANA chain id hex', async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.request({ method: 'eth_chainId' }), PRANA_CHAIN_ID_HEX);
});

test('eth_accounts is empty before connect (no prompt)', async () => {
  const { provider } = makeProvider({ approve: async () => true });
  assert.deepEqual(await provider.request({ method: 'eth_accounts' }), []);
});

test('net_version returns decimal chain id', async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.request({ method: 'net_version' }), '108369');
});

// --- permission deny --------------------------------------------------------

test('default-deny: eth_requestAccounts rejects with 4001 when no approve hook', async () => {
  const { provider } = makeProvider(); // no approve => default-deny
  await assert.rejects(
    () => provider.request({ method: 'eth_requestAccounts' }),
    (e) => e instanceof ProviderRpcError && e.code === ERROR_CODES.USER_REJECTED,
  );
});

test('explicit deny hook → 4001', async () => {
  const { provider } = makeProvider({ approve: async () => false });
  await assert.rejects(
    () => provider.request({ method: 'eth_requestAccounts' }),
    (e) => e.code === 4001,
  );
});

// --- connect + events -------------------------------------------------------

test('eth_requestAccounts approved → returns accounts, emits connect+accountsChanged', async () => {
  const { provider, signer } = makeProvider({ approve: async () => true });
  const events = [];
  provider.on('connect', (info) => events.push(['connect', info]));
  provider.on('accountsChanged', (a) => events.push(['accountsChanged', a]));

  const accts = await provider.request({ method: 'eth_requestAccounts' });
  assert.deepEqual(accts, [ACCT]);
  // eth_accounts now reflects authorization without re-prompting.
  assert.deepEqual(await provider.request({ method: 'eth_accounts' }), [ACCT]);

  const eventNames = events.map((e) => e[0]);
  assert.ok(eventNames.includes('connect'), 'connect emitted');
  assert.ok(eventNames.includes('accountsChanged'), 'accountsChanged emitted');
  const connectEv = events.find((e) => e[0] === 'connect');
  assert.equal(connectEv[1].chainId, PRANA_CHAIN_ID_HEX);
});

test('second eth_requestAccounts does not re-prompt', async () => {
  let prompts = 0;
  const upstream = new MockUpstream();
  const signer = new MockSignerBackend();
  const provider = new WalletProvider({
    upstream,
    signer,
    approve: async () => {
      prompts++;
      return true;
    },
  });
  await provider.request({ method: 'eth_requestAccounts' });
  await provider.request({ method: 'eth_requestAccounts' });
  assert.equal(prompts, 1);
});

// --- send transaction -------------------------------------------------------

test('eth_sendTransaction routes signer → upstream eth_sendRawTransaction', async () => {
  const { provider, upstream, signer } = makeProvider({ approve: async () => true });
  await provider.request({ method: 'eth_requestAccounts' });
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: ACCT, to: ACCT, value: '0x1' }],
  });
  assert.equal(hash, '0xdeadbeef');
  assert.equal(signer.signedTxs.length, 1);
  const rawCall = upstream.calls.find((c) => c.method === 'eth_sendRawTransaction');
  assert.deepEqual(rawCall.params, ['0xrawsignedtx']);
});

test('eth_sendTransaction denied → 4001, nothing broadcast', async () => {
  const upstream = new MockUpstream();
  const signer = new MockSignerBackend();
  let allow = true;
  const provider = new WalletProvider({ upstream, signer, approve: async () => allow });
  await provider.request({ method: 'eth_requestAccounts' });
  allow = false;
  await assert.rejects(
    () => provider.request({ method: 'eth_sendTransaction', params: [{ from: ACCT, to: ACCT }] }),
    (e) => e.code === 4001,
  );
  assert.equal(signer.signedTxs.length, 0);
  assert.ok(!upstream.calls.some((c) => c.method === 'eth_sendRawTransaction'));
});

test('eth_sendTransaction from unauthorized account → 4100', async () => {
  const { provider } = makeProvider({ approve: async () => true });
  await provider.request({ method: 'eth_requestAccounts' });
  await assert.rejects(
    () =>
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: '0x000000000000000000000000000000000000dEaD', to: ACCT }],
      }),
    (e) => e.code === ERROR_CODES.UNAUTHORIZED,
  );
});

// --- signing ----------------------------------------------------------------

test('personal_sign routes to backend after approval', async () => {
  const { provider, signer } = makeProvider({ approve: async () => true });
  await provider.request({ method: 'eth_requestAccounts' });
  const sig = await provider.request({ method: 'personal_sign', params: ['0xhello', ACCT] });
  assert.equal(sig, '0xsig');
  assert.equal(signer.signedMessages[0].address, ACCT);
});

test('eth_signTypedData_v4 routes to backend after approval', async () => {
  const { provider, signer } = makeProvider({ approve: async () => true });
  await provider.request({ method: 'eth_requestAccounts' });
  const td = { domain: {}, types: {}, primaryType: 'X', message: {} };
  const sig = await provider.request({ method: 'eth_signTypedData_v4', params: [ACCT, td] });
  assert.equal(sig, '0xtypedsig');
  assert.deepEqual(signer.signedTyped[0].typedData, td);
});

test('eth_sign is explicitly unsupported (4200)', async () => {
  const { provider } = makeProvider({ approve: async () => true });
  await assert.rejects(
    () => provider.request({ method: 'eth_sign', params: [ACCT, '0xdead'] }),
    (e) => e.code === ERROR_CODES.UNSUPPORTED_METHOD,
  );
});

// --- switch chain -----------------------------------------------------------

test('wallet_switchEthereumChain to PRANA succeeds (returns null)', async () => {
  const { provider } = makeProvider();
  assert.equal(
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: PRANA_CHAIN_ID_HEX }],
    }),
    null,
  );
});

test('wallet_switchEthereumChain case-insensitive match', async () => {
  const { provider } = makeProvider();
  assert.equal(
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1A751' }],
    }),
    null,
  );
});

test('wallet_switchEthereumChain to other chain → 4902', async () => {
  const { provider } = makeProvider();
  await assert.rejects(
    () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }),
    (e) => e.code === ERROR_CODES.CHAIN_NOT_ADDED,
  );
});

// --- passthrough ------------------------------------------------------------

test('unknown read method passes through to upstream', async () => {
  const { provider, upstream } = makeProvider();
  const bal = await provider.request({ method: 'eth_getBalance', params: [ACCT, 'latest'] });
  assert.equal(bal, '0xde0b6b3a7640000');
  assert.ok(upstream.calls.some((c) => c.method === 'eth_getBalance'));
});

// --- bad input --------------------------------------------------------------

test('request without method → invalid params', async () => {
  const { provider } = makeProvider();
  await assert.rejects(
    () => provider.request({ params: [] }),
    (e) => e.code === ERROR_CODES.INVALID_PARAMS,
  );
});

// --- UI-driven account changes ---------------------------------------------

test('disconnectDapp emits accountsChanged([])', async () => {
  const { provider } = makeProvider({ approve: async () => true });
  await provider.request({ method: 'eth_requestAccounts' });
  let got = null;
  provider.on('accountsChanged', (a) => (got = a));
  provider.disconnectDapp();
  assert.deepEqual(got, []);
  assert.deepEqual(await provider.request({ method: 'eth_accounts' }), []);
});
