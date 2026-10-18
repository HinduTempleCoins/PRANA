#!/usr/bin/env bash
# Rebuild the PRANA mainnet node exactly as it runs live (chain 712217, CoreGeth 1.12.23-unstable,
# PRANA commit cb5dceae + pot2 switch). Source = upstream core-geth at the pinned commit below,
# overlaid with chain/core-geth-fork/ (the 13 PRANA-modified files). The same change set is in
# chain/patches/0002-prana-live-cb5dceae-pot2.patch for review or `git apply`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SRC:-$ROOT/core-geth-live}"
UPSTREAM_COMMIT=c4784df34eeaae08f5f0d61a01e41d6dcaf6d72c   # etclabscore/core-geth, release/v1.12.22 merge (2026-03-27)

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/etclabscore/core-geth.git "$SRC"
fi
git -C "$SRC" checkout -q "$UPSTREAM_COMMIT"
cp -r "$ROOT/core-geth-fork/." "$SRC/"
cd "$SRC"
GOTOOLCHAIN="${GOTOOLCHAIN:-go1.22.12}" make geth
echo "==> Done. Binary: $SRC/build/bin/geth"
