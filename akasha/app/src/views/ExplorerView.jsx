// ExplorerView — pillar 2. Latest blocks + block/address/tx lookup.
// All data via plain JSON-RPC (props.rpc). Builds & runs without a live node:
// every child shows a graceful connection banner on network errors.
import { useState } from 'react';
import BlockList from '../components/explorer/BlockList.jsx';
import BlockDetail from '../components/explorer/BlockDetail.jsx';
import AddressCard from '../components/explorer/AddressCard.jsx';
import TxCard from '../components/explorer/TxCard.jsx';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export default function ExplorerView({ rpc }) {
  // selection: { kind: 'blocks' | 'block' | 'address' | 'tx', value? }
  const [sel, setSel] = useState({ kind: 'blocks' });
  const [query, setQuery] = useState('');
  const [queryError, setQueryError] = useState(null);

  function onSearch(e) {
    e.preventDefault();
    const q = query.trim();
    setQueryError(null);
    if (q === '') return;
    if (HASH_RE.test(q)) {
      setSel({ kind: 'tx', value: q });
    } else if (ADDR_RE.test(q)) {
      setSel({ kind: 'address', value: q });
    } else if (/^\d+$/.test(q)) {
      setSel({ kind: 'block', value: Number(q) });
    } else {
      setQueryError('Enter a block number, 0x address (40 hex), or 0x tx hash (64 hex).');
    }
  }

  return (
    <section>
      <form className="search-row" onSubmit={onSearch}>
        <input
          className="search-input"
          placeholder="Search block #, address (0x…40), or tx hash (0x…64)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="btn">Search</button>
        <button type="button" className="link-btn" onClick={() => setSel({ kind: 'blocks' })}>
          latest blocks
        </button>
      </form>
      {queryError && <p className="danger">{queryError}</p>}

      {sel.kind === 'blocks' && (
        <BlockList rpc={rpc} onSelectBlock={(n) => setSel({ kind: 'block', value: n })} />
      )}
      {sel.kind === 'block' && (
        <BlockDetail
          rpc={rpc}
          blockNumber={sel.value}
          onSelectTx={(h) => setSel({ kind: 'tx', value: h })}
          onBack={() => setSel({ kind: 'blocks' })}
        />
      )}
      {sel.kind === 'address' && <AddressCard rpc={rpc} address={sel.value} />}
      {sel.kind === 'tx' && (
        <TxCard
          rpc={rpc}
          hash={sel.value}
          onSelectBlock={(n) => setSel({ kind: 'block', value: n })}
        />
      )}
    </section>
  );
}
