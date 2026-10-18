// WalletView — create / import / unlock a vault, balances, receive, send (PRANA mainnet).
//
// Key-handling rules (security, public build):
//   * Private keys and the recovery phrase NEVER leave this browser. The only network
//     I/O is JSON-RPC to the public PRANA node (rpc.js): reads, plus
//     eth_sendRawTransaction carrying an already-signed tx.
//   * Keys only ever pass through lib/keyvault + lib/keystore (scrypt + AES-128-CTR
//     Web3 Secret Storage v3, encrypted at rest in localStorage). This view gets a
//     signer handle via keystore.get(id).signerFor(i) only at the moment of sending.
//   * A NEW phrase is held in memory only until the backup quiz passes; only then is
//     it encrypted and persisted. It is never written anywhere in plaintext.
//   * Every tx is EIP-155 signed for CHAIN_ID, and we refuse to sign if the node
//     reports another chain id.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keystore,
  createLocalStorageStorage,
  buildTx,
  dryRun,
  sendAndWait,
  txLink,
  addressLink,
  newMnemonicPhrase,
  normalizeMnemonic,
  pickQuizPositions,
  encodeErc20Transfer,
  decodeErc20Transfer,
  isAddress,
  getAddress,
} from '../lib/wallet.js';
import {
  formatPranaWithSymbol,
  parsePranaToWei,
  truncateAddress,
  formatUnits,
  parseUnits,
} from '../lib/format.js';
import Balances from '../components/TokenBalances.jsx';
import {
  CHAIN_ID,
  NATIVE_SYMBOL,
  EXPLORER_URL,
  TOKENS,
  SIGNER_URL,
  isPublicTestAddress,
} from '../lib/network.js';

const MIN_PASSWORD = 10;
const PRIVKEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

function makeKeystore() {
  return new Keystore({ storage: createLocalStorageStorage() });
}

async function assertChainId(rpc) {
  const cid = await rpc.call('eth_chainId', []);
  if (BigInt(cid) !== BigInt(CHAIN_ID)) {
    throw new Error(
      `Refusing to sign: the node reports chain ${BigInt(cid)}, expected PRANA mainnet ${CHAIN_ID}.`,
    );
  }
}

