// provider-1193.mjs — EIP-1193 provider shim for the Akasha in-app dapp-browser.
//
// The wallet UI injects an instance of `WalletProvider` as `window.ethereum`
// into the embedded dapp browser. Dapps call `provider.request({method, params})`
// exactly as they would against MetaMask. We route:
//   - state reads (eth_chainId, eth_accounts)         → answered locally
//   - permissioned actions (eth_requestAccounts,
//     eth_sendTransaction, *_sign*)                   → an injected SignerBackend
//                                                        + an approval hook owned
//                                                        by the UI (default-deny)
//   - everything else (eth_getBalance, eth_call, …)   → passed through to an
//                                                        upstream ethers provider
//
// This module is deliberately decoupled from the keyvault: it accepts a
// `SignerBackend` by injection. The backend exposes the few signing primitives
// we need and is free to wrap an ethers Wallet/Signer however it likes.
//
// Spec references:
//   EIP-1193  (request/response + events + error codes)
//   EIP-3326  (wallet_switchEthereumChain, 4902)
//   EIP-1474  (JSON-RPC error code conventions)

import { getAddress } from 'ethers';

// PRANA local chain — single-chain wallet for now.
export const PRANA_CHAIN_ID_HEX = '0x1a751'; // 108369
export const PRANA_CHAIN_ID_DEC = 108369;

// ---------------------------------------------------------------------------
// EIP-1193 provider errors (with the standard `.code` field dapps switch on).
// ---------------------------------------------------------------------------
export class ProviderRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// Canonical EIP-1193 / EIP-1474 codes we emit.
export const ERROR_CODES = {
  USER_REJECTED: 4001, // EIP-1193: user rejected the request
  UNAUTHORIZED: 4100, // requested method/account not authorized
  UNSUPPORTED_METHOD: 4200, // provider does not support the method
  DISCONNECTED: 4900,
  CHAIN_DISCONNECTED: 4901,
  CHAIN_NOT_ADDED: 4902, // EIP-3326: chain has not been added to the wallet
  INVALID_PARAMS: -32602, // EIP-1474
  INTERNAL: -32603,
};

export function userRejected(msg = 'User rejected the request.') {
  return new ProviderRpcError(ERROR_CODES.USER_REJECTED, msg);
}
export function unsupportedMethod(method) {
  return new ProviderRpcError(
    ERROR_CODES.UNSUPPORTED_METHOD,
    `The provider does not support the method "${method}".`,
  );
}
export function chainNotAdded(chainIdHex) {
  return new ProviderRpcError(
    ERROR_CODES.CHAIN_NOT_ADDED,
    `Unrecognized chain ID "${chainIdHex}". Try adding the chain first.`,
  );
}

// ---------------------------------------------------------------------------
// Tiny EIP-1193 event emitter (on/removeListener/emit). We avoid Node's
// EventEmitter so this runs unchanged in a browser bundle.
// ---------------------------------------------------------------------------
class TinyEmitter {
  constructor() {
    this._listeners = new Map(); // event -> Set<fn>
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }
  addListener(event, fn) {
    return this.on(event, fn);
  }
  once(event, fn) {
    const wrap = (...args) => {
      this.removeListener(event, wrap);
      fn(...args);
    };
    return this.on(event, wrap);
  }
  removeListener(event, fn) {
    this._listeners.get(event)?.delete(fn);
    return this;
  }
  off(event, fn) {
    return this.removeListener(event, fn);
  }
  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch {
        // A buggy dapp listener must not break provider state transitions.
      }
    }
    return true;
  }
  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }
}

