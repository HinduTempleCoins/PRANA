#!/bin/bash
# stop + wipe the isolated payout devnet (only processes started from /root/prana-payout)
D=/root/prana-payout/devnet
pkill -f "/root/prana-payout/devnet/e2e.py" ; pkill -f "e2e.py"
for f in miner1loop miner1 pool redis geth geth2; do [ -f $D/$f.pid ] && kill $(cat $D/$f.pid) 2>/dev/null; done
pkill -f "devminer -pool 127.0.0.1:8018"; pkill -f "fleetq.py --db $D"; pkill -f "http.server 86[34]"
pkill -f "fleet_worker.py --queue http://127.0.0.1:8621"
sleep 3; rm -rf $D/dd $D/dd2 $D/pub $D/pub-evil $D/state $D/sigs $D/sigs-evil-test $D/fleetq.sqlite $D/logs $D/*.pid
echo down
