// transparency-score.mjs — compute a 0-100 "clarity / transparency" score for
// a token from on-chain facts. PUBLIC, fixture-driven, no network required.
//
// The score is the aggregator's differentiator: a market-data listing that
// also tells you, structurally, how concentrated / mintable / rug-prone a
// token is. This module is the reference implementation of that field. It is
// pure: it takes an already-collected `facts` object (so collection can be
// done by any indexer / RPC walk / subgraph) and returns the scored breakdown.
//
// Inputs (`facts`) — all optional; missing facts lower confidence, not score:
//   {
//     holders: [{ address, balance, isContract }],  // top holders, balance as string/bigint
//     totalSupply: "<decimal string>",              // ERC-20 totalSupply()
//     mintAuthority: { renounced: bool, owner } | null,
//     lpLock: { locked: bool, fraction, unlockTime } | null,
//   }
//
// Output: { score, grade, components: {...}, flags: [...], confidence }
//
// Each component returns a 0..1 sub-score and a weight; score = Σ(sub*weight)*100.

// ---------------------------------------------------------------------------
// Component weights — must sum to 1.0. Rationale in transparency-score.md.
// ---------------------------------------------------------------------------
export const WEIGHTS = Object.freeze({
  concentration: 0.35, // top-10 holder concentration — biggest rug/dump vector
  contractRatio: 0.15, // share of supply held by contracts vs EOAs
  mintAuthority: 0.3, // can supply be inflated at will? renounced is best
  lpLock: 0.2, // is the liquidity locked / for how long
});

function toBig(v) {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v;
  return BigInt(String(v));
}

// --- concentration: top-10 *EOA* holders' share of supply. Lower share =
// higher score. sub = 1 - top10Fraction, clamped. We exclude contract holders
// because contract-held supply (LP pools, locks, staking vaults) is a distinct
// risk assessed by scoreContractRatio — counting an LP contract as a "whale"
// would double-penalise the very locking that makes a token safer. A token
// where the top-10 EOAs hold <10% scores ~0.9+; >90% scores ~0.1. Linear is
// intentional: a penalty proportional and explainable to non-experts.
export function scoreConcentration(facts) {
  const supply = toBig(facts.totalSupply);
  const holders = (facts.holders || []).filter((h) => !h.isContract);
  if (supply <= 0n || holders.length === 0) {
    return { sub: null, top10Fraction: null, note: "insufficient EOA holder data" };
  }
  const sorted = [...holders].sort((a, b) => (toBig(b.balance) > toBig(a.balance) ? 1 : -1));
  const top10 = sorted.slice(0, 10).reduce((acc, h) => acc + toBig(h.balance), 0n);
  // fraction in [0,1] with 4-decimal precision via fixed-point.
  const fracMilli = Number((top10 * 10000n) / supply) / 10000;
  const top10Fraction = Math.min(1, Math.max(0, fracMilli));
  return { sub: 1 - top10Fraction, top10Fraction };
}

// --- contractRatio: fraction of supply held by *contract* addresses.
// Contracts can be locks/vaults/LP (good) or honeypots/team multisigs (mixed).
// We treat a *very high* contract share as slightly opaque (you must trust the
// contract), and a *moderate* share as neutral-to-good. Peak score at ~40-60%
// contract-held (typical: LP + staking), tapering both extremes.
export function scoreContractRatio(facts) {
  const supply = toBig(facts.totalSupply);
  const holders = facts.holders || [];
  if (supply <= 0n || holders.length === 0) {
    return { sub: null, contractFraction: null, note: "insufficient holder data" };
  }
  const inContracts = holders
    .filter((h) => h.isContract)
    .reduce((acc, h) => acc + toBig(h.balance), 0n);
  const contractFraction = Math.min(1, Number((inContracts * 10000n) / supply) / 10000);
  // Tent function peaking at 0.5: sub = 1 - 2*|frac - 0.5|, floored at 0.2 so a
  // pure-EOA or pure-contract token isn't zeroed (it's just less legible).
  const sub = Math.max(0.2, 1 - 2 * Math.abs(contractFraction - 0.5));
  return { sub, contractFraction };
}

// --- mintAuthority: renounced/zero owner = 1.0 (cannot inflate). Active owner
// = 0.2 (supply can be diluted at will). Unknown = null (lowers confidence).
export function scoreMintAuthority(facts) {
  const m = facts.mintAuthority;
  if (m == null) return { sub: null, note: "mint authority unknown" };
  if (m.renounced) return { sub: 1, renounced: true };
  return { sub: 0.2, renounced: false, owner: m.owner ?? null };
}

// --- lpLock: liquidity locked → score scales with locked fraction; unlocked or
// absent lock → 0.1 (high rug risk). A long unlock horizon could further raise
// this; we keep it fraction-driven and leave time-weighting as a documented TODO.
export function scoreLpLock(facts) {
  const l = facts.lpLock;
  if (l == null) return { sub: null, note: "LP lock status unknown" };
  if (!l.locked) return { sub: 0.1, locked: false };
  const frac = typeof l.fraction === "number" ? Math.min(1, Math.max(0, l.fraction)) : 1;
  // Locked liquidity floors at 0.5 (any lock is materially safer than none).
  return { sub: 0.5 + 0.5 * frac, locked: true, fraction: frac, unlockTime: l.unlockTime ?? null };
}

// Map a 0..100 score to a letter grade for the UI badge.
export function grade(score) {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// Compute the full score. Components with null sub-scores are dropped and their
// weight is redistributed across the present components, so a partially-known
// token is scored on what IS known (and `confidence` reports the coverage).
export function computeTransparencyScore(facts = {}) {
  const components = {
    concentration: scoreConcentration(facts),
    contractRatio: scoreContractRatio(facts),
    mintAuthority: scoreMintAuthority(facts),
    lpLock: scoreLpLock(facts),
  };

  let weightPresent = 0;
  let weighted = 0;
  for (const [key, comp] of Object.entries(components)) {
    if (comp.sub == null) continue;
    weightPresent += WEIGHTS[key];
    weighted += comp.sub * WEIGHTS[key];
  }

  const score = weightPresent > 0 ? Math.round((weighted / weightPresent) * 100) : null;
  const confidence = Math.round(weightPresent * 100) / 100; // fraction of weight covered

  const flags = [];
  if (components.concentration.top10Fraction != null && components.concentration.top10Fraction > 0.5)
    flags.push("HIGH_CONCENTRATION");
  if (components.mintAuthority.sub != null && !components.mintAuthority.renounced)
    flags.push("MINT_AUTHORITY_ACTIVE");
  if (components.lpLock.sub != null && components.lpLock.locked === false)
    flags.push("LP_UNLOCKED");

  return {
    score,
    grade: score == null ? null : grade(score),
    confidence,
    components,
    flags,
  };
}

// Wrap in the canonical aggregator envelope (shared with chain-stats).
export function envelope(payload, { source = "prana-transparency", chainId, now = () => new Date() } = {}) {
  return { source, chainId, updatedAt: now().toISOString(), payload };
}
