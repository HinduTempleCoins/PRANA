/**
 * verify-deployment.js — post-deploy smoke verifier (backlog N3).
 *
 * Reads contracts/deployments.json via scripts/lib/deployments.js and, for every
 * recorded contract:
 *   1. eth_getCode(address) — must be non-empty ("0x" / "0x0" = dead address).
 *   2. ONE cheap view call chosen from a small probe registry keyed by contract
 *      type (name()/symbol() for tokens, paused() for pausables, etc.). The probe
 *      is read-only (eth_call) and spends no gas.
 *
 * Exits NON-ZERO if any recorded address has no code or fails its probe, so it can
 * gate CI / a deploy pipeline. Unknown contract names still get the code check plus
 * a generic ERC-165-ish / fallback probe, so a new contract never silently passes
 * without at least a liveness check.
 *
 * This complements scripts/smoke.js: smoke.js is a richer multi-call table; this is
 * the tight pass/fail gate built on the canonical deployments loader.
 *
 * Usage (DO NOT run during the contracts-writing phase — other agents are compiling):
 *   npx hardhat run scripts/verify-deployment.js --network localprana
 */

const { ethers, network } = require("hardhat");
const { loadRegistry, DEFAULT_FILE } = require("./lib/deployments.js");

// ---------------------------------------------------------------------------
// Probe registry: contract name -> a single cheap view call.
//
// Each probe is { sig, label } where `sig` is a human-readable function
// signature we encode as a minimal ABI fragment. We attach a one-function
// Contract to the address and call it. The selector is derived by ethers from
// the signature, so this doubles as the "probe selector" registry the task asks
// for, without hand-maintaining 4-byte hex.
// ---------------------------------------------------------------------------
const TOKEN_NAME = { sig: "function name() view returns (string)", label: "name()" };
const TOKEN_SYMBOL = { sig: "function symbol() view returns (string)", label: "symbol()" };
const PAUSED = { sig: "function paused() view returns (bool)", label: "paused()" };
const OWNER = { sig: "function owner() view returns (address)", label: "owner()" };
const TOTAL_SUPPLY = {
  sig: "function totalSupply() view returns (uint256)",
  label: "totalSupply()",
};
const DECIMALS = { sig: "function decimals() view returns (uint8)", label: "decimals()" };

// One probe per known contract *type*. Tokens -> symbol(); NFTs -> name();
// vaults/markets -> a defining getter; access/role contracts -> a role getter.
const PROBES = {
  // --- fungible tokens (ERC-20 family) ---
  PoLToken: TOKEN_SYMBOL,
  ERC20Base: TOKEN_SYMBOL,
  DemoToken: TOKEN_SYMBOL,
  UtilityToken: TOKEN_SYMBOL,
  GovernanceToken: TOKEN_SYMBOL,
  MineableERC20: TOKEN_SYMBOL,
  MockERC20: TOKEN_SYMBOL,
  BurnInput: TOKEN_SYMBOL,
  BondingCurveToken: TOKEN_SYMBOL,
  EquityDividendToken: TOKEN_SYMBOL,
  WrappedNative: TOKEN_SYMBOL,

  // --- NFTs / multi-token ---
  PranaNFT: TOKEN_NAME,
  RoyaltyNFT: TOKEN_NAME,
  CreatureNFT: TOKEN_NAME,
  ERC1155Base: { sig: "function uri(uint256) view returns (string)", label: "uri(0)", args: [0] },
  SeasonPass: TOKEN_NAME,
  SubscriptionLockNFT: TOKEN_NAME,

  // --- vaults / markets / DeFi ---
  ERC4626Vault: { sig: "function asset() view returns (address)", label: "asset()" },
  CDPVault: TOTAL_SUPPLY, // falls back to generic if absent
  PeggedSwapPool: { sig: "function getReserves() view returns (uint256,uint256)", label: "getReserves()" },
  DividendDistributor: {
    sig: "function rewardToken() view returns (address)",
    label: "rewardToken()",
  },
  BurnMine: { sig: "function ratioNum() view returns (uint256)", label: "ratioNum()" },

  // --- governance / ve ---
  VoteEscrow: { sig: "function maxLock() view returns (uint256)", label: "maxLock()" },
  GaugeController: {
    sig: "function votingEscrow() view returns (address)",
    label: "votingEscrow()",
  },
  GovernorDAO: { sig: "function votingDelay() view returns (uint256)", label: "votingDelay()" },

  // --- oracles / misc ---
  SimplePriceOracle: { sig: "function owner() view returns (address)", label: "owner()" },
  TWAPOracle: { sig: "function owner() view returns (address)", label: "owner()" },
};

