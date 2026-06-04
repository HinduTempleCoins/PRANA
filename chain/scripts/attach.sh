#!/usr/bin/env bash
# Attach an interactive JS console to a running PRANA node.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GETH="$ROOT/core-geth/build/bin/geth"
DATADIR="$ROOT/data"
exec "$GETH" attach "$DATADIR/geth.ipc"
