#!/usr/bin/env python3
"""Mainnet PotDistributor address = CREATE(deployer, nonce). Use a FRESH deployer EOA (nonce 0) that is used
for nothing else, so the address is known before deployment and cannot be consumed by an unrelated tx.
usage: predict_pot_address.py <deployerAddress> [nonce=0] [--rpc URL]   (with --rpc, also checks the live nonce)"""
import json, sys, urllib.request
import rlp
from eth_utils import keccak, to_checksum_address
dep = to_checksum_address(sys.argv[1]); nonce = int(sys.argv[2]) if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else 0
addr = to_checksum_address(keccak(rlp.encode([bytes.fromhex(dep[2:]), nonce]))[12:])
out = {"deployer": dep, "nonce": nonce, "potAddress": addr}
if "--rpc" in sys.argv:
    url = sys.argv[sys.argv.index("--rpc") + 1]
    def rpc(m, p):
        r = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), {"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(r).read())["result"]
    out["liveNonce"] = int(rpc("eth_getTransactionCount", [dep, "latest"]), 16)
    out["codeAtAddress"] = rpc("eth_getCode", [addr, "latest"]) != "0x"
    out["balanceAtAddress"] = int(rpc("eth_getBalance", [addr, "latest"]), 16)
    out["ok"] = out["liveNonce"] == nonce and not out["codeAtAddress"]
print(json.dumps(out, indent=1))
