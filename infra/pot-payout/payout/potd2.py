#!/usr/bin/env python3
"""potd2 — PRANA pot round COORDINATOR (proposer). Holds no key and no power.

Each round of `roundBlocks` blocks it gathers the PUBLIC inputs — the pool's share records (+ template
headers), the fleet queue's verified AI jobs, the pot's receivedTotal read from the chain — runs
roundlib.compute_round, and publishes, Devcoin-style:
    <publishDir>/round_<N>/inputs.json     canonical bundle (its sha256 is the on-chain inputsHash)
    <publishDir>/round_<N>/proposal.json   {round, root, total, inputsHash, endBlock, ...}
    <publishDir>/round_<N>/round.json      cumulative per address + Merkle proofs (for claimers)
    <publishDir>/round_<N>/receiver_<N>.csv
Signers fetch inputs.json, recompute independently and sign only on a byte-identical root. A wrong
proposal therefore achieves nothing: it never gathers K signatures."""
import argparse, json, os, socket, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chain import RPC, Pot
import roundlib
from verify import BlockCache, check_shares, derive_blocks


class Redis:  # tiny RESP client (no deps)
    def __init__(self, host="127.0.0.1", port=6379, db=0):
        self.s = socket.create_connection((host, port), timeout=10); self.f = self.s.makefile("rb")
        if db: self.cmd("SELECT", db)

    def cmd(self, *a):
        buf = b"*%d\r\n" % len(a)
        for x in a:
            x = str(x).encode(); buf += b"$%d\r\n%s\r\n" % (len(x), x)
        self.s.sendall(buf); return self._read()

    def _read(self):
        l = self.f.readline(); t, r = l[:1], l[1:-2]
        if t == b"+": return r.decode()
        if t == b"-": raise RuntimeError(r.decode())
        if t == b":": return int(r)
        if t == b"$":
            n = int(r)
            if n < 0: return None
            return self.f.read(n + 2)[:-2].decode()
        if t == b"*":
            n = int(r); return None if n < 0 else [self._read() for _ in range(n)]
        raise RuntimeError("bad reply")


def log(**kw):
    print(json.dumps({"t": int(time.time()), "who": "potd2", **kw}), flush=True)


def load_state(state_dir, rnd, params):
    if rnd == 0:
        return roundlib.genesis_state(params["genesisStartBlock"])
    with open(os.path.join(state_dir, f"state_{rnd}.json")) as f:
        return json.load(f)


