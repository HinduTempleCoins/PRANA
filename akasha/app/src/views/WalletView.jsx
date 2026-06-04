// WalletView — pillar 1. Create/unlock vault, accounts, balance, send.
//
// Key-handling rule (security): private keys NEVER appear here directly. We only
// ever go through the lib/ modules — the Keystore holds the encrypted entries and
// hands back a signer via keystoreEntry.signerFor(index). Mnemonic is shown ONCE
// at creation behind a confirm step, then dropped from React state.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keystore,
  createVault,
  serializeVault,
  createLocalStorageStorage,
  buildTx,
  dryRun,
  sendAndWait,
  txLink,
} from '../lib/wallet.js';
import { formatPranaWithSymbol, parsePranaToWei, truncateAddress } from '../lib/format.js';
import { isNetworkError } from '../lib/rpc.js';

// DEV WALLET (publicly-known Anvil/Hardhat key #0) — pre-funded on the dev genesis.
// Clearly labelled and NEVER to be used with real value. Importing it lets the user
// immediately see the ~10000 PRANA the genesis pre-funds.
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EXPLORER_BASE = 'http://127.0.0.1:8545'; // EIP-3091 base is informational here

// A single Keystore instance for the app session (storage = browser localStorage).
function makeKeystore() {
  return new Keystore({ storage: createLocalStorageStorage() });
}

