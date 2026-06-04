// MintView — in-wallet NFT mint surface (AK12).
//
// Pick a mint-capable collection, fill its mint params (fields generated from the
// contract ABI via the abi-form model — exactly the abi-form generator the lib
// already ships), preview gas + a dry-run, handle an ERC-20 price's approval
// step, then mint and show the decoded tokenId.
//
// Key-handling rule (same as WalletView): private keys NEVER appear here. We get
// a signer from the unlocked Keystore (key stays inside lib/). When there is no
// live node, prepareMint falls back to a deterministic fixture plan so the screen
// stays usable offline (the read-only/fixture wallet pattern used across the app).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keystore,
  createLocalStorageStorage,
  prepareMint,
  executeMint,
  approveIfNeeded,
  formModelForFunction,
  txLink,
} from '../lib/wallet.js';
import { formatPranaWithSymbol, parsePranaToWei, truncateAddress } from '../lib/format.js';
import { isNetworkError } from '../lib/rpc.js';

const EXPLORER_BASE = 'http://127.0.0.1:8545';

// ---------------------------------------------------------------------------
// Bound collections — the real PRANA NFT contracts, with human-readable ABIs.
// `paramSkip` lists the mint args this view drives itself (none here; price is a
// separate field). `pricePath` describes whether the mint takes payment.
// ---------------------------------------------------------------------------
const COLLECTIONS = [
  {
    id: 'royalty',
    label: 'RoyaltyNFT — simple mintable ERC-721',
    fn: 'mint',
    abi: [
      'function mint(address to, string uri) returns (uint256 tokenId)',
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ],
    pricePath: 'none', // role-gated free mint
  },
  {
    id: 'mutablestat',
    label: 'MutableStatNFT — cross-game ERC-721 with a genome',
    fn: 'mint',
    abi: [
      'function mint(address to, uint256 genome, string uri) returns (uint256 tokenId)',
      'event Minted(uint256 indexed tokenId, address indexed to, uint256 genome)',
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ],
    pricePath: 'none',
  },
  {
    id: 'entrain',
    label: 'EntrainmentProgramNFT — buy an edition (priced)',
    fn: 'mintEdition',
    abi: [
      'function mintEdition(uint256 programId, address to) payable returns (uint256 tokenId)',
      'event EditionMinted(uint256 indexed tokenId, uint256 indexed programId, address indexed buyer, uint256 pricePaid, uint256 protocolCut)',
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ],
    pricePath: 'priced', // native OR ERC-20 per the program's payToken
  },
];

function makeKeystore() {
  return new Keystore({ storage: createLocalStorageStorage() });
}

