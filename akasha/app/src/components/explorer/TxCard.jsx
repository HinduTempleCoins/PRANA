// TxCard — transaction detail with receipt status (provider injected).
import { useEffect, useState } from 'react';
import { mapTxWithReceipt } from '../../lib/rpcMappers.js';
import { formatPranaWithSymbol, formatGas, truncateAddress } from '../../lib/format.js';
import { isNetworkError } from '../../lib/rpc.js';
import { ConnBanner } from './BlockList.jsx';

const STATUS_CLASS = {
  success: 'success',
  failed: 'danger',
  pending: 'warn',
  unknown: 'muted',
};

export default function TxCard({ rpc, hash, onSelectBlock }) {
  const [tx, setTx] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setTx(null);
    setError(null);
    if (!hash) return undefined;
    (async () => {
      try {
        const [txRaw, receiptRaw] = await Promise.all([
          rpc.call('eth_getTransactionByHash', [hash]),
          rpc.call('eth_getTransactionReceipt', [hash]),
        ]);
        if (!cancelled) {
          if (!txRaw) {
            setError(new Error('transaction not found'));
          } else {
            setTx(mapTxWithReceipt(txRaw, receiptRaw));
          }
        }
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, hash]);

  if (error && isNetworkError(error)) return <ConnBanner url={rpc.url} />;
  if (error) return <p className="danger">Lookup failed: {error.message}</p>;
  if (!tx) return <p className="muted">Looking up transaction…</p>;

  return (
    <div className="card">
      <h3>
        Transaction <span className={STATUS_CLASS[tx.status]}>· {tx.status}</span>
      </h3>
      <dl className="kv">
        <dt>Hash</dt>
        <dd className="mono">{tx.hash}</dd>
        <dt>Block</dt>
        <dd>
          {tx.blockNumber != null ? (
            <button className="link-btn" onClick={() => onSelectBlock?.(tx.blockNumber)}>
              #{tx.blockNumber}
            </button>
          ) : (
            'pending'
          )}
        </dd>
        <dt>From</dt>
        <dd className="mono">{tx.from}</dd>
        <dt>To</dt>
        <dd className="mono">{tx.to ?? (tx.contractAddress ? `${tx.contractAddress} (created)` : 'contract creation')}</dd>
        <dt>Value</dt>
        <dd className="accent">{formatPranaWithSymbol(tx.value ?? 0n)}</dd>
        <dt>Nonce</dt>
        <dd>{tx.nonce ?? '—'}</dd>
        <dt>Gas limit</dt>
        <dd>{formatGas(tx.gas)}</dd>
        <dt>Gas used</dt>
        <dd>{tx.gasUsed != null ? formatGas(tx.gasUsed) : '—'}</dd>
      </dl>
    </div>
  );
}