// Ordered list of generic probes to try for unknown contracts (first that
// succeeds wins). Keeps the verifier from hard-failing on a contract it has no
// specific recipe for, while still proving the code is callable.
const GENERIC_PROBES = [TOKEN_SYMBOL, TOKEN_NAME, OWNER, PAUSED, TOTAL_SUPPLY, DECIMALS];

// ---------------------------------------------------------------------------
// Flatten whatever shape deployments.json has into [{name, address, record}].
// Accepts:
//   { network, chainId, contracts: { name: "0x.." | {address} } }  (deploy-core.js)
//   { "<chainId>": { contracts: { name: {address} } }, ... }       (lib/deployments.js)
// ---------------------------------------------------------------------------
function flatten(reg) {
  const out = [];
  const collect = (contracts) => {
    if (!contracts || typeof contracts !== "object") return;
    for (const [name, val] of Object.entries(contracts)) {
      const address = typeof val === "string" ? val : val && val.address;
      if (typeof address === "string" && ethers.isAddress(address)) {
        out.push({ name, address });
      }
    }
  };
  if (reg && reg.contracts) {
    collect(reg.contracts); // flat manifest
  } else if (reg && typeof reg === "object") {
    for (const slice of Object.values(reg)) collect(slice && slice.contracts); // per-chain registry
  }
  return out;
}

async function hasCode(provider, address) {
  const code = await provider.getCode(address);
  return typeof code === "string" && code !== "0x" && code !== "0x0" && code.length > 2;
}

async function runProbe(address, probe, signerOrProvider) {
  const c = new ethers.Contract(address, [probe.sig], signerOrProvider);
  const fnName = probe.label.replace(/\(.*/, "");
  const args = probe.args ?? [];
  const result = await c[fnName](...args);
  return String(result);
}

async function main() {
  const file = process.env.DEPLOYMENTS_FILE || DEFAULT_FILE;
  let reg;
  try {
    reg = loadRegistry(file);
  } catch (e) {
    console.error(`verify-deployment: cannot load ${file}: ${e.message}`);
    process.exit(1);
  }

  const entries = flatten(reg);
  if (entries.length === 0) {
    console.error(
      `verify-deployment: no usable contract addresses in ${file}. ` +
        "Run scripts/deploy-core.js (or deploy-defi-core.sh) first."
    );
    process.exit(1);
  }

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  console.log(`verify-deployment: network ${network.name} (chainId ${Number(net.chainId)})`);
  console.log(`verify-deployment: checking ${entries.length} contract(s) from ${file}`);
  console.log("");

  let failures = 0;
  for (const { name, address } of entries) {
    // 1) code presence
    let live;
    try {
      live = await hasCode(provider, address);
    } catch (e) {
      console.log(`  ✗ ${name.padEnd(22)} ${address}  eth_getCode error: ${e.message}`);
      failures++;
      continue;
    }
    if (!live) {
      console.log(`  ✗ ${name.padEnd(22)} ${address}  NO CODE (dead address)`);
      failures++;
      continue;
    }

    // 2) one view-call probe
    const known = PROBES[name];
    const candidates = known ? [known, ...GENERIC_PROBES] : GENERIC_PROBES;
    let probed = false;
    let lastErr = null;
    for (const probe of candidates) {
      try {
        const value = await runProbe(address, probe, provider);
        console.log(`  ✓ ${name.padEnd(22)} ${address}  ${probe.label} -> ${value}`);
        probed = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!probed) {
      // Code exists but no probe call succeeded. Treat as a soft pass for the
      // liveness check but a hard fail overall only if a KNOWN type's probe
      // failed (an unknown contract with no matching getter is not a defect).
      if (known) {
        console.log(
          `  ✗ ${name.padEnd(22)} ${address}  has code but probe ${known.label} failed: ${lastErr?.message ?? "unknown"}`
        );
        failures++;
      } else {
        console.log(
          `  ~ ${name.padEnd(22)} ${address}  has code; no generic probe matched (OK — unknown type)`
        );
      }
    }
  }

  console.log("");
  if (failures > 0) {
    console.error(`verify-deployment: FAIL — ${failures} contract(s) dead or unprobeable.`);
    process.exit(1);
  }
  console.log(`verify-deployment: OK — all ${entries.length} contract(s) live and responsive.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