export default function MintView({ rpc }) {
  const ksRef = useRef(null);
  if (ksRef.current == null) ksRef.current = makeKeystore();
  const ks = ksRef.current;

  const [accounts, setAccounts] = useState([]);
  const [selectedAcct, setSelectedAcct] = useState(0);
  const [error, setError] = useState(null);

  // Load accounts from the (already-unlocked) keystore session, if any.
  useEffect(() => {
    (async () => {
      await ks.load();
      try {
        const list = ks.list();
        setAccounts(list.map((e) => ({ entryId: e.id, type: e.type, label: e.label, address: e.address, index: 0 })));
      } catch {
        setAccounts([]);
      }
    })();
  }, [ks]);

  const current = accounts[selectedAcct] ?? null;

  return (
    <section>
      <div className="dev-badge" title="Mints against the local dev chain only.">
        MINT · local PRANA chain only · binds RoyaltyNFT / MutableStatNFT / EntrainmentProgramNFT
      </div>
      {error && <p className="danger">{String(error.message ?? error)}</p>}

      {accounts.length === 0 ? (
        <div className="card">
          <p className="muted">
            Unlock your vault in the Wallet tab first — minting needs a signer. You can still
            preview a mint below (dry-run only) once an account is available.
          </p>
        </div>
      ) : (
        <div className="card">
          <label>
            Mint from account
            <select
              className="search-input"
              value={selectedAcct}
              onChange={(e) => setSelectedAcct(Number(e.target.value))}
            >
              {accounts.map((a, i) => (
                <option key={a.entryId} value={i}>
                  {a.label} · {truncateAddress(a.address)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <MintForm ks={ks} rpc={rpc} account={current} setError={setError} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The mint form: collection pick → ABI-driven param fields → preview → mint.
// ---------------------------------------------------------------------------
function MintForm({ ks, rpc, account, setError }) {
  const [collId, setCollId] = useState(COLLECTIONS[0].id);
  const coll = useMemo(() => COLLECTIONS.find((c) => c.id === collId), [collId]);

  // Generated field model for the chosen mint function (the abi-form generator).
  const model = useMemo(() => formModelForFunction(coll.abi, coll.fn), [coll]);

  const [address, setAddress] = useState(''); // deployed collection address
  const [values, setValues] = useState({}); // raw mint-arg values, by input name
  const [price, setPrice] = useState(''); // PRANA price (priced collections)
  const [payToken, setPayToken] = useState(''); // ERC-20 token addr (blank => native)

  const [plan, setPlan] = useState(null);
  const [status, setStatus] = useState(null); // 'preparing' | 'approving' | 'minting' | 'done' | 'fixture'
  const [result, setResult] = useState(null); // { hash, receipt, tokenId }

  // reset derived state when the inputs that feed a plan change
  function resetPlan() {
    setPlan(null);
    setResult(null);
    setStatus(null);
  }

  function setField(name, v) {
    setValues((prev) => ({ ...prev, [name]: v }));
    resetPlan();
  }

  async function doPreview(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setStatus('preparing');
    try {
      const from = account?.address ?? '0x0000000000000000000000000000000000000000';
      const opts = { fnName: coll.fn };
      if (coll.pricePath === 'priced') {
        opts.price = price ? parsePranaToWei(price) : 0n;
        if (payToken.trim()) opts.payToken = payToken.trim();
      }

      let p;
      try {
        const provider = rpc.asProvider();
        p = await prepareMint({ provider, contract: address, abi: coll.abi, from, values, opts });
        setStatus('ready');
      } catch (err) {
        // No node / network error → deterministic fixture preview so the UI works offline.
        if (isNetworkError(err)) {
          p = await prepareMint({
            provider: null,
            contract: address || '0x0000000000000000000000000000000000000000',
            abi: coll.abi,
            from,
            values,
            opts: { ...opts, fixture: { ok: true, gasEstimate: 120000, tokenId: 0 } },
          });
          setStatus('fixture');
        } else {
          throw err;
        }
      }
      setPlan(p);
    } catch (err) {
      setStatus(null);
      setError(err);
    }
  }

  async function doMint() {
    if (!account) {
      setError(new Error('Unlock an account in the Wallet tab to sign the mint.'));
      return;
    }
    setError(null);
    try {
      const provider = rpc.asProvider();
      const opened = await ks.get(account.entryId);
      const signer = opened.type === 'vault' ? opened.signerFor(account.index ?? 0) : opened.signer();

      // ERC-20 price: send the approval first if the plan flagged it.
      if (plan?.payment && !plan.payment.native && plan.payment.needsApproval) {
        setStatus('approving');
        await approveIfNeeded(signer, provider, plan, { confirmations: 1 });
        // re-prepare so allowance is re-read and the mint dry-run reflects it
        const from = account.address;
        const opts = { fnName: coll.fn };
        if (coll.pricePath === 'priced') {
          opts.price = price ? parsePranaToWei(price) : 0n;
          if (payToken.trim()) opts.payToken = payToken.trim();
        }
        const fresh = await prepareMint({ provider, contract: address, abi: coll.abi, from, values, opts });
        setPlan(fresh);
        if (fresh.ok === false) {
          setStatus('ready');
          setError(new Error(`Still reverts after approval: ${fresh.revertReason}`));
          return;
        }
      }

      setStatus('minting');
      const out = await executeMint({ signer, provider, abi: coll.abi, plan, opts: { confirmations: 1 } });
      setResult(out);
      setStatus('done');
    } catch (err) {
      setStatus('ready');
      setError(err);
    }
  }

  const busy = status === 'preparing' || status === 'approving' || status === 'minting';

  return (
    <div className="card">
      <h3>Mint an NFT</h3>

      <form onSubmit={doPreview} className="stack">
        <label>
          Collection
          <select
            className="search-input"
            value={collId}
            onChange={(e) => {
              setCollId(e.target.value);
              setValues({});
              resetPlan();
            }}
          >
            {COLLECTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Collection address
          <input
            className="search-input"
            placeholder="0x… deployed collection"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              resetPlan();
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </label>

        {/* ABI-driven mint param fields (generated from the contract ABI). */}
        {model.inputs.map((field) => (
          <MintField
            key={field.name}
            field={field}
            account={account}
            value={values[field.name] ?? ''}
            onChange={(v) => setField(field.name, v)}
          />
        ))}

        {coll.pricePath === 'priced' && (
          <>
            <label>
              Price (PRANA, or token units if an ERC-20 is set)
              <input
                className="search-input"
                placeholder="0.0"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  resetPlan();
                }}
                inputMode="decimal"
              />
            </label>
            <label>
              Pay token (blank = native PRANA)
              <input
                className="search-input"
                placeholder="0x… ERC-20 (optional)"
                value={payToken}
                onChange={(e) => {
                  setPayToken(e.target.value);
                  resetPlan();
                }}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </>
        )}

        <button className="btn" type="submit" disabled={busy || !address}>
          {status === 'preparing' ? 'Simulating…' : 'Preview (dry-run)'}
        </button>
      </form>

      {plan && (
        <div className="preview">
          <h4>Preview {status === 'fixture' && <span className="muted">(offline fixture)</span>}</h4>
          {plan.ok ? (
            <p className="success">
              Will succeed. Est. gas {String(plan.gasEstimate)} · fn {plan.fn}
            </p>
          ) : (
            <p className="danger">Would revert{plan.revertReason ? `: ${plan.revertReason}` : ''}</p>
          )}
          {plan.warning && <p className="warn">{plan.warning}</p>}

          <dl className="kv">
            <dt>Function</dt>
            <dd className="mono">{plan.signature}</dd>
            <dt>Value sent</dt>
            <dd>{formatPranaWithSymbol(plan.value)}</dd>
            <dt>Payment</dt>
            <dd>
              {plan.payment?.native
                ? 'native PRANA'
                : `ERC-20 ${truncateAddress(plan.payment?.token ?? '')}${
                    plan.payment?.needsApproval ? ' · approval required' : ' · allowance ok'
                  }`}
            </dd>
          </dl>

          <button
            className="btn"
            onClick={doMint}
            disabled={plan.ok === false || busy || !account}
          >
            {status === 'approving'
              ? 'Approving token…'
              : status === 'minting'
                ? 'Minting…'
                : plan.payment && !plan.payment.native && plan.payment.needsApproval
                  ? 'Approve & mint'
                  : 'Mint'}
          </button>
          {!account && <p className="muted">Unlock an account in the Wallet tab to mint.</p>}
        </div>
      )}

      {status === 'done' && result && (
        <div className="banner success">
          Minted{result.tokenId != null ? ` token #${result.tokenId.toString()}` : ''}. Tx{' '}
          <a
            href={txLink(EXPLORER_BASE, result.hash)}
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {truncateAddress(result.hash)}
          </a>
          .
        </div>
      )}
    </div>
  );
}

// One mint-param input. Uses the abi-form field model's `component` hint to pick
// a widget, and offers a "me" shortcut for the recipient address field.
function MintField({ field, value, onChange, account }) {
  const isRecipient =
    field.component === 'address' && /^(to|recipient|buyer|account)$/i.test(field.name);
  return (
    <label>
      {field.name} <span className="muted">({field.type})</span>
      <div className="row-between" style={{ gap: '0.5rem' }}>
        {field.component === 'bool' ? (
          <select className="search-input" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            className="search-input"
            placeholder={field.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode={field.component === 'number' ? 'numeric' : undefined}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        {isRecipient && account && (
          <button type="button" className="link-btn" onClick={() => onChange(account.address)}>
            me
          </button>
        )}
      </div>
    </label>
  );
}
