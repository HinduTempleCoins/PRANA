// chain-stats.mjs — read-only "Chains" exporter for the PRANA aggregator.
//
// Reads the local PRANA RPC (via the shared adapter layer) and emits the
// single canonical envelope the data aggregator ingests on its Chains pages:
//
//   { source, chainId, updatedAt, payload }
//
// where payload is the chain summary:
//   { chainId, name, height, difficulty, gasPrice, baseFee, peerCount,
//     totalSupply, totalSupplyNote, blockTime, pool }
//
// `difficulty` and the nested `pool` health block frame the live PoW difficulty
// as a trust / strength signal: a rising difficulty means more honest hashpower
// is committed to PRANA, which makes the chain proportionally harder (more
// expensive) to 51%-attack or reorg. This is the "Pool / River" §10 framing —
// difficulty is read as network conviction, not just a mining knob. The `pool`
// block also carries the current compute-stack epoch (derived off-chain from the
// EpochManager epoch-length, which is a pure timestamp/length bucket) and a
// short difficulty trend, so a dashboard can show "committed, hard-to-attack
// network" without any extra indexer.
//
// Nothing here is custodial or write-capable: it only calls read methods on
// the RPC (eth_blockNumber, eth_getBlockByNumber, eth_gasPrice). It reuses
// RpcClient + FixtureProvider from tools/adapters so the live and fixture
// paths share one code path and the test suite runs fully offline.
//
// CLI:
//   node chain-stats.mjs --once                 emit one envelope to stdout
//   node chain-stats.mjs --interval 15000       emit every 15s until killed
//   node chain-stats.mjs --rpc http://host:8545 override the RPC URL
//   node chain-stats.mjs --window 30            blockTime/difficulty-trend window (blocks)
//   node chain-stats.mjs --epoch-length 3600    compute-stack epoch length (seconds)
//
// Exit codes: 0 ok (--once), non-zero on a hard RPC failure in --once mode.

import { RpcClient, PRANA_CHAIN_ID, PRANA_DEFAULT_RPC } from "../adapters/rpc.mjs";

export const SOURCE = "prana-chain-stats";

// How many recent blocks the rolling blockTime average spans by default.
export const DEFAULT_BLOCK_WINDOW = 20;

// ---------------------------------------------------------------------------
// Core collection
// ---------------------------------------------------------------------------

// Pull the gas price via the raw provider `send` when available (ethers
// JsonRpcProvider exposes it; the FixtureProvider may not). We degrade to null
// rather than throw, because gasPrice is informational for the aggregator, not
// load-bearing. Live ethers providers expose getFeeData(); we prefer that.
async function readGasFees(client) {
  const provider = client.provider;
  let gasPrice = null;
  let baseFee = null;

  // ethers JsonRpcProvider path.
  if (typeof provider.getFeeData === "function") {
    try {
      const fd = await provider.getFeeData();
      if (fd) {
        if (fd.gasPrice != null) gasPrice = fd.gasPrice.toString();
        if (fd.maxFeePerGas != null && baseFee == null) {
          // maxFeePerGas is not baseFee, but the latest block's baseFeePerGas
          // is the canonical source — read it below from the block instead.
        }
      }
    } catch {
      // leave gasPrice null
    }
  }
  return { gasPrice, baseFee };
}

// peerCount comes from net_peerCount, which is admin-ish and not part of the
// ethers high-level surface. We try a raw `send`; null if unsupported.
async function readPeerCount(client) {
  const provider = client.provider;
  if (typeof provider.send !== "function") return null;
  try {
    const hex = await provider.send("net_peerCount", []);
    if (hex == null) return null;
    return typeof hex === "number" ? hex : parseInt(String(hex), 16);
  } catch {
    return null;
  }
}

// Rolling average block time over the last `window` blocks, in seconds.
// Computed from block timestamps: (ts[height] - ts[height-window]) / window.
// Returns null if there are too few blocks to form a window.
async function rollingBlockTime(client, height, window) {
  if (height < 1) return null;
  const span = Math.min(window, height);
  if (span < 1) return null;

  const [latest, older] = await Promise.all([
    client.getBlock(height),
    client.getBlock(height - span),
  ]);
  if (!latest || !older) return null;

  const tsLatest = Number(latest.timestamp);
  const tsOlder = Number(older.timestamp);
  if (!Number.isFinite(tsLatest) || !Number.isFinite(tsOlder)) return null;

  const dt = tsLatest - tsOlder;
  if (dt <= 0) return null;
  // Round to 2 decimals — block time is a human-facing stat.
  return Math.round((dt / span) * 100) / 100;
}

