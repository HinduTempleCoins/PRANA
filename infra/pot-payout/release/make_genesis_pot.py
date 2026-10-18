#!/usr/bin/env python3
"""Build the release genesis/chain-config for the pot hardfork with potAddress = the PotDistributor.
Reads the fork agent's verified base files READ-ONLY (/root/prana-fork/release/ACTIVE.json + stored_cfg.json,
i.e. the config actually stored on the 3 mainnet nodes) and writes into THIS workspace.
usage: make_genesis_pot.py <F> <potDistributorAddress>"""
import json, os, sys
from eth_utils import to_checksum_address
F = int(sys.argv[1]); pot = to_checksum_address(sys.argv[2])
assert pot.lower() != "0xbd749b16e83d0c81fbce8fc72005e81f3b3180ff", "0xBD74 is Hathor's treasury wallet, NOT the pot (operator decision 2026-10-17)"
src = "/root/prana-fork/release"; d = os.path.dirname(os.path.abspath(__file__))
g = json.load(open(f"{src}/ACTIVE.json")); g["config"] = json.load(open(f"{src}/stored_cfg.json"))
g["config"]["hathorFee"]["potAddress"] = pot
g["config"]["hathorFee"]["potActivationBlock"] = F
out = f"{d}/genesis-pot-F{F}-{pot[2:10].lower()}.json"; json.dump(g, open(out, "w"), indent=1)
print(json.dumps({"out": out, "hathorFee": g["config"]["hathorFee"], "ecip1099FBlock": g["config"].get("ecip1099FBlock")}, indent=1))
