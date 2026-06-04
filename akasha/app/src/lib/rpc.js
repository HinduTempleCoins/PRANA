// rpc.js — minimal JSON-RPC-over-fetch client for the Akasha explorer + wallet.
//
// Deliberately tiny and dependency-free (plain fetch). The explorer view uses
// this directly; the wallet's txbuilder takes a provider object exposing
// `send(method, params)`, which this client also satisfies (see asProvider()).
//
// Connection-refused handling: when there's no live node the fetch rejects; we
// translate that into a typed RpcError({ kind: 'network' }) so the UI can show a
// graceful "node unreachable" banner instead of crashing.

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8545';

export class RpcError extends Error {
  constructor(message, { kind = 'rpc', code, data } = {}) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind; // 'network' | 'rpc' | 'http'
    this.code = code;
    this.data = data;
  }
}

let _id = 0;

export function makeRpc(url = DEFAULT_RPC_URL) {
  async function call(method, params = []) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
      });
    } catch (err) {
      // fetch rejects on connection refused / DNS / CORS network failure.
      throw new RpcError(`cannot reach node at ${url}`, { kind: 'network' });
    }
    if (!res.ok) {
      throw new RpcError(`node returned HTTP ${res.status}`, { kind: 'http', code: res.status });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RpcError('node returned a non-JSON response', { kind: 'http' });
    }
    if (body.error) {
      throw new RpcError(body.error.message ?? 'RPC error', {
        kind: 'rpc',
        code: body.error.code,
        data: body.error.data,
      });
    }
    return body.result;
  }

  return {
    url,
    call,
    // Adapter so txbuilder.mjs (which wants provider.send) can use this client.
    asProvider() {
      return { send: (method, params) => call(method, params) };
    },
  };
}

export function isNetworkError(err) {
  return err instanceof RpcError && err.kind === 'network';
}