export default function WalletView({ rpc }) {
  const ksRef = useRef(null);
  if (ksRef.current == null) ksRef.current = makeKeystore();
  const ks = ksRef.current;

  const [phase, setPhase] = useState('boot'); // boot | locked | empty | unlocked
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // On mount: load persisted blob to decide between "locked" (has entries) and
  // "empty" (fresh — go straight to create/unlock with a new password).
  useEffect(() => {
    (async () => {
      await ks.load();
      const list = ks.list();
      setEntries(list);
      setPhase(list.length > 0 ? 'locked' : 'empty');
    })();
  }, [ks]);

  function refreshEntries() {
    setEntries(ks.list());
  }

  return (
    <section>
      <div className="dev-badge" title="This wallet runs against the local dev chain only.">
        DEV WALLET · local PRANA chain only · do not store real value
      </div>

      {error && <p className="danger">{String(error.message ?? error)}</p>}

      {phase === 'boot' && <p className="muted">Loading vault…</p>}

      {(phase === 'locked' || phase === 'empty') && (
        <Onboard
          ks={ks}
          hasEntries={entries.length > 0}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onUnlocked={() => {
            refreshEntries();
            setPhase('unlocked');
          }}
        />
      )}

      {phase === 'unlocked' && (
        <Unlocked
          ks={ks}
          rpc={rpc}
          entries={entries}
          refreshEntries={refreshEntries}
          setError={setError}
          onLock={() => {
            ks.lock();
            setPhase('locked');
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Onboarding: unlock existing, or create new vault (mnemonic-once + confirm).
// ---------------------------------------------------------------------------
function Onboard({ ks, hasEntries, busy, setBusy, setError, onUnlocked }) {
  const [mode, setMode] = useState(hasEntries ? 'unlock' : 'create');
  const [password, setPassword] = useState('');

  // create flow sub-state
  const [mnemonic, setMnemonic] = useState(null); // shown once
  const [confirmInput, setConfirmInput] = useState('');

  async function doUnlock(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ks.unlock(password);
      setPassword('');
      onUnlocked();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doCreate(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Establish the session password, create an HD vault, show the phrase ONCE.
      await ks.unlock(password); // empty store: just sets the password
      const { mnemonic: phrase } = await createVault(password);
      // The keystore re-encrypts the phrase under the same password as its own entry.
      await ks.addVault({ mnemonic: phrase, label: 'HD Vault' });
      setMnemonic(phrase);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmBackup(e) {
    e.preventDefault();
    setError(null);
    // Require the user to retype the last word to prove they backed it up.
    const words = mnemonic.trim().split(/\s+/);
    if (confirmInput.trim().toLowerCase() !== words[words.length - 1]) {
      setError(new Error('Last word does not match — please re-check your backup.'));
      return;
    }
    setMnemonic(null); // drop the phrase from memory
    setConfirmInput('');
    setPassword('');
    onUnlocked();
  }

  // Mnemonic reveal + confirm screen
  if (mnemonic) {
    return (
      <div className="card">
        <h3>Back up your recovery phrase</h3>
        <p className="warn">
          Shown ONCE. Write these 12 words down in order. Anyone with them controls this
          wallet. Akasha cannot recover them for you.
        </p>
        <ol className="mnemonic-grid">
          {mnemonic.split(/\s+/).map((w, i) => (
            <li key={i} className="mono">
              {w}
            </li>
          ))}
        </ol>
        <form onSubmit={confirmBackup} className="stack">
          <label>
            Confirm: type the <strong>last</strong> word
            <input
              className="search-input"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="btn" type="submit">
            I've backed it up — continue
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="tab-row">
        {hasEntries && (
          <button
            className={mode === 'unlock' ? 'tab active' : 'tab'}
            onClick={() => setMode('unlock')}
          >
            Unlock
          </button>
        )}
        <button
          className={mode === 'create' ? 'tab active' : 'tab'}
          onClick={() => setMode('create')}
        >
          Create new
        </button>
      </div>

      {mode === 'unlock' ? (
        <form onSubmit={doUnlock} className="stack">
          <h3>Unlock your vault</h3>
          <input
            className="search-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button className="btn" type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      ) : (
        <form onSubmit={doCreate} className="stack">
          <h3>Create a new vault</h3>
          <p className="muted">
            A 12-word recovery phrase is generated and encrypted (scrypt + AES) under this
            password in your browser. The phrase is shown once on the next screen.
          </p>
          <input
            className="search-input"
            type="password"
            placeholder="Choose a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <button className="btn" type="submit" disabled={busy || password.length === 0}>
            {busy ? 'Creating…' : 'Create vault'}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unlocked: account list + balance + send.
// ---------------------------------------------------------------------------
function Unlocked({ ks, rpc, entries, refreshEntries, setError, onLock }) {
  // Flatten entries -> selectable accounts. For an HD vault entry we list its
  // addresses; for an imported key, the single address.
  const accounts = useMemo(() => {
    const out = [];
    for (const e of entries) {
      out.push({ entryId: e.id, type: e.type, label: e.label, address: e.address, index: 0 });
    }
    return out;
  }, [entries]);

  const [selected, setSelected] = useState(0);
  const current = accounts[selected] ?? null;

  async function importDevKey() {
    setError(null);
    try {
      await ks.addImportedKey(DEV_KEY, { label: 'DEV account (pre-funded)' });
      refreshEntries();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="wallet-grid">
      <aside className="card">
        <div className="row-between">
          <h3>Accounts</h3>
          <button className="link-btn" onClick={onLock}>
            lock
          </button>
        </div>
        <ul className="account-list">
          {accounts.map((a, i) => (
            <li
              key={a.entryId}
              className={i === selected ? 'account active' : 'account'}
              onClick={() => setSelected(i)}
            >
              <span className="account-label">{a.label}</span>
              <span className="mono account-addr">{truncateAddress(a.address)}</span>
            </li>
          ))}
        </ul>
        <button className="link-btn" onClick={importDevKey}>
          + import DEV key
        </button>
      </aside>

      <div className="stack">
        {current ? (
          <>
            <Balance rpc={rpc} address={current.address} />
            <SendForm
              ks={ks}
              rpc={rpc}
              account={current}
              setError={setError}
            />
          </>
        ) : (
          <div className="card">
            <p className="muted">No accounts. Import the DEV key to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Balance({ rpc, address }) {
  const [balance, setBalance] = useState(null);
  const [netErr, setNetErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const wei = await rpc.call('eth_getBalance', [address, 'latest']);
        if (!cancelled) {
          setBalance(BigInt(wei));
          setNetErr(false);
        }
      } catch (err) {
        if (!cancelled) setNetErr(isNetworkError(err));
      }
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [rpc, address]);

  return (
    <div className="card balance-card">
      <div className="balance-label">Balance · {truncateAddress(address)}</div>
      {netErr ? (
        <div className="warn">node unreachable — balance unavailable</div>
      ) : (
        <div className="balance-amount accent">
          {balance == null ? '…' : formatPranaWithSymbol(balance)}
        </div>
      )}
    </div>
  );
}

function SendForm({ ks, rpc, account, setError }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState(null); // dryRun result + built tx
  const [status, setStatus] = useState(null); // 'previewing' | 'sending' | 'sent' | error str
  const [result, setResult] = useState(null); // { hash, receipt }

  function reset() {
    setPreview(null);
    setResult(null);
    setStatus(null);
  }

  async function doPreview(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setStatus('previewing');
    try {
      const value = parsePranaToWei(amount || '0');
      const provider = rpc.asProvider();
      const tx = await buildTx({ from: account.address, to, value }, provider);
      const sim = await dryRun(tx, provider);
      setPreview({ tx, sim });
      setStatus(sim.ok ? 'ready' : 'revert');
    } catch (err) {
      setStatus(null);
      setError(err);
    }
  }

  async function doSend() {
    setError(null);
    setStatus('sending');
    try {
      const provider = rpc.asProvider();
      // Get a signer for this account via the keystore (key never leaves lib/).
      const opened = await ks.get(account.entryId);
      const signer =
        opened.type === 'vault'
          ? opened.signerFor(account.index ?? 0)
          : opened.signer();
      const out = await sendAndWait(signer, preview.tx, provider, { confirmations: 1 });
      setResult(out);
      setStatus('sent');
    } catch (err) {
      setStatus(null);
      setError(err);
    }
  }

  return (
    <div className="card">
      <h3>Send PRANA</h3>
      <form onSubmit={doPreview} className="stack">
        <label>
          To
          <input
            className="search-input"
            placeholder="0x… recipient"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              reset();
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Amount (PRANA)
          <input
            className="search-input"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              reset();
            }}
            inputMode="decimal"
          />
        </label>
        <button className="btn" type="submit" disabled={status === 'sending' || !to}>
          Preview (dry-run)
        </button>
      </form>

      {preview && (
        <div className="preview">
          <h4>Preview</h4>
          {preview.sim.ok ? (
            <p className="success">
              Will succeed. Est. gas: {String(preview.sim.gasEstimate ?? '—')} ·{' '}
              fee type {preview.tx.type === 2 ? 'EIP-1559' : 'legacy'}
            </p>
          ) : (
            <p className="danger">
              Would revert{preview.sim.revertReason ? `: ${preview.sim.revertReason}` : ''}
              {preview.sim.error && !preview.sim.revertReason ? ` (${preview.sim.error})` : ''}
            </p>
          )}
          <dl className="kv">
            <dt>To</dt>
            <dd className="mono">{preview.tx.to}</dd>
            <dt>Value</dt>
            <dd>{formatPranaWithSymbol(preview.tx.value)}</dd>
            <dt>Gas limit</dt>
            <dd>{String(preview.tx.gasLimit)}</dd>
            <dt>Nonce</dt>
            <dd>{preview.tx.nonce}</dd>
          </dl>
          <button
            className="btn"
            onClick={doSend}
            disabled={!preview.sim.ok || status === 'sending'}
          >
            {status === 'sending' ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      )}

      {status === 'sent' && result && (
        <div className="banner success">
          Sent. Tx{' '}
          <a href={txLink(EXPLORER_BASE, result.hash)} target="_blank" rel="noreferrer" className="mono">
            {truncateAddress(result.hash)}
          </a>{' '}
          confirmed in block {result.receipt?.blockNumber ? BigInt(result.receipt.blockNumber).toString() : '—'}.
        </div>
      )}
    </div>
  );
}
