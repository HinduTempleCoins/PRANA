// Tests for burn-to-mine.mjs — the "Burn Coin Wallet" surface (BC1).
//
// Drives the driver against the REAL router/registry/price-source ABIs using a tiny mock
// provider (eth_call dispatcher), plus fixture mode. Proves: lists allowed currencies, quotes
// permanent weight, builds approve+burn for an ERC-20 path, reads accumulated weight, decodes
// the BurnedToMine event, and that IRREVERSIBILITY is surfaced on every plan. No live node;
// any timers are unref'd (there are none here, but the loop-free design keeps the process clean).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBurnToMine,
  routerIface,
  registryIface,
  priceSourceIface,
  isNative,
  NATIVE,
  DEFAULT_CURRENCIES,
} from './burn-to-mine.mjs';
import { Interface, getAddress } from 'ethers';

const ROUTER = '0x1111111111111111111111111111111111111111';
const REGISTRY = '0x2222222222222222222222222222222222222222';
const PRICE_SRC = '0x3333333333333333333333333333333333333333';
const WMELEK = '0x4444444444444444444444444444444444444444';
const CURE = '0x5555555555555555555555555555555555555555';
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const erc20Iface = new Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
]);

// A mock provider: routes eth_call by (to, function selector) to canned encoded results,
// so the driver exercises the REAL ABIs end-to-end without a node.
function makeMockProvider(state) {
  return {
    async send(method, params) {
      if (method !== 'eth_call') throw new Error(`unexpected method ${method}`);
      const [{ to, data }] = params;
      const target = getAddress(to);

      if (target === getAddress(ROUTER)) {
        const fn = routerIface.parseTransaction({ data });
        if (fn.name === 'priceSource') return routerIface.encodeFunctionResult('priceSource', [PRICE_SRC]);
        if (fn.name === 'currencyAllowed') {
          const token = getAddress(fn.args.token);
          const allowed = Boolean(state.allowed?.[token]);
          return routerIface.encodeFunctionResult('currencyAllowed', [allowed]);
        }
        if (fn.name === 'burnToMine') {
          // dry-run: succeed unless the token is a not-allowed ERC-20.
          const token = getAddress(fn.args.token);
          if (token !== getAddress(NATIVE) && !state.allowed?.[token]) {
            const e = new Error('execution reverted');
            e.data = '0x'; // custom error
            throw e;
          }
          return routerIface.encodeFunctionResult('burnToMine', [state.weights?.[token] ?? 1n]);
        }
        throw new Error(`unhandled router fn ${fn.name}`);
      }

      if (target === getAddress(PRICE_SRC)) {
        const fn = priceSourceIface.parseTransaction({ data });
        const token = getAddress(fn.args.token);
        const amount = fn.args.amount;
        const ratio = state.ratio?.[token] ?? 1n; // weight = amount * ratio
        return priceSourceIface.encodeFunctionResult('weightOf', [amount * ratio]);
      }

      if (target === getAddress(REGISTRY)) {
        const fn = registryIface.parseTransaction({ data });
        if (fn.name === 'weightOf') return registryIface.encodeFunctionResult('weightOf', [state.accountWeight ?? 0n]);
        if (fn.name === 'totalWeight') return registryIface.encodeFunctionResult('totalWeight', [state.totalWeight ?? 0n]);
        throw new Error(`unhandled registry fn ${fn.name}`);
      }

      // ERC-20 token reads (allowance / balanceOf / symbol).
      const fn = erc20Iface.parseTransaction({ data });
      if (fn.name === 'allowance') return erc20Iface.encodeFunctionResult('allowance', [state.allowance?.[target] ?? 0n]);
      if (fn.name === 'balanceOf') return erc20Iface.encodeFunctionResult('balanceOf', [state.balance?.[target] ?? 0n]);
      if (fn.name === 'symbol') return erc20Iface.encodeFunctionResult('symbol', [state.symbols?.[target] ?? 'TKN']);
      throw new Error(`unhandled erc20 fn ${fn.name}`);
    },
  };
}

// --- isNative sentinel -------------------------------------------------------

test('isNative recognizes address(0) / null as native PRANA', () => {
  assert.equal(isNative(null), true);
  assert.equal(isNative(NATIVE), true);
  assert.equal(isNative('0x0000000000000000000000000000000000000000'), true);
  assert.equal(isNative(WMELEK), false);
});

// --- listCurrencies (allowlist) ---------------------------------------------

