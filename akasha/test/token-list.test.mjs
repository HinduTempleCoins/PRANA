import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress } from 'ethers';

import { loadRegistry } from '../lib/contract-registry.mjs';
import {
  loadTokenList,
  fromDeployments,
  balancesOf,
  hasErc20Surface,
} from '../lib/token-list.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ABIS_DIR = path.resolve(__dirname, '../../contracts/abis');
const CHAIN_ID = 108369;

const A1 = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const A2 = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
const ACCT = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');

// ---- loadTokenList: accept / reject table -----------------------------------

const REJECT = [
  ['non-object top', 42, /top level must be an object/],
  ['missing name', { chainId: 1, tokens: [] }, /"name" must be/],
  ['bad chainId', { name: 'x', chainId: 0, tokens: [] }, /"chainId" must be/],
  ['tokens not array', { name: 'x', chainId: 1, tokens: {} }, /"tokens" must be an array/],
  [
    'bad address',
    { name: 'x', chainId: 1, tokens: [{ address: '0x123', symbol: 'A', name: 'A', decimals: 18 }] },
    /invalid address/,
  ],
  [
    'bad decimals',
    { name: 'x', chainId: 1, tokens: [{ address: A1, symbol: 'A', name: 'A', decimals: 40 }] },
    /decimals must be/,
  ],
  [
    'empty symbol',
    { name: 'x', chainId: 1, tokens: [{ address: A1, symbol: '', name: 'A', decimals: 18 }] },
    /symbol must be/,
  ],
  [
    'duplicate address',
    {
      name: 'x',
      chainId: 1,
      tokens: [
        { address: A1, symbol: 'A', name: 'A', decimals: 18 },
        { address: A1.toLowerCase(), symbol: 'B', name: 'B', decimals: 18 },
      ],
    },
    /duplicate address/,
  ],
];

for (const [label, input, re] of REJECT) {
  test(`loadTokenList rejects: ${label}`, () => {
    assert.throws(() => loadTokenList(input), re);
  });
}

test('loadTokenList accepts a valid list and checksums addresses', () => {
  const list = loadTokenList({
    name: 'PRANA',
    chainId: 108369,
    tokens: [
      { address: A1.toLowerCase(), symbol: 'AKA', name: 'Akasha', decimals: 18, tags: ['core'] },
      { address: A2.toLowerCase(), symbol: 'PRN', name: 'Prana', decimals: 6, logoURI: 'http://x/y.png' },
    ],
  });
  assert.equal(list.tokens[0].address, A1); // checksummed
  assert.deepEqual(list.tokens[0].tags, ['core']);
  assert.equal(list.tokens[1].logoURI, 'http://x/y.png');
});

// ---- hasErc20Surface against the real ABI dir -------------------------------

test('hasErc20Surface true for ERC20Base, false for an interface-only / non-token', () => {
  const reg = loadRegistry({ abisDir: ABIS_DIR, chainId: CHAIN_ID });
  assert.equal(hasErc20Surface(reg.get('ERC20Base').abi), true);
  // GovernorDAO is not an ERC-20 (no transfer/symbol/decimals trio).
  if (reg.has('GovernorDAO')) {
    assert.equal(hasErc20Surface(reg.get('GovernorDAO').abi), false);
  }
});

// ---- fromDeployments against the real ABI dir + a stub registry --------------

