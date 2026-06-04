// config.mjs — load + validate the coordinator's runtime config.
//
// Spec: design/compute/coordinator.md §1-§3 + §6 (bound contract surfaces). A coordinator
// is an OFF-CHAIN service that holds two NARROW on-chain authorities and nothing more:
//   - CREDITOR_ROLE on HashLaneCreditor  (credit normalized hash batches)
//   - CREDITOR_ROLE on TaskLaneCreditor  (+ CONFIG_ROLE on a TaskVerificationGate)
// It NEVER holds a token-moving role; the chain pays workers directly on claim(). See §0.
//
// PR8 (multi-coin): PRANA is the home chain, but the same coordinator code can point at any
// Ethash-family EVM coin's RPC + that coin's deployed ledger/creditor/registry. We list the
// SUPPORTED_COINS and pick one with PRANA_COIN. Everything downstream reads `cfg.coin`.
//
// REAL vs STUB: the SHAPE of the config (fields the service obeys) is real. The default
// signer key is the publicly-known Anvil/Hardhat dev account #0 — DEV ONLY, never a real key.

/** Publicly-known Anvil/Hardhat dev account #0 private key — DEV ONLY placeholder. */
const DEV_SIGNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEV_SIGNER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * The Ethash-family EVM coins this coordinator binary understands (PR8).
 * Each entry is a TEMPLATE: chainId + default RPC + the on-chain wiring slots a deployment
 * fills in. Addresses are zero by default (a real deployment supplies them via env). The
 * point of the registry is that switching coins is config, not code.
 *
 * NOTE: PRANA is the canonical home chain (its UnifiedSharesLedger is THE pool). The other
 * coins are listed so a community coordinator can mine an Ethash sibling and settle to that
 * coin's own ledger deployment — there is still exactly one ledger PER chain (§0).
 */
export const SUPPORTED_COINS = Object.freeze({
  prana: {
    key: 'prana',
    name: 'PRANA',
    symbol: 'PRANA',
    chainId: 108369, // 0x1a751 — the home chain (CLAUDE.md: 108 + 369)
    defaultRpc: 'http://127.0.0.1:8545',
    family: 'ethash',
  },
  etc: {
    key: 'etc',
    name: 'Ethereum Classic',
    symbol: 'ETC',
    chainId: 61,
    defaultRpc: 'https://etc.rpc.example/', // placeholder; operator supplies real RPC
    family: 'etchash', // ECIP-1099 doubled-epoch Etchash (see PR4/PR5 note)
  },
  ethw: {
    key: 'ethw',
    name: 'EthereumPoW',
    symbol: 'ETHW',
    chainId: 10001,
    defaultRpc: 'https://ethw.rpc.example/',
    family: 'ethash',
  },
});

/**
 * Build a frozen config object from an env-like map (defaults to process.env).
 * Pure: pass a custom `env` in tests instead of mutating process.env.
 * @param {Record<string,string|undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const coinKey = (env.PRANA_COIN || 'prana').toLowerCase();
  const coin = SUPPORTED_COINS[coinKey];
  if (!coin) {
    throw new Error(
      `config: PRANA_COIN="${coinKey}" not supported; one of [${Object.keys(SUPPORTED_COINS).join(', ')}]`,
    );
  }

  const cfg = {
    // --- which coin we're coordinating (PR8) ---
    coin, // frozen template from SUPPORTED_COINS

    // --- RPC (read epoch/state; send settle tx in prod) ---
    rpcUrl: env.PRANA_RPC_URL || coin.defaultRpc,

    // --- this coordinator's on-chain identity / signer ---
    // holds CREDITOR_ROLE only; never a fund-moving role (coordinator.md §1).
    signerKey: env.PRANA_SIGNER_KEY || DEV_SIGNER_PK,
    signerAddr: env.PRANA_SIGNER_ADDR || DEV_SIGNER_ADDR,
    // stable id mixed into batchId = keccak(coordinatorId, epoch, seq) (coordinator.md §3.1).
    coordinatorId: env.PRANA_COORDINATOR_ID || 'prana-coord-dev',

    // --- bound contract addresses (coordinator.md §6) ---
    // zero address = "not wired" → settle.mjs builds the tx shape but cannot send.
    ledgerAddr: env.PRANA_LEDGER_ADDR || ZERO,
    hashCreditorAddr: env.PRANA_HASH_CREDITOR_ADDR || ZERO,
    taskCreditorAddr: env.PRANA_TASK_CREDITOR_ADDR || ZERO,
    gateAddr: env.PRANA_GATE_ADDR || ZERO, // TaskVerificationGate (openClaim CONFIG_ROLE)
    registryAddr: env.PRANA_COORD_REGISTRY_ADDR || ZERO, // CoordinatorRegistry (bond/allowlist)
    jobLedgerAddr: env.PRANA_JOB_LEDGER_ADDR || ZERO, // JobClaimLedger (cross-coord dedup)

    // --- epoch math (must match the on-chain ledger's epochLength: epoch = ts / len) ---
    epochLengthSeconds: num(env.PRANA_EPOCH_LENGTH_SECONDS, 3600), // 1h default bucket

    // --- HTTP server ---
    host: env.PRANA_COORDINATOR_HOST || '127.0.0.1',
    // 8645 is the worker's default coordinator port (pool-worker config.mjs).
    port: num(env.PRANA_COORDINATOR_PORT, 8645),

    // --- vardiff / share difficulty surfaced to workers (PR9) ---
    // the per-connection target the coordinator advertises; workers tune toward it.
    shareDifficulty: num(env.PRANA_SHARE_DIFFICULTY, 1000),

    // --- task K-of-N attestation shape (coordinator.md §3.2; TaskVerificationGate) ---
    attestK: num(env.PRANA_ATTEST_K, 2),
    attestN: num(env.PRANA_ATTEST_N, 3),

    // --- epoch tick cadence (all timers .unref()'d so node:test can exit) ---
    epochTickMs: num(env.PRANA_EPOCH_TICK_MS, 5000),
  };

  validate(cfg);
  return Object.freeze(cfg);
}

const ZERO = '0x0000000000000000000000000000000000000000';

function validate(cfg) {
  if (!/^https?:\/\//.test(cfg.rpcUrl)) {
    throw new Error(`config: rpcUrl must be http(s) URL, got "${cfg.rpcUrl}"`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.signerAddr)) {
    throw new Error(`config: signerAddr must be a 20-byte hex address, got "${cfg.signerAddr}"`);
  }
  if (cfg.epochLengthSeconds <= 0) throw new Error('config: epochLengthSeconds must be > 0');
  if (cfg.port <= 0 || cfg.port > 65535) throw new Error(`config: port out of range: ${cfg.port}`);
  if (cfg.attestK <= 0 || cfg.attestK > cfg.attestN) {
    throw new Error(`config: require 0 < attestK <= attestN, got K=${cfg.attestK} N=${cfg.attestN}`);
  }
}

function num(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: expected a number, got "${v}"`);
  return n;
}
