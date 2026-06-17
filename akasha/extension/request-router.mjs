// request-router.mjs — pure classification of EIP-1193 methods for the Akasha MV3 extension's
// background worker. Mirrors akasha/lib/provider-1193.mjs's switch, but as a side-effect-free classifier
// so the background plumbing (and its tests) stay simple. No network, no keys, never throws.
//
//   local        — answered from local state (chainId/accounts), no prompt, no network
//   permissioned — needs user approval + a signature (connect / sendTx / sign / switch-chain)
//   passthrough  — a read forwarded verbatim to the PRANA JSON-RPC node
//   refused      — intentionally disabled (legacy eth_sign)

export const PRANA_CHAIN_ID_HEX = '0x1a751'; // 108369

const LOCAL = new Set(['eth_chainId', 'net_version', 'eth_accounts']);
const PERMISSIONED = new Set([
  'eth_requestAccounts', 'wallet_requestPermissions',
  'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4',
  'wallet_switchEthereumChain', 'wallet_addEthereumChain',
]);
const REFUSED = new Set(['eth_sign']); // legacy unsafe raw sign

/** Classify a method into one of the four buckets. Unknown methods are read passthroughs. */
export function classify(method) {
  if (typeof method !== 'string' || method.length === 0) return 'invalid';
  if (REFUSED.has(method)) return 'refused';
  if (LOCAL.has(method)) return 'local';
  if (PERMISSIONED.has(method)) return 'permissioned';
  return 'passthrough';
}

/** Answer a `local` method from the worker's state. Returns { ok, result } or { ok:false, reason }. */
export function answerLocal(method, state = {}) {
  const chainId = state.chainIdHex || PRANA_CHAIN_ID_HEX;
  const accounts = Array.isArray(state.authorizedAccounts) ? state.authorizedAccounts : [];
  switch (method) {
    case 'eth_chainId': return { ok: true, result: chainId };
    case 'net_version': return { ok: true, result: String(parseInt(chainId, 16)) };
    case 'eth_accounts': return { ok: true, result: [...accounts] };
    default: return { ok: false, reason: 'not-local' };
  }
}

/** Whether a permissioned method also requires the vault to be UNLOCKED (i.e. produces a signature). */
export function needsUnlock(method) {
  return method === 'eth_sendTransaction' || method === 'personal_sign' || method === 'eth_signTypedData_v4';
}

/** Validate the inbound request envelope. Returns { ok, method, params } or { ok:false, reason }. */
export function parseRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'bad-envelope' };
  const { method, params } = args;
  if (typeof method !== 'string' || method.length === 0) return { ok: false, reason: 'bad-method' };
  if (params != null && !Array.isArray(params) && typeof params !== 'object') return { ok: false, reason: 'bad-params' };
  return { ok: true, method, params: params ?? [] };
}
