#!/usr/bin/env bash
# Initialize a fresh PRANA datadir from the genesis block.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GETH="$ROOT/core-geth/build/bin/geth"
GENESIS="$ROOT/genesis/prana.genesis.json"
DATADIR="$ROOT/data"

[ -x "$GETH" ] || { echo "geth not built. Run scripts/build.sh first."; exit 1; }

echo "==> Initializing PRANA datadir at $DATADIR"
"$GETH" --datadir "$DATADIR" init "$GENESIS"
echo "==> Initialized. Next: scripts/run-miner.sh"
