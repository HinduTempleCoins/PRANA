// Tests for lib/balance-dashboard.mjs — mock provider, no live node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { createBalanceDashboard } from '../lib/balance-dashboard.mjs';
import { loadTokenList } from '../lib/token-list.mjs';

const ACCT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOK_A = '0x1111111111111111111111111111111111111111';
const TOK_B = '0x2222222222222222222222222222222222222222';

const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)']);
const encBal = (v) => ERC20.encodeFunctionResult('balanceOf', [v]);

function makeList(tokens) {
  return loadTokenList({ name: 'test', chainId: 108369, tokens });
}

// Mock provider: sequential balanceOf path (no Multicall registry).
// `balances` maps token address (lowercase) -> bigint; native via getBalance.
function makeProvider(nativeBal, balances) {
  return {
    async getBalance() {
      return nativeBal;
    },
    async call({ to }) {
      const v = balances[to.toLowerCase()] ?? 0n;
      return encBal(v);
    },
  };
}

test('load: native PRANA row + one row per token, formatted', async () => {
  const list = makeList([
    { address: TOK_A, symbol: 'AAA', name: 'Token A', decimals: 18 },
    { address: TOK_B, symbol: 'BBB', name: 'Token B', decimals: 6 },
  ]);
  const provider = makeProvider(2_000000000000000000n, {
    [TOK_A]: 5_000000000000000000n,
    [TOK_B]: 1_500000n,
  });
  const dash = createBalanceDashboard(provider, list, ACCT);
  const rows = await dash.load();

  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'native');
  assert.equal(rows[0].symbol, 'PRANA');
  assert.equal(rows[0].formatted, '2.0');
  assert.equal(rows[0].address, null);

  assert.equal(rows[1].kind, 'token');
  assert.equal(rows[1].symbol, 'AAA');
  assert.equal(rows[1].name, 'Token A');
  assert.equal(rows[1].formatted, '5.0');

  assert.equal(rows[2].decimals, 6);
  assert.equal(rows[2].formatted, '1.5');
});

test('displayDecimals truncates the formatted string', async () => {
  const list = makeList([{ address: TOK_A, symbol: 'AAA', name: 'A', decimals: 18 }]);
  const provider = makeProvider(0n, { [TOK_A]: 1_234567890123456789n });
  const dash = createBalanceDashboard(provider, list, ACCT, { displayDecimals: 3 });
  const rows = await dash.load();
  assert.equal(rows[1].formatted, '1.234');
});

test('refresh: change detection flags only the changed keys', async () => {
  const list = makeList([
    { address: TOK_A, symbol: 'AAA', name: 'A', decimals: 18 },
    { address: TOK_B, symbol: 'BBB', name: 'B', decimals: 18 },
  ]);
  const state = {
    native: 1n,
    [TOK_A]: 10n,
    [TOK_B]: 20n,
  };
  const provider = {
    async getBalance() {
      return state.native;
    },
    async call({ to }) {
      return encBal(state[to.toLowerCase()] ?? 0n);
    },
  };
  const dash = createBalanceDashboard(provider, list, ACCT);
  await dash.load();

  // No change → clean.
  let r = await dash.refresh();
  assert.equal(r.dirty, false);
  assert.deepEqual(r.changed, []);

  // Change native + token A only.
  state.native = 2n;
  state[TOK_A] = 99n;
  r = await dash.refresh();
  assert.equal(r.dirty, true);
  assert.equal(r.changed.includes('native'), true);
  assert.equal(r.changed.some((k) => k.toLowerCase() === TOK_A), true);
  assert.equal(r.changed.some((k) => k.toLowerCase() === TOK_B), false);
});

test('constructor guards: invalid account + missing provider methods', () => {
  const list = makeList([]);
  assert.throws(() => createBalanceDashboard({}, list, ACCT), /call\(\) is required/);
  assert.throws(
    () => createBalanceDashboard({ call() {} }, list, ACCT),
    /getBalance\(\) is required/,
  );
  assert.throws(
    () => createBalanceDashboard({ call() {}, getBalance() {} }, list, 'not-an-address'),
    /invalid account/,
  );
});

test('rows getter is empty before load', () => {
  const list = makeList([]);
  const dash = createBalanceDashboard(makeProvider(0n, {}), list, ACCT);
  assert.deepEqual(dash.rows, []);
});
