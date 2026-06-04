// PackOpenView — pack-opening (commit/reveal) with a rarity reveal.
//
// Binds lib/pack-opening.mjs (the headless commit/reveal driver that mirrors the
// on-chain GachaMintOnCommit two-phase flow). The driver does ALL chain logic;
// this view only renders its state machine and drives commit()/reveal().
//
// Flow the user sees:
//   1. pick a pack (contract) → "Open pack" runs commit(saltHash) and escrows
//      the pull. A SECRET salt is generated locally and kept in driver state.
//   2. the reveal block (commitBlock+1) must be mined — we poll the driver's
//      refreshReadiness(); a "charging" bar shows blocks-until-revealable.
//   3. "Reveal" runs reveal(salt); the driver decodes the minted tokenId +
//      rarity from the Revealed event and we play a Canvas burst, then show the
//      card + rarity name.
//
// Runs WITHOUT a live node: with no RPC reachable (or no signer), the view falls
// back to the driver's fixture mode so the whole commit→reveal→reveal-animation
// experience still works offline (the same code path the lib tests use).
//
// Animation is pure Canvas 2D — no new dependencies.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPackOpening,
  STATES,
  generateSalt,
} from '../../../lib/pack-opening.mjs';

// Demo packs for the offline / no-signer experience. A real deployment would
// load these from the contract registry (deployments.json) instead.
const DEMO_PACKS = [
  {
    id: 'starter',
    name: 'Starter Relic Pack',
    contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    rarityNames: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'],
    weights: [62, 24, 9, 4, 1], // disclosed odds, for display
  },
];

