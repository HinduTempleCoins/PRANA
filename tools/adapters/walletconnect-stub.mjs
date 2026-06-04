// walletconnect-stub.mjs — DOCUMENTED STUB for WalletConnect v2 session handling.
//
// STATUS: STUB. This installs NO dependencies (`@walletconnect/*` is deferred to
// wallet v2 — see the WalletConnect research spike). It exists to pin down the
// *interfaces* a future real adapter must implement, and to prove the one piece
// we can build today with zero external deps: routing an incoming WalletConnect
// `session_request` into the standard EIP-1193 `request({ method, params })`
// shape the wallet's provider already speaks, via a LocalSignerFallback.
//
// Why this shape: WalletConnect v2 and an in-app dapp-browser are two TRANSPORTS
// into ONE approval+signing pipeline. The in-app browser injects an EIP-1193
// provider as window.ethereum; WalletConnect delivers the identical JSON-RPC
// calls over an encrypted relay. So a WC `session_request` must become a
// `provider.request({ method, params })` call — that normalization is what this
// stub implements and tests.
//
// The real adapter (post-MVP) swaps `WalletConnectSessionHandler`'s in-memory
// bookkeeping for `@walletconnect/web3wallet` (WalletKit): core.pairing.pair({uri}),
// the `session_proposal` event, approveSession(namespaces), and the `session_request`
// event — but `routeRequest` / `LocalSignerFallback` stay exactly as written here.
//
// This module is provider-AGNOSTIC: it depends only on the public EIP-1193
// `request()` contract, never on any specific wallet implementation, so it is
// safe to publish.
//
// PUBLIC FILE: brand strings are "PRANA" only.

// EIP-155 CAIP-2 chain id for the PRANA chain (chainId 108369 = 0x1a751).
export const PRANA_CHAIN_ID_DEC = 108369;
export const PRANA_EIP155_CHAIN = `eip155:${PRANA_CHAIN_ID_DEC}`;

// The JSON-RPC methods a dapp may invoke over a WalletConnect session. Mirrors
// what the EIP-1193 provider routes (state reads + permissioned signing). Used to
// build session namespaces and to reject out-of-scope session_request methods.
export const SUPPORTED_METHODS = Object.freeze([
  'eth_chainId',
  'eth_accounts',
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
]);

export const SUPPORTED_EVENTS = Object.freeze(['accountsChanged', 'chainChanged']);

// ---------------------------------------------------------------------------
// JSDoc interface contracts (the "shape" this stub promises and a real adapter
// must honor). These are documentation-only typedefs — no runtime cost.
// ---------------------------------------------------------------------------

/**
 * A WalletConnect v2 session proposal, as delivered by the `session_proposal`
 * event of `@walletconnect/web3wallet`. Only the fields the handler reads are
 * modeled here.
 * @typedef {Object} SessionProposal
 * @property {number|string} id            - proposal id (echoed back on approve/reject)
 * @property {Object} params
 * @property {Object} params.proposer
 * @property {Object} params.proposer.metadata - dapp metadata { name, url, icons, description }
 * @property {Object} params.requiredNamespaces - CAIP namespaces the dapp requires
 * @property {Object} [params.optionalNamespaces]
 */

/**
 * The namespaces object returned when APPROVING a proposal (CAIP-25 shape).
 * @typedef {Object} SessionNamespaces
 * @property {Object} eip155
 * @property {string[]} eip155.chains    - e.g. ["eip155:108369"]
 * @property {string[]} eip155.methods   - subset of SUPPORTED_METHODS
 * @property {string[]} eip155.events    - subset of SUPPORTED_EVENTS
 * @property {string[]} eip155.accounts  - CAIP-10, e.g. ["eip155:108369:0xabc…"]
 */

