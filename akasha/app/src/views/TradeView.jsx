// TradeView — in-wallet open market (AK14).
//
// Browse RoyaltyMarketplace listings, list an owned NFT, buy a listing, and
// cancel your own listings — all from inside Akasha. The on-chain logic lives in
// lib/trade-market.mjs (the headless driver bound to the REAL RoyaltyMarketplace
// signatures); this view only sequences UI + signs/broadcasts the txs it returns.
//
// Settlement nuance surfaced to the user: the marketplace settles in an ERC-20
// (the listing's payToken), NEVER native PRANA. So BUY may need a one-time ERC-20
// approve(market, price) first, and LIST may need an NFT approve(market, tokenId)
// first. The driver detects this and returns an `approval` tx alongside the
// action; this view submits the approval, waits, then submits the action.
//
// Read-only / fixture mode: when there is no marketplace address (or the node is
// unreachable) the view runs against built-in FIXTURE listings so it renders and
// is demoable offline — mirroring the rest of the Akasha app's "works without a
// live node" rule. A real signer (via the keystore) is only needed to actually
// list / buy / cancel; browsing is read-only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTradeMarket } from '../../../lib/trade-market.mjs';
import { Keystore, createLocalStorageStorage, sendAndWait, buildTx } from '../lib/wallet.js';
import { formatPrana, truncateAddress } from '../lib/format.js';
import { isNetworkError } from '../lib/rpc.js';

// Demo listings used when there's no marketplace address / no node. Shapes match
// the driver's `normalizeListing` input (plain-object form).
const FIXTURE_MARKET = '0x00000000000000000000000000000000000000AB';
const FIXTURE_LISTINGS = [
  {
    listingId: 0,
    seller: '0x3333333333333333333333333333333333333333',
    nft: '0x1111111111111111111111111111111111111111',
    tokenId: 7n,
    payToken: '0x2222222222222222222222222222222222222222',
    price: 25_000000000000000000n,
    active: true,
  },
  {
    listingId: 1,
    seller: '0x4444444444444444444444444444444444444444',
    nft: '0x1111111111111111111111111111111111111111',
    tokenId: 12n,
    payToken: '0x2222222222222222222222222222222222222222',
    price: 4_500000000000000000n,
    active: true,
  },
];

function makeKeystore() {
  return new Keystore({ storage: createLocalStorageStorage() });
}

