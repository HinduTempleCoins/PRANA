// rpc.test.mjs — offline tests for the RPC adapter (W1) via FixtureProvider.
import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcClient, FixtureProvider, mapEthersError, PRANA_CHAIN_ID } from "./rpc.mjs";
import { AdapterError, RateLimitError, UpstreamError } from "./base.mjs";

const DEV_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TX_HASH = "0xtx0000000000000000000000000000000000000000000000000000000000000a";

async function fixtureClient() {
  const provider = await FixtureProvider.fromFixture("rpc-basic");
  // no-op sleep so the negative-path retry test doesn't wall-clock wait.
  return new RpcClient({ provider, sleep: async () => {} });
}

test("default chainId is PRANA (108369)", () => {
  assert.equal(PRANA_CHAIN_ID, 108369);
});

test("getBlockNumber from fixture", async () => {
  const c = await fixtureClient();
  assert.equal(await c.getBlockNumber(), 1024);
});

test("getBlock latest + by number", async () => {
  const c = await fixtureClient();
  const latest = await c.getBlock("latest");
  assert.equal(latest.number, 1024);
  assert.equal(latest.transactions.length, 1);
  const byNum = await c.getBlock("1024");
  assert.equal(byNum.number, 1024);
});

test("getBalance returns a BigInt (wei), case-insensitive address", async () => {
  const c = await fixtureClient();
  const bal = await c.getBalance(DEV_ADDR.toUpperCase());
  assert.equal(typeof bal, "bigint");
  assert.equal(bal, 10000000000000000000000n);
});

test("getTransaction from fixture", async () => {
  const c = await fixtureClient();
  const tx = await c.getTransaction(TX_HASH);
  assert.equal(tx.value, "1000000000000000000");
  assert.equal(tx.nonce, 0);
});

test("call returns recorded return data", async () => {
  const c = await fixtureClient();
  const out = await c.call({ to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", data: "0x" });
  assert.match(out, /^0x0+1$/);
});

test("sendRawTransaction passthrough returns hash", async () => {
  const c = await fixtureClient();
  const res = await c.sendRawTransaction("0x02f86b827777808459682f00...");
  assert.equal(res.hash, TX_HASH);
});

test("missing fixture data throws UpstreamError", async () => {
  const c = await fixtureClient();
  await assert.rejects(() => c.getBalance("0x0000000000000000000000000000000000000000"), UpstreamError);
});

// ---- retry / error mapping (no real network) ------------------------------
test("RpcClient retries on a server error then succeeds", async () => {
  let calls = 0;
  const flakyProvider = {
    async getBlockNumber() {
      calls++;
      if (calls < 3) {
        const e = new Error("bad gateway");
        e.code = "SERVER_ERROR";
        e.info = { responseStatus: "502 Bad Gateway" };
        throw e;
      }
      return 42;
    },
  };
  const c = new RpcClient({ provider: flakyProvider, maxRetries: 5, sleep: async () => {}, rng: () => 0 });
  assert.equal(await c.getBlockNumber(), 42);
  assert.equal(calls, 3);
});

test("RpcClient does not retry a non-retriable error (revert)", async () => {
  let calls = 0;
  const provider = {
    async call() {
      calls++;
      const e = new Error("execution reverted");
      e.code = "CALL_EXCEPTION";
      throw e;
    },
  };
  const c = new RpcClient({ provider, maxRetries: 3, sleep: async () => {} });
  await assert.rejects(() => c.call({ to: "0x0", data: "0x" }), AdapterError);
  assert.equal(calls, 1);
});

test("mapEthersError taxonomy", () => {
  const rl = mapEthersError({ code: "TOO_MANY_REQUESTS" }, "x");
  assert.ok(rl instanceof RateLimitError);

  const rl2 = mapEthersError({ info: { responseStatus: "429 Too Many Requests" } }, "x");
  assert.ok(rl2 instanceof RateLimitError);

  const up = mapEthersError({ code: "SERVER_ERROR", info: { responseStatus: "503" } }, "x");
  assert.ok(up instanceof UpstreamError);
  assert.equal(up.status, 503);

  const net = mapEthersError({ code: "NETWORK_ERROR" }, "x");
  assert.ok(net instanceof UpstreamError);

  const other = mapEthersError({ code: "INVALID_ARGUMENT", message: "bad" }, "x");
  assert.ok(other instanceof AdapterError);
  assert.ok(!(other instanceof UpstreamError));
});
