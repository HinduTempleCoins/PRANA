// format.js — pure display formatters for the Akasha wallet/explorer UI.
//
// All functions here are PURE (no I/O, no ethers, no DOM) so they are trivially
// unit-testable under node:test. The wallet/explorer views import these for
// every human-readable number/time/address they render.
//
// Unit nuance (see CLAUDE.md rebrand notes): the smallest unit is still "wei"
// under the hood; we only relabel the *display* denomination "ether" -> "PRANA".
// 1 PRANA = 10^18 wei, exactly like ETH. We do NOT rename the EVM unit.

const WEI_PER_PRANA = 10n ** 18n;

// Coerce number|string|bigint|hex into a BigInt of wei. Returns null on junk.
export function toWei(v) {
  if (v == null) return null;
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.trunc(v));
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return null;
      return BigInt(s); // handles 0x.. and decimal
    }
  } catch {
    return null;
  }
  return null;
}

// Format a wei amount as a PRANA string with up to `maxDecimals` fractional
// digits (trailing zeros trimmed). Pure bigint math — no float rounding error.
//   formatPrana(1500000000000000000n) -> "1.5"
//   formatPrana(0n) -> "0"
export function formatPrana(wei, maxDecimals = 6) {
  const w = toWei(wei);
  if (w == null) return '—';
  const neg = w < 0n;
  const abs = neg ? -w : w;
  const whole = abs / WEI_PER_PRANA;
  const frac = abs % WEI_PER_PRANA;

  let out = whole.toString();
  if (maxDecimals > 0 && frac > 0n) {
    // 18-digit zero-padded fractional part, then trim to maxDecimals + strip zeros.
    let fracStr = frac.toString().padStart(18, '0').slice(0, maxDecimals);
    fracStr = fracStr.replace(/0+$/, '');
    if (fracStr.length > 0) out += '.' + fracStr;
  }
  return (neg ? '-' : '') + out;
}

// Convenience: wei -> "<value> PRANA"
export function formatPranaWithSymbol(wei, maxDecimals = 6) {
  return `${formatPrana(wei, maxDecimals)} PRANA`;
}

// Parse a human PRANA decimal string into a BigInt of wei. Throws on bad input
// (used by the send form before building a tx). Pure string math.
export function parsePranaToWei(input) {
  if (typeof input !== 'string') input = String(input ?? '');
  const s = input.trim();
  if (s === '' || !/^\d*\.?\d*$/.test(s) || s === '.') {
    throw new Error(`invalid PRANA amount: "${input}"`);
  }
  const [wholeStr = '0', fracStrRaw = ''] = s.split('.');
  const fracStr = (fracStrRaw + '0'.repeat(18)).slice(0, 18);
  if (fracStrRaw.length > 18) {
    throw new Error('too many decimal places (max 18)');
  }
  const whole = BigInt(wholeStr || '0');
  const frac = BigInt(fracStr || '0');
  return whole * WEI_PER_PRANA + frac;
}

// Truncate a 0x address for compact display: 0x1234…cdef
export function truncateAddress(addr, lead = 6, tail = 4) {
  if (typeof addr !== 'string' || !addr.startsWith('0x') || addr.length <= lead + tail) {
    return addr ?? '';
  }
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

// Truncate a long hash (tx/block hash) the same way but with more lead context.
export function truncateHash(hash, lead = 10, tail = 8) {
  return truncateAddress(hash, lead, tail);
}

// Convert a unix seconds timestamp (number | hex | bigint) into a "time ago"
// string relative to `now` (ms). Deterministic when `now` is injected (tests).
export function timeAgo(tsSeconds, now = Date.now()) {
  let secs;
  try {
    secs = Number(toWei(tsSeconds));
  } catch {
    return '—';
  }
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const deltaMs = now - secs * 1000;
  if (deltaMs < 0) return 'in the future';
  const s = Math.floor(deltaMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

// Format a unix-seconds timestamp as a local datetime string for detail views.
export function formatTimestamp(tsSeconds) {
  const secs = Number(toWei(tsSeconds));
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  return new Date(secs * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

// Coerce a hex/decimal quantity to a plain Number for small counts (txs, gas).
// Returns null on failure. For values that might exceed Number range, use toWei.
export function hexToNumber(v) {
  const big = toWei(v);
  if (big == null) return null;
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(big);
}

// Format a gas figure (wei-of-gas count) with thousands separators.
export function formatGas(v) {
  const big = toWei(v);
  if (big == null) return '—';
  return big.toLocaleString('en-US');
}