export default function TradeView({ rpc }) {
  const ksRef = useRef(null);
  if (ksRef.current == null) ksRef.current = makeKeystore();
  const ks = ksRef.current;

  // The deployed RoyaltyMarketplace address. Empty => fixture/offline mode.
  const [market, setMarket] = useState('');
  const [account, setAccount] = useState(null); // { entryId, type, address, index }
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);

  const isFixture = !market || !/^0x[0-9a-fA-F]{40}$/.test(market);

  // Build the headless driver. In fixture mode we pass FIXTURE_LISTINGS so reads
  // never hit RPC; otherwise it talks to the live marketplace via rpc.asProvider().
  const driver = useMemo(() => {
    try {
      return createTradeMarket({
        provider: rpc.asProvider(),
        marketplace: isFixture ? FIXTURE_MARKET : market,
        opts: isFixture ? { fixtures: FIXTURE_LISTINGS } : {},
      });
    } catch (e) {
      return null;
    }
  }, [rpc, market, isFixture]);

  // Try to surface the unlocked accounts (read-only browsing works without them).
  useEffect(() => {
    (async () => {
      await ks.load();
      if (ks.locked) return; // locked → browse-only
      const list = ks.list().map((e) => ({
        entryId: e.id,
        type: e.type,
        address: e.address,
        index: 0,
      }));
      setAccounts(list);
      if (list.length > 0) setAccount(list[0]);
    })().catch(() => {});
  }, [ks]);

  // Sign + broadcast a tx the driver built. Returns the receipt. Key never leaves lib/.
  const submit = useCallback(
    async (tx) => {
      if (isFixture) throw new Error('connect to a deployed marketplace to transact');
      if (!account) throw new Error('unlock an account in the Wallet tab first');
      const provider = rpc.asProvider();
      const built = await buildTx({ from: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n }, provider);
      const opened = await ks.get(account.entryId);
      const signer = opened.type === 'vault' ? opened.signerFor(account.index ?? 0) : opened.signer();
      return sendAndWait(signer, built, provider, { confirmations: 1 });
    },
    [rpc, ks, account, isFixture],
  );

  return (
    <section>
      <div className="dev-badge" title="Open market — RoyaltyMarketplace (ERC-20 settled).">
        OPEN MARKET · fixed-price ERC-721, settled in an ERC-20 · escrowed on listing
      </div>

      {error && <p className="danger">{String(error.message ?? error)}</p>}

      <div className="card">
        <div className="row-between">
          <h3>Marketplace</h3>
          {isFixture && <span className="muted">fixture / offline preview</span>}
        </div>
        <label>
          RoyaltyMarketplace address
          <input
            className="search-input"
            placeholder="0x… (leave blank for fixture preview)"
            value={market}
            onChange={(e) => setMarket(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {accounts.length > 0 ? (
          <label>
            Acting account
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
        ) : (
          <p className="muted">
            Browsing read-only. Unlock a vault in the Wallet tab to list / buy / cancel.
          </p>
        )}
      </div>

      {driver && (
        <>
          <Listings driver={driver} account={account} submit={submit} setError={setError} isFixture={isFixture} />
          {account && (
            <ListForm driver={driver} account={account} submit={submit} setError={setError} isFixture={isFixture} />
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Listings browser + per-row buy / cancel.
// ---------------------------------------------------------------------------
function Listings({ driver, account, submit, setError, isFixture }) {
  const [rows, setRows] = useState(null);
  const [netErr, setNetErr] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await driver.loadListings({ activeOnly: true });
      setRows(list);
      setNetErr(false);
    } catch (err) {
      if (isNetworkError(err)) setNetErr(true);
      else setError(err);
    }
  }, [driver, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onBuy(l) {
    setError(null);
    setNotice(null);
    setBusyId(l.listingId);
    try {
      const { action, approval, sim } = await driver.buy(l.listingId, { from: account.address });
      if (sim && sim.ok === false) {
        throw new Error(`would revert${sim.revertReason ? `: ${sim.revertReason}` : ''}`);
      }
      // ERC-20 settlement: approve the marketplace for `price` first if needed.
      if (approval) {
        setNotice(`Approving ${formatPrana(l.price)} of the pay token…`);
        await submit(approval);
      }
      setNotice('Submitting purchase…');
      const out = await submit(action);
      setNotice(`Bought listing #${l.listingId} · tx ${truncateAddress(out.hash)}`);
      await refresh();
    } catch (err) {
      setError(err);
      setNotice(null);
    } finally {
      setBusyId(null);
    }
  }

  async function onCancel(l) {
    setError(null);
    setNotice(null);
    setBusyId(l.listingId);
    try {
      const { action, sim } = await driver.cancel(l.listingId, { from: account.address });
      if (sim && sim.ok === false) {
        // The contract reverts "not seller" for a non-seller — show it plainly.
        throw new Error(`cannot cancel${sim.revertReason ? `: ${sim.revertReason}` : ''}`);
      }
      setNotice('Cancelling listing…');
      const out = await submit(action);
      setNotice(`Cancelled listing #${l.listingId} · tx ${truncateAddress(out.hash)}`);
      await refresh();
    } catch (err) {
      setError(err);
      setNotice(null);
    } finally {
      setBusyId(null);
    }
  }

  if (netErr) {
    return (
      <div className="card">
        <div className="warn">node unreachable — listings unavailable</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row-between">
        <h3>Active listings</h3>
        <button className="link-btn" onClick={refresh}>
          refresh
        </button>
      </div>

      {notice && <div className="banner success">{notice}</div>}

      {rows == null ? (
        <p className="muted">Loading listings…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No active listings.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>NFT / token</th>
              <th>Price</th>
              <th>Seller</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const isSeller = account && l.seller && account.address.toLowerCase() === l.seller.toLowerCase();
              const busy = busyId === l.listingId;
              return (
                <tr key={l.listingId}>
                  <td className="mono">{l.listingId}</td>
                  <td className="mono">
                    {truncateAddress(l.nft)} #{l.tokenId}
                  </td>
                  <td>{formatPrana(l.price)} (ERC-20)</td>
                  <td className="mono">{truncateAddress(l.seller)}</td>
                  <td>
                    {account ? (
                      isSeller ? (
                        <button className="link-btn" disabled={busy || isFixture} onClick={() => onCancel(l)}>
                          {busy ? '…' : 'cancel'}
                        </button>
                      ) : (
                        <button className="btn" disabled={busy || isFixture} onClick={() => onBuy(l)}>
                          {busy ? '…' : 'buy'}
                        </button>
                      )
                    ) : (
                      <span className="muted">unlock to trade</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {isFixture && (
        <p className="muted">
          Fixture preview — connect a deployed marketplace address above to trade for real.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List an owned NFT for sale.
// ---------------------------------------------------------------------------
function ListForm({ driver, account, submit, setError, isFixture }) {
  const [nft, setNft] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [payToken, setPayToken] = useState('');
  const [price, setPrice] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onList(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // price is entered in whole pay-token units * 1e18 (ERC-20 18-dec assumed for UI).
      const priceWei = BigInt(Math.round(Number(price) * 1e6)) * 10n ** 12n;
      const { action, approval, sim } = await driver.list({
        from: account.address,
        nft,
        tokenId,
        payToken,
        price: priceWei,
      });
      if (sim && sim.ok === false) {
        throw new Error(`would revert${sim.revertReason ? `: ${sim.revertReason}` : ''}`);
      }
      // Escrow requires the NFT be approved to the marketplace first.
      if (approval) {
        setNotice('Approving the NFT to the marketplace…');
        await submit(approval);
      }
      setNotice('Submitting listing…');
      const out = await submit(action);
      setNotice(`Listed · tx ${truncateAddress(out.hash)}`);
      setNft('');
      setTokenId('');
      setPayToken('');
      setPrice('');
    } catch (err) {
      setError(err);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  const valid =
    /^0x[0-9a-fA-F]{40}$/.test(nft) &&
    /^0x[0-9a-fA-F]{40}$/.test(payToken) &&
    /^\d+$/.test(tokenId) &&
    Number(price) > 0;

  return (
    <div className="card">
      <h3>List an NFT for sale</h3>
      <p className="muted">
        The NFT is escrowed in the marketplace on listing. You approve it once; buyers
        pay in the pay token you choose.
      </p>
      {notice && <div className="banner success">{notice}</div>}
      <form onSubmit={onList} className="stack">
        <label>
          NFT contract
          <input
            className="search-input"
            placeholder="0x… ERC-721 address"
            value={nft}
            onChange={(e) => setNft(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Token ID
          <input
            className="search-input"
            placeholder="e.g. 42"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value.trim())}
            inputMode="numeric"
          />
        </label>
        <label>
          Pay token (ERC-20)
          <input
            className="search-input"
            placeholder="0x… ERC-20 the buyer pays in"
            value={payToken}
            onChange={(e) => setPayToken(e.target.value.trim())}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Price (pay-token units)
          <input
            className="search-input"
            placeholder="0.0"
            value={price}
            onChange={(e) => setPrice(e.target.value.trim())}
            inputMode="decimal"
          />
        </label>
        <button className="btn" type="submit" disabled={busy || isFixture || !valid}>
          {busy ? 'Listing…' : 'List for sale'}
        </button>
        {isFixture && <p className="muted">Connect a deployed marketplace to list.</p>}
      </form>
    </div>
  );
}
