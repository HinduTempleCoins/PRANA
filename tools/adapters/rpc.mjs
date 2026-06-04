// rpc.mjs — RPC client adapter for the PRANA L1 node (W1).
//
// Thin, typed wrapper over ethers v6 JsonRpcProvider, pointed at the PRANA
// local RPC by default. Every public method routes through the base layer's
// retry + typed-error handling so callers get consistent failure semantics.
//
// Two provider modes:
//   - live: a real ethers JsonRpcProvider against an HTTP RPC endpoint.
//   - fixture: FixtureProvider, which answers the minimal provider surface
//     from recorded JSON — no network, used by the test suite.

import { ethers } from "ethers";
import { AdapterError, UpstreamError, RateLimitError, backoffDelay, defaultSleep, loadFixture } from "./base.mjs";

// PRANA chain defaults (see repo CLAUDE.md / genesis).
export const PRANA_DEFAULT_RPC = "http://127.0.0.1:8545";
export const PRANA_CHAIN_ID = 108369; // 0x1a751

// --------------------------------------------------------------------------
// FixtureProvider — minimal provider surface backed by recorded JSON.
// --------------------------------------------------------------------------
//
// Implements only the methods RpcClient calls. Backing data shape:
//   {
//     "blockNumber": 1234,
//     "blocks": { "1234": {..ethers block-ish..}, "latest": {...} },
//     "balances": { "0xabc...": "1000000000000000000" },
//     "transactions": { "0xhash...": {...} },
//     "calls": { "<to>:<data>": "0x..." },
//     "sendRawTransaction": { "<rawtx>": "0xhash..." }
//   }
//
// Keys are matched case-insensitively for addresses/hashes. Missing data
// throws UpstreamError (mirrors loadFixture's "fail loud" contract).
export class FixtureProvider {
  constructor(data = {}) {
    this.data = data;
  }

  static async fromFixture(name) {
    const data = await loadFixture(name);
    return new FixtureProvider(data);
  }

  _norm(k) {
    return String(k).toLowerCase();
  }

  async getBlockNumber() {
    if (typeof this.data.blockNumber !== "number") {
      throw new UpstreamError("fixture missing blockNumber");
    }
    return this.data.blockNumber;
  }

  async getBlock(tag) {
    const blocks = this.data.blocks || {};
    const key = String(tag);
    const block = blocks[key] ?? blocks[this._norm(key)];
    if (block === undefined) {
      throw new UpstreamError(`fixture missing block: ${key}`);
    }
    return block;
  }

  async getBalance(address) {
    const balances = this.data.balances || {};
    const v = balances[address] ?? balances[this._norm(address)];
    if (v === undefined) {
      throw new UpstreamError(`fixture missing balance: ${address}`);
    }
    return BigInt(v);
  }

  async getTransaction(hash) {
    const txs = this.data.transactions || {};
    const tx = txs[hash] ?? txs[this._norm(hash)];
    if (tx === undefined) {
      throw new UpstreamError(`fixture missing transaction: ${hash}`);
    }
    return tx;
  }

  async call(tx) {
    const calls = this.data.calls || {};
    const key = `${this._norm(tx.to || "")}:${this._norm(tx.data || "0x")}`;
    const v = calls[key];
    if (v === undefined) {
      throw new UpstreamError(`fixture missing call: ${key}`);
    }
    return v;
  }

  // ethers v6 calls this `broadcastTransaction`; we also expose a raw send.
  async _rawSend(rawTx) {
    const sends = this.data.sendRawTransaction || {};
    const v = sends[rawTx] ?? sends[this._norm(rawTx)];
    if (v === undefined) {
      throw new UpstreamError(`fixture missing sendRawTransaction for raw tx`);
    }
    return v;
  }

  async broadcastTransaction(rawTx) {
    const hash = await this._rawSend(rawTx);
    // Mimic ethers' return shape minimally.
    return { hash, raw: rawTx };
  }
}

// --------------------------------------------------------------------------
// RpcClient
// --------------------------------------------------------------------------

