// App — Akasha shell (PRANA mainnet public build). Tabbed views, no router.
//
// Only views whose contracts exist on PRANA mainnet are mounted. The NFT / Mint /
// Market / Packs / Burn views (InventoryView, MintView, TradeView, PackOpenView,
// BurnToMineView) are bound to alpha-chain / fixture contracts and stay out of the
// public build until their contracts are deployed on 712217.
import { useMemo, useState } from 'react';
import WalletView from './views/WalletView.jsx';
import ExplorerView from './views/ExplorerView.jsx';
import AboutView from './views/AboutView.jsx';
import { makeRpc } from './lib/rpc.js';
import { RPC_URL, CHAIN_ID, KULASWAP_URL } from './lib/network.js';

const TABS = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'about', label: 'Network' },
];

export default function App() {
  const [tab, setTab] = useState('wallet');
  // One RPC client for the whole app (txbuilder gets it via rpc.asProvider()).
  const rpc = useMemo(() => makeRpc(RPC_URL), []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-core" aria-hidden="true" />
          <span className="brand-name">Akasha</span>
          <span className="brand-sub">PRANA wallet · mainnet · chain {CHAIN_ID}</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <a className="tab" href={KULASWAP_URL} target="_blank" rel="noopener noreferrer">
            KulaSwap ↗
          </a>
        </nav>
      </header>

      <main className="app-main">
        {/* kept mounted so switching tabs does not drop the unlocked session */}
        <div hidden={tab !== 'wallet'}>
          <WalletView rpc={rpc} />
        </div>
        {tab === 'explorer' && <ExplorerView rpc={rpc} />}
        {tab === 'about' && <AboutView rpc={rpc} />}
      </main>

      <footer className="app-footer">
        Akasha · the ether through which PRANA moves · self-custody: your keys never leave this browser
      </footer>
    </div>
  );
}
