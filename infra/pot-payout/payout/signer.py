#!/usr/bin/env python3
"""PRANA pot SIGNER daemon — one per independent operator/box. Never signs what the coordinator says.

For the next round it:
  1. downloads the public bundle (inputs.json) and the proposal; checks sha256(bundle) == proposal.inputsHash
  2. checks every chain fact against ITS OWN node: endBlock is buried >= depth and its hash matches,
     startBlock == on-chain active.endBlock, receivedTotal == balance(pot@E) + totalClaimed(@E), the on-chain
     active root == the root of ITS OWN previous-round state (it keeps its own state; bootstraps by replaying
     every published round against the on-chain RootFinalized events)
  3. re-verifies the Etchash PoW of the shares (all, or a seeded sample) with an independent verifier and the
     template binding to its own canonical chain; validates every AI verdict; optionally re-runs sampled AI jobs
  4. recomputes the round with ITS OWN pinned params -> root; signs EIP-712 only if byte-identical
  5. never equivocates: a second, different root for the same round is signed only after the first was vetoed
Signatures are published at <sigDir>/round_<N>.json (served over HTTP to any relayer)."""
import argparse, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roundlib
from chain import RPC, Pot, load_key, local_digest, sign_digest
from verify import BlockCache, check_shares, derive_blocks


def log(name, **kw):
    print(json.dumps({"t": int(time.time()), "who": name, **kw}), flush=True)


def fetch(url, binary=False):
    if url.startswith("file://") or url.startswith("/"):
        with open(url.removeprefix("file://"), "rb") as f:
            b = f.read()
    else:
        b = urllib.request.urlopen(url, timeout=120).read()
    return b if binary else json.loads(b)


def write_atomic(path, data: bytes):
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