/**
 * A WalletConnect v2 `session_request` event payload.
 * @typedef {Object} SessionRequest
 * @property {number|string} id
 * @property {string} topic                - the session topic this request belongs to
 * @property {string} chainId              - CAIP-2, e.g. "eip155:108369"
 * @property {Object} params
 * @property {Object} params.request
 * @property {string} params.request.method  - a JSON-RPC method (see SUPPORTED_METHODS)
 * @property {Array<any>} params.request.params
 */

/**
 * The EIP-1193 request shape every transport normalizes into. This is exactly
 * `WalletProvider.request(args)`'s argument from the wallet's EIP-1193 provider module.
 * @typedef {Object} Eip1193Request
 * @property {string} method
 * @property {Array<any>} [params]
 */

/**
 * Minimal EIP-1193 provider surface this adapter routes into. Satisfied by the
 * wallet's `WalletProvider` (its `.request(args)` method) or any object exposing
 * an async `request({ method, params })`.
 * @typedef {Object} Eip1193Provider
 * @property {(args: Eip1193Request) => Promise<any>} request
 */

/**
 * The UI-owned approval hook. Same contract as the EIP-1193 provider's `approve`:
 * receives the request context and returns true to allow. Default-DENY.
 * @callback ApproveHook
 * @param {{ method: string, params: any[], origin: string|null }} ctx
 * @returns {Promise<boolean>}
 */

// ---------------------------------------------------------------------------
// LocalSignerFallback — routes a WalletConnect session_request into the EIP-1193
// provider.request() shape and dispatches it to the injected provider.
//
// "Fallback" because in wallet v1 (no WC relay) this is the ONLY path; in v2 the
// real WC handler will call the very same routeRequest() so the downstream
// pipeline (approval + signing + broadcast) is shared verbatim.
// ---------------------------------------------------------------------------
export class LocalSignerFallback {
  /**
   * @param {Object} opts
   * @param {Eip1193Provider} opts.provider - the wallet's EIP-1193 provider (or compatible)
   * @param {string} [opts.expectedChain]   - CAIP-2 chain we accept (default PRANA)
   */
  constructor({ provider, expectedChain = PRANA_EIP155_CHAIN } = {}) {
    if (!provider || typeof provider.request !== 'function') {
      throw new Error(
        'LocalSignerFallback requires an EIP-1193 provider with a request() method',
      );
    }
    this._provider = provider;
    this._expectedChain = expectedChain;
  }

  /**
   * Normalize a WalletConnect `session_request` into the EIP-1193 `{ method,
   * params }` shape. Pure (no I/O) so it is trivially unit-testable.
   * @param {SessionRequest} sessionRequest
   * @returns {Eip1193Request}
   */
  toEip1193(sessionRequest) {
    if (!sessionRequest || typeof sessionRequest !== 'object') {
      throw new Error('session_request must be an object');
    }
    const { chainId, params } = sessionRequest;
    if (chainId && this._expectedChain && chainId !== this._expectedChain) {
      // Single-chain wallet: reject requests scoped to another chain up front.
      throw new Error(
        `unsupported chain "${chainId}"; this wallet only serves ${this._expectedChain}`,
      );
    }
    const inner = params && params.request;
    if (!inner || typeof inner.method !== 'string' || inner.method.length === 0) {
      throw new Error('session_request.params.request.method is required');
    }
    if (!SUPPORTED_METHODS.includes(inner.method)) {
      throw new Error(`method "${inner.method}" is not supported over this session`);
    }
    return {
      method: inner.method,
      params: Array.isArray(inner.params) ? inner.params : [],
    };
  }

  /**
   * Route a WalletConnect `session_request` all the way through to the EIP-1193
   * provider and return the provider's result (a signed-tx hash, signature, etc.).
   * @param {SessionRequest} sessionRequest
   * @returns {Promise<any>}
   */
  async routeRequest(sessionRequest) {
    const eip1193 = this.toEip1193(sessionRequest);
    return this._provider.request(eip1193);
  }
}

