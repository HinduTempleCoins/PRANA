#!/usr/bin/env node
/**
 * export-abis.js — extract just the ABI array from each Hardhat artifact.
 *
 * Reads  contracts/artifacts/contracts/**\/*.json  (the compiled artifacts),
 * skips the *.dbg.json debug companions and any zero-ABI artifacts (interfaces,
 * abstract/library-only files), and writes each contract's ABI to
 * contracts/abis/<ContractName>.json as a bare ABI array.
 *
 * Generic and public-safe: no addresses, keys, or network data — only ABIs that
 * are already implied by the public source. Run after `npx hardhat compile`.
 *
 * Coverage: the walk is a recursive glob over `artifacts/contracts/**`, so EVERY
 * real contract subtree is exported automatically — including the compute-stack
 * contracts under `contracts/compute/` (UnifiedSharesLedger, the Hash/Task lane
 * creditors, TaskVerificationGate, the BurnStake family, the fee mechanism, the
 * Regent governance pair, the Task/dispatch registries, CoordinatorRegistry,
 * JobClaimLedger, …). No per-contract allowlist is needed: anything that compiles
 * to a non-empty ABI lands in `abis/`. The one deliberate exception is
 * `EpochManager`, a pure `library` whose functions are all `internal` — it
 * compiles to an EMPTY ABI (it is inlined at the call site, never called over
 * RPC) and is therefore correctly skipped by the empty-ABI filter below. The
 * front-end consumes these files via `akasha/lib/contract-registry.mjs`
 * (`loadRegistry({ abisDir: contracts/abis, ... })`).
 *
 * Below we additionally cross-check the export against a list of EXPECTED
 * compute-stack contract names and warn (non-fatally) if any are missing, so a
 * stale-artifact run is caught instead of silently shipping an incomplete set.
 *
 * Usage:  node scripts/export-abis.js
 */

const fs = require("fs");
const path = require("path");

// Resolve paths relative to the Hardhat project root (this file lives in scripts/).
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts", "contracts");
const OUT_DIR = path.join(ROOT, "abis");

// Exclude test-only artifact subdirectories — mocks and the echidna fuzz harness are
// test scaffolding, not part of the public deployable ABI surface. (We still walk the
// real subdirs: amm/, games/, diamond/, aa/, lib/, interfaces/.)
const EXCLUDED_DIRS = new Set(["mocks", "echidna"]);

// Compute-stack contracts that the wallet/front-end (and the chain-stats /
// pool exporters) expect to find an ABI for. This is a SELF-CHECK only — the
// export itself is glob-driven and needs no allowlist — but listing the
// expected names lets us warn loudly if a compute ABI fails to land (e.g. a
// stale `artifacts/` dir, a contract that did not compile). EpochManager is
// intentionally NOT here: it is a pure `library` with only `internal`
// functions, so it compiles to an empty ABI and is correctly never exported.
const EXPECTED_COMPUTE_CONTRACTS = [
  "UnifiedSharesLedger",
  "HashLaneCreditor",
  "TaskLaneCreditor",
  "TaskVerificationGate",
  "HashTaskWeightConfig",
  "BurnStakeRegistry",
  "BurnStakeGovernanceAdapter",
  "MultiCurrencyBurnRouter",
  "BurnStakePriceSource",
  "SettlementFeeHook",
  "CountercyclicalFeeOracle",
  "HathorFeeTreasury",
  "VerifiedMachineCounter",
  "RegentGovernance",
  "RegentVotesAdapter",
  "TaskRegistry",
  "TaskDispatchPolicy",
  "CoordinatorRegistry",
  "JobClaimLedger",
  // EpochManager: intentionally omitted — pure library, empty ABI (see above).
];

/** Recursively collect every *.json artifact under a directory. */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test-only artifact dirs (mocks/, echidna/) anywhere in the tree.
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    console.error(
      `No artifacts found at ${ARTIFACTS_DIR}. Run \`npx hardhat compile\` first.`
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = walk(ARTIFACTS_DIR);
  let exported = 0;
  let skipped = 0;
  const exportedNames = new Set();

  for (const file of files) {
    // Skip Hardhat debug companions.
    if (file.endsWith(".dbg.json")) {
      continue;
    }

    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`  skip (unparseable): ${path.relative(ROOT, file)}`);
      skipped++;
      continue;
    }

    // Only treat it as a contract artifact if it has the expected shape.
    if (!artifact || !Array.isArray(artifact.abi) || !artifact.contractName) {
      continue;
    }

    // Skip artifacts with empty ABIs (pure interfaces with no entries, libs, etc).
    if (artifact.abi.length === 0) {
      skipped++;
      continue;
    }

    const outPath = path.join(OUT_DIR, `${artifact.contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact.abi, null, 2) + "\n");
    exportedNames.add(artifact.contractName);
    exported++;
  }

  console.log(
    `Exported ${exported} ABIs to ${path.relative(ROOT, OUT_DIR)}/` +
      (skipped ? ` (${skipped} skipped: empty/unparseable)` : "")
  );

  // Self-check: warn (non-fatally) if any expected compute-stack ABI is absent.
  // The export is glob-driven, so a miss here means stale artifacts or a build
  // failure upstream — surface it rather than silently shipping a partial set.
  const missingCompute = EXPECTED_COMPUTE_CONTRACTS.filter(
    (name) => !exportedNames.has(name)
  );
  if (missingCompute.length) {
    console.warn(
      `  WARNING: ${missingCompute.length} expected compute-stack ABI(s) not ` +
        `exported — recompile (\`npx hardhat compile\`) and re-run: ` +
        missingCompute.join(", ")
    );
  } else {
    console.log(
      `  compute-stack: all ${EXPECTED_COMPUTE_CONTRACTS.length} expected ABIs present.`
    );
  }
}

main();
