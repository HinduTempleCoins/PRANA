"""TEST HARNESS — a compromised COORDINATOR publishes a round whose bundle contains a forged share credited
to the attacker (PoW does not verify), with a self-consistent proposal (correct inputsHash and root for the
forged data). Honest signers must refuse it; the attacker's lone signer signature cannot reach quorum."""
import json, os, shutil, sys, urllib.request
sys.path.insert(0, "/root/prana-payout/payout")
import roundlib
from signer import Signer

D = os.path.dirname(os.path.abspath(__file__)); rnd = int(sys.argv[1]); attacker = sys.argv[2].lower()
src, dst = f"{D}/pub/round_{rnd}", f"{D}/pub-evil/round_{rnd}"
os.makedirs(dst, exist_ok=True)
b = json.loads(open(f"{src}/inputs.json", "rb").read())
real = b["shares"][len(b["shares"]) // 2]
forged = dict(real, login=attacker, nonce="0x%016x" % ((int(real["nonce"], 16) + 12345) % 2**64), block=False)
b["shares"].append(forged); b["shares"].sort(key=lambda s: (int(s["height"]), s["hashNoNonce"], s["nonce"]))
res = roundlib.compute_round(b, b["params"], b["prev"])        # self-consistent forged proposal
raw = roundlib.canonical(b)
open(f"{dst}/inputs.json", "wb").write(raw)
json.dump({"round": rnd, "root": res["root"], "total": str(res["total"]), "inputsHash": roundlib.sha256hex(raw),
           "endBlock": res["endBlock"], "chainId": b["chainId"], "pot": b["pot"]}, open(f"{dst}/proposal.json", "w"))
print(json.dumps({"who": "EVIL-COORDINATOR", "event": "published forged round", "round": rnd, "root": res["root"],
                  "forgedShare": {k: forged[k] for k in ("login", "height", "nonce", "hashNoNonce", "diff")}}))
for i in (1, 2):
    cfg = json.load(open(f"{D}/signer{i}.json")); cfg["publishUrl"] = f"file://{D}/pub-evil"
    cfg["sigDir"] = f"{D}/sigs-evil-test/signer{i}"; cfg["stateDir"] = cfg["stateDir"]  # same own state
    s = Signer(cfg)
    out = s.tick()
    print(json.dumps({"who": cfg["name"], "against": "forged publication", "result": out}))
    assert not out.get("ok", False) and "signed" not in out, "honest signer signed a forged round!"
shutil.rmtree(f"{D}/pub-evil")