test('listCurrencies: PRANA always allowed; wrapped tokens reflect the router allowlist', async () => {
  const provider = makeMockProvider({
    allowed: { [getAddress(WMELEK)]: true, [getAddress(CURE)]: false },
    symbols: { [getAddress(WMELEK)]: 'wMELEK', [getAddress(CURE)]: 'CURE' },
  });
  const driver = createBurnToMine({
    provider,
    router: ROUTER,
    registry: REGISTRY,
    opts: {
      currencies: [
        { id: 'prana', symbol: 'PRANA', address: null, native: true },
        { id: 'wmelek', symbol: 'wMELEK', address: WMELEK, native: false },
        { id: 'cure', symbol: 'CURE', address: CURE, native: false },
      ],
    },
  });

  const list = await driver.listCurrencies();
  const prana = list.find((c) => c.id === 'prana');
  const wmelek = list.find((c) => c.id === 'wmelek');
  const cure = list.find((c) => c.id === 'cure');

  assert.equal(prana.allowed, true);
  assert.equal(prana.native, true);
  assert.equal(wmelek.allowed, true);
  assert.equal(wmelek.symbol, 'wMELEK');
  assert.equal(cure.allowed, false); // router has not admitted CURE
});

test('DEFAULT_CURRENCIES includes PRANA + wMELEK + wVKBT + CURE', () => {
  const symbols = DEFAULT_CURRENCIES.map((c) => c.symbol);
  assert.deepEqual(symbols, ['PRANA', 'wMELEK', 'wVKBT', 'CURE']);
  assert.equal(DEFAULT_CURRENCIES[0].native, true);
});

// --- quoteWeight (price source) ---------------------------------------------

test('quoteWeight reads the price source: weight = amount * ratio', async () => {
  const provider = makeMockProvider({ ratio: { [getAddress(WMELEK)]: 2n } });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });

  const q = await driver.quoteWeight(WMELEK, 1000n);
  assert.equal(q.weight, 2000n); // 1000 * ratio 2
  assert.equal(q.priceSource, getAddress(PRICE_SRC));
  assert.equal(q.token, getAddress(WMELEK));
  assert.equal(q.fixture, false);
});

test('quoteWeight rejects a zero amount', async () => {
  const provider = makeMockProvider({});
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });
  await assert.rejects(() => driver.quoteWeight(NATIVE, 0n), /amount must be > 0/);
});

// --- buildBurn: ERC-20 path (approve + burn) --------------------------------

test('buildBurn (ERC-20): emits approve(router,amount) + burnToMine, surfaces IRREVERSIBILITY', async () => {
  const provider = makeMockProvider({
    allowed: { [getAddress(WMELEK)]: true },
    ratio: { [getAddress(WMELEK)]: 1n },
    allowance: { [getAddress(WMELEK)]: 0n }, // no allowance yet → approve needed
  });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });

  const plan = await driver.buildBurn({ from: ME, token: WMELEK, amount: 500n });

  assert.equal(plan.native, false);
  assert.equal(plan.amount, 500n);
  assert.equal(plan.weight, 500n);
  // approval step present and points the approve at the wrapped token, spender = router.
  assert.ok(plan.approval.needed);
  assert.equal(plan.approval.token, getAddress(WMELEK));
  const approveDecoded = erc20ApproveDecode(plan.approval.data);
  assert.equal(approveDecoded.spender, getAddress(ROUTER));
  assert.equal(approveDecoded.amount, 500n);

  // burn tx is genuine burnToMine(token, amount) calldata with no native value.
  assert.equal(plan.burnTx.to, getAddress(ROUTER));
  assert.equal(plan.burnTx.value, 0n);
  const burnDecoded = routerIface.decodeFunctionData('burnToMine', plan.burnTx.data);
  assert.equal(getAddress(burnDecoded[0]), getAddress(WMELEK));
  assert.equal(burnDecoded[1], 500n);

  // IRREVERSIBILITY is load-bearing — must be on every plan.
  assert.equal(plan.irreversible, true);
  assert.match(plan.warning, /PERMANENT/);
  assert.match(plan.warning, /never be unstaked/);
});

test('buildBurn (ERC-20): no approve step when allowance already covers the amount', async () => {
  const provider = makeMockProvider({
    allowed: { [getAddress(WMELEK)]: true },
    ratio: { [getAddress(WMELEK)]: 1n },
    allowance: { [getAddress(WMELEK)]: 1000n },
  });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });
  const plan = await driver.buildBurn({ from: ME, token: WMELEK, amount: 500n });
  assert.equal(plan.approval.needed, false);
});