// ---------------------------------------------------------------------------
// WalletProvider
// ---------------------------------------------------------------------------
//
// Required injected dependencies:
//   upstream: an ethers-style provider exposing async `send(method, params)`
//             (ethers v6 JsonRpcProvider has exactly this) OR a `request`
//             method. Used for read passthrough + broadcasting raw txs.
//   signer:   a SignerBackend (see MockSignerBackend in the tests for the
//             contract). Must expose:
//               getAccounts(): Promise<string[]>
//               signTransaction(txParams): Promise<string>  // raw 0x tx
//               personalSign(message, address): Promise<string>
//               signTypedDataV4(address, typedDataJsonOrObj): Promise<string>
//   approve:  async (req) => boolean  — the UI-owned permission hook. Receives
//             { method, params, origin }. Returns true to allow. Default-DENY.
//
export class WalletProvider extends TinyEmitter {
  constructor({
    upstream,
    signer,
    approve,
    chainIdHex = PRANA_CHAIN_ID_HEX,
    origin = null,
  } = {}) {
    super();
    if (!upstream) throw new Error('WalletProvider requires an upstream provider');
    if (!signer) throw new Error('WalletProvider requires a SignerBackend');

    this.isAkasha = true; // brand flag dapps can sniff (mirrors isMetaMask)
    this._upstream = upstream;
    this._signer = signer;
    // Default-deny: with no approval hook injected, every permissioned action
    // is rejected. The UI MUST supply one to enable connect/sign/send.
    this._approve = typeof approve === 'function' ? approve : async () => false;
    this._chainIdHex = chainIdHex;
    this._origin = origin;

    // Connection state. Accounts stay empty until a dapp is granted permission
    // via eth_requestAccounts; eth_accounts reflects currently-authorized ones.
    this._authorizedAccounts = [];
    this._connected = false;
  }

  // -- public state helpers (not part of EIP-1193 but handy for the UI) ------
  get chainId() {
    return this._chainIdHex;
  }
  get selectedAddress() {
    return this._authorizedAccounts[0] ?? null;
  }

  // Announce initial connection. EIP-1193 `connect` carries { chainId }.
  _emitConnect() {
    if (!this._connected) {
      this._connected = true;
      this.emit('connect', { chainId: this._chainIdHex });
    }
  }

  _setAccounts(accounts) {
    const next = accounts.map((a) => getAddress(a));
    const changed =
      next.length !== this._authorizedAccounts.length ||
      next.some((a, i) => a !== this._authorizedAccounts[i]);
    this._authorizedAccounts = next;
    if (changed) this.emit('accountsChanged', [...next]);
  }

