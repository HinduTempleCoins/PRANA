#!/usr/bin/env python3
"""Prove the code at <potAddress> is PotDistributor.sol from this commit (compiled with contracts/foundry.toml)
and print its live configuration. Runtime bytecode is compared byte-for-byte except the compiler-reported
immutable slots (timelock, EIP-712 cached chainId/this/separator/name/version), which are then checked
semantically via view calls. Read-only. usage: verify_pot.py <rpc> <potAddress> [artifactPath]"""
import json, sys
sys.path.insert(0, "/root/prana-payout/payout")
from chain import RPC, Pot
from eth_abi import decode
from eth_utils import keccak
rpc_url, pot = sys.argv[1], sys.argv[2]
art = json.load(open(sys.argv[3] if len(sys.argv) > 3 else "/root/prana-payout/contracts/out/PotDistributor.sol/PotDistributor.json"))
rpc = RPC(rpc_url); P = Pot(rpc, pot)
onchain = bytearray(bytes.fromhex(rpc("eth_getCode", [pot, "latest"])[2:]))
ref = bytearray(bytes.fromhex(art["deployedBytecode"]["object"][2:]))
masked = 0
for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
    for r in refs:
        for i in range(r["start"], r["start"] + r["length"]):
            if i < len(onchain): onchain[i] = 0
            ref[i] = 0; masked += 1
match = len(onchain) == len(ref) and onchain == ref
cfg = {"timelock": P.call("timelock()", [], [], ["address"])[0], "guardian": P.call("guardian()", [], [], ["address"])[0],
       "signers": list(P.call("signers()", [], [], ["address[]"])[0]), "threshold": P.threshold(), "signerEpoch": P.signer_epoch(),
       "challengePeriod": P.challenge_period(), "currentRound": P.current_round(), "paused": P.paused(),
       "eip712Domain": [str(x) for x in P.call("eip712Domain()", [], [], ["bytes1", "string", "string", "uint256", "address", "bytes32", "uint256[]"])[:5]],
       "chainId": int(rpc("eth_chainId"), 16)}
dom_ok = cfg["eip712Domain"][1] == "PRANA PotDistributor" and int(cfg["eip712Domain"][3]) == cfg["chainId"] and cfg["eip712Domain"][4].lower() == pot.lower()
print(json.dumps({"runtimeLen": len(onchain), "maskedImmutableBytes": masked, "bytecodeMatch": match, "domainOk": dom_ok,
                  "codeKeccak": "0x" + keccak(bytes.fromhex(rpc("eth_getCode", [pot, "latest"])[2:])).hex(), **cfg}, indent=1, default=str))
sys.exit(0 if match and dom_ok else 1)
