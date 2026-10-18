#!/bin/bash
# Bring up the isolated payout devnet. Every port is localhost-only and distinct from live services.
set -u
D=/root/prana-payout/devnet; B=/root/prana-payout/bin; PY=/root/prana-payout/venv/bin/python
GETH=/root/prana-fork/out/geth-pot
mkdir -p $D/logs
cd /root/prana-payout/contracts && export PATH=/root/.foundry/bin:$PATH
# devnet-only contract variant: identical except MIN_CHALLENGE (1 hour -> 60 s) so rounds fit a test run
mkdir -p src/devnet && sed -e 's/uint64 public constant MIN_CHALLENGE = 1 hours;/uint64 public constant MIN_CHALLENGE = 60 seconds; \/\/ DEVNET ONLY/' \
  -e 's/contract PotDistributor is/contract PotDistributorDevnet is/' src/PotDistributor.sol > src/devnet/PotDistributorDevnet.sol
diff src/PotDistributor.sol src/devnet/PotDistributorDevnet.sol
forge build >/dev/null 2>&1 && echo "forge build ok"
cd $D && $PY setup.py
rm -rf $D/dd && $GETH --datadir $D/dd init $D/genesis.json 2>&1 | grep -E "Successfully wrote genesis|rror"
nohup nice -n 15 $GETH --datadir $D/dd --networkid 7122188 --nodiscover --maxpeers 5 --port 30511 --authrpc.port 8612 \
  --http --http.addr 127.0.0.1 --http.port 8611 --http.api eth,net,web3,txpool,miner,admin --ipcdisable \
  --mine --miner.threads -1 --miner.etherbase 0x1111111111111111111111111111111111111111 \
  --gcmode archive --verbosity 3 > $D/logs/geth.log 2>&1 &
echo $! > $D/geth.pid
nohup redis-server --port 6395 --bind 127.0.0.1 --save "" --appendonly no --dir $D > $D/logs/redis.log 2>&1 &
echo $! > $D/redis.pid
sleep 4
# OUTSIDE miner: an independent node that seals blocks with ITS OWN coinbase (not via the pool)
OUT=$(python3 -c "import json;print(json.load(open('$D/addresses.json'))['outsider']['address'])")
rm -rf $D/dd2 && $GETH --datadir $D/dd2 init $D/genesis.json >/dev/null 2>&1
nohup nice -n 19 $GETH --datadir $D/dd2 --networkid 7122188 --nodiscover --maxpeers 5 --port 30513 --authrpc.port 8614 \
  --http --http.addr 127.0.0.1 --http.port 8613 --http.api eth,net,web3,admin,miner --ipcdisable \
  --mine --miner.threads 1 --miner.etherbase $OUT --ethash.dagdir $D/dag2 --verbosity 2 > $D/logs/geth-outsider.log 2>&1 &
echo $! > $D/geth2.pid; sleep 4
EN=$(curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"admin_nodeInfo","params":[]}' http://127.0.0.1:8611 | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['enode'].split('?')[0])")
curl -s -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"admin_addPeer\",\"params\":[\"$EN\"]}" http://127.0.0.1:8613; echo " outsider peered (coinbase $OUT)"
nohup nice -n 10 $B/oep-pot $D/pool.json > $D/logs/pool.log 2>&1 &
echo $! > $D/pool.pid
sleep 3; tail -3 $D/logs/geth.log; tail -5 $D/logs/pool.log
ps -o pid,pcpu,rss,cmd -p $(cat $D/geth.pid) | cut -c1-120
