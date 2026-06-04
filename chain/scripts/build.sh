#!/usr/bin/env bash
# Build the PRANA node (forked from core-geth, Ethash PoW).
# Re-clones core-geth if the source is missing (e.g. fresh checkout).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/core-geth"

if [ ! -d "$SRC" ]; then
  echo "==> core-geth source missing; cloning..."
  git clone --depth 1 https://github.com/etclabscore/core-geth.git "$SRC"
fi

echo "==> Building geth (PRANA node) ..."
cd "$SRC"
# core-geth's go.mod targets Go 1.21; a much newer Go fails to build it, so pin a
# known-good toolchain (Go auto-downloads it). Override with GOTOOLCHAIN env if needed.
GOTOOLCHAIN="${GOTOOLCHAIN:-go1.22.12}" make geth
echo "==> Done. Binary: $SRC/build/bin/geth"
