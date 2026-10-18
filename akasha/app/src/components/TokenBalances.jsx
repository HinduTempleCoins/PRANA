// TokenBalances — native PRANA + the mainnet ERC-20 list for any address (read-only
// eth_getBalance / balanceOf via the public RPC), with KulaSwap links.
import { useEffect, useState } from 'react';
import { erc20, addressLink } from '../lib/wallet.js';
import { formatPranaWithSymbol, formatUnits } from '../lib/format.js';
import { EXPLORER_URL, TOKENS, NATIVE_SYMBOL, NATIVE_SWAP, kulaSwapLink } from '../lib/network.js';

function useBalances(rpc, address) {
  const [state, setState] = useState({ native: null, tokens: {}, netErr: false });
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = erc20.encodeFunctionData('balanceOf', [address]);
        const [wei, ...toks] = await Promise.all([
          rpc.call('eth_getBalance', [address, 'latest']),
          ...TOKENS.map((t) =>
            rpc.call('eth_call', [{ to: t.address, data }, 'latest']).catch(() => null),
          ),
        ]);
        if (cancelled) return;
        const tokens = {};
        TOKENS.forEach((t, i) => {
          tokens[t.symbol] = toks[i] && toks[i] !== '0x' ? BigInt(toks[i]) : null;
        });
        setState({ native: BigInt(wei), tokens, netErr: false });
      } catch (err) {
        if (!cancelled) setState((s) => ({ ...s, netErr: true }));
      }
    }
    poll();
    const t = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rpc, address]);
  return state;
}

export default function Balances({ rpc, address }) {
  const { native, tokens, netErr } = useBalances(rpc, address);
  return (
    <div className="card">
      <div className="row-between">
        <h3>Balances</h3>
        <a href={kulaSwapLink(...NATIVE_SWAP)} target="_blank" rel="noopener noreferrer">
          Trade on KulaSwap ↗
        </a>
      </div>
      {netErr && <div className="warn">PRANA node unreachable — balances may be stale.</div>}
      <table className="balance-table" data-testid="balances">
        <tbody>
          <tr>
            <td>
              <strong>{NATIVE_SYMBOL}</strong> <span className="muted small">native gas coin</span>
            </td>
            <td className="mono right" data-symbol={NATIVE_SYMBOL}>
              {native == null ? '…' : formatPranaWithSymbol(native).replace(/ PRANA$/, '')}
            </td>
            <td className="right">
              <a href={kulaSwapLink(...NATIVE_SWAP)} target="_blank" rel="noopener noreferrer">
                swap
              </a>
            </td>
          </tr>
          {TOKENS.map((t) => (
            <tr key={t.symbol}>
              <td>
                <a href={addressLink(EXPLORER_URL, t.address)} target="_blank" rel="noopener noreferrer">
                  <strong>{t.symbol}</strong>
                </a>{' '}
                <span className="muted small">{t.name}</span>
              </td>
              <td className="mono right" data-symbol={t.symbol}>
                {tokens[t.symbol] == null ? '…' : formatUnits(tokens[t.symbol], t.decimals, 4)}
              </td>
              <td className="right">
                {t.swap && (
                  <a href={kulaSwapLink(...t.swap)} target="_blank" rel="noopener noreferrer">
                    swap
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

