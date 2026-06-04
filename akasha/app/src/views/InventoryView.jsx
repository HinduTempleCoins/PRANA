// InventoryView — pillar (NFT): the owner's on-chain NFT holdings (AK7+AK8).
//
// Read-only by construction. It never touches private keys: it reads the *account
// list* from the same Keystore the WalletView uses (ks.list() returns address-only
// metadata without unlocking), and reads NFT holdings over JSON-RPC through the
// headless lib (akasha/lib/nft-inventory.mjs).
//
// Provider wiring: the app passes the same `rpc` client every view gets (a tiny
// JSON-RPC-over-fetch client with `.call(method, params)`). The lib wants an
// ethers-style `call({to,data}) -> hexString`, so we adapt rpc → eth_call here.
//
// Fixture fallback (mirrors the TD chainLoader / ExplorerView graceful-degrade):
// when the node is unreachable, OR no NFT collections are configured/deployed, OR
// any read throws, we render the bundled FIXTURE inventory so the UI still works
// with no live node. A banner makes the demo state explicit.
import { useEffect, useMemo, useRef, useState } from 'react';
import { readInventory } from '../../../lib/nft-inventory.mjs';
import { Keystore, createLocalStorageStorage } from '../lib/wallet.js';
import { truncateAddress } from '../lib/format.js';
import { isNetworkError } from '../lib/rpc.js';
import NftCard from '../components/inventory/NftCard.jsx';

// Same publicly-known DEV account WalletView pre-funds, so the inventory tab has a
// sensible default owner even before the user creates/imports a vault.
const DEV_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// NFT collections to scan. Empty by default (no NFT contracts in deployments.json
// yet) → the view renders the fixture. When NFT collections are deployed, list
// them here (or wire from the contract-registry / deployments.json):
//   { address, standard?: 'erc721'|'erc1155', tokenIds?: [...] }  // ids for 1155
const COLLECTIONS = [];

// Bundled demo inventory — shape matches lib/nft-inventory.mjs holdings. Rendered
// whenever live reads can't run, so the gallery is never blank in dev.
const FIXTURE_INVENTORY = [
  {
    contract: '0x1111111111111111111111111111111111111111',
    standard: 'erc721',
    name: 'Naga Creatures',
    symbol: 'NAGA',
    tokenId: '7',
    balance: 1n,
    metadata: { name: 'Naga #7', image: '' },
  },
  {
    contract: '0x1111111111111111111111111111111111111111',
    standard: 'erc721',
    name: 'Naga Creatures',
    symbol: 'NAGA',
    tokenId: '42',
    balance: 1n,
    metadata: { name: 'Naga #42', image: '' },
  },
  {
    contract: '0x2222222222222222222222222222222222222222',
    standard: 'erc1155',
    name: 'Ley Relics',
    tokenId: '300',
    balance: 5n,
    metadata: { name: 'Sun Relic', image: '' },
  },
];

// Adapt the app rpc client into the ethers-style { call({to,data}) } the lib wants.
function rpcToCallProvider(rpc) {
  return {
    async call({ to, data }) {
      return rpc.call('eth_call', [{ to, data }, 'latest']);
    },
  };
}

// Read-only "wallet hook": pulls address-only account metadata from the Keystore
// (no unlock, no keys). Falls back to the DEV address when the vault is empty.
function useReadonlyAccounts() {
  const ksRef = useRef(null);
  if (ksRef.current == null) {
    ksRef.current = new Keystore({ storage: createLocalStorageStorage() });
  }
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ksRef.current.load();
        const list = ksRef.current
          .list()
          .filter((e) => e.address)
          .map((e) => ({ label: e.label, address: e.address }));
        if (!cancelled) setAccounts(list);
      } catch {
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Always offer the DEV account as a selectable owner (de-duped).
  return useMemo(() => {
    const seen = new Set(accounts.map((a) => a.address.toLowerCase()));
    const out = [...accounts];
    if (!seen.has(DEV_ADDR.toLowerCase())) {
      out.push({ label: 'DEV account', address: DEV_ADDR });
    }
    return out;
  }, [accounts]);
}

export default function InventoryView({ rpc }) {
  const accounts = useReadonlyAccounts();
  const [selected, setSelected] = useState(0);
  const owner = accounts[selected]?.address ?? DEV_ADDR;

  const [holdings, setHoldings] = useState([]);
  const [state, setState] = useState('loading'); // loading | live | fixture | netdown
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError(null);
    (async () => {
      // No NFT collections configured/deployed → render the fixture demo directly.
      if (COLLECTIONS.length === 0) {
        const rows = await readInventory({ owner, fixtures: FIXTURE_INVENTORY });
        if (!cancelled) {
          setHoldings(rows);
          setState('fixture');
        }
        return;
      }
      try {
        const provider = rpcToCallProvider(rpc);
        const rows = await readInventory({
          provider,
          owner,
          collections: COLLECTIONS,
          withUris: true,
          fetchMetadata: true,
        });
        if (!cancelled) {
          setHoldings(rows);
          setState('live');
        }
      } catch (err) {
        // Graceful degrade to the fixture inventory (matches the explorer/TD pattern).
        const rows = await readInventory({ owner, fixtures: FIXTURE_INVENTORY });
        if (!cancelled) {
          setHoldings(rows);
          setState(isNetworkError(err) ? 'netdown' : 'fixture');
          setError(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, owner]);

  return (
    <section>
      <div className="row-between inventory-head">
        <h3>NFT inventory</h3>
        {accounts.length > 1 && (
          <select
            className="search-input account-select"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {accounts.map((a, i) => (
              <option key={a.address} value={i}>
                {a.label} · {truncateAddress(a.address)}
              </option>
            ))}
          </select>
        )}
      </div>

      <p className="muted">
        Owner <span className="mono">{truncateAddress(owner)}</span>
      </p>

      {state === 'netdown' && (
        <div className="banner warn">
          Node unreachable — showing a demo inventory. Start the node
          (<code>chain/scripts/run-miner.sh</code>) to read live holdings.
        </div>
      )}
      {state === 'fixture' && (
        <div className="banner muted">
          Demo inventory (no NFT collections deployed yet). Wire deployed collections
          into <code>InventoryView</code> to read live holdings.
        </div>
      )}

      {state === 'loading' ? (
        <p className="muted">Reading inventory…</p>
      ) : holdings.length === 0 ? (
        <div className="card">
          <p className="muted">No NFTs found for this account.</p>
        </div>
      ) : (
        <div className="nft-grid">
          {holdings.map((h) => (
            <NftCard key={`${h.contract}:${h.tokenId}`} holding={h} />
          ))}
        </div>
      )}
    </section>
  );
}
