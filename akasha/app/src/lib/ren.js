// ren.js — resolve REN names (ryan.melek) to PRANA addresses, client-side, for the wallet.
//
// REN is the MELEK naming registrar on PRANA (RENRegistrar). The send form lets a user type a
// name instead of a 0x address; we resolve it via a read-only eth_call to the registrar's
// resolve(string) view over the same RPC the wallet already uses. Pure hex ABI (no deps).

// Deployed RENRegistrar on the PRANA testnet (override at build time via VITE_REN_REGISTRAR).
export const REN_REGISTRAR =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_REN_REGISTRAR) ||
  '0x07882Ae1ecB7429a84f1D53048d35c4bB2056877';
export const REN_TLDS = ['melek', 'prana', 'kula'];
const SEL_RESOLVE = '0x461a4478'; // resolve(string) -> address

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** A string is a REN name if it's label.tld with an allowlisted tld (and not a raw 0x address). */
export function looksLikeRenName(s) {
  const v = String(s || '').trim().toLowerCase();
  if (ADDR_RE.test(v)) return false;
  const dot = v.indexOf('.');
  if (dot < 1 || dot !== v.lastIndexOf('.') || dot === v.length - 1) return false;
  return /^[a-z0-9-]+$/.test(v.slice(0, dot)) && REN_TLDS.includes(v.slice(dot + 1));
}

// ABI-encode resolve(string): selector + offset(0x20) + length + right-padded utf8 bytes.
function encodeResolve(name) {
  const bytes = new TextEncoder().encode(name);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  const lenWord = bytes.length.toString(16).padStart(64, '0');
  const dataWords = hex ? hex.padEnd(Math.ceil(hex.length / 64) * 64, '0') : '';
  return SEL_RESOLVE + (32).toString(16).padStart(64, '0') + lenWord + dataWords;
}

function decodeAddress(hexResult) {
  const w = String(hexResult || '').replace(/^0x/, '');
  if (w.length < 64) return null;
  const addr = '0x' + w.slice(24, 64);
  return /^0x0+$/.test(addr) ? null : addr;
}

/**
 * resolveRenName(provider, name) -> 0x address or null.
 * provider: anything with .send(method, params) (rpc.asProvider()). Soft-fail → null.
 */
export async function resolveRenName(provider, name, registrar = REN_REGISTRAR) {
  if (!looksLikeRenName(name) || !provider || typeof provider.send !== 'function') return null;
  try {
    const res = await provider.send('eth_call', [{ to: registrar, data: encodeResolve(name.trim().toLowerCase()) }, 'latest']);
    return decodeAddress(res);
  } catch {
    return null;
  }
}

export const _internal = { encodeResolve, decodeAddress };
