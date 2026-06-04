// BlockList — latest blocks table with auto-refresh.
// Provider injected via props (an object with async call(method, params)).
import { useEffect, useState, useCallback } from 'react';
import { mapBlockSummary } from '../../lib/rpcMappers.js';
import { timeAgo, truncateHash, truncateAddress, formatGas } from '../../lib/format.js';
import { isNetworkError } from '../../lib/rpc.js';

export default function BlockList({ rpc, count = 12, refreshMs = 4000, onSelectBlock }) {
  const [blocks, setBlocks] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const headHex = await rpc.call('eth_blockNumber', []);
      const head = BigInt(headHex);
      const nums = [];
      for (let i = 0n; i < BigInt(count) && head - i >= 0n; i++) nums.push(head - i);
      const raw = await Promise.all(
        nums.map((n) => rpc.call('eth_getBlockByNumber', ['0x' + n.toString(16), false])),
      );
      setBlocks(raw.filter(Boolean).map(mapBlockSummary));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [rpc, count]);

  useEffect(() => {
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  if (error && isNetworkError(error)) {
    return <ConnBanner url={rpc.url} />;
  }
  if (loading && blocks.length === 0) {
    return <p className="muted">Loading latest blocks…</p>;
  }

  return (
    <div className="card">
      <h3>Latest blocks {error ? <span className="warn">· refresh failed</span> : null}</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Block</th>
            <th>Age</th>
            <th>Txns</th>
            <th>Miner</th>
            <th>Gas used</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr
              key={b.hash ?? b.number}
              className="clickable"
              onClick={() => onSelectBlock?.(b.number)}
            >
              <td className="accent">#{b.number}</td>
              <td>{timeAgo(b.timestamp)}</td>
              <td>{b.txCount}</td>
              <td className="mono">{truncateAddress(b.miner)}</td>
              <td>{formatGas(b.gasUsed)}</td>
              <td className="mono">{truncateHash(b.hash)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConnBanner({ url }) {
  return (
    <div className="banner danger">
      <strong>Node unreachable.</strong> Could not connect to the PRANA RPC at{' '}
      <code>{url}</code>. Start the node (<code>chain/scripts/run-miner.sh</code>) and it
      will reconnect automatically.
    </div>
  );
}
