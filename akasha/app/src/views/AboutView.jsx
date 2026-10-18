// AboutView — network metadata + live connection probe. Helps the user add PRANA
// to a wallet (EIP-3091 / wallet_addEthereumChain shape) and confirms the node.
import { useEffect, useState } from 'react';
import { networkFromMetadata } from '../lib/wallet.js';
import { isNetworkError } from '../lib/rpc.js';

import { CHAIN_ID_HEX, CHAIN_NAME, NATIVE_SYMBOL, RPC_URL, EXPLORER_URL } from '../lib/network.js';

const NET = networkFromMetadata({
  explorerUrl: EXPLORER_URL,
  chainIdHex: CHAIN_ID_HEX,
  name: CHAIN_NAME,
  symbol: NATIVE_SYMBOL,
  rpcUrl: RPC_URL,
});

export default function AboutView({ rpc }) {
  const [chainId, setChainId] = useState(null);
  const [height, setHeight] = useState(null);
  const [status, setStatus] = useState('checking'); // checking | online | offline | error

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const [cid, h] = await Promise.all([
          rpc.call('eth_chainId', []),
          rpc.call('eth_blockNumber', []),
        ]);
        if (!cancelled) {
          setChainId(cid);
          setHeight(BigInt(h).toString());
          setStatus('online');
        }
      } catch (err) {
        if (!cancelled) setStatus(isNetworkError(err) ? 'offline' : 'error');
      }
    }
    probe();
    const t = setInterval(probe, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rpc]);

  return (
    <section className="stack">
      <div className="card">
        <h3>
          Node status:{' '}
          <span className={status === 'online' ? 'success' : status === 'offline' ? 'warn' : 'muted'}>
            {status}
          </span>
        </h3>
        {status === 'offline' && (
          <p className="muted">
            Cannot reach <code>{rpc.url}</code> right now; this view auto-reconnects.
          </p>
        )}
        <dl className="kv">
          <dt>RPC</dt>
          <dd className="mono">{rpc.url}</dd>
          <dt>Chain ID (live)</dt>
          <dd className="mono">{chainId ? `${chainId} (${BigInt(chainId).toString()})` : '—'}</dd>
          <dt>Block height</dt>
          <dd>{height ?? '—'}</dd>
        </dl>
      </div>

      <div className="card">
        <h3>Add PRANA to a wallet</h3>
        <p className="muted">EIP-3091 / wallet_addEthereumChain metadata:</p>
        <pre className="code-block">{JSON.stringify(NET, null, 2)}</pre>
      </div>
    </section>
  );
}
