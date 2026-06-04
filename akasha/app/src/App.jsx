// App — Akasha shell. Three tabbed views, no router (plain useState tab switch).
import { useMemo, useState } from 'react';
import WalletView from './views/WalletView.jsx';
import ExplorerView from './views/ExplorerView.jsx';
import InventoryView from './views/InventoryView.jsx';
import MintView from './views/MintView.jsx';
import TradeView from './views/TradeView.jsx';
import PackOpenView from './views/PackOpenView.jsx';
import BurnToMineView from './views/BurnToMineView.jsx';
import AboutView from './views/AboutView.jsx';
import { makeRpc, DEFAULT_RPC_URL } from './lib/rpc.js';

const TABS = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'inventory', label: 'NFTs' },
  { id: 'mint', label: 'Mint' },
  { id: 'trade', label: 'Market' },
  { id: 'packs', label: 'Packs' },
  { id: 'burn', label: 'Burn' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'about', label: 'Network' },
];

export default function App() {
  const [tab, setTab] = useState('wallet');
  // One RPC client for the whole app (txbuilder gets it via rpc.asProvider()).
  const rpc = useMemo(() => makeRpc(DEFAULT_RPC_URL), []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-core" aria-hidden="true" />
          <span className="brand-name">Akasha</span>
          <span className="brand-sub">PRANA wallet · chain 108369</span>
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
        </nav>
      </header>

      <main className="app-main">
        {tab === 'wallet' && <WalletView rpc={rpc} />}
        {tab === 'inventory' && <InventoryView rpc={rpc} />}
        {tab === 'mint' && <MintView rpc={rpc} />}
        {tab === 'trade' && <TradeView rpc={rpc} />}
        {tab === 'packs' && <PackOpenView rpc={rpc} />}
        {tab === 'burn' && <BurnToMineView rpc={rpc} />}
        {tab === 'explorer' && <ExplorerView rpc={rpc} />}
        {tab === 'about' && <AboutView rpc={rpc} />}
      </main>

      <footer className="app-footer">
        Akasha · the ether through which PRANA moves · local dev build
      </footer>
    </div>
  );
}
