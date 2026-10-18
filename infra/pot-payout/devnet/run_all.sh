D=/root/prana-payout/devnet
until [ "$(curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8611 | python3 -c 'import json,sys;print(int(json.load(sys.stdin)["result"],16))')" -ge 2 ]; do sleep 3; done
cd $D && /root/prana-payout/venv/bin/python deploy.py > logs/deploy.out 2>&1
/root/prana-payout/venv/bin/python -u e2e.py > logs/e2e.transcript 2>&1
