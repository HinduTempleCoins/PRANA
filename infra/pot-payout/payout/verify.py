"""Independent checks used by signers (and by the coordinator as a pre-filter, and by any outside auditor):
Etchash PoW of every (or a sampled set of) share(s), template binding to the canonical chain, and an
optional re-execution of sampled AI jobs on the pinned model."""
import json, random, subprocess


def run_shareverify(binpath, shares, templates, fblock, mindiff):
    inp = json.dumps({"shares": shares, "templates": templates}).encode()
    p = subprocess.run([binpath, "shares", "-fblock", str(fblock), "-mindiff", str(mindiff)], input=inp,
                       capture_output=True, timeout=3600)
    if p.returncode != 0:
        raise RuntimeError("shareverify failed: " + p.stderr.decode()[:300])
    return json.loads(p.stdout)["results"]


class BlockCache:
    def __init__(self, rpc):
        self.rpc, self.c = rpc, {}

    def get(self, n):
        if n not in self.c:
            self.c[n] = self.rpc("eth_getBlockByNumber", [hex(n), False])
        return self.c[n]


def check_shares(rpc, binpath, shares, templates, params, sample=1.0, seed=None, blocks=None):
    """Returns (bad: list of (index, reason), checked: int, bound: int). With sample < 1 a deterministic
    pseudo-random subset (seeded by the signer's own secret-free seed, e.g. its address + round) is checked."""
    blocks = blocks or BlockCache(rpc)
    idx = list(range(len(shares)))
    if sample < 1.0:
        rnd = random.Random(seed)
        idx = sorted(rnd.sample(idx, max(1, int(len(idx) * sample)))) if idx else []
    sub = [shares[i] for i in idx]
    res = run_shareverify(binpath, sub, templates, params["ecip1099FBlock"], params["minShareDiff"]) if sub else []
    bad, bound = [], 0
    for i, r in zip(idx, res):
        if not r["ok"]:
            bad.append((i, r.get("reason", "invalid")))
            continue
        if r.get("bound"):
            h = int(shares[i]["height"])
            parent = blocks.get(h - 1)
            if parent is None or parent["hash"].lower() != r["parentHash"].lower():
                bad.append((i, "template parent is not the canonical block height-1"))
                continue
            bound += 1
        elif params.get("requireTemplates"):
            bad.append((i, "unbound share (no template)"))
    # Block shares are bound to the chain: the canonical block at that height must carry exactly this
    # nonce + mixDigest (with a valid PoW over hashNoNonce, equal nonce+mix means hashNoNonce IS its seal hash).
    found_diff = 0
    orphans = 0
    for i, s in enumerate(shares):
        if not s.get("block"):
            continue
        b = blocks.get(int(s["height"]))
        if b is None or b["nonce"].lower() != s["nonce"].lower() or b["mixHash"].lower() != s["mixDigest"].lower():
            # an orphaned/uncled block is still a valid share (its PoW was checked above); it just does not
            # count as found difficulty for the luck check
            orphans += 1
            continue
        found_diff += int(b["difficulty"], 16)
    # Luck: share work claimed vs block difficulty the pool actually found. Shares mined on headers that are
    # not real PRANA templates still cost hashing but can never become blocks -> luck collapses.
    work = sum(int(s["diff"]) for s in shares)
    if work and params.get("luckMin"):
        avg = sum(int(blocks.get(int(s["height"]))["difficulty"], 16) for s in shares[:: max(1, len(shares) // 50)]) / \
            len(shares[:: max(1, len(shares) // 50)])
        expected_blocks = work / avg
        ratio = found_diff / work
        if expected_blocks >= params.get("luckMinExpectedBlocks", 20) and ratio < params["luckMin"]:
            bad.append((-1, f"luck {ratio:.3f} < {params['luckMin']} over {expected_blocks:.1f} expected blocks"))
    return bad, len(idx), bound


class Hathor0Rerun:
    """Optional: re-execute sampled AI jobs on the pinned model and compare with the verified result."""

    def __init__(self, cfg):
        import importlib.util, sys
        spec = importlib.util.spec_from_file_location("fleet_worker", cfg["fleetWorker"])
        m = importlib.util.module_from_spec(spec); sys.modules["fleet_worker"] = m; spec.loader.exec_module(m)
        self.m = m
        self.h0 = m.Hathor0(cfg["ckpt"], cfg["tok"], cfg["modelDir"], cfg.get("threads", 2))

    def check(self, rec):
        job = {"type": rec["type"], "params": rec["params"], "input": rec["input"], "job": rec["job"]}
        out = self.m.run(job, self.h0)
        if rec["type"] == "llm.generate":
            return out["output_hash"] == rec["resultHash"]
        ref = [s for s in rec["submissions"] if s["outputHash"] == rec["resultHash"]][0]["output"]["vector"]
        from roundlib import _cos
        return _cos(out["result"]["vector"], ref) >= 0.9999


# ---------------------------------------------------------------- Lost-and-Found: per-block attribution
def era0_rewards(n, uncle_numbers, R, fee_bps):
    """core-geth ECIP-1017 era 0 (PRANA: base R): winner gross = R + nU*R/32 (Hathor fee taken from it),
    each uncle (u + 8 - n) * R / 8 paid in full. Returns (winnerNetToPot, [uncleRewardToPot...])."""
    gross = R + len(uncle_numbers) * (R // 32)
    fee = gross * fee_bps // 10000
    return gross - fee, [(u + 8 - n) * R // 8 for u in uncle_numbers]


def derive_blocks(rpc, pot, S, E, params, blocks=None):
    """For every block in (S, E]: header coinbase, its uncles' coinbases, and how much of the pot's measured
    inflow (delta of balance + totalClaimed) each of them caused. Coordinator and every signer derive this from
    their OWN node; the bundle copy must be identical. Era > 0 is refused (formula must be re-checked then)."""
    blocks = blocks or BlockCache(rpc)
    R, fee_bps, era_len = int(params["blockReward"]), int(params["feeBps"]), int(params["eraRounds"])
    out = []
    prev = pot.received_total(hex(S))
    start = prev
    for n in range(S + 1, E + 1):
        if (n - 1) // era_len != 0:
            raise RuntimeError("ECIP-1017 era > 0: re-verify the reward formula before continuing")
        b = blocks.get(n)
        cur = pot.received_total(hex(n))
        delta = cur - prev; prev = cur
        uncles = []
        for i in range(len(b["uncles"])):
            u = rpc("eth_getUncleByBlockNumberAndIndex", [hex(n), hex(i)])
            uncles.append({"number": int(u["number"], 16), "hash": u["hash"].lower(), "coinbase": u["miner"].lower()})
        win, urs = era0_rewards(n, [u["number"] for u in uncles], R, fee_bps)
        for u, r in zip(uncles, urs):
            u["amount"] = str(r)
        if delta < win + sum(urs):
            raise RuntimeError(f"block {n}: pot received {delta} < consensus formula {win + sum(urs)}")
        # anything above the formula (a donation / forced send) is attributed to the winner's class
        out.append({"number": n, "hash": b["hash"].lower(), "coinbase": b["miner"].lower(),
                    "amount": str(delta - sum(urs)), "uncles": uncles})
    return out, start
