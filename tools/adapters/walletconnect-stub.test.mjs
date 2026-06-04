// walletconnect-stub.test.mjs — proves the WalletConnect session_request ->
// EIP-1193 routing (the one runnable piece of the stub). No network, no deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalSignerFallback,
  WalletConnectSessionHandler,
  PRANA_EIP155_CHAIN,
  SUPPORTED_METHODS,
} from './walletconnect-stub.mjs';

// A fake EIP-1193 provider that records the exact { method, params } it receives,
// matching the wallet WalletProvider.request(args) EIP-1193 contract.
function makeProvider(returnValue = '0xresult') {
  const calls = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      return returnValue;
    },
  };
}

// Build a WalletConnect-shaped session_request.
function wcRequest(method, params, { chainId = PRANA_EIP155_CHAIN, topic = 't1' } = {}) {
  return { id: 1, topic, chainId, params: { request: { method, params } } };
}

test('toEip1193 normalizes a session_request into { method, params }', () => {
  const fb = new LocalSignerFallback({ provider: makeProvider() });
  const out = fb.toEip1193(
    wcRequest('personal_sign', ['0xdead', '0xabc']),
  );
  assert.deepEqual(out, { method: 'personal_sign', params: ['0xdead', '0xabc'] });
});

test('toEip1193 defaults missing params to an empty array', () => {
  const fb = new LocalSignerFallback({ provider: makeProvider() });
  const out = fb.toEip1193(wcRequest('eth_accounts', undefined));
  assert.deepEqual(out, { method: 'eth_accounts', params: [] });
});

test('routeRequest dispatches the normalized call to the provider and returns its result', async () => {
  const provider = makeProvider('0xsignedhash');
  const fb = new LocalSignerFallback({ provider });
  const result = await fb.routeRequest(
    wcRequest('eth_sendTransaction', [{ from: '0xabc', to: '0xdef', value: '0x1' }]),
  );
  assert.equal(result, '0xsignedhash');
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0], {
    method: 'eth_sendTransaction',
    params: [{ from: '0xabc', to: '0xdef', value: '0x1' }],
  });
});

test('routeRequest rejects a request scoped to a foreign chain', async () => {
  const fb = new LocalSignerFallback({ provider: makeProvider() });
  await assert.rejects(
    () => fb.routeRequest(wcRequest('eth_chainId', [], { chainId: 'eip155:1' })),
    /unsupported chain/,
  );
});

test('routeRequest rejects an unsupported method', async () => {
  const fb = new LocalSignerFallback({ provider: makeProvider() });
  await assert.rejects(
    () => fb.routeRequest(wcRequest('eth_sign', ['0xabc', '0xdead'])),
    /not supported/,
  );
});

test('LocalSignerFallback ctor requires a request()-capable provider', () => {
  assert.throws(() => new LocalSignerFallback({ provider: {} }), /request\(\) method/);
});

test('handler: rejected proposal throws user-rejected (default-deny)', async () => {
  const handler = new WalletConnectSessionHandler({
    provider: makeProvider(),
    getAccounts: async () => ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    // no approve hook -> default deny
  });
  await assert.rejects(
    () => handler.onSessionProposal({ params: { proposer: { metadata: { url: 'https://dapp.example' } } } }),
    (e) => e.code === 4001,
  );
});

test('handler: approved proposal grants PRANA namespaces with CAIP-10 accounts', async () => {
  const acct = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const handler = new WalletConnectSessionHandler({
    provider: makeProvider(),
    getAccounts: async () => [acct],
    approve: async () => true,
  });
  const { topic, namespaces } = await handler.onSessionProposal({
    params: { proposer: { metadata: { url: 'https://dapp.example' } } },
  });
  assert.ok(topic);
  assert.deepEqual(namespaces.eip155.chains, [PRANA_EIP155_CHAIN]);
  assert.deepEqual(namespaces.eip155.accounts, [`${PRANA_EIP155_CHAIN}:${acct}`]);
  assert.deepEqual(namespaces.eip155.methods, [...SUPPORTED_METHODS]);
  assert.deepEqual(handler.activeTopics(), [topic]);
});

test('handler: a session_request on an unknown topic is rejected', async () => {
  const handler = new WalletConnectSessionHandler({
    provider: makeProvider(),
    getAccounts: async () => ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    approve: async () => true,
  });
  await assert.rejects(
    () => handler.onSessionRequest(wcRequest('eth_accounts', [], { topic: 'nope' })),
    /unknown session topic/,
  );
});

test('handler: end-to-end proposal -> request routes into the provider', async () => {
  const provider = makeProvider('0xhash');
  const handler = new WalletConnectSessionHandler({
    provider,
    getAccounts: async () => ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    approve: async () => true,
  });
  const { topic } = await handler.onSessionProposal({
    params: { proposer: { metadata: { url: 'https://dapp.example' } } },
  });
  const res = await handler.onSessionRequest(
    wcRequest('personal_sign', ['0xhello', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'], { topic }),
  );
  assert.equal(res, '0xhash');
  assert.equal(provider.calls[0].method, 'personal_sign');
});

// Sanity: the stub also routes into the REAL wallet EIP-1193 provider (its
// request() surface), not just a mock — proves the shape binding is correct.
//
// The wallet front-end lives in a separate, optionally-present package
// (resolved at ../../<wallet>/lib/provider-1193.mjs). When it is not checked out
// this binding test SKIPS rather than failing, so the public adapter suite stays
// green standalone. The shape it binds to is the standard EIP-1193 WalletProvider.
test('routes into the real wallet WalletProvider.request surface', async (t) => {
  let WalletProvider;
  try {
    ({ WalletProvider } = await import('../../akasha/lib/provider-1193.mjs'));
  } catch {
    t.skip('wallet provider package not present in this checkout');
    return;
  }
  // Minimal upstream + signer backends so eth_chainId resolves locally.
  const upstream = { async send() { return '0x0'; } };
  const signer = {
    async getAccounts() { return []; },
    async signTransaction() { return '0x'; },
    async personalSign() { return '0x'; },
    async signTypedDataV4() { return '0x'; },
  };
  const provider = new WalletProvider({ upstream, signer, approve: async () => false });
  const fb = new LocalSignerFallback({ provider });
  // eth_chainId is answered locally by the provider — proves routeRequest reaches it.
  const out = await fb.routeRequest(wcRequest('eth_chainId', []));
  assert.equal(out, '0x1a751'); // PRANA chainId hex
});