test('buildBurn rejects a wrapped token the router has not admitted', async () => {
  const provider = makeMockProvider({ allowed: { [getAddress(CURE)]: false } });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });
  await assert.rejects(
    () => driver.buildBurn({ from: ME, token: CURE, amount: 1n }),
    /currency not allowed/,
  );
});

// --- buildBurn: native PRANA path -------------------------------------------

test('buildBurn (native PRANA): value == amount, no approval, dry-run ok', async () => {
  const provider = makeMockProvider({ ratio: { [getAddress(NATIVE)]: 1n } });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });

  const plan = await driver.buildBurn({ from: ME, token: NATIVE, amount: 777n });
  assert.equal(plan.native, true);
  assert.equal(plan.approval, null);
  assert.equal(plan.burnTx.value, 777n); // native carries msg.value == amount
  const decoded = routerIface.decodeFunctionData('burnToMine', plan.burnTx.data);
  assert.equal(getAddress(decoded[0]), getAddress(NATIVE));
  assert.equal(decoded[1], 777n);
  assert.equal(plan.simulation.ok, true);
  assert.equal(plan.irreversible, true);
});

// --- accumulatedWeight (registry read) --------------------------------------

test('accumulatedWeight reads weightOf + totalWeight from the registry', async () => {
  const provider = makeMockProvider({ accountWeight: 4200n, totalWeight: 99999n });
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });
  const acc = await driver.accumulatedWeight(ME);
  assert.equal(acc.weight, 4200n);
  assert.equal(acc.totalWeight, 99999n);
});

// --- decodeBurnReceipt -------------------------------------------------------

test('decodeBurnReceipt parses the BurnedToMine event', async () => {
  const provider = makeMockProvider({});
  const driver = createBurnToMine({ provider, router: ROUTER, registry: REGISTRY });

  const log = routerIface.encodeEventLog('BurnedToMine', [
    ME, // account
    NATIVE, // token
    1000n, // amount
    1000n, // weightAdded
    true, // nativeSink
  ]);
  const receipt = { hash: '0xfeed', logs: [{ topics: log.topics, data: log.data }] };
  const out = driver.decodeBurnReceipt(receipt);
  assert.equal(getAddress(out.account), getAddress(ME));
  assert.equal(out.amount, 1000n);
  assert.equal(out.weightAdded, 1000n);
  assert.equal(out.nativeSink, true);
  assert.equal(out.txHash, '0xfeed');
});

// --- fixture mode (no provider) ---------------------------------------------

test('fixture mode (no provider): quote, accumulated weight, and plan all work offline', async () => {
  const driver = createBurnToMine({
    provider: null,
    router: ROUTER,
    registry: REGISTRY,
    opts: {
      fixtures: {
        allowed: { [getAddress(WMELEK)]: true },
        weights: { [getAddress(WMELEK)]: 2500n },
        accountWeight: 12n,
        totalWeight: 100n,
        allowance: 0n,
      },
    },
  });

  const q = await driver.quoteWeight(WMELEK, 999n);
  assert.equal(q.weight, 2500n);
  assert.equal(q.fixture, true);

  const acc = await driver.accumulatedWeight(ME);
  assert.equal(acc.weight, 12n);
  assert.equal(acc.totalWeight, 100n);

  const plan = await driver.buildBurn({ from: ME, token: WMELEK, amount: 999n });
  assert.equal(plan.fixture, true);
  assert.equal(plan.weight, 2500n);
  assert.ok(plan.approval.needed); // allowance 0 < amount
  assert.equal(plan.simulation, null); // no dry-run offline
  assert.equal(plan.irreversible, true);
});

test('fixture native PRANA quote defaults to 1:1 parity weight', async () => {
  const driver = createBurnToMine({ provider: null, router: ROUTER, registry: REGISTRY, opts: { fixtures: {} } });
  const q = await driver.quoteWeight(NATIVE, 1234n);
  assert.equal(q.weight, 1234n);
});

// --- helper: decode an approve(spender, amount) calldata ---------------------
function erc20ApproveDecode(data) {
  const iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
  const d = iface.decodeFunctionData('approve', data);
  return { spender: getAddress(d[0]), amount: d[1] };
}