test('fromDeployments builds a list from deployed ERC-20s only', () => {
  // Build a stub registry: ERC20Base deployed (token), GovernorDAO deployed (not token),
  // and an undeployed ERC20Base-like entry must be skipped.
  const real = loadRegistry({ abisDir: ABIS_DIR, chainId: CHAIN_ID });
  const erc20Abi = real.get('ERC20Base').abi;
  const govAbi = real.has('GovernorDAO') ? real.get('GovernorDAO').abi : [{ type: 'function', name: 'x', inputs: [], outputs: [] }];

  const entries = new Map([
    ['Akasha', { name: 'Akasha', address: A1, abi: erc20Abi }],
    ['Gov', { name: 'Gov', address: A2, abi: govAbi }], // not a token -> skipped
    ['Undeployed', { name: 'Undeployed', address: null, abi: erc20Abi }], // no address -> skipped
  ]);
  const stubRegistry = {
    chainId: String(CHAIN_ID),
    list: () => [...entries.keys()],
    has: (n) => entries.has(n),
    get: (n) => entries.get(n),
  };

  const list = fromDeployments(stubRegistry);
  assert.equal(list.chainId, CHAIN_ID);
  assert.equal(list.tokens.length, 1, 'only the deployed ERC-20 should appear');
  assert.equal(list.tokens[0].symbol, 'Akasha');
  assert.equal(list.tokens[0].address, A1);
});

// ---- balancesOf: mocked multicall batching + sequential fallback -------------

const ERC20_IFACE = new Interface(['function balanceOf(address) view returns (uint256)']);

function makeList() {
  return loadTokenList({
    name: 'PRANA',
    chainId: 108369,
    tokens: [
      { address: A1, symbol: 'AKA', name: 'Akasha', decimals: 18 },
      { address: A2, symbol: 'PRN', name: 'Prana', decimals: 18 },
    ],
  });
}

test('balancesOf uses Multicall.aggregate when Multicall is deployed (mock provider)', async () => {
  const MC_ADDR = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  const real = loadRegistry({ abisDir: ABIS_DIR, chainId: CHAIN_ID });
  const mcIface = real.get('Multicall').iface;

  // Registry stub exposing the Multicall entry.
  const registry = {
    chainId: String(CHAIN_ID),
    has: (n) => n === 'Multicall',
    get: (n) => {
      if (n !== 'Multicall') throw new Error('no');
      return { name: 'Multicall', address: MC_ADDR, abi: real.get('Multicall').abi, iface: mcIface };
    },
    list: () => ['Multicall'],
  };

  let calledTo = null;
  const provider = {
    call: async ({ to, data }) => {
      calledTo = to;
      // Decode the aggregate() input to prove batching, then craft the response.
      const [calls] = mcIface.decodeFunctionResult
        ? mcIface.decodeFunctionData('aggregate', data)
        : [];
      assert.equal(calls.length, 2, 'two calls batched into one aggregate');
      const balances = [123n, 456n].map((b) =>
        ERC20_IFACE.encodeFunctionResult('balanceOf', [b]),
      );
      return mcIface.encodeFunctionResult('aggregate', [99n, balances]);
    },
  };

  const res = await balancesOf(provider, makeList(), ACCT, { registry });
  assert.equal(calledTo, MC_ADDR, 'single call goes to the Multicall contract');
  assert.deepEqual(res.map((r) => r.balance), [123n, 456n]);
  assert.equal(res[0].symbol, 'AKA');
});

test('balancesOf falls back to sequential per-token calls when no Multicall', async () => {
  const seen = [];
  const balByAddr = { [A1]: 11n, [A2]: 22n };
  const provider = {
    call: async ({ to, data }) => {
      seen.push(to);
      // Confirm it's a balanceOf call.
      const [acct] = ERC20_IFACE.decodeFunctionData('balanceOf', data);
      assert.equal(getAddress(acct), ACCT);
      return ERC20_IFACE.encodeFunctionResult('balanceOf', [balByAddr[getAddress(to)]]);
    },
  };
  // registry without Multicall (has() returns false).
  const registry = { chainId: String(CHAIN_ID), has: () => false, get: () => null, list: () => [] };
  const res = await balancesOf(provider, makeList(), ACCT, { registry });
  assert.deepEqual(seen, [A1, A2], 'one sequential call per token');
  assert.deepEqual(res.map((r) => r.balance), [11n, 22n]);
});

test('balancesOf rejects a provider without call()', async () => {
  await assert.rejects(() => balancesOf({}, makeList(), ACCT), /provider with a call/);
});
