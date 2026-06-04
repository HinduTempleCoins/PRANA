#!/usr/bin/env bash
# Quick one-glance health of the local PRANA node (reads the JSON-RPC endpoint).
# Deliberately NOT 'set -e' — a status check should report, never crash.
RPC="${RPC:-http://127.0.0.1:8545}"
DEV_ACCT="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # publicly-known dev account

rpc() { curl -s -X POST -H "Content-Type: application/json" \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":${2:-[]},\"id\":1}" "$RPC" 2>/dev/null; }
hex() { echo "$1" | grep -oE '0x[0-9a-fA-F]+' | head -1; }
dec() { local h; h=$(hex "$1"); [ -n "$h" ] && printf '%d' "$h" 2>/dev/null || echo "?"; }

echo "PRANA node @ $RPC"
ver=$(rpc web3_clientVersion | grep -oE '"result":"[^"]*"' | cut -d'"' -f4)
if [ -z "$ver" ]; then echo "  ✗ no response — is the node running? (chain/scripts/run-miner.sh)"; exit 1; fi
cid=$(rpc eth_chainId)
echo "  client      : ${ver:-?}"
echo "  chainId     : $(hex "$cid")  ($(dec "$cid"))"
echo "  blockNumber : $(dec "$(rpc eth_blockNumber)")"
echo "  mining      : $(rpc eth_mining | grep -oE 'true|false' | head -1)"
echo "  hashrate    : $(dec "$(rpc eth_hashrate)") H/s"
echo "  peers       : $(dec "$(rpc net_peerCount)")"
echo "  gasPrice    : $(dec "$(rpc eth_gasPrice)") wei"
bal=$(rpc eth_getBalance "[\"$DEV_ACCT\",\"latest\"]")
echo "  dev balance : $(dec "$bal") wei  ($DEV_ACCT)"
