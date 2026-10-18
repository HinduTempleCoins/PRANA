"""Recipient PULL claim: fetch the published proof for my address from the active round and claim (I pay gas)."""
import json, sys, urllib.request
sys.path.insert(0, "/root/prana-payout/payout")
from chain import RPC, Pot, encode_call, load_key, send_tx
rpc_url, pub, keyfile, pot_addr, cid = sys.argv[1:6]
rpc = RPC(rpc_url); pot = Pot(rpc, pot_addr); acct = load_key({"keyFile": keyfile})
cur = pot.current_round()
rf = json.loads(urllib.request.urlopen(f"{pub}/round_{cur}/round.json").read())
me = acct.address.lower(); cum = int(rf["cumulative"][me]); proof = [bytes.fromhex(p[2:]) for p in rf["proofs"][me]]
before = int(rpc("eth_getBalance", [acct.address, "latest"]), 16)
if pot.claimed(me) >= cum:
    print(json.dumps({"claim": me, "round": cur, "cumulative": cum, "claimedOnChain": pot.claimed(me), "note": "nothing left to claim (already paid/pushed)"}))
    sys.exit(0)
rc = send_tx(rpc, acct, pot_addr, encode_call("claim(address,uint256,bytes32[])", ["address", "uint256", "bytes32[]"],
             [acct.address, cum, proof]), chain_id=int(cid))
after = int(rpc("eth_getBalance", [acct.address, "latest"]), 16)
gas = int(rc["gasUsed"], 16) * int(rc["effectiveGasPrice"], 16)
print(json.dumps({"claim": me, "round": cur, "cumulative": cum, "status": int(rc["status"], 16), "received": after - before + gas,
                  "gasUsed": int(rc["gasUsed"], 16), "claimedOnChain": pot.claimed(me)}))
# a second claim of the same cumulative must revert (NothingToClaim)
try:
    rpc("eth_call", [{"from": acct.address, "to": pot_addr, "data": "0x" + encode_call("claim(address,uint256,bytes32[])",
        ["address", "uint256", "bytes32[]"], [acct.address, cum, proof]).hex()}, "latest"])
    print(json.dumps({"doubleClaim": "UNEXPECTEDLY SUCCEEDS"}))
except RuntimeError as e:
    print(json.dumps({"doubleClaim": "reverted", "err": str(e)[:160]}))
# inflated amount must revert (InvalidProof)
try:
    rpc("eth_call", [{"from": acct.address, "to": pot_addr, "data": "0x" + encode_call("claim(address,uint256,bytes32[])",
        ["address", "uint256", "bytes32[]"], [acct.address, cum * 2, proof]).hex()}, "latest"])
    print(json.dumps({"inflatedClaim": "UNEXPECTEDLY SUCCEEDS"}))
except RuntimeError as e:
    print(json.dumps({"inflatedClaim": "reverted", "err": str(e)[:160]}))