// Read a block's PoW difficulty as a decimal string (or null). ethers v6 Block
// exposes `difficulty` (a bigint) on PoW chains; post-Merge PoS blocks report 0
// and the field may be absent on minimal fixtures — degrade to null, never throw.
// On a PoW chain like PRANA this is the canonical "how much work secures the
// tip" number.
function blockDifficulty(block) {
  if (!block) return null;
  const d = block.difficulty;
  if (d == null) return null;
  try {
    return d.toString();
  } catch {
    return null;
  }
}

// Difficulty trend over the rolling window: compare the tip's difficulty to the
// difficulty `span` blocks back. Returns "rising" | "falling" | "flat" | null.
// Framed as a health signal: "rising" = more hashpower committing = a harder,
// safer chain to attack. Pure comparison of two on-chain difficulty values.
async function difficultyTrend(client, height, window) {
  if (height < 1) return null;
  const span = Math.min(window, height);
  if (span < 1) return null;

  const [latest, older] = await Promise.all([
    client.getBlock(height),
    client.getBlock(height - span),
  ]);
  const dNow = blockDifficulty(latest);
  const dOld = blockDifficulty(older);
  if (dNow == null || dOld == null) return null;

  let now, old;
  try {
    now = BigInt(dNow);
    old = BigInt(dOld);
  } catch {
    return null;
  }
  if (now > old) return "rising";
  if (now < old) return "falling";
  return "flat";
}

// Current compute-stack epoch, derived OFF-CHAIN from the latest block timestamp
// and the governed epoch length, using the exact EpochManager bucket rule
// (epoch = floor(timestamp / epochLength)). EpochManager is a pure Solidity
// library (internal-only, no deployed address to call), so there is nothing to
// query over RPC — the canonical formula is reproduced here. Returns null when
// no epochLength is configured or the timestamp is unavailable.
function currentEpoch(latestBlock, epochLengthSec) {
  if (!epochLengthSec || epochLengthSec <= 0) return null;
  if (!latestBlock || latestBlock.timestamp == null) return null;
  const ts = Number(latestBlock.timestamp);
  if (!Number.isFinite(ts) || ts < 0) return null;
  return Math.floor(ts / epochLengthSec);
}

// totalSupply on an EVM chain is NON-TRIVIAL and we deliberately emit null.
//
// Why: native-coin supply is NOT a queryable state variable like an ERC-20's
// totalSupply(). It is the implicit sum of every account's balance across the
// entire state trie. To compute it truthfully you must either:
//   (a) sum balances over every account in state (no RPC enumerates accounts;
//       you would need an archive node + state-trie walk), or
//   (b) reconstruct it from genesis allocation + cumulative block rewards
//       - uncle rewards - burnt baseFee (EIP-1559) - any explicit burns,
//       which requires replaying issuance rules and is chain-config specific.
// A read-only exporter over a standard RPC cannot do either correctly, so we
// emit null plus a machine-readable note rather than a wrong number. A future
// dedicated indexer (issuance accountant) can populate this field.
export const TOTAL_SUPPLY_NOTE =
  "native totalSupply is not RPC-queryable on EVM (sum-of-all-balances across " +
  "the state trie, or genesis+rewards-burns reconstruction); emitted null on " +
  "purpose — populate via a dedicated issuance indexer.";