  // -- the one entry point dapps use -----------------------------------------
  async request(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        'request() expects a single { method, params } object.',
      );
    }
    const { method, params } = args;
    if (typeof method !== 'string' || method.length === 0) {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        '"method" must be a non-empty string.',
      );
    }

    switch (method) {
      case 'eth_chainId':
        return this._chainIdHex;

      case 'net_version':
        return String(parseInt(this._chainIdHex, 16));

      case 'eth_accounts':
        // Never triggers a prompt; returns only already-authorized accounts.
        return [...this._authorizedAccounts];

      case 'eth_requestAccounts':
      case 'wallet_requestPermissions':
        return this._handleRequestAccounts(method, params);

      case 'eth_sendTransaction':
        return this._handleSendTransaction(params);

      case 'personal_sign':
        return this._handlePersonalSign(params);

      case 'eth_signTypedData_v4':
        return this._handleSignTypedDataV4(params);

      case 'wallet_switchEthereumChain':
        return this._handleSwitchChain(params);

      // Methods we intentionally route nowhere yet (see open questions).
      case 'eth_sign': // legacy unsafe raw sign — refuse on purpose
        throw new ProviderRpcError(
          ERROR_CODES.UNSUPPORTED_METHOD,
          'eth_sign is disabled in Akasha; use personal_sign or eth_signTypedData_v4.',
        );

      default:
        return this._passthrough(method, params);
    }
  }

  // -- permissioned: connect -------------------------------------------------
  async _handleRequestAccounts(method, params) {
    // If already authorized, EIP-1193 says return current accounts w/o prompt.
    if (this._authorizedAccounts.length > 0) {
      this._emitConnect();
      return [...this._authorizedAccounts];
    }
    const allowed = await this._approve({
      method,
      params,
      origin: this._origin,
    });
    if (!allowed) throw userRejected('User rejected the connection request.');

    const accounts = await this._signer.getAccounts();
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new ProviderRpcError(
        ERROR_CODES.INTERNAL,
        'SignerBackend returned no accounts.',
      );
    }
    this._emitConnect();
    this._setAccounts(accounts);
    return [...this._authorizedAccounts];
  }

  // -- permissioned: send a transaction --------------------------------------
  async _handleSendTransaction(params) {
    const tx = Array.isArray(params) ? params[0] : params;
    if (!tx || typeof tx !== 'object') {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        'eth_sendTransaction expects a transaction object.',
      );
    }
    this._assertAuthorizedFrom(tx.from);

    const allowed = await this._approve({
      method: 'eth_sendTransaction',
      params: [tx],
      origin: this._origin,
    });
    if (!allowed) throw userRejected('User rejected the transaction.');

    // Backend signs → we broadcast the raw tx upstream and return the hash,
    // exactly as a node would for eth_sendTransaction.
    const rawTx = await this._signer.signTransaction(tx);
    return this._passthrough('eth_sendRawTransaction', [rawTx]);
  }

  // -- permissioned: personal_sign -------------------------------------------
  // EIP-1193 / MetaMask param order: [message, address].
  async _handlePersonalSign(params) {
    if (!Array.isArray(params) || params.length < 2) {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        'personal_sign expects [message, address].',
      );
    }
    const [message, address] = params;
    this._assertAuthorizedFrom(address);

    const allowed = await this._approve({
      method: 'personal_sign',
      params,
      origin: this._origin,
    });
    if (!allowed) throw userRejected('User rejected message signing.');

    return this._signer.personalSign(message, getAddress(address));
  }

  // -- permissioned: eth_signTypedData_v4 ------------------------------------
  // MetaMask param order: [address, typedDataJSON].
  async _handleSignTypedDataV4(params) {
    if (!Array.isArray(params) || params.length < 2) {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        'eth_signTypedData_v4 expects [address, typedData].',
      );
    }
    const [address, typedData] = params;
    this._assertAuthorizedFrom(address);

    const allowed = await this._approve({
      method: 'eth_signTypedData_v4',
      params,
      origin: this._origin,
    });
    if (!allowed) throw userRejected('User rejected typed-data signing.');

    return this._signer.signTypedDataV4(getAddress(address), typedData);
  }

  // -- wallet_switchEthereumChain (single-chain) -----------------------------
  async _handleSwitchChain(params) {
    const target = Array.isArray(params) ? params[0] : params;
    const targetId = target?.chainId;
    if (typeof targetId !== 'string') {
      throw new ProviderRpcError(
        ERROR_CODES.INVALID_PARAMS,
        'wallet_switchEthereumChain expects [{ chainId }].',
      );
    }
    // Normalize for comparison (accept 0x1A751 / 0x1a751).
    if (targetId.toLowerCase() === this._chainIdHex.toLowerCase()) {
      // Already on PRANA — succeed. (Per EIP-3326 a successful switch returns null.)
      return null;
    }
    // Single-chain wallet: any other chain is "not added".
    throw chainNotAdded(targetId);
  }

  // -- read passthrough ------------------------------------------------------
  async _passthrough(method, params) {
    const p = params ?? [];
    if (typeof this._upstream.send === 'function') {
      // ethers v6 JsonRpcProvider.send(method, params)
      return this._upstream.send(method, Array.isArray(p) ? p : [p]);
    }
    if (typeof this._upstream.request === 'function') {
      return this._upstream.request({ method, params: p });
    }
    throw new ProviderRpcError(
      ERROR_CODES.INTERNAL,
      'Upstream provider exposes neither send() nor request().',
    );
  }

  // -- guards ----------------------------------------------------------------
  _assertAuthorizedFrom(from) {
    if (this._authorizedAccounts.length === 0) {
      throw new ProviderRpcError(
        ERROR_CODES.UNAUTHORIZED,
        'No authorized account. Call eth_requestAccounts first.',
      );
    }
    if (from == null) return; // some flows omit `from`; backend picks default
    let normalized;
    try {
      normalized = getAddress(from);
    } catch {
      throw new ProviderRpcError(ERROR_CODES.INVALID_PARAMS, `Invalid "from" address: ${from}`);
    }
    if (!this._authorizedAccounts.includes(normalized)) {
      throw new ProviderRpcError(
        ERROR_CODES.UNAUTHORIZED,
        `Account ${normalized} is not authorized for this dapp.`,
      );
    }
  }

  // -- UI-facing programmatic controls (not dapp-callable) -------------------
  // The wallet UI calls these to push state changes that EIP-1193 surfaces as
  // events to the connected dapp.
  setAuthorizedAccounts(accounts) {
    this._setAccounts(accounts);
  }
  disconnectDapp() {
    this._setAccounts([]); // emits accountsChanged([]) — dapp sees logout
  }
}

export default WalletProvider;