export default function WalletView({ rpc }) {
  const ksRef = useRef(null);
  if (ksRef.current == null) ksRef.current = makeKeystore();
  const ks = ksRef.current;

  const [phase, setPhase] = useState('boot'); // boot | locked | empty | unlocked
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        await ks.load();
      } catch (err) {
        setError(err);
      }
      const list = ks.list();
      setEntries(list);
      setPhase(list.length > 0 ? 'locked' : 'empty');
    })();
  }, [ks]);

  // The keystore auto-locks after 5 idle minutes; reflect that in the UI.
  useEffect(() => {
    if (phase !== 'unlocked') return undefined;
    const t = setInterval(() => {
      if (ks.locked) setPhase('locked');
    }, 2000);
    return () => clearInterval(t);
  }, [ks, phase]);

  function refreshEntries() {
    const list = ks.list();
    setEntries(list);
    return list;
  }

  return (
    <section>
      <div className="banner warn mainnet-notice">
        <strong>PRANA mainnet · real value.</strong> Akasha is self-custody: your keys are made and
        kept in this browser, encrypted with your password, and never sent to any server.{' '}
        <strong>Your recovery phrase is the only way back in — we cannot recover it.</strong> Clearing
        this browser&apos;s site data deletes the encrypted copy; only the phrase restores it.
      </div>
      <p className="muted small">
        Already have a MELEK-Signer account? Your PRANA wallet for that account is held there:{' '}
        <a href={SIGNER_URL} target="_blank" rel="noopener noreferrer">
          signer.melek.salon
        </a>
        .
      </p>

      {error && <p className="danger" role="alert">{String(error.message ?? error)}</p>}

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
          onReset={() => {
            refreshEntries();
            setPhase('empty');
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
// Onboarding: unlock / create (phrase + quiz) / import phrase.
// ---------------------------------------------------------------------------
function Onboard({ ks, hasEntries, busy, setBusy, setError, onUnlocked, onReset }) {
  const [mode, setMode] = useState(hasEntries ? 'unlock' : 'create');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [importPhrase, setImportPhrase] = useState('');

  // create flow: phrase lives only here until the quiz passes.
  const [mnemonic, setMnemonic] = useState(null);
  const [quiz, setQuiz] = useState([]);
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState('show'); // show | quiz

  useEffect(() => {
    setMode(hasEntries ? 'unlock' : 'create');
  }, [hasEntries]);

  function clearSecrets() {
    setMnemonic(null);
    setAnswers({});
    setQuiz([]);
    setStep('show');
    setPassword('');
    setPassword2('');
    setImportPhrase('');
  }

  function checkNewPassword() {
    if (password.length < MIN_PASSWORD) {
      throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
    }
    if (password !== password2) throw new Error('The two passwords do not match.');
  }

  async function doUnlock(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await ks.unlock(password);
      setPassword('');
      onUnlocked();
    } catch (err) {
      setError(new Error('Wrong password (or the stored vault is damaged).'));
    } finally {
      setBusy(false);
    }
  }

  function doCreate(e) {
    e.preventDefault();
    setError(null);
    try {
      checkNewPassword();
      const phrase = newMnemonicPhrase();
      setMnemonic(phrase);
      setQuiz(pickQuizPositions(phrase.split(' ').length, 3));
      setAnswers({});
      setStep('show');
    } catch (err) {
      setError(err);
    }
  }

  async function confirmBackup(e) {
    e.preventDefault();
    setError(null);
    const words = mnemonic.split(' ');
    for (const i of quiz) {
      if ((answers[i] ?? '').trim().toLowerCase() !== words[i]) {
        setError(new Error(`Word #${i + 1} does not match — check your written backup.`));
        return;
      }
    }
    setBusy(true);
    try {
      await ks.unlock(password); // empty store: sets the session password
      await ks.addVault({ mnemonic, label: 'Account 1' });
      clearSecrets();
      onUnlocked();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doImport(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      checkNewPassword();
      const phrase = normalizeMnemonic(importPhrase);
      await ks.unlock(password);
      await ks.addVault({ mnemonic: phrase, label: 'Imported phrase' });
      clearSecrets();
      onUnlocked();
    } catch (err) {
      setError(
        /invalid mnemonic|checksum|word/i.test(String(err?.message))
          ? new Error('That recovery phrase is not valid (check the words and their order).')
          : err,
      );
    } finally {
      setBusy(false);
    }
  }

  function doReset() {
    setError(null);
    const typed = window.prompt(
      'This deletes the encrypted wallet stored in THIS browser. Funds are only recoverable with your recovery phrase.\n\nType DELETE to continue.',
    );
    if (typed !== 'DELETE') return;
    try {
      window.localStorage.removeItem('akasha.keystore.v1');
    } catch {
      /* storage blocked */
    }
    ks.lock();
    ks._entries = [];
    onReset();
  }

  if (mnemonic) {
    const words = mnemonic.split(' ');
    if (step === 'show') {
      return (
        <div className="card">
          <h3>Write down your recovery phrase</h3>
          <p className="warn">
            Write these {words.length} words on paper, in order, and keep them offline. Anyone who
            has them controls this wallet. Do not screenshot, email, or paste them into any site.
            Akasha cannot show them again and cannot recover them for you.
          </p>
          <ol className="mnemonic-grid">
            {words.map((w, i) => (
              <li key={i} className="mono">
                {w}
              </li>
            ))}
          </ol>
          <div className="row-gap">
            <button className="btn" onClick={() => setStep('quiz')}>
              I wrote it down — continue
            </button>
            <button className="link-btn" onClick={clearSecrets}>
              cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <h3>Confirm your backup</h3>
        <p className="muted">Type the requested words from your written copy.</p>
        <form onSubmit={confirmBackup} className="stack">
          {quiz.map((i) => (
            <label key={i}>
              Word #{i + 1}
              <input
                className="search-input"
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
          ))}
          <div className="row-gap">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Encrypting…' : 'Confirm & create wallet'}
            </button>
            <button type="button" className="link-btn" onClick={() => setStep('show')}>
              back to the words
            </button>
          </div>
        </form>
      </div>
    );
  }

  const pwFields = (
    <>
      <input
        className="search-input"
        type="password"
        placeholder={`Password (min ${MIN_PASSWORD} characters)`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
      />
      <input
        className="search-input"
        type="password"
        placeholder="Repeat password"
        value={password2}
        onChange={(e) => setPassword2(e.target.value)}
        autoComplete="new-password"
      />
      <p className="muted small">
        The password encrypts the wallet in this browser (scrypt + AES). It is not a backup — the
        recovery phrase is.
      </p>
    </>
  );

  return (
    <div className="card">
      <div className="tab-row">
        {!hasEntries && (
          <>
            <button
              className={mode === 'create' ? 'tab active' : 'tab'}
              onClick={() => setMode('create')}
            >
              Create new
            </button>
            <button
              className={mode === 'import' ? 'tab active' : 'tab'}
              onClick={() => setMode('import')}
            >
              Import phrase
            </button>
          </>
        )}
      </div>

      {hasEntries && (
        <form onSubmit={doUnlock} className="stack">
          <h3>Unlock your wallet</h3>
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
          <button type="button" className="link-btn danger" onClick={doReset}>
            forgot password? remove this browser&apos;s wallet and restore from phrase
          </button>
        </form>
      )}

      {!hasEntries && mode === 'create' && (
        <form onSubmit={doCreate} className="stack">
          <h3>Create a new wallet</h3>
          <p className="muted">
            A 12-word recovery phrase is generated in your browser. You will write it down and
            confirm it before anything is saved.
          </p>
          {pwFields}
          <button className="btn" type="submit" disabled={busy || password.length === 0}>
            Generate recovery phrase
          </button>
        </form>
      )}

      {!hasEntries && mode === 'import' && (
        <form onSubmit={doImport} className="stack">
          <h3>Import a recovery phrase</h3>
          <textarea
            className="search-input mono"
            rows={3}
            placeholder="12 or 24 words, separated by spaces"
            value={importPhrase}
            onChange={(e) => setImportPhrase(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          {pwFields}
          <button className="btn" type="submit" disabled={busy || importPhrase.length === 0}>
            {busy ? 'Encrypting…' : 'Import'}
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unlocked: accounts, receive, balances, send, add account.
// ---------------------------------------------------------------------------
function Unlocked({ ks, rpc, entries, refreshEntries, setError, onLock }) {
  const accounts = useMemo(
    () =>
      entries.map((e) => ({
        entryId: e.id,
        type: e.type,
        label: e.label,
        address: e.address,
        index: 0,
        unsafe: isPublicTestAddress(e.address),
      })),
    [entries],
  );

  const [selected, setSelected] = useState(0);
  const current = accounts[selected] ?? accounts[0] ?? null;
  const [adding, setAdding] = useState(false);

  async function removeEntry(a) {
    const msg = a.unsafe
      ? 'Remove this PUBLIC test key from the wallet?'
      : `Remove "${a.label}" (${a.address}) from this browser? Only its recovery phrase / key can bring it back.`;
    if (!window.confirm(msg)) return;
    try {
      await ks.remove(a.entryId);
      refreshEntries();
      setSelected(0);
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
              className={a === current ? 'account active' : 'account'}
              onClick={() => setSelected(i)}
            >
              <span className="account-label">
                {a.label}
                {a.unsafe && <span className="danger"> · PUBLIC TEST KEY</span>}
              </span>
              <span className="mono account-addr">{truncateAddress(a.address)}</span>
            </li>
          ))}
        </ul>
        <button className="link-btn" onClick={() => setAdding(!adding)}>
          {adding ? 'cancel' : '+ add account (phrase or private key)'}
        </button>
        {current && (
          <button className="link-btn danger" onClick={() => removeEntry(current)}>
            remove selected
          </button>
        )}
      </aside>

      <div className="stack">
        {adding && (
          <AddAccount
            ks={ks}
            setError={setError}
            onDone={() => {
              const list = refreshEntries();
              setSelected(Math.max(0, list.length - 1));
              setAdding(false);
            }}
          />
        )}
        {current ? (
          current.unsafe ? (
            <div className="banner danger">
              This address belongs to a <strong>publicly known development key</strong> (imported by an
              older dev build of Akasha). Anyone can take funds sent to it, instantly. Do not use it —
              remove it from the list.
            </div>
          ) : (
            <>
              <Receive address={current.address} />
              <Balances rpc={rpc} address={current.address} />
              <SendForm ks={ks} rpc={rpc} account={current} setError={setError} />
            </>
          )
        ) : (
          <div className="card">
            <p className="muted">No accounts in this wallet. Add one with your phrase or key.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AddAccount({ ks, setError, onDone }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const s = secret.trim();
      if (PRIVKEY_RE.test(s)) {
        const pk = s.startsWith('0x') ? s : `0x${s}`;
        await ks.addImportedKey(pk, { label: 'Imported key' });
      } else {
        await ks.addVault({ mnemonic: normalizeMnemonic(s), label: 'Imported phrase' });
      }
      setSecret('');
      onDone();
    } catch (err) {
      setError(new Error('Not a valid recovery phrase or 64-hex private key.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>Add an account</h3>
      <p className="muted small">
        Paste a recovery phrase or a private key. It is encrypted under your current password and
        stays in this browser.
      </p>
      <textarea
        className="search-input mono"
        rows={3}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <button className="btn" type="submit" disabled={busy || !secret}>
        {busy ? 'Encrypting…' : 'Add'}
      </button>
    </form>
  );
}

function Receive({ address }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the address is selectable */
    }
  }
  return (
    <div className="card">
      <h3>Receive</h3>
      <p className="muted small">
        Your PRANA mainnet address (chain {CHAIN_ID}). Send only PRANA-chain assets here.
      </p>
      <div className="mono receive-addr" data-testid="receive-address">
        {address}
      </div>
      <div className="row-gap">
        <button className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <a href={addressLink(EXPLORER_URL, address)} target="_blank" rel="noopener noreferrer">
          view on PRANAScan ↗
        </a>
      </div>
    </div>
  );
}

function SendForm({ ks, rpc, account, setError }) {
  const [asset, setAsset] = useState(NATIVE_SYMBOL);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);

  const token = TOKENS.find((t) => t.symbol === asset) ?? null;

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
      if (!isAddress(to.trim())) throw new Error('Recipient is not a valid 0x address.');
      const recipient = getAddress(to.trim());
      if (isPublicTestAddress(recipient)) {
        throw new Error('Recipient is a publicly known test key — anyone can take funds sent there.');
      }
      await assertChainId(rpc);
      const provider = rpc.asProvider();
      let req;
      if (token) {
        const raw = parseUnits(amount || '0', token.decimals);
        if (raw <= 0n) throw new Error('Enter an amount greater than zero.');
        req = { from: account.address, to: token.address, value: 0n, data: encodeErc20Transfer(recipient, raw) };
      } else {
        const value = parsePranaToWei(amount || '0');
        if (value <= 0n) throw new Error('Enter an amount greater than zero.');
        req = { from: account.address, to: recipient, value };
      }
      const tx = await buildTx(req, provider, { chainId: CHAIN_ID });
      const sim = await dryRun(tx, provider);
      setPreview({ tx, sim, token, decoded: token ? decodeErc20Transfer(tx.data) : null });
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
      if (preview.tx.chainId !== CHAIN_ID) throw new Error('chain id mismatch — not signing');
      await assertChainId(rpc);
      const provider = rpc.asProvider();
      const opened = await ks.get(account.entryId);
      const signer = opened.type === 'vault' ? opened.signerFor(account.index ?? 0) : opened.signer();
      const out = await sendAndWait(signer, preview.tx, provider, { confirmations: 1 });
      setResult(out);
      setStatus('sent');
    } catch (err) {
      setStatus(null);
      setError(err);
    }
  }

  const fee =
    preview &&
    (preview.tx.type === 2 ? preview.tx.maxFeePerGas : preview.tx.gasPrice) * preview.tx.gasLimit;

  return (
    <div className="card">
      <h3>Send</h3>
      <form onSubmit={doPreview} className="stack">
        <label>
          Asset
          <select
            className="search-input"
            value={asset}
            onChange={(e) => {
              setAsset(e.target.value);
              reset();
            }}
          >
            <option value={NATIVE_SYMBOL}>{NATIVE_SYMBOL} (native)</option>
            {TOKENS.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <input
            className="search-input mono"
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
          Amount ({asset})
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
          Review
        </button>
      </form>

      {preview && (
        <div className="preview" data-testid="confirm">
          <h4>Confirm — this is exactly what will be signed</h4>
          {preview.sim.ok ? (
            <p className="success">Simulation OK.</p>
          ) : (
            <p className="danger">
              Would fail{preview.sim.revertReason ? `: ${preview.sim.revertReason}` : ''}
              {preview.sim.error && !preview.sim.revertReason ? ` (${preview.sim.error})` : ''}
            </p>
          )}
          <dl className="kv">
            <dt>Network</dt>
            <dd>PRANA mainnet · chain id {preview.tx.chainId}</dd>
            <dt>From</dt>
            <dd className="mono">{preview.tx.from}</dd>
            {preview.token ? (
              <>
                <dt>Sends</dt>
                <dd>
                  <strong>
                    {preview.decoded ? formatUnits(preview.decoded.amount, preview.token.decimals, preview.token.decimals) : '?'}{' '}
                    {preview.token.symbol}
                  </strong>
                </dd>
                <dt>Recipient</dt>
                <dd className="mono">{preview.decoded?.to ?? '?'}</dd>
                <dt>Token contract (tx to)</dt>
                <dd className="mono">{preview.tx.to}</dd>
                <dt>PRANA value</dt>
                <dd>{formatPranaWithSymbol(preview.tx.value, 18)}</dd>
              </>
            ) : (
              <>
                <dt>Sends</dt>
                <dd>
                  <strong>{formatPranaWithSymbol(preview.tx.value, 18)}</strong>
                </dd>
                <dt>Recipient (tx to)</dt>
                <dd className="mono">{preview.tx.to}</dd>
              </>
            )}
            <dt>Data</dt>
            <dd className="mono small">{preview.tx.data}</dd>
            <dt>Max network fee</dt>
            <dd>{fee != null ? formatPranaWithSymbol(fee, 8) : '—'} (gas limit {String(preview.tx.gasLimit)})</dd>
            <dt>Nonce</dt>
            <dd>{preview.tx.nonce}</dd>
          </dl>
          <button className="btn" onClick={doSend} disabled={!preview.sim.ok || status === 'sending'}>
            {status === 'sending' ? 'Signing & sending…' : 'Sign & send'}
          </button>
        </div>
      )}

      {status === 'sent' && result && (
        <div className="banner success">
          Sent. Tx{' '}
          <a href={txLink(EXPLORER_URL, result.hash)} target="_blank" rel="noopener noreferrer" className="mono">
            {truncateAddress(result.hash)}
          </a>{' '}
          confirmed in block {result.receipt?.blockNumber ? BigInt(result.receipt.blockNumber).toString() : '—'}.
        </div>
      )}
    </div>
  );
}
