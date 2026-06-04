// BurnToMineView — the "Burn Coin Wallet" surface (BC1, Round 10, Burn-Stake doc §2).
//
// One-click BURN-TO-MINE from inside Akasha: the pool's THIRD door into PRANA mining —
// capital / commitment, NO GPU. Pick a currency (native PRANA, or an allowlisted wrapped
// ecosystem token: wMELEK / wVKBT / CURE), enter an amount, see the PERMANENT burn-stake
// weight it would credit, read a CLEAR irreversibility warning, then confirm the burn.
//
// The on-chain logic lives in lib/burn-to-mine.mjs (the headless driver bound to the REAL
// MultiCurrencyBurnRouter + BurnStakeRegistry + IBurnStakePriceSource signatures); this view
// only sequences the UI and signs/broadcasts the txs the driver returns. Keys never leave lib/.
//
// ⚠ IRREVERSIBLE — load-bearing UX: burning DESTROYS the principal and the credited weight can
// NEVER be unstaked, withdrawn, or transferred. The warning below is intentionally loud and the
// final action requires an explicit "I understand" acknowledgement. Do not soften it.
//
// ERC-20 vs native (mirrors TradeView / bridge): a wrapped token burn needs a one-time
// approve(router, amount) first (the router pulls then burns); native PRANA carries its value
// as msg.value and needs no approval. The driver detects this and returns an `approval` step.
//
// Fixture / offline mode: with no router/registry address (or no node) the view runs against
// the driver's fixture fallback so it renders and is demoable offline — the rest of Akasha's
// "works without a live node" rule. A real signer (via the keystore) is only needed to burn.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBurnToMine,
  BURN_CURRENCIES,
  Keystore,
  createLocalStorageStorage,
  sendAndWait,
  buildTx,
} from '../lib/wallet.js';
import { formatPrana, parsePranaToWei, truncateAddress, truncateHash } from '../lib/format.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Fixture addresses used for the offline preview (the driver runs in fixture mode here).
const FIXTURE_ROUTER = '0x00000000000000000000000000000000000000B1';
const FIXTURE_REGISTRY = '0x00000000000000000000000000000000000000B2';
const FIXTURE_WMELEK = '0x4444444444444444444444444444444444444444';

// Fixture currency catalog: PRANA + one wrapped token (wMELEK) wired to a resolvable address so
// the offline preview can exercise the full approve→burn path.
const FIXTURE_CURRENCIES = [
  { id: 'prana', symbol: 'PRANA', label: 'PRANA (native)', address: null, native: true },
  { id: 'wmelek', symbol: 'wMELEK', label: 'wMELEK (wrapped MELEK)', address: FIXTURE_WMELEK, native: false },
];
const FIXTURE_STATE = {
  allowed: { [FIXTURE_WMELEK]: true },
  weights: { [FIXTURE_WMELEK]: 0n }, // computed 1:1 below per-amount when absent
  accountWeight: 0n,
  totalWeight: 0n,
  allowance: 0n,
};

function makeKeystore() {
  return new Keystore({ storage: createLocalStorageStorage() });
}

