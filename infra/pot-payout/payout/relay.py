#!/usr/bin/env python3
"""PRANA pot RELAYER — a courier with no power. Anyone can run one; its key only pays gas.
  * collects signer signatures for the published proposal, keeps only those that recover to a current
    on-chain signer over the exact digest, sorts them by address and calls postRoot once >= threshold;
  * calls finalize() after the challenge window;
  * optional batched PUSH (claimMany) of small balances so dust holders need not pay gas to claim."""
import argparse, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eth_abi import encode
from chain import RPC, Pot, encode_call, load_key, local_digest, recover, send_tx
import roundlib


def log(**kw):
    print(json.dumps({"t": int(time.time()), "who": "relay", **kw}), flush=True)


def fetch(url):
    if url.startswith("/") or url.startswith("file://"):
        with open(url.removeprefix("file://")) as f:
            return json.load(f)
    return json.loads(urllib.request.urlopen(url, timeout=60).read())


def tick(cfg, acct):
    P = cfg["params"]; rpc = RPC(cfg["rpc"]); pot = Pot(rpc, P["pot"])
    cur = pot.current_round(); pend = pot.pending()
    if pend["root"] != roundlib.ZERO_ROOT:
        due = pend["postedAt"] + pot.challenge_period()
        now = int(rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        if now >= due and not pot.paused():
            rc = send_tx(rpc, acct, P["pot"], encode_call("finalize()", [], []), chain_id=P["chainId"])
            log(event="finalize", round=pend["round"], status=rc["status"], tx=rc["transactionHash"])
            return {"finalized": pend["round"]}
        return {"wait": "challenge window", "round": pend["round"], "remaining_s": due - now}
    rnd = cur + 1
    try:
        prop = fetch(f"{cfg['publishUrl']}/round_{rnd}/proposal.json")
    except Exception:
        return {"idle": "no proposal", "round": rnd}
    epoch = pot.signer_epoch(); k = pot.threshold()
    d = local_digest(P["chainId"], P["pot"], rnd, prop["root"], int(prop["total"]), prop["inputsHash"], prop["endBlock"], epoch)
    good = {}
    for url in cfg["signerSigUrls"]:
        try:
            s = fetch(f"{url}/round_{rnd}.json")
        except Exception:
            continue
        if s.get("root") != prop["root"]:
            log(event="signer_disagrees", round=rnd, signer=s.get("signer"), their_root=s.get("root"), proposal=prop["root"])
            continue
        who = recover(d, s["sig"])
        if who != s.get("signer") or not pot.is_signer(who):
            log(event="sig_rejected", round=rnd, claimed=s.get("signer"), recovered=who)
            continue
        good[who] = s["sig"]
    if len(good) < k:
        return {"wait": "signatures", "round": rnd, "have": len(good), "need": k}
    sigs = [bytes.fromhex(good[a][2:]) for a in sorted(good, key=lambda x: int(x, 16))]
    data = encode_call("postRoot(uint64,bytes32,uint256,bytes32,uint64,bytes[])",
                       ["uint64", "bytes32", "uint256", "bytes32", "uint64", "bytes[]"],
                       [rnd, bytes.fromhex(prop["root"][2:]), int(prop["total"]), bytes.fromhex(prop["inputsHash"][2:]),
                        prop["endBlock"], sigs])
    rc = send_tx(rpc, acct, P["pot"], data, chain_id=P["chainId"])
    log(event="postRoot", round=rnd, root=prop["root"], signers=sorted(good), status=rc["status"], tx=rc["transactionHash"])
    return {"posted": rnd, "status": rc["status"]}


def push(cfg, acct, max_wei, batch=40):
    """claimMany for every account in the ACTIVE round whose unclaimed amount is <= max_wei."""
    P = cfg["params"]; rpc = RPC(cfg["rpc"]); pot = Pot(rpc, P["pot"])
    cur = pot.current_round()
    rf = fetch(f"{cfg['publishUrl']}/round_{cur}/round.json")
    if rf["root"] != pot.active()["root"]:
        raise RuntimeError("published round.json does not match the active root")
    items = []
    for a, c in rf["cumulative"].items():
        due = int(c) - pot.claimed(a)
        if 0 < due <= max_wei:
            items.append((a, int(c), [bytes.fromhex(p[2:]) for p in rf["proofs"][a]]))
    out = []
    for i in range(0, len(items), batch):
        chunk = items[i:i + batch]
        data = encode_call("claimMany((address,uint256,bytes32[])[])", ["(address,uint256,bytes32[])[]"], [chunk])
        rc = send_tx(rpc, acct, P["pot"], data, chain_id=P["chainId"])
        out.append({"n": len(chunk), "status": rc["status"], "gasUsed": int(rc["gasUsed"], 16)})
        log(event="push", **out[-1])
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("config"); ap.add_argument("--loop", type=int, default=0)
    ap.add_argument("--push-max-wei", type=int, default=0)
    a = ap.parse_args(); cfg = json.load(open(a.config)); acct = load_key(cfg["key"])
    if a.push_max_wei:
        print(json.dumps(push(cfg, acct, a.push_max_wei))); sys.exit(0)
    while True:
        try:
            out = tick(cfg, acct)
            if not a.loop: print(json.dumps(out))
        except Exception as e:
            log(error=str(e))
        if not a.loop: break
        time.sleep(a.loop)
