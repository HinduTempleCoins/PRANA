#!/usr/bin/env bash
# deploy-defi-core.sh — one-shot wrapper that brings the local PRANA chain up and
# confirms the DeFi core got deployed (backlog N2).
#
# This is a THIN wrapper. It does NOT re-implement bring-up: the heavy lifting
# (init datadir -> start miner -> wait for RPC -> deploy-core.js -> smoke) lives
# in chain/scripts/dev-stack.sh, which we simply invoke. This script's only added
# value is:
#   1. running dev-stack.sh from anywhere (path-independent),
#   2. verifying afterwards that contracts/deployments.json was actually written
#      and is non-empty, via scripts/lib/deployments.js,
#   3. printing a clear pass/fail summary and exiting non-zero if the deploy
#      didn't land.
#
# Idempotent: dev-stack.sh reuses an already-running node and re-deploys onto it;
# re-running this script just refreshes deployments.json. Safe to run repeatedly.
#
# Usage:
#   contracts/scripts/deploy-defi-core.sh          # full bring-up + verify
#   STOP=1 contracts/scripts/deploy-defi-core.sh   # stop the node dev-stack started
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$CONTRACTS/.." && pwd)"
DEV_STACK="$ROOT/chain/scripts/dev-stack.sh"
DEPLOYMENTS="$CONTRACTS/deployments.json"

if [ ! -x "$DEV_STACK" ]; then
  echo "✗ cannot find chain/scripts/dev-stack.sh at $DEV_STACK" >&2
  exit 1
fi

# Pass STOP=1 straight through to dev-stack (tear down and exit).
if [ "${STOP:-0}" = "1" ]; then
  STOP=1 "$DEV_STACK"
  exit $?
fi

echo "==> deploy-defi-core: delegating bring-up to chain/scripts/dev-stack.sh"
echo ""
# dev-stack.sh does: init (if needed) -> miner -> wait RPC -> deploy-core.js -> smoke -> status.
"$DEV_STACK"

echo ""
echo "==> deploy-defi-core: verifying deployments.json was written"

# Verify via the canonical loader (scripts/lib/deployments.js) rather than
# re-parsing the file by hand, so this stays in sync with how the rest of the
# tooling reads deployments. deploy-core.js writes a flat manifest
# ({ network, chainId, contracts: { name: address } }); the loader's loadRegistry
# returns whatever is on disk, so we tolerate both that flat shape and the
# per-chainId registry shape and just assert there is >=1 contract address.
node - "$DEPLOYMENTS" <<'NODE'
const path = require("path");
const file = process.argv[2];
const { loadRegistry } = require(path.join(process.cwd(), "scripts", "lib", "deployments.js"));

let reg;
try {
  reg = loadRegistry(file);
} catch (e) {
  console.error(`✗ could not load deployments.json: ${e.message}`);
  process.exit(1);
}

if (!reg || typeof reg !== "object" || Object.keys(reg).length === 0) {
  console.error("✗ deployments.json is empty — deploy did not record anything.");
  process.exit(1);
}

// Collect contract addresses from either shape.
const addrs = [];
const collect = (contracts) => {
  if (!contracts || typeof contracts !== "object") return;
  for (const [name, val] of Object.entries(contracts)) {
    const addr = typeof val === "string" ? val : val && val.address;
    if (typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr)) addrs.push(`${name}=${addr}`);
  }
};

if (reg.contracts) {
  // flat manifest from deploy-core.js
  collect(reg.contracts);
} else {
  // per-chainId registry from lib/deployments.js record()
  for (const slice of Object.values(reg)) collect(slice && slice.contracts);
}

if (addrs.length === 0) {
  console.error("✗ deployments.json has no usable contract addresses.");
  process.exit(1);
}

console.log(`✓ deployments.json OK — ${addrs.length} contract(s) recorded:`);
for (const a of addrs) console.log(`    ${a}`);
NODE

echo ""
echo "==> deploy-defi-core: DONE. Next, run the smoke verifier:"
echo "    ( cd contracts && npx hardhat run scripts/verify-deployment.js --network localprana )"
