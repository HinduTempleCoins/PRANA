// BlockDetail — full detail of one block (provider injected via props).
import { useEffect, useState } from 'react';
import { mapBlockDetail } from '../../lib/rpcMappers.js';
import {
  formatTimestamp,
  timeAgo,
  truncateHash,
  truncateAddress,
  formatGas,
} from '../../lib/format.js';
import { isNetworkError } from '../../lib/rpc.js';
import { ConnBanner } from './BlockList.jsx';

export default function BlockDetail({ rpc, blockNumber, onSelectTx, onBack }) {
  const [block, setBlock] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setBlock(null);
    setError(null);
    (async () => {
      try {
        const tag =
          typeof blockNumber === 'number'
            ? '0x' + blockNumber.toString(16)
            : blockNumber;
        const raw = await rpc.call('eth_getBlockByNumber', [tag, true]);
        if (!cancelled) setBlock(raw ? mapBlockDetail(raw) : null);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, blockNumber]);

  if (error && isNetworkError(error)) return <ConnBanner url={rpc.url} />;
  if (error) return <p className="danger">Lookup failed: {error.message}</p>;
  if (!block) return <p className="muted">Loading block #{String(blockNumber)}…</p>;

  return (
    <div className="card">
      <button className="link-btn" onClick={onBack}>
        ← back to blocks
      </button>
      <h3>Block #{block.number}</h3>
      <dl className="kv">
        <Row k="Timestamp" v={`${formatTimestamp(block.timestamp)} (${timeAgo(block.timestamp)})`} />
        <Row k="Hash" v={block.hash} mono />
        <Row k="Parent" v={block.parentHash} mono />
        <Row k="Miner" v={block.miner} mono />
        <Row k="Gas used" v={formatGas(block.gasUsed)} />
        <Row k="Gas limit" v={formatGas(block.gasLimit)} />
        <Row k="Base fee" v={block.baseFeePerGas != null ? formatGas(block.baseFeePerGas) + ' wei' : '—'} />
        <Row k="Transactions" v={String(block.txsAreObjects ? block.transactions.length : block.transactions.length)} />
      </dl>

      <h4>Transactions</h4>
      {block.transactions.length === 0 ? (
        <p className="muted">No transactions in this block.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Hash</th>
              <th>From</th>
              <th>To</th>
            </tr>
          </thead>
          <tbody>
            {block.transactions.map((tx) => {
              const hash = block.txsAreObjects ? tx.hash : tx;
              return (
                <tr key={hash} className="clickable" onClick={() => onSelectTx?.(hash)}>
                  <td className="mono accent">{truncateHash(hash)}</td>
                  <td className="mono">{block.txsAreObjects ? truncateAddress(tx.from) : '—'}</td>
                  <td className="mono">
                    {block.txsAreObjects ? (tx.to ? truncateAddress(tx.to) : 'contract creation') : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : undefined}>{v ?? '—'}</dd>
    </>
  );
}