// Rarity → accent colour, drawn from the theme ramp (dark field → luminous core).
const RARITY_COLOR = {
  Common: '#9fb6e8',
  Uncommon: '#7fffb0',
  Rare: '#62d0ff',
  Epic: '#9be4ff',
  Legendary: '#ffe27f',
};
function rarityColor(name) {
  return RARITY_COLOR[name] ?? 'var(--core-glow)';
}

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export default function PackOpenView({ rpc, signer = null, account = null }) {
  const pack = DEMO_PACKS[0];

  // The driver is created lazily on "open" so each pull gets a fresh secret salt.
  const driverRef = useRef(null);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [salt, setSalt] = useState(null);

  // Decide live-vs-fixture once: a usable signer + reachable rpc = live.
  const canGoLive = Boolean(rpc && signer && account);

  function makeDriver() {
    const freshSalt = generateSalt();
    setSalt(freshSalt);
    const common = {
      contract: pack.contract,
      account: account ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // dev addr
      salt: freshSalt,
      rarityNames: pack.rarityNames,
    };
    let d;
    if (canGoLive) {
      d = createPackOpening({
        ...common,
        provider: rpc.asProvider(),
        signer,
        opts: { confirmations: 1, pollMs: 1500, timeoutMs: 90_000 },
      });
    } else {
      // Offline demo: a moving fake block height + a weighted draw stand in for
      // the chain. We advance the block on reveal so the gate opens naturally.
      let block = 1000n;
      d = createPackOpening({
        ...common,
        fixture: {
          get currentBlock() {
            return block;
          },
          advance() {
            block += 3n;
          },
          rarityNames: pack.rarityNames,
          reveal: () => ({ tokenId: randomTokenId(), rarityIndex: drawRarity(pack.weights) }),
        },
      });
      d._demoAdvance = () => {
        block += 3n;
      };
    }
    return d;
  }

  // Subscribe to driver snapshots.
  function attach(d) {
    driverRef.current = d;
    setSnap(d.snapshot());
    d.subscribe((s) => setSnap(s));
  }

  async function onOpen() {
    setBusy(true);
    try {
      const d = makeDriver();
      attach(d);
      await d.commit();
      // In offline demo, simulate the reveal block being mined shortly after.
      if (!canGoLive && d._demoAdvance) {
        d._demoAdvance();
        await d.refreshReadiness();
      }
    } finally {
      setBusy(false);
    }
  }

  async function onReveal() {
    const d = driverRef.current;
    if (!d) return;
    setBusy(true);
    try {
      await d.reveal();
    } finally {
      setBusy(false);
    }
  }

  function onReset() {
    const d = driverRef.current;
    if (d) d.reset();
    driverRef.current = null;
    setSnap(null);
    setSalt(null);
  }

  // Poll readiness while committed (live mode waits for the reveal block).
  useEffect(() => {
    if (!snap || snap.state !== STATES.COMMITTED) return;
    if (!canGoLive) return; // fixture mode advances synchronously
    let cancelled = false;
    const t = setInterval(async () => {
      const d = driverRef.current;
      if (!d || cancelled) return;
      await d.refreshReadiness();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [snap?.state, canGoLive]);

  const state = snap?.state ?? STATES.IDLE;
  const card = snap?.cards?.[0] ?? null;

  return (
    <section className="stack">
      <div className="dev-badge" title="Pack opening uses the on-chain commit/reveal gacha.">
        PACK OPENING · commit → reveal · {canGoLive ? 'live chain' : 'offline demo (no node)'}
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <div className="balance-label">{pack.name}</div>
            <div className="muted">
              Two-phase fair pull: you commit a secret, then reveal once the next block is sealed.
            </div>
          </div>
          <RarityOdds names={pack.rarityNames} weights={pack.weights} />
        </div>

        <PackStage state={state} card={card} />

        {snap?.error && <p className="danger">{String(snap.error.message)}</p>}

        <div className="row-between">
          <PhaseLabel state={state} snap={snap} />
          <div className="stack-row">
            {(state === STATES.IDLE || state === STATES.FAILED || state === STATES.EXPIRED) && (
              <button className="btn" onClick={onOpen} disabled={busy}>
                {state === STATES.FAILED || state === STATES.EXPIRED ? 'Try another pack' : 'Open pack'}
              </button>
            )}
            {state === STATES.REVEALABLE && (
              <button className="btn" onClick={onReveal} disabled={busy}>
                Reveal
              </button>
            )}
            {state === STATES.REVEALED && (
              <button className="link-btn" onClick={onReset}>
                Open another
              </button>
            )}
          </div>
        </div>

        {salt && state !== STATES.REVEALED && (
          <div className="muted mono" style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
            secret salt (kept locally until reveal): {salt.slice(0, 18)}…
          </div>
        )}
      </div>
    </section>
  );
}

// ---- phase label -----------------------------------------------------------

function PhaseLabel({ state, snap }) {
  const text =
    {
      [STATES.IDLE]: 'Ready to open.',
      [STATES.COMMITTING]: 'Committing the pull…',
      [STATES.COMMITTED]: 'Waiting for the reveal block to seal…',
      [STATES.REVEALABLE]: 'Block sealed — reveal your card.',
      [STATES.REVEALING]: 'Revealing…',
      [STATES.REVEALED]: 'Revealed!',
      [STATES.EXPIRED]: 'Commit expired — escrow refundable. Open another.',
      [STATES.FAILED]: 'Something went wrong.',
    }[state] ?? '';
  return (
    <span className={state === STATES.REVEALED ? 'success' : 'muted'}>
      {text}
      {snap?.commitBlock != null && state === STATES.COMMITTED ? ` (commit #${snap.commitBlock})` : ''}
    </span>
  );
}

// ---- disclosed odds --------------------------------------------------------

function RarityOdds({ names, weights }) {
  const total = weights.reduce((a, b) => a + b, 0);
  return (
    <div className="stack" style={{ gap: 2, textAlign: 'right' }}>
      <div className="muted" style={{ fontSize: '0.7rem' }}>disclosed odds</div>
      {names.map((n, i) => (
        <div key={n} style={{ fontSize: '0.72rem', color: rarityColor(n) }}>
          {n} {((weights[i] / total) * 100).toFixed(1)}%
        </div>
      ))}
    </div>
  );
}

// ---- the stage: a Canvas "pack" that bursts into the revealed card ----------

function PackStage({ state, card }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const revealedRef = useRef(false);

  // Trigger the burst when we enter REVEALED.
  useEffect(() => {
    revealedRef.current = state === STATES.REVEALED;
    startRef.current = 0;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const color = card ? rarityColor(card.rarityName) : '#62d0ff';

    // A ring of particles for the burst.
    const N = 80;
    const parts = Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 2;
      const speed = 1.4 + Math.random() * 2.2;
      return { a, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 1 + Math.random() * 2.5 };
    });

    function frame(ts) {
      if (!startRef.current) startRef.current = ts;
      const t = (ts - startRef.current) / 1000; // seconds
      ctx.clearRect(0, 0, W, H);

      // Ambient dark field.
      const bg = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(W, H) / 1.4);
      bg.addColorStop(0, '#0d1830');
      bg.addColorStop(1, '#05080f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      if (!revealedRef.current) {
        // Pre-reveal: a pulsing "sealed pack" core (the Prana spark charging).
        const pulse = 0.5 + 0.5 * Math.sin(t * 3);
        const charging = state === STATES.COMMITTED || state === STATES.COMMITTING || state === STATES.REVEALING;
        const baseR = 34 + (charging ? pulse * 10 : 0);
        const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, baseR + 26);
        g.addColorStop(0, '#bff0ff');
        g.addColorStop(0.3, '#62d0ff');
        g.addColorStop(1, 'rgba(10,20,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + 26, 0, Math.PI * 2);
        ctx.fill();

        // Sealed diamond glyph.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * (charging ? 0.6 : 0.15));
        ctx.strokeStyle = '#9be4ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -22);
        ctx.lineTo(20, 0);
        ctx.lineTo(0, 22);
        ctx.lineTo(-20, 0);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      } else {
        // Reveal burst: particles fly out, then a glowing card frame settles.
        const burst = Math.min(t / 0.9, 1);
        const ease = 1 - Math.pow(1 - burst, 3);
        for (const p of parts) {
          const d = ease * 120;
          const px = cx + p.vx * d;
          const py = cy + p.vy * d;
          ctx.globalAlpha = 1 - burst;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, p.r * (1 - burst * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Card frame fades/scales in.
        const appear = Math.min(Math.max((t - 0.35) / 0.6, 0), 1);
        const cardW = 150 * appear;
        const cardH = 200 * appear;
        if (appear > 0) {
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = 30 * appear;
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.fillStyle = '#0a1428';
          roundRect(ctx, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 10);
          ctx.fill();
          ctx.stroke();
          ctx.restore();

          // Inner spark.
          const ig = ctx.createRadialGradient(cx, cy - 10, 2, cx, cy - 10, 50 * appear);
          ig.addColorStop(0, color);
          ig.addColorStop(1, 'rgba(10,20,40,0)');
          ctx.globalAlpha = appear;
          ctx.fillStyle = ig;
          ctx.beginPath();
          ctx.arc(cx, cy - 10, 50 * appear, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state, card]);

  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '0.5rem 0' }}>
      <canvas
        ref={canvasRef}
        width={300}
        height={260}
        style={{ borderRadius: 12, border: '1px solid var(--border)', maxWidth: '100%' }}
      />
      {state === STATES.REVEALED && card && (
        <div className="stack" style={{ alignItems: 'center', gap: 4, marginTop: 8 }}>
          <div
            className="balance-amount"
            style={{ color: rarityColor(card.rarityName), fontSize: '1.3rem' }}
          >
            {card.rarityName ?? `Rarity #${card.rarityIndex}`}
          </div>
          <div className="muted mono">token #{String(card.tokenId)}</div>
        </div>
      )}
    </div>
  );
}

// ---- small canvas + draw helpers ------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- offline-demo draw (mirrors the contract's WeightedRandomDraw) ----------

function drawRarity(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.floor(Math.random() * total);
  for (let i = 0; i < weights.length; i++) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
  }
  return weights.length - 1;
}

function randomTokenId() {
  return BigInt(Math.floor(Math.random() * 1_000_000));
}

// Quiet the unused-import lint when DEV_KEY is referenced only in docs.
void DEV_KEY;
