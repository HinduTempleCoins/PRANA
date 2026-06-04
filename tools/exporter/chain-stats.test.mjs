// chain-stats.test.mjs — offline tests for the Chains exporter.
//
// Uses the shared FixtureProvider so no network is touched. Verifies the
// canonical envelope, the rolling block-time math, the deliberate null
// totalSupply, and graceful degradation when optional fields are unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcClient, FixtureProvider } from "../adapters/rpc.mjs";
import {
  collectChainStats,
  exportOnce,
  envelope,
  healthNoteFor,
  SOURCE,
  TOTAL_SUPPLY_NOTE,
  DEFAULT_BLOCK_WINDOW,
} from "./chain-stats.mjs";

// Build a fixture where block N has timestamp 1000 + N*12 (12s block time),
// plus a baseFeePerGas on the latest block. Heights 0..100 available.
// `difficultyAt(n)` (optional) supplies a per-block PoW difficulty so the
// difficulty + trend fields can be exercised; omit it to model a chain/fixture
// that does not report difficulty (fields degrade to null).
function makeFixture({
  height = 100,
  blockTimeSec = 12,
  baseFee = "1000000000",
  difficultyAt = null,
} = {}) {
  const blocks = {};
  for (let n = 0; n <= height; n++) {
    const block = {
      number: n,
      timestamp: 1000 + n * blockTimeSec,
      baseFeePerGas: n === height ? baseFee : null,
    };
    if (typeof difficultyAt === "function") {
      const d = difficultyAt(n);
      if (d != null) block.difficulty = BigInt(d);
    }
    blocks[String(n)] = block;
  }
  blocks.latest = blocks[String(height)];
  return { blockNumber: height, blocks };
}

function fixtureClient(opts) {
  const provider = new FixtureProvider(makeFixture(opts));
  return new RpcClient({ provider, chainId: 108369 });
}

test("collectChainStats returns the documented payload shape", async () => {
  const client = fixtureClient();
  const p = await collectChainStats(client, { window: 20 });

  assert.equal(p.chainId, 108369);
  assert.equal(p.name, "PRANA");
  assert.equal(p.height, 100);
  assert.equal(p.baseFee, "1000000000");
  // FixtureProvider has no getFeeData/send → degrades to null, never throws.
  assert.equal(p.gasPrice, null);
  assert.equal(p.peerCount, null);
  // totalSupply is deliberately null with an explanatory note.
  assert.equal(p.totalSupply, null);
  assert.equal(p.totalSupplyNote, TOTAL_SUPPLY_NOTE);
  // No difficulty in the base fixture → degrades to null, never throws.
  assert.equal(p.difficulty, null);
  // pool health block is always present, even when difficulty is unavailable.
  assert.ok(p.pool && typeof p.pool === "object");
  assert.equal(p.pool.difficulty, null);
  assert.equal(p.pool.difficultyTrend, null);
  assert.equal(p.pool.epoch, null); // no epochLength configured
  assert.equal(p.pool.trendWindowBlocks, 20);
  assert.equal(typeof p.pool.healthNote, "string");
});

test("difficulty + rising trend are read as a network-strength signal", async () => {
  // difficulty climbs by 1000 per block → tip > window-back → "rising".
  const provider = new FixtureProvider(
    makeFixture({ height: 100, difficultyAt: (n) => 1_000_000 + n * 1000 }),
  );
  const client = new RpcClient({ provider, chainId: 108369 });
  const p = await collectChainStats(client, { window: 20 });

  assert.equal(p.difficulty, String(1_000_000 + 100 * 1000)); // tip difficulty
  assert.equal(p.pool.difficulty, p.difficulty);
  assert.equal(p.pool.difficultyTrend, "rising");
  assert.match(p.pool.healthNote, /harder and more expensive to attack/);
});

test("falling and flat difficulty trends are detected", async () => {
  const falling = new RpcClient({
    provider: new FixtureProvider(
      makeFixture({ height: 100, difficultyAt: (n) => 10_000_000 - n * 1000 }),
    ),
    chainId: 108369,
  });
  const pf = await collectChainStats(falling, { window: 20 });
  assert.equal(pf.pool.difficultyTrend, "falling");

  const flat = new RpcClient({
    provider: new FixtureProvider(
      makeFixture({ height: 100, difficultyAt: () => 5_000_000 }),
    ),
    chainId: 108369,
  });
  const pflat = await collectChainStats(flat, { window: 20 });
  assert.equal(pflat.pool.difficultyTrend, "flat");
});

test("pool.epoch is derived off-chain from the EpochManager bucket rule", async () => {
  // latest block timestamp = 1000 + 100*12 = 2200; epochLength 600 → floor(2200/600)=3
  const client = fixtureClient({ height: 100, blockTimeSec: 12 });
  const p = await collectChainStats(client, { window: 20, epochLengthSec: 600 });
  assert.equal(p.pool.epoch, Math.floor(2200 / 600));
  assert.equal(p.pool.epochLengthSec, 600);
});

test("healthNoteFor maps every trend to copy", () => {
  assert.match(healthNoteFor("rising"), /committing/);
  assert.match(healthNoteFor("falling"), /attack cost/);
  assert.match(healthNoteFor("flat"), /steady/);
  assert.match(healthNoteFor(null), /unavailable/);
});

test("rolling blockTime averages timestamps over the window", async () => {
  const client = fixtureClient({ height: 100, blockTimeSec: 12 });
  const p = await collectChainStats(client, { window: 20 });
  // (ts[100] - ts[80]) / 20 = (12*20)/20 = 12.0
  assert.equal(p.blockTime, 12);
});

test("blockTime window clamps to available height on a young chain", async () => {
  // height 5, window 20 → span clamps to 5; (15*5? ) avg still equals block time.
  const client = fixtureClient({ height: 5, blockTimeSec: 15 });
  const p = await collectChainStats(client, { window: 20 });
  assert.equal(p.blockTime, 15);
});

test("blockTime is null at genesis height 0", async () => {
  const client = fixtureClient({ height: 0 });
  const p = await collectChainStats(client, { window: 20 });
  assert.equal(p.height, 0);
  assert.equal(p.blockTime, null);
});

test("envelope wraps payload in the canonical contract", async () => {
  const fixedNow = () => new Date("2026-06-03T12:00:00.000Z");
  const payload = { chainId: 108369, name: "PRANA", height: 1 };
  const env = envelope(payload, { chainId: 108369, now: fixedNow });
  assert.deepEqual(Object.keys(env).sort(), ["chainId", "payload", "source", "updatedAt"]);
  assert.equal(env.source, SOURCE);
  assert.equal(env.chainId, 108369);
  assert.equal(env.updatedAt, "2026-06-03T12:00:00.000Z");
  assert.equal(env.payload, payload);
});

test("exportOnce produces a full envelope deterministically", async () => {
  const client = fixtureClient();
  const fixedNow = () => new Date("2026-06-03T12:00:00.000Z");
  const env = await exportOnce(client, { window: 20, now: fixedNow });
  assert.equal(env.source, SOURCE);
  assert.equal(env.chainId, 108369);
  assert.equal(env.updatedAt, "2026-06-03T12:00:00.000Z");
  assert.equal(env.payload.height, 100);
  assert.equal(env.payload.blockTime, 12);
});

test("DEFAULT_BLOCK_WINDOW is a sane positive integer", () => {
  assert.ok(Number.isInteger(DEFAULT_BLOCK_WINDOW) && DEFAULT_BLOCK_WINDOW > 0);
});