// ---------------------------------------------------------------------------
// WalletConnectSessionHandler — STUB session bookkeeping. Models the v2
// proposal -> approve -> request lifecycle in memory so the UI can be built and
// tested before the real relay lib is wired. NO network, NO crypto.
// ---------------------------------------------------------------------------
export class WalletConnectSessionHandler {
  /**
   * @param {Object} opts
   * @param {Eip1193Provider} opts.provider  - the wallet's EIP-1193 provider
   * @param {() => Promise<string[]>} opts.getAccounts - current authorized accounts (0x…)
   * @param {ApproveHook} [opts.approve]     - UI approval hook; default-DENY
   * @param {string} [opts.chain]            - CAIP-2 chain (default PRANA)
   */
  constructor({ provider, getAccounts, approve, chain = PRANA_EIP155_CHAIN } = {}) {
    if (!provider) throw new Error('WalletConnectSessionHandler requires a provider');
    if (typeof getAccounts !== 'function') {
      throw new Error('WalletConnectSessionHandler requires a getAccounts() function');
    }
    this._chain = chain;
    this._getAccounts = getAccounts;
    this._approve = typeof approve === 'function' ? approve : async () => false;
    this._fallback = new LocalSignerFallback({ provider, expectedChain: chain });
    /** @type {Map<string, { topic: string, namespaces: SessionNamespaces, metadata: any }>} */
    this._sessions = new Map();
    this._topicSeq = 0;
  }

  /**
   * Build the CAIP-25 namespaces we would grant for a proposal. Pure; does not
   * mutate state. The real lib calls this to assemble the approveSession arg.
   * @param {string[]} accounts - authorized 0x addresses
   * @returns {SessionNamespaces}
   */
  buildNamespaces(accounts) {
    return {
      eip155: {
        chains: [this._chain],
        methods: [...SUPPORTED_METHODS],
        events: [...SUPPORTED_EVENTS],
        accounts: accounts.map((a) => `${this._chain}:${a}`),
      },
    };
  }

  /**
   * Handle a `session_proposal`: ask the UI to approve, and on approval record a
   * session and return its namespaces. Default-DENY when no approve hook is set.
   * @param {SessionProposal} proposal
   * @returns {Promise<{ topic: string, namespaces: SessionNamespaces }>}
   */
  async onSessionProposal(proposal) {
    const metadata = proposal?.params?.proposer?.metadata ?? null;
    const allowed = await this._approve({
      method: 'wc_sessionProposal',
      params: [proposal],
      origin: metadata?.url ?? null,
    });
    if (!allowed) {
      const err = new Error('User rejected the session proposal.');
      err.code = 4001; // EIP-1193 user-rejected, mirrored for WC callers
      throw err;
    }
    const accounts = await this._getAccounts();
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('no authorized accounts to approve a session with');
    }
    const namespaces = this.buildNamespaces(accounts);
    const topic = `stub-topic-${++this._topicSeq}`;
    this._sessions.set(topic, { topic, namespaces, metadata });
    return { topic, namespaces };
  }

  /**
   * Handle a `session_request`: verify the session exists, then route the inner
   * JSON-RPC call into the EIP-1193 provider via LocalSignerFallback (which
   * carries the approval+signing). Returns the provider's result.
   * @param {SessionRequest} request
   * @returns {Promise<any>}
   */
  async onSessionRequest(request) {
    const topic = request?.topic;
    if (!topic || !this._sessions.has(topic)) {
      throw new Error(`unknown session topic "${topic}"`);
    }
    return this._fallback.routeRequest(request);
  }

  /** @returns {string[]} active (stub) session topics */
  activeTopics() {
    return [...this._sessions.keys()];
  }

  /** Drop a session (the real lib emits `session_delete`). */
  disconnect(topic) {
    return this._sessions.delete(topic);
  }
}

export default {
  PRANA_EIP155_CHAIN,
  PRANA_CHAIN_ID_DEC,
  SUPPORTED_METHODS,
  SUPPORTED_EVENTS,
  LocalSignerFallback,
  WalletConnectSessionHandler,
};
