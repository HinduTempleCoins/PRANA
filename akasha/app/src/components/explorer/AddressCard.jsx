// AddressCard — balance / kind / nonce for an address (provider injected).
import { useEffect, useState } from 'react';
import { mapAddressInfo } from '../../lib/rpcMappers.js';
import { formatPranaWithSymbol, truncateAddress } from '../../lib/format.js';
import { isNetworkError } from '../../lib/rpc.js';
import { ConnBanner } from './BlockList.jsx';

// `address` is required. Looks up balance, code (EOA vs contract), and tx count.
export default function AddressCard({ rpc, address }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setError(null);
    if (!address) return undefined;
    (async () => {
      try {
        const [balanceWei, code, txCount] = await Promise.all([
          rpc.call('eth_getBalance', [address, 'latest']),
          rpc.call('eth_getCode', [address, 'latest']),
          rpc.call('eth_getTransactionCount', [address, 'latest']),
        ]);
        if (!cancelled) setInfo(mapAddressInfo({ address, balanceWei, code, txCount }));
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, address]);

  if (error && isNetworkError(error)) return <ConnBanner url={rpc.url} />;
  if (error) return <p className="danger">Lookup failed: {error.message}</p>;
  if (!info) return <p className="muted">Looking up {truncateAddress(address)}…</p>;

  return (
    <div className="card">
      <h3>Address</h3>
      <dl className="kv">
        <dt>Address</dt>
        <dd className="mono">{info.address}</dd>
        <dt>Type</dt>
        <dd>{info.kind === 'contract' ? `Contract (${info.codeSize} bytes)` : 'EOA (wallet)'}</dd>
        <dt>Balance</dt>
        <dd className="accent">{formatPranaWithSymbol(info.balance ?? 0n)}</dd>
        <dt>Tx count (nonce)</dt>
        <dd>{info.txCount ?? '—'}</dd>
      </dl>
    </div>
  );
}
