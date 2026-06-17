// request-router.test.mjs — offline, no deps. node --test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, answerLocal, needsUnlock, parseRequest, PRANA_CHAIN_ID_HEX } from './request-router.mjs';

test('classify buckets each method', () => {
  assert.equal(classify('eth_chainId'), 'local');
  assert.equal(classify('eth_accounts'), 'local');
  assert.equal(classify('eth_requestAccounts'), 'permissioned');
  assert.equal(classify('eth_sendTransaction'), 'permissioned');
  assert.equal(classify('personal_sign'), 'permissioned');
  assert.equal(classify('wallet_switchEthereumChain'), 'permissioned');
  assert.equal(classify('eth_getBalance'), 'passthrough');
  assert.equal(classify('eth_call'), 'passthrough');
  assert.equal(classify('eth_sign'), 'refused');
  assert.equal(classify(''), 'invalid');
  assert.equal(classify(null), 'invalid');
});

test('answerLocal returns chainId/net_version/accounts', () => {
  assert.deepEqual(answerLocal('eth_chainId'), { ok: true, result: PRANA_CHAIN_ID_HEX });
  assert.deepEqual(answerLocal('net_version'), { ok: true, result: '108369' });
  assert.deepEqual(answerLocal('eth_accounts', { authorizedAccounts: ['0xabc'] }), { ok: true, result: ['0xabc'] });
  assert.equal(answerLocal('eth_accounts').result.length, 0);
  assert.equal(answerLocal('eth_getBalance').ok, false);
});

test('needsUnlock only for signing methods', () => {
  assert.equal(needsUnlock('eth_sendTransaction'), true);
  assert.equal(needsUnlock('personal_sign'), true);
  assert.equal(needsUnlock('eth_signTypedData_v4'), true);
  assert.equal(needsUnlock('eth_requestAccounts'), false); // connect approves but needs no signature
  assert.equal(needsUnlock('eth_chainId'), false);
});

test('parseRequest validates the envelope', () => {
  assert.deepEqual(parseRequest({ method: 'eth_chainId' }), { ok: true, method: 'eth_chainId', params: [] });
  assert.deepEqual(parseRequest({ method: 'eth_call', params: [{ to: '0x1' }] }).params, [{ to: '0x1' }]);
  assert.equal(parseRequest(null).ok, false);
  assert.equal(parseRequest([]).ok, false);
  assert.equal(parseRequest({ method: '' }).reason, 'bad-method');
  assert.equal(parseRequest({ method: 'x', params: 5 }).reason, 'bad-params');
});
