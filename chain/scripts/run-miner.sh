#!/usr/bin/env bash
# Run a single-node PRANA dev network with Ethash PoW mining enabled.
# Mined block rewards go to a freshly-created etherbase account (auto-created
# on first run, password-less, DEV ONLY). The JSON-RPC endpoint is opened so
# MetaMask / Hardhat / Foundry can connect.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GETH="$ROOT/core-geth/build/bin/geth"
DATADIR="$ROOT/data"
CHAINID=108369

[ -x "$GETH" ] || { echo "geth not built. Run scripts/build.sh first."; exit 1; }
[ -d "$DATADIR/geth" ] || { echo "datadir not initialized. Run scripts/init.sh first."; exit 1; }

# Create a miner/etherbase account if none exists (empty password, DEV ONLY).
if [ -z "$(ls -A "$DATADIR/keystore" 2>/dev/null || true)" ]; then
  echo "==> Creating dev etherbase account (empty password) ..."
  printf '' > /tmp/prana-empty-pass
  "$GETH" --datadir "$DATADIR" account new --password /tmp/prana-empty-pass
fi
# Derive the etherbase from the keystore filename (UTC--...--<40-hex-address>),
# which is format-stable across geth versions.
KSFILE="$(ls "$DATADIR/keystore" | head -1)"
ETHERBASE="0x${KSFILE##*--}"
echo "==> Etherbase (mining rewards): $ETHERBASE"

exec "$GETH" \
  --datadir "$DATADIR" \
  --networkid "$CHAINID" \
  --nodiscover \
  --mine --miner.threads 1 --miner.etherbase "$ETHERBASE" \
  --http --http.addr 127.0.0.1 --http.port 8545 \
  --http.api eth,net,web3,personal,txpool,miner,debug \
  --http.corsdomain '*' \
  --ws --ws.addr 127.0.0.1 --ws.port 8546 --ws.api eth,net,web3 \
  --allow-insecure-unlock \
  --verbosity 3