export class RpcClient {
  // Either pass `provider` (a live JsonRpcProvider or a FixtureProvider) or
  // let the constructor build a JsonRpcProvider from `rpcUrl`/`chainId`.
  constructor({
    rpcUrl = PRANA_DEFAULT_RPC,
    chainId = PRANA_CHAIN_ID,
    provider = null,
    maxRetries = 3,
    backoff = {},
    sleep = defaultSleep,
    rng = Math.random,
  } = {}) {
    this.chainId = chainId;
    this.rpcUrl = rpcUrl;
    this.maxRetries = maxRetries;
    this.backoff = backoff;
    this._sleep = sleep;
    this._rng = rng;

    if (provider) {
      this.provider = provider;
    } else {
      // `staticNetwork` avoids an extra eth_chainId round-trip per call and
      // pins the provider to PRANA's network.
      const network = ethers.Network.from({ chainId, name: "prana" });
      this.provider = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
    }
  }

  // Wrap a provider call with retry + typed-error mapping. ethers throws its
  // own error objects; we normalise transient ones into our taxonomy so the
  // base retry policy and downstream callers behave consistently.
  async _withRetry(fn, label) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const mapped = mapEthersError(err, label);
        lastErr = mapped;
        const retriable =
          mapped instanceof RateLimitError ||
          (mapped instanceof UpstreamError && (mapped.status == null || mapped.status >= 500));
        if (!retriable || attempt === this.maxRetries) throw mapped;
        let delay;
        if (mapped instanceof RateLimitError && mapped.retryAfterMs != null) {
          delay = mapped.retryAfterMs;
        } else {
          delay = backoffDelay(attempt, { ...this.backoff, rng: this._rng });
        }
        await this._sleep(delay);
      }
    }
    throw lastErr;
  }

  getBlockNumber() {
    return this._withRetry(() => this.provider.getBlockNumber(), "getBlockNumber");
  }

  // tag: number | "latest" | "pending" | block hash
  getBlock(tag = "latest") {
    return this._withRetry(() => this.provider.getBlock(tag), "getBlock");
  }

  // Returns balance as a BigInt (wei).
  getBalance(address, blockTag) {
    return this._withRetry(
      () =>
        blockTag === undefined
          ? this.provider.getBalance(address)
          : this.provider.getBalance(address, blockTag),
      "getBalance",
    );
  }

  getTransaction(hash) {
    return this._withRetry(() => this.provider.getTransaction(hash), "getTransaction");
  }

  // Read-only eth_call. `tx` is an ethers TransactionRequest ({ to, data, ... }).
  call(tx) {
    return this._withRetry(() => this.provider.call(tx), "call");
  }

  // eth_sendRawTransaction passthrough. ethers v6 names it broadcastTransaction;
  // we accept the raw signed-tx hex and return the provider's result (a
  // TransactionResponse for live providers, { hash, raw } for the fixture one).
  sendRawTransaction(rawTx) {
    return this._withRetry(() => this.provider.broadcastTransaction(rawTx), "sendRawTransaction");
  }
}

// Map an ethers/network error into our typed taxonomy. ethers v6 surfaces a
// `code` and sometimes a `.info.responseStatus`; we use those to detect rate
// limits and server errors. Anything unrecognised becomes a non-retriable
// AdapterError.
export function mapEthersError(err, label) {
  if (err instanceof AdapterError) return err;

  const code = err?.code;
  const status =
    err?.info?.responseStatus != null
      ? parseInt(String(err.info.responseStatus), 10)
      : err?.status ?? null;

  if (status === 429 || code === "TOO_MANY_REQUESTS") {
    return new RateLimitError(`rpc rate limited during ${label}`, { cause: err, status: 429 });
  }
  if ((status != null && status >= 500) || code === "SERVER_ERROR" || code === "NETWORK_ERROR" || code === "TIMEOUT") {
    return new UpstreamError(`rpc upstream error during ${label}`, {
      cause: err,
      status: Number.isFinite(status) ? status : null,
      details: { code },
    });
  }
  // Things like reverted calls / bad params are not retriable.
  return new AdapterError(`rpc call ${label} failed: ${err?.message ?? err}`, {
    cause: err,
    details: { code, status },
  });
}
