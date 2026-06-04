#!/usr/bin/env bash
# dev-stack.sh — one-shot bring-up of the full PRANA dev stack (backlog E3 / N2):
#   1. init the chain datadir from genesis if missing
#   2. start the PoW node (mining) in the background
#   3. wait for the RPC to answer
#   4. deploy the DeFi core (records contracts/deployments.json)
#   5. run the post-deploy smoke test
#   6. print a status summary
#
# Usage:  chain/scripts/dev-stack.sh            # full bring-up
#         STOP=1 chain/scripts/dev-stack.sh     # stop the node started by this script
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHAIN="$ROOT/chain"
GETH="$CHAIN/core-geth/build/bin/geth"   # `prana` symlink points here too
DATADIR="$CHAIN/data"
RPC="http://127.0.0.1:8545"
PIDFILE="/tmp/prana-dev-stack.pid"

if [ "${STOP:-0}" = "1" ]; then
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null && echo "node stopped" || echo "node was not running"
    rm -f "$PIDFILE"
  else
    echo "no pidfile — nothing to stop"
  fi
  exit 0
fi

# 1. init if needed
if [ ! -d "$DATADIR/geth/chaindata" ]; then
  echo "==> initializing datadir from genesis"
  "$CHAIN/scripts/init.sh"
fi

# 2. start the miner unless the RPC is already up
if curl -sf -m 2 -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" >/dev/null 2>&1; then
  echo "==> RPC already answering — reusing the running node"
else
  echo "==> starting the PRANA miner (log: /tmp/prana-node.log)"
  nohup "$CHAIN/scripts/run-miner.sh" >/tmp/prana-node.log 2>&1 &
  echo $! > "$PIDFILE"
fi

# 3. wait for RPC (DAG generation can take ~3 min on first run)
echo -n "==> waiting for RPC"
for i in $(seq 1 120); do
  if curl -sf -m 2 -X POST -H 'Content-Type: application/json' \
       --data '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" >/dev/null 2>&1; then
    echo " — up"; break
  fi
  echo -n "."; sleep 3
  [ "$i" = "120" ] && { echo " TIMEOUT — check /tmp/prana-node.log"; exit 1; }
done

# 4. deploy the core
echo "==> deploying DeFi core to $RPC"
( cd "$ROOT/contracts" && npx hardhat run scripts/deploy-core.js --network localprana )

# 5. smoke test
echo "==> smoke test"
( cd "$ROOT/contracts" && npx hardhat run scripts/smoke.js --network localprana ) || \
  echo "WARN: smoke test failed — inspect manually"

# 6. status
echo "==> status"
"$CHAIN/scripts/status.sh" || true
echo "DONE. RPC: $RPC  chainId: 108369 (0x1a751)"