def write_atomic(path, data: bytes):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def run_once(cfg):
    rpc = RPC(cfg["rpc"]); pot = Pot(rpc, cfg["params"]["pot"]); P = cfg["params"]
    pub, sdir = cfg["publishDir"], cfg["stateDir"]
    os.makedirs(pub, exist_ok=True); os.makedirs(sdir, exist_ok=True)
    cur = pot.current_round(); act = pot.active(); pend = pot.pending()

    # promote a finalized proposal to state (only once the chain says it is the active root)
    prop_path = os.path.join(sdir, f"proposed_{cur}.json")
    if cur > 0 and not os.path.exists(os.path.join(sdir, f"state_{cur}.json")):
        st = json.load(open(prop_path))
        if st["root"] != act["root"]:
            raise RuntimeError(f"finalized root for round {cur} is not ours — recompute required")
        write_atomic(os.path.join(sdir, f"state_{cur}.json"), json.dumps(st).encode())
        log(event="finalized", round=cur, root=act["root"])
    prev = load_state(sdir, cur, P)
    if prev["root"] != act["root"]:
        raise RuntimeError("own previous state does not match the on-chain active root")
    rnd = cur + 1
    if pend["root"] != roundlib.ZERO_ROOT:
        return {"wait": "pending root in challenge window", "round": pend["round"]}

    S = prev["endBlock"]; RB = int(cfg["roundBlocks"]); E = S + RB
    head = int(rpc("eth_blockNumber"), 16)
    if int(prev["total"]) == 0 and head - int(cfg["depth"]) - S >= RB:
        # nothing distributed yet: an empty root cannot be posted (ZeroRoot), so the first paying round
        # stretches to the latest whole-round boundary until it contains pool shares
        E = S + RB * ((head - int(cfg["depth"]) - S) // RB)
    if E > head - int(cfg["depth"]):
        return {"wait": "round not complete", "need": E + int(cfg["depth"]), "head": head}

    rdir = os.path.join(pub, f"round_{rnd}")
    vetoed = pot.vetoed_roots(rnd)
    if os.path.exists(os.path.join(rdir, "proposal.json")):
        prop = json.load(open(os.path.join(rdir, "proposal.json")))
        if prop["root"] not in vetoed:
            return {"published": rnd, "root": prop["root"]}
        log(event="vetoed", round=rnd, root=prop["root"])

    # ---- gather public inputs
    r = Redis(cfg.get("redisHost", "127.0.0.1"), cfg["redisPort"], cfg.get("redisDb", 0))
    pre = cfg["redisPrefix"]
    raw = r.cmd("ZRANGEBYSCORE", f"{pre}:sharelog", f"({S}", str(E)) or []
    shares = [json.loads(x) for x in raw]
    for s in shares:
        s["login"] = s["login"].lower(); s["nonce"] = s["nonce"].lower()
        s["hashNoNonce"] = s["hashNoNonce"].lower(); s["mixDigest"] = s["mixDigest"].lower()
    shares.sort(key=lambda s: (int(s["height"]), s["hashNoNonce"], s["nonce"]))
    templates = {}
    for s in shares:
        h = s["hashNoNonce"]
        if h not in templates:
            t = r.cmd("HGET", f"{pre}:tmpl", h)
            if t:
                templates[h] = json.loads(t)
    # pre-filter with the SAME independent verifier signers use (pool already checked; belt and braces)
    blocks = BlockCache(rpc)
    bad, _, bound = check_shares(rpc, cfg["shareverify"], shares, templates, P, 1.0, blocks=blocks)
    if bad:
        badset = {i for i, _ in bad}
        log(event="dropped_invalid_shares", n=len(bad), reasons=sorted({x for _, x in bad}))
        shares = [s for i, s in enumerate(shares) if i not in badset]
    used = {s["hashNoNonce"] for s in shares}
    templates = {k: v for k, v in templates.items() if k in used}
    startTs = int(blocks.get(S)["timestamp"], 16); endBlk = blocks.get(E); endTs = int(endBlk["timestamp"], 16)
    blist, recv_start = derive_blocks(rpc, pot, S, E, P, blocks)
    exp = json.loads(urllib.request.urlopen(f"{cfg['fleetq']}/export?since={startTs}&until={endTs}", timeout=60).read())
    bundle = {
        "schema": roundlib.SCHEMA, "chainId": P["chainId"], "pot": P["pot"].lower(), "round": rnd,
        "startBlock": S, "endBlock": E, "endBlockHash": endBlk["hash"], "startTs": startTs, "endTs": endTs,
        "receivedTotal": str(pot.received_total(hex(E))), "receivedAtStart": str(recv_start), "params": P, "prev": prev,
        "blocks": blist,
        "shares": shares, "templates": templates, "ai": exp["jobs"],
        "exclusions": cfg.get("exclusions", {}).get(str(rnd), {"shares": [], "jobs": [], "reason": ""}),
    }
    res = roundlib.compute_round(bundle, P, prev)
    if res["root"] == roundlib.ZERO_ROOT:
        return {"wait": "no pool shares yet; first round keeps stretching", "round": rnd, "endBlock": E}
    if res["root"] in vetoed:
        return {"blocked": "recomputed root equals the vetoed root; operator must publish exclusions", "round": rnd}
    os.makedirs(rdir, exist_ok=True)
    write_atomic(os.path.join(rdir, "inputs.json"), roundlib.canonical(bundle))
    write_atomic(os.path.join(rdir, "round.json"), json.dumps({
        "round": rnd, "root": res["root"], "total": str(res["total"]), "endBlock": E,
        "cumulative": res["state"]["cumulative"], "proofs": res["proofs"], "heldAI": {a: str(v) for a, v in res["heldAI"].items()},
        "units": res["units"], "banned": res["banned"],
        "lostFound": res["state"]["lostFound"], "lostFoundEntries": res["lostFoundEntries"],
        "lostFoundReleased": {a: str(v) for a, v in res["lostFoundReleased"].items()}}, indent=1).encode())
    write_atomic(os.path.join(rdir, f"receiver_{rnd}.csv"), roundlib.receiver_csv(res).encode())
    write_atomic(os.path.join(sdir, f"proposed_{rnd}.json"), json.dumps(res["state"]).encode())
    prop = {"round": rnd, "root": res["root"], "total": str(res["total"]), "inputsHash": res["inputsHash"],
            "endBlock": E, "chainId": P["chainId"], "pot": P["pot"], "shares": len(shares),
            "boundShares": bound, "aiJobs": len(exp["jobs"]), "distributable": str(res["distributable"])}
    write_atomic(os.path.join(rdir, "proposal.json"), json.dumps(prop, indent=1).encode())
    log(event="proposed", **prop)
    return prop


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("config"); ap.add_argument("--loop", type=int, default=0)
    a = ap.parse_args(); cfg = json.load(open(a.config))
    while True:
        try:
            out = run_once(cfg)
            if out and not a.loop: print(json.dumps(out))
        except Exception as e:
            log(error=str(e))
        if not a.loop: break
        time.sleep(a.loop)