export default function BurnToMineView({ rpc }) {
  const ksRef = useRef(null);
  if (ksRef.current == null) ksRef.current = makeKeystore();
  const ks = ksRef.current;

  // Deployed addresses. Empty => fixture/offline mode.
  const [router, setRouter] = useState('');
  const [registry, setRegistry] = useState('');
  const [account, setAccount] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);

  const isFixture = !ADDR_RE.test(router) || !ADDR_RE.test(registry);

  // The headless driver. Fixture mode passes a null provider + fixtures so reads never hit RPC.
  const driver = useMemo(() => {
    try {
      if (isFixture) {
        return createBurnToMine({
          provider: null,
          router: FIXTURE_ROUTER,
          registry: FIXTURE_REGISTRY,
          opts: { currencies: FIXTURE_CURRENCIES, fixtures: FIXTURE_STATE },
        });
      }
      return createBurnToMine({
        provider: rpc.asProvider(),
        router,
        registry,
        opts: { currencies: BURN_CURRENCIES },
      });
    } catch {
      return null;
    }
  }, [rpc, router, registry, isFixture]);

  // Surface unlocked accounts (browsing/quoting works without them; burning needs a signer).
  useEffect(() => {
    (async () => {
      await ks.load();
      if (ks.locked) return;
      const list = ks.list().map((e) => ({ entryId: e.id, type: e.type, address: e.address, index: 0 }));
      setAccounts(list);
      if (list.length > 0) setAccount(list[0]);
    })().catch(() => {});
  }, [ks]);

  // Sign + broadcast a tx the driver built. Key never leaves lib/.
  const submit = useCallback(
    async (tx) => {
      if (isFixture) throw new Error('connect a deployed router + registry to burn for real');
      if (!account) throw new Error('unlock an account in the Wallet tab first');
      const provider = rpc.asProvider();
      const built = await buildTx(
        { from: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n },
        provider,
      );
      const opened = await ks.get(account.entryId);
      const signer = opened.type === 'vault' ? opened.signerFor(account.index ?? 0) : opened.signer();
      return sendAndWait(signer, built, provider, { confirmations: 1 });
    },
    [rpc, ks, account, isFixture],
  );

  return (
    <section>
      <div className="dev-badge" title="Burn-to-mine — MultiCurrencyBurnRouter + BurnStakeRegistry.">
        BURN COIN · the third door into PRANA mining — capital, no GPU · PERMANENT, no unstake
      </div>

      {error && <p className="danger">{String(error.message ?? error)}</p>}

      <div className="card">
        <div className="row-between">
          <h3>Burn-to-mine</h3>
          {isFixture && <span className="muted">fixture / offline preview</span>}
        </div>
        <p className="muted">
          Burning permanently destroys coin to mint permanent burn-stake weight — a capture-resistant
          mining lane that can&apos;t be borrowed or flash-loaned, because there is no way out.
        </p>
        <label>
          MultiCurrencyBurnRouter address
          <input
            className="search-input"
            placeholder="0x… (leave blank for fixture preview)"
            value={router}
            onChange={(e) => setRouter(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          BurnStakeRegistry address
          <input
            className="search-input"
            placeholder="0x… (leave blank for fixture preview)"
            value={registry}
            onChange={(e) => setRegistry(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {accounts.length > 0 && (
          <label>
            Burn from account
            <select
              className="search-input"
              value={account?.entryId ?? ''}
              onChange={(e) => setAccount(accounts.find((a) => a.entryId === e.target.value) ?? null)}
            >
              {accounts.map((a) => (
                <option key={a.entryId} value={a.entryId}>
                  {truncateAddress(a.address)}
                </option>
              ))}
            </select>
          </label>
        )}
        {accounts.length === 0 && (
          <p className="muted">Unlock your vault in the Wallet tab to burn — quoting works without it.</p>
        )}
      </div>

      <BurnPanel driver={driver} account={account} isFixture={isFixture} submit={submit} setError={setError} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The burn panel: currency pick → amount → quoted PERMANENT weight → confirm.
// ---------------------------------------------------------------------------
function BurnPanel({ driver, account, isFixture, submit, setError }) {
  const [currencies, setCurrencies] = useState([]);
  const [currencyId, setCurrencyId] = useState('prana');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null); // { weight }
  const [accumulated, setAccumulated] = useState(null); // { weight, totalWeight }
  const [plan, setPlan] = useState(null);
  const [ack, setAck] = useState(false); // explicit "I understand it's irreversible"
  const [status, setStatus] = useState('idle'); // idle|quoting|building|approving|burning|done
  const [result, setResult] = useState(null);

  const currency = useMemo(() => currencies.find((c) => c.id === currencyId) ?? null, [currencies, currencyId]);

  // Load the allowlisted currency catalog from the driver.
  useEffect(() => {
    if (!driver) return;
    (async () => {
      try {
        const list = await driver.listCurrencies();
        setCurrencies(list);
        if (!list.some((c) => c.id === currencyId)) setCurrencyId(list[0]?.id ?? 'prana');
      } catch (e) {
        setError(e);
      }
    })();
  }, [driver]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh the user's accumulated permanent weight whenever the account changes.
  useEffect(() => {
    if (!driver || !account) {
      setAccumulated(null);
      return;
    }
    (async () => {
      try {
        setAccumulated(await driver.accumulatedWeight(account.address));
      } catch {
        setAccumulated(null);
      }
    })();
  }, [driver, account, result]);

  // Reset derived state when inputs that feed a quote/plan change.
  function resetDerived() {
    setQuote(null);
    setPlan(null);
    setAck(false);
    setResult(null);
    setStatus('idle');
  }

  function tokenArg() {
    return currency?.native ? null : currency?.address ?? null;
  }

  async function doQuote(e) {
    e?.preventDefault();
    setError(null);
    resetDerived();
    if (!driver) return;
    let amt;
    try {
      amt = parsePranaToWei(amount); // 18-dec base units (token assumed 18-dec like PRANA)
      if (amt <= 0n) throw new Error('enter an amount greater than 0');
    } catch (err) {
      setError(err);
      return;
    }
    if (!currency?.native && !currency?.address) {
      setError(new Error('this currency has no configured address yet'));
      return;
    }
    setStatus('quoting');
    try {
      const q = await driver.quoteWeight(tokenArg(), amt);
      setQuote(q);
      const built = await driver.buildBurn({ from: account?.address ?? FIXTURE_ROUTER, token: tokenArg(), amount: amt });
      setPlan(built);
      setStatus('idle');
    } catch (err) {
      setStatus('idle');
      setError(err);
    }
  }

  async function doBurn() {
    if (!plan) return;
    if (!ack) {
      setError(new Error('Tick the acknowledgement — burning is permanent and irreversible.'));
      return;
    }
    if (!account) {
      setError(new Error('Unlock an account in the Wallet tab to sign the burn.'));
      return;
    }
    setError(null);
    try {
      // ERC-20 path: approve the router for `amount` first if the plan flagged it.
      if (plan.approval?.needed) {
        setStatus('approving');
        await submit({ to: plan.approval.to, data: plan.approval.data, value: 0n });
      }
      setStatus('burning');
      const receipt = await submit(plan.burnTx);
      const decoded = driver.decodeBurnReceipt(receipt.receipt ?? receipt) ?? null;
      setResult({ hash: receipt.hash ?? receipt.transactionHash ?? null, decoded });
      setStatus('done');
    } catch (err) {
      setStatus('idle');
      setError(err);
    }
  }

  const busy = status === 'quoting' || status === 'approving' || status === 'burning';
  const selectable = currencies.filter((c) => c.native || c.allowed);

  return (
    <div className="card">
      <h3>Burn a currency for permanent weight</h3>

      {accumulated && (
        <dl className="kv">
          <dt>Your burn-stake weight</dt>
          <dd className="mono">{formatPrana(accumulated.weight)}</dd>
          <dt>Total burned weight</dt>
          <dd className="mono">{formatPrana(accumulated.totalWeight)}</dd>
        </dl>
      )}

      <form onSubmit={doQuote} className="stack">
        <label>
          Currency to burn
          <select
            className="search-input"
            value={currencyId}
            onChange={(e) => {
              setCurrencyId(e.target.value);
              resetDerived();
            }}
          >
            {selectable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label ?? c.symbol}
                {c.native ? '' : ' · allowlisted'}
              </option>
            ))}
          </select>
        </label>
        {currencies.some((c) => !c.native && !c.allowed) && (
          <p className="muted">
            Some wrapped tokens are not (yet) admitted by the router&apos;s on-chain allowlist and are hidden.
          </p>
        )}

        <label>
          Amount to burn ({currency?.symbol ?? 'PRANA'})
          <input
            className="search-input"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              resetDerived();
            }}
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        <button className="btn" type="submit" disabled={busy || !driver || !amount}>
          {status === 'quoting' ? 'Quoting…' : 'Quote permanent weight'}
        </button>
      </form>

      {quote && plan && (
        <div className="preview">
          <h4>You would permanently receive</h4>
          <p className="success" style={{ fontSize: '1.5rem', margin: '4px 0' }}>
            <span className="mono">{formatPrana(quote.weight)}</span> burn-stake weight
          </p>
          <dl className="kv">
            <dt>Burning</dt>
            <dd className="mono">
              {formatPrana(plan.amount)} {currency?.symbol ?? 'PRANA'}
            </dd>
            <dt>Sink</dt>
            <dd>{plan.native ? 'native PRANA → dead address (0x…dEaD)' : 'wrapped ERC-20 → burned (supply reduced)'}</dd>
            <dt>Approval</dt>
            <dd>
              {plan.native
                ? 'none (native carries value)'
                : plan.approval?.needed
                  ? `approve(router) required for ${truncateAddress(plan.approval.token)}`
                  : 'allowance already sufficient'}
            </dd>
          </dl>

          {plan.simulation && plan.simulation.ok === false && !plan.approval?.needed && (
            <p className="danger">
              Would revert{plan.simulation.revertReason ? `: ${plan.simulation.revertReason}` : ''}.
            </p>
          )}

          {/* THE load-bearing irreversibility warning. */}
          <div className="banner danger" role="alert" style={{ marginTop: '12px' }}>
            <strong>Burning is permanent — there is no unstake, ever.</strong>
            <br />
            The {currency?.symbol ?? 'PRANA'} you burn is destroyed forever, and the burn-stake weight you
            receive can never be unstaked, withdrawn, transferred, or refunded — not by you, not by an
            admin, not by the DAO. This is a one-way door. Burn only what you are willing to give up
            permanently.
          </div>

          <label className="warn" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this burn is permanent and irreversible.
          </label>

          <button
            className="btn"
            onClick={doBurn}
            disabled={busy || !ack || !account || quote.weight === 0n}
            style={{ marginTop: '8px' }}
          >
            {status === 'approving'
              ? 'Approving token…'
              : status === 'burning'
                ? 'Burning…'
                : plan.approval?.needed
                  ? `Approve & burn ${currency?.symbol ?? 'PRANA'} forever`
                  : `Burn ${currency?.symbol ?? 'PRANA'} forever`}
          </button>
          {isFixture && (
            <p className="muted">Fixture preview — connect a deployed router + registry above to burn for real.</p>
          )}
          {!account && !isFixture && <p className="muted">Unlock an account in the Wallet tab to burn.</p>}
          {quote.weight === 0n && (
            <p className="muted">This currency is not priced by the router&apos;s price source — it cannot be burned.</p>
          )}
        </div>
      )}

      {status === 'done' && result && (
        <div className="banner success">
          Burned. {result.decoded ? `Credited ${formatPrana(result.decoded.weightAdded)} permanent weight. ` : ''}
          {result.hash && <span className="mono">Tx {truncateHash(result.hash)}</span>}
        </div>
      )}
    </div>
  );
}
