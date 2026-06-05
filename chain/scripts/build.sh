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

# --- PRANA Hathor Fees Module: consensus-level, un-bypassable block-reward skim. ---
# Drop the module package into the core-geth tree and apply the reward-split patch.
# Idempotent: re-running build.sh is safe (copies overwrite; patch is skipped if applied).
# Full rationale + the genesis-config plumbing steps: chain/patches/INTEGRATION.md.
HF_PKG="$SRC/params/hathorfees"
if [ ! -d "$HF_PKG" ]; then
  echo "==> Installing Hathor Fees Module into core-geth (params/hathorfees) ..."
  mkdir -p "$HF_PKG"
  cp "$ROOT/hathorfees/"*.go "$HF_PKG/"
fi
if ! grep -q "Hathor Fees Module" "$SRC/params/mutations/rewards.go" 2>/dev/null; then
  echo "==> Applying Hathor fee reward-split patch ..."
  git -C "$SRC" apply "$ROOT/patches/0001-hathor-fees-consensus.patch"
fi
echo "==> NOTE: genesis-config plumbing (GetHathorFee accessor) is documented in"
echo "    chain/patches/INTEGRATION.md steps 3-4 and must be applied for the fee to read"
echo "    its parameters from genesis. Without it the module stays inert (no fee taken)."
# ---------------------------------------------------------------------------------

echo "==> Building geth (PRANA node) ..."
cd "$SRC"
# core-geth's go.mod targets Go 1.21; a much newer Go fails to build it, so pin a
# known-good toolchain (Go auto-downloads it). Override with GOTOOLCHAIN env if needed.
GOTOOLCHAIN="${GOTOOLCHAIN:-go1.22.12}" make geth
echo "==> Done. Binary: $SRC/build/bin/geth"
