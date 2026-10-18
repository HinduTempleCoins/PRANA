"""TEST HARNESS ONLY — a malicious signer (it holds a real signer key from the on-chain set).
It takes the honest public bundle, redirects every share to the attacker, recomputes a self-serving root,
signs it, publishes that signature, and then tries every way it can to get the root on-chain:
  (a) alone (1 of K=2),
  (b) paired with an honest signer's signature (which is over the honest digest),
  (c) the same signature twice.
Each attempt is simulated with eth_call first so the exact revert reason is recorded, then broadcast."""
import json, os, sys
sys.path.insert(0, "/root/prana-payout/payout")
import roundlib
from chain import RPC, Pot, encode_call, load_key, local_digest, sign_digest, send_tx

cfg = json.load(open(sys.argv[1])); P = cfg["params"]
attacker = sys.argv[2].lower(); rnd = int(sys.argv[3]); honest_sig_file = sys.argv[4] if len(sys.argv) > 4 else None
rpc = RPC(cfg["rpc"]); pot = Pot(rpc, P["pot"]); acct = load_key(cfg["key"])
relayer = load_key(json.load(open(os.path.join(os.path.dirname(sys.argv[1]), "relay.json")))["key"])
import urllib.request
raw = urllib.request.urlopen(f"{cfg['publishUrl']}/round_{rnd}/inputs.json").read()
b = json.loads(raw)
for s in b["shares"]:
    s["login"] = attacker
for j in b["ai"]:
    pass
res = roundlib.compute_round(b, P, b["prev"])
ih = roundlib.inputs_hash(b)
epoch = pot.signer_epoch()
d = local_digest(P["chainId"], P["pot"], rnd, res["root"], res["total"], ih, res["endBlock"], epoch)
sig = sign_digest(acct, d)
os.makedirs(cfg["sigDir"], exist_ok=True)
json.dump({"round": rnd, "root": res["root"], "total": str(res["total"]), "inputsHash": ih, "endBlock": res["endBlock"],
           "signerEpoch": epoch, "signer": acct.address.lower(), "sig": sig}, open(os.path.join(cfg["sigDir"], f"round_{rnd}.json"), "w"))
print(json.dumps({"who": "EVIL", "event": "signed_malicious_root", "round": rnd, "root": res["root"],
                  "attackerCumulative": res["state"]["cumulative"].get(attacker)}))

T = ["uint64", "bytes32", "uint256", "bytes32", "uint64", "bytes[]"]
def attempt(name, sigs):
    data = encode_call("postRoot(uint64,bytes32,uint256,bytes32,uint64,bytes[])", T,
                       [rnd, bytes.fromhex(res["root"][2:]), res["total"], bytes.fromhex(ih[2:]), res["endBlock"], sigs])
    try:
        rpc("eth_call", [{"from": relayer.address, "to": P["pot"], "data": "0x" + data.hex()}, "latest"])
        sim = "WOULD SUCCEED"
    except RuntimeError as e:
        sim = str(e)[:200]
    try:
        rc = send_tx(rpc, relayer, P["pot"], data, chain_id=P["chainId"], gas=500000)
        status = int(rc["status"], 16)
    except Exception as e:
        status = f"send error {str(e)[:120]}"
    print(json.dumps({"who": "EVIL", "attempt": name, "simulated": sim, "minedStatus": status}))

attempt("alone (1 of 2)", [bytes.fromhex(sig[2:])])
attempt("same signature twice", [bytes.fromhex(sig[2:])] * 2)
if honest_sig_file and os.path.exists(honest_sig_file):
    h = json.load(open(honest_sig_file))
    pair = sorted([(acct.address.lower(), sig), (h["signer"], h["sig"])], key=lambda x: int(x[0], 16))
    attempt("paired with an honest signature (over the honest root)", [bytes.fromhex(x[1][2:]) for x in pair])
print(json.dumps({"who": "EVIL", "pendingAfter": pot.pending()["root"], "currentRound": pot.current_round()}))