class Signer:
    def __init__(self, cfg):
        self.cfg, self.P = cfg, cfg["params"]
        self.name = cfg.get("name", "signer")
        self.rpc = RPC(cfg["rpc"]); self.pot = Pot(self.rpc, self.P["pot"])
        self.acct = load_key(cfg["key"])           # never logged
        self.sd = cfg["stateDir"]; os.makedirs(self.sd, exist_ok=True)
        self.sigdir = cfg["sigDir"]; os.makedirs(self.sigdir, exist_ok=True)
        if float(cfg.get("powSample", 1.0)) != 1.0:
            raise SystemExit("powSample must be 1.0: every share is verified (sampling let a forged share through on the devnet)")
        self.rerun = None
        if cfg.get("aiRerun", 0) > 0:
            from verify import Hathor0Rerun
            self.rerun = Hathor0Rerun(cfg["hathor0"])

    # ---------------------------------------------------------------- own state
    def state(self, rnd):
        if rnd == 0:
            return roundlib.genesis_state(self.P["genesisStartBlock"])
        p = os.path.join(self.sd, f"state_{rnd}.json")
        return json.load(open(p)) if os.path.exists(p) else None

    def catch_up(self, cur):
        """Make sure we hold our own state for every finalized round, recomputed from published inputs."""
        fin = None
        for r in range(1, cur + 1):
            if self.state(r) is not None:
                continue
            fin = fin or self.pot.finalized_roots()
            mine = os.path.join(self.sd, f"computed_{r}_{(fin.get(r) or '0x')[2:10]}.json")
            if fin.get(r) and os.path.exists(mine):   # we verified + signed this exact root ourselves
                st = json.load(open(mine))
                if st["root"] == fin[r]:
                    write_atomic(os.path.join(self.sd, f"state_{r}.json"), json.dumps(st).encode())
                    log(self.name, event="promoted", round=r, root=fin[r])
                    continue
            bundle = json.loads(fetch(f"{self.cfg['publishUrl']}/round_{r}/inputs.json", binary=True))
            res = roundlib.compute_round(bundle, self.P, self.state(r - 1))
            if res["root"] != fin.get(r):
                raise RuntimeError(f"replay of round {r} gives {res['root']}, chain finalized {fin.get(r)}")
            write_atomic(os.path.join(self.sd, f"state_{r}.json"), json.dumps(res["state"]).encode())
            log(self.name, event="replayed", round=r, root=res["root"])

    # ---------------------------------------------------------------- one tick
    def tick(self):
        cur = self.pot.current_round(); act = self.pot.active(); pend = self.pot.pending()
        self.catch_up(cur)
        prev = self.state(cur)
        if prev["root"] != act["root"]:
            raise RuntimeError("ALERT own state root != on-chain active root")
        rnd = cur + 1
        try:
            prop = fetch(f"{self.cfg['publishUrl']}/round_{rnd}/proposal.json")
            raw = fetch(f"{self.cfg['publishUrl']}/round_{rnd}/inputs.json", binary=True)
        except Exception:
            return {"idle": "no proposal", "round": rnd}
        verdict = self.verify(rnd, prop, raw, act, prev)
        # watchdog: a pending root that is not what we computed is an alarm for the guardian
        if pend["root"] != roundlib.ZERO_ROOT and pend["round"] == rnd and verdict.get("root") != pend["root"]:
            log(self.name, event="ALERT_PENDING_ROOT_MISMATCH", round=rnd, pending=pend["root"], ours=verdict.get("root"))
        if not verdict["ok"]:
            log(self.name, event="REFUSED", round=rnd, reason=verdict["reason"])
            return verdict
        return self.sign(rnd, prop)

    def verify(self, rnd, prop, raw, act, prev):
        P, cfg = self.P, self.cfg
        bundle = json.loads(raw)
        if roundlib.canonical(bundle) != raw:
            return {"ok": False, "reason": "inputs.json is not canonical JSON"}
        ih = roundlib.sha256hex(raw)
        if ih != prop["inputsHash"]:
            return {"ok": False, "reason": "inputs hash != proposal"}
        if int(bundle["round"]) != rnd or prop["round"] != rnd:
            return {"ok": False, "reason": "round number"}
        E, S = int(bundle["endBlock"]), int(bundle["startBlock"])
        head = int(self.rpc("eth_blockNumber"), 16)
        if E > head - int(cfg["depth"]):
            return {"ok": False, "reason": f"endBlock {E} not buried {cfg['depth']} deep (head {head})"}
        blocks = BlockCache(self.rpc)
        if blocks.get(E)["hash"].lower() != bundle["endBlockHash"].lower():
            return {"ok": False, "reason": "endBlock hash differs from own node (reorg or fake)"}
        if E <= S or (E - S) % int(cfg["roundBlocks"]) != 0:
            return {"ok": False, "reason": "round length differs from pinned roundBlocks"}
        if rnd > 1 and act["endBlock"] != S:
            return {"ok": False, "reason": "startBlock != on-chain active.endBlock"}
        if int(blocks.get(S)["timestamp"], 16) != int(bundle["startTs"]) or int(blocks.get(E)["timestamp"], 16) != int(bundle["endTs"]):
            return {"ok": False, "reason": "round timestamps differ from own node"}
        recv = self.pot.received_total(hex(E))
        if str(recv) != bundle["receivedTotal"]:
            return {"ok": False, "reason": f"receivedTotal {bundle['receivedTotal']} != own node {recv}"}
        # per-block attribution (pool vs outside coinbase -> Lost-and-Found) re-derived from OUR node
        own_blocks, own_start = derive_blocks(self.rpc, self.pot, S, E, P, blocks)
        if str(own_start) != bundle["receivedAtStart"] or roundlib.canonical(own_blocks) != roundlib.canonical(bundle["blocks"]):
            return {"ok": False, "reason": "per-block attribution differs from own node"}
        exc = bundle.get("exclusions") or {}
        if (exc.get("shares") or exc.get("jobs")) and not self.pot.vetoed_roots(rnd):
            return {"ok": False, "reason": "exclusions present but this round was never vetoed"}
        # PoW + template binding (independent Go verifier, own canonical chain)
        # EVERY share's PoW is verified. (Devnet finding 2026-10-17: with 50% sampling one signer missed a single
        # forged share and signed a forged round. Full verification costs seconds, so sampling is not allowed.)
        bad, checked, bound = check_shares(self.rpc, cfg["shareverify"], bundle["shares"], bundle["templates"], P,
                                           1.0, blocks=blocks)
        if checked != len(bundle["shares"]):
            return {"ok": False, "reason": "internal: not every share was PoW-checked"}
        if bad:
            return {"ok": False, "reason": f"{len(bad)} invalid share(s), e.g. #{bad[0][0]}: {bad[0][1]}"}
        # deterministic recomputation (also validates every AI verdict + structure)
        try:
            res = roundlib.compute_round(bundle, P, prev)
        except roundlib.RoundError as e:
            return {"ok": False, "reason": f"round invalid: {e}"}
        if self.rerun:
            import random
            rng = random.Random(f"{self.acct.address}:{rnd}:ai")
            jobs = [j for j in bundle["ai"]]
            for j in rng.sample(jobs, max(0, int(len(jobs) * float(cfg["aiRerun"])))):
                if not self.rerun.check(j):
                    return {"ok": False, "reason": f"AI job {j['job']} did not reproduce on the pinned model"}
        for k in ("root", "endBlock"):
            if res[k] != prop[k]:
                return {"ok": False, "reason": f"{k} mismatch: ours {res[k]} vs proposed {prop[k]}", "root": res["root"]}
        if str(res["total"]) != str(prop["total"]):
            return {"ok": False, "reason": "total mismatch", "root": res["root"]}
        self._computed = res
        log(self.name, event="verified", round=rnd, root=res["root"], shares=len(bundle["shares"]), powChecked=checked,
            bound=bound, aiJobs=len(bundle["ai"]))
        return {"ok": True, "root": res["root"]}

    def sign(self, rnd, prop):
        epoch = self.pot.signer_epoch()
        if prop["root"] in self.pot.vetoed_roots(rnd):
            log(self.name, event="REFUSED_VETOED_ROOT", round=rnd, root=prop["root"])
            return {"ok": False, "reason": "this exact root was vetoed by the guardian for this round"}
        signed_path = os.path.join(self.sd, f"signed_{epoch}_{rnd}.json")
        if os.path.exists(signed_path):
            prior = json.load(open(signed_path))
            if prior["root"] != prop["root"] and prior["root"] not in self.pot.vetoed_roots(rnd):
                log(self.name, event="REFUSED_EQUIVOCATION", round=rnd, prior=prior["root"], new=prop["root"])
                return {"ok": False, "reason": "already signed a different root for this round"}
        d = local_digest(self.P["chainId"], self.P["pot"], rnd, prop["root"], int(prop["total"]), prop["inputsHash"],
                         prop["endBlock"], epoch)
        onchain = self.pot.root_digest_onchain(rnd, prop["root"], int(prop["total"]), prop["inputsHash"], prop["endBlock"])
        if d != onchain:
            return {"ok": False, "reason": "local EIP-712 digest != contract rootDigest (wrong contract/chain?)"}
        sig = sign_digest(self.acct, d)
        rec = {"round": rnd, "root": prop["root"], "total": prop["total"], "inputsHash": prop["inputsHash"],
               "endBlock": prop["endBlock"], "signerEpoch": epoch, "signer": self.acct.address.lower(), "sig": sig}
        write_atomic(signed_path, json.dumps(rec).encode())
        write_atomic(os.path.join(self.sigdir, f"round_{rnd}.json"), json.dumps(rec).encode())
        # adopt our computed state as "proposed"; it becomes state_<rnd> when the chain finalizes it
        write_atomic(os.path.join(self.sd, f"computed_{rnd}_{prop['root'][2:10]}.json"),
                     json.dumps(self._computed["state"]).encode())
        log(self.name, event="SIGNED", round=rnd, root=prop["root"], signer=rec["signer"])
        return {"ok": True, "signed": rnd, "root": prop["root"]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("config"); ap.add_argument("--loop", type=int, default=0)
    a = ap.parse_args(); s = Signer(json.load(open(a.config)))
    while True:
        try:
            out = s.tick()
            if not a.loop: print(json.dumps(out))
        except Exception as e:
            log(s.name, error=str(e))
        if not a.loop: break
        time.sleep(a.loop)