// Collect the full chain summary. Pure async function over an RpcClient so it
// is trivially testable with a FixtureProvider-backed client.
export async function collectChainStats(
  client,
  { window = DEFAULT_BLOCK_WINDOW, epochLengthSec = null } = {},
) {
  const height = await client.getBlockNumber();
  const latestBlock = await client.getBlock(height);

  const baseFee =
    latestBlock && latestBlock.baseFeePerGas != null
      ? latestBlock.baseFeePerGas.toString()
      : null;

  const difficulty = blockDifficulty(latestBlock); // PoW work at the tip, decimal string | null

  const { gasPrice } = await readGasFees(client);
  const peerCount = await readPeerCount(client);
  const blockTime = await rollingBlockTime(client, height, window);
  const diffTrend = await difficultyTrend(client, height, window);

  // pool health block — frames PoW difficulty as a TRUST / STRENGTH signal:
  // rising difficulty = more honest hashpower committed = harder & costlier to
  // 51%-attack or reorg ("committed, hard-to-attack network"). Read-only: every
  // field is derived from already-fetched block data + the governed epoch length.
  const pool = {
    epoch: currentEpoch(latestBlock, epochLengthSec), // compute-stack epoch, or null if unconfigured
    epochLengthSec: epochLengthSec ?? null, // governed bucket width (seconds), or null
    difficulty, // same value as top-level, surfaced here for the health view
    difficultyTrend: diffTrend, // "rising" | "falling" | "flat" | null
    trendWindowBlocks: window, // how many blocks the trend compares across
    // Human-facing interpretation of the trend as a security signal. Static
    // copy keyed off the trend so a dashboard renders it directly.
    healthNote: healthNoteFor(diffTrend),
  };

  return {
    chainId: client.chainId,
    name: "PRANA",
    height,
    difficulty, // PoW difficulty at the tip, decimal string, or null
    gasPrice, // wei, as decimal string, or null
    baseFee, // wei, as decimal string, or null (pre-1559 / no field)
    peerCount, // integer or null (net_peerCount may be disabled)
    totalSupply: null, // see TOTAL_SUPPLY_NOTE
    totalSupplyNote: TOTAL_SUPPLY_NOTE,
    blockTime, // rolling avg seconds/block over `window`, or null
    pool, // network-strength / trust health block (difficulty + epoch)
  };
}

// Map a difficulty trend to a short, human-facing security interpretation.
// Exported so tests and the aggregator can assert the exact framing.
export function healthNoteFor(trend) {
  switch (trend) {
    case "rising":
      return "rising difficulty — more hashpower is committing; the chain is getting harder and more expensive to attack.";
    case "falling":
      return "falling difficulty — hashpower is easing off; watch for reduced attack cost.";
    case "flat":
      return "stable difficulty — committed hashpower is holding steady.";
    default:
      return "difficulty trend unavailable (too few blocks or field unsupported).";
  }
}

// Wrap a payload in the canonical aggregator envelope.
export function envelope(payload, { source = SOURCE, chainId, now = () => new Date() } = {}) {
  return {
    source,
    chainId: chainId ?? payload.chainId,
    updatedAt: now().toISOString(),
    payload,
  };
}

// One full pass: collect + wrap. `now` injectable for deterministic tests.
export async function exportOnce(
  client,
  { window = DEFAULT_BLOCK_WINDOW, epochLengthSec = null, now } = {},
) {
  const payload = await collectChainStats(client, { window, epochLengthSec });
  return envelope(payload, { chainId: client.chainId, now });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    mode: "once",
    intervalMs: 15000,
    rpc: PRANA_DEFAULT_RPC,
    window: DEFAULT_BLOCK_WINDOW,
    epochLengthSec: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") out.mode = "once";
    else if (a === "--interval") {
      out.mode = "interval";
      const v = argv[++i];
      if (v != null && !v.startsWith("--")) out.intervalMs = parseInt(v, 10);
    } else if (a === "--rpc") out.rpc = argv[++i];
    else if (a === "--window") out.window = parseInt(argv[++i], 10);
    else if (a === "--epoch-length") out.epochLengthSec = parseInt(argv[++i], 10);
  }
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const client = new RpcClient({ rpcUrl: opts.rpc, chainId: PRANA_CHAIN_ID });

  const emit = async () => {
    const env = await exportOnce(client, {
      window: opts.window,
      epochLengthSec: opts.epochLengthSec,
    });
    process.stdout.write(JSON.stringify(env) + "\n");
  };

  if (opts.mode === "once") {
    await emit();
    return;
  }

  // interval mode: emit, then on a timer; tolerate transient RPC blips so a
  // single failed pass does not kill the long-running exporter.
  const tick = async () => {
    try {
      await emit();
    } catch (err) {
      process.stderr.write(
        JSON.stringify({ source: SOURCE, level: "error", error: String(err?.message ?? err) }) + "\n",
      );
    }
  };
  await tick();
  const timer = setInterval(tick, opts.intervalMs);
  // Keep the process alive; clear on SIGINT/SIGTERM for a clean shutdown.
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exit(1);
  });
}
