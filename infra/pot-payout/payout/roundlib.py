"""PRANA pot round computation — the ONE deterministic function every party runs.

The coordinator (potd2) runs it to propose a round; every signer daemon runs it again, on its own copy of
the public inputs, with its OWN pinned parameters and its OWN previous-round state, and signs only if the
resulting Merkle root is byte-for-byte identical. Anyone else can run it to audit a round.

Model (Devcoin "receiver_N.csv" rounds, made verifiable):
  * Consensus credits the PotDistributor contract. receivedTotal(E) = balance(pot @E) + totalClaimed(@E).
  * Round N covers blocks (startBlock, endBlock]. Distributable D = receivedTotal - prevTotal - prevHeld.
  * Units: each accepted hash share = diff / unitDiff; each verified AI job credits every agreeing worker
    milliWU/1000 * aiWeight (the see-saw knob).
  * Each address gets floor(D * units / totalUnits). Hash earnings go straight into its CUMULATIVE balance;
    AI earnings vest one round ("held") and are forfeited if the worker reaches banStrikes by then.
  * Leaves = (address, cumulative). total = sum(cumulative). Invariant: total + held <= receivedTotal.
Every input is validated; anything malformed raises RoundError (signers then refuse to sign)."""
import hashlib, json, math, re
from fractions import Fraction

from merkle import build as merkle_build

SCHEMA = "prana-pot-round/1"
ADDR = re.compile(r"^0x[0-9a-f]{40}$")
HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
NONCE = re.compile(r"^0x[0-9a-f]{16}$")
ZERO_ROOT = "0x" + "00" * 32


class RoundError(Exception):
    pass


def canonical(o) -> bytes:
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256hex(b: bytes) -> str:
    return "0x" + hashlib.sha256(b).hexdigest()


def inputs_hash(bundle) -> str:
    return sha256hex(canonical(bundle))


def genesis_state(start_block: int):
    return {"round": 0, "root": ZERO_ROOT, "total": "0", "endBlock": int(start_block),
            "cumulative": {}, "held": {}, "strikes": {}, "lostFound": {}, "preFork": None}


# ------------------------------------------------------------------ AI work verification (mirrors fleetq)
def _wu(rec):
    t, p, i = rec["type"], rec.get("params") or {}, rec.get("input") or {}
    if t == "llm.generate":
        return 1000 + 10 * int(p.get("max_tokens", 64))
    if t == "embed.text":
        return 200 * max(1, len(i.get("texts", [])))
    if t == "image.sd":
        w, h = image_size(p)
        return 2000 * image_steps(p) * w * h // 262144
    raise RoundError(f"unknown AI type {t}")


def image_size(p):
    """image.sd canvas: 'WxH', each side 256..768 and a multiple of 8 (default 512x512) — mirrors fleetq."""
    try:
        w, h = (int(x) for x in str(p.get("size") or "512x512").lower().split("x")[:2])
    except ValueError:
        raise RoundError("image.sd: bad size")
    if not (256 <= w <= 768 and 256 <= h <= 768 and w % 8 == 0 and h % 8 == 0):
        raise RoundError("image.sd: size out of range")
    return w, h


def image_steps(p):
    s = int(p.get("steps", 6))
    if not 2 <= s <= 8:
        raise RoundError("image.sd: steps out of range")
    return s


def llm_hash(token_ids):
    return hashlib.sha256(json.dumps(token_ids).encode()).hexdigest()


def embed_hash(vector):
    return hashlib.sha256(bytes((int(round(z * 127)) & 0xff) for z in vector)).hexdigest()


def _cos(x, y):
    if not x or not y or len(x) != len(y):
        return -1.0
    nx = math.sqrt(sum(a * a for a in x)); ny = math.sqrt(sum(b * b for b in y))
    if nx == 0 or ny == 0:
        return -1.0
    return sum(a * b for a, b in zip(x, y)) / (nx * ny)


def check_ai(rec, params):
    """Validate one verified AI job record. Returns (credited_addresses, struck_addresses)."""
    for k in ("job", "type", "modelSha256", "inputHash", "paramsHash", "k", "submissions", "credited",
              "resultHash", "milliWU", "verifiedAt", "status"):
        if k not in rec:
            raise RoundError(f"AI job missing {k}")
    j = rec["job"]
    if rec["status"] != "verified":
        raise RoundError(f"AI job {j} not verified")
    if rec["type"] not in params["aiTypes"]:
        raise RoundError(f"AI job {j}: type {rec['type']} not offered")
    if rec["modelSha256"] not in params["modelSha256"]:
        raise RoundError(f"AI job {j}: model {rec['modelSha256'][:12]} not pinned")
    if (rec.get("params") or {}).get("model_sha256") != rec["modelSha256"]:
        raise RoundError(f"AI job {j}: params.model_sha256 != modelSha256")
    if sha256hex(canonical(rec.get("input"))) != rec["inputHash"]:
        raise RoundError(f"AI job {j}: input hash mismatch")
    if sha256hex(canonical(rec.get("params"))) != rec["paramsHash"]:
        raise RoundError(f"AI job {j}: params hash mismatch")
    if int(rec["milliWU"]) != _wu(rec):
        raise RoundError(f"AI job {j}: milliWU {rec['milliWU']} != rule {_wu(rec)}")
    tcfg = params["aiTypes"][rec["type"]]
    k = int(rec["k"])
    if k < tcfg["minQuorum"]:
        raise RoundError(f"AI job {j}: quorum {k} below minimum {tcfg['minQuorum']}")
    subs = rec["submissions"]
    seen = set()
    # recompute each submission's output hash from its published output
    for s in subs:
        w = s["worker"]
        if not ADDR.match(w) or w in seen:
            raise RoundError(f"AI job {j}: bad/duplicate worker {w}")
        seen.add(w)
        if rec["type"] == "llm.generate":
            if llm_hash(s["output"]["token_ids"]) != s["outputHash"]:
                raise RoundError(f"AI job {j}: worker {w} output hash does not match its tokens")
        else:
            if embed_hash(s["output"]["vector"]) != s["outputHash"]:
                raise RoundError(f"AI job {j}: worker {w} output hash does not match its vector")
    ref = [s for s in subs if s["outputHash"] == rec["resultHash"]]
    if not ref:
        raise RoundError(f"AI job {j}: no submission produced the result")
    ref = ref[0]

    def agrees(s):
        if rec["type"] == "llm.generate":
            return s["outputHash"] == ref["outputHash"]
        return _cos(s["output"]["vector"], ref["output"]["vector"]) >= tcfg.get("cosine", 0.9999)

    credited = sorted(set(rec["credited"]))
    matched = sorted(s["worker"] for s in subs if s.get("verdict") == "match")
    if credited != matched:
        raise RoundError(f"AI job {j}: credited set != match verdicts")
    for s in subs:
        if s.get("verdict") == "match" and not agrees(s):
            raise RoundError(f"AI job {j}: {s['worker']} credited but disagrees with the result")
        if s.get("verdict") == "mismatch" and agrees(s):
            raise RoundError(f"AI job {j}: {s['worker']} struck but agrees with the result")
    if len(credited) < k:
        raise RoundError(f"AI job {j}: {len(credited)} agreeing < quorum {k}")
    anchors = set(params["anchors"])
    if tcfg.get("anchor", True) and not (set(credited) & anchors):
        raise RoundError(f"AI job {j}: no trusted anchor in the agreeing set (Sybil rule)")
    struck = sorted(s["worker"] for s in subs if s.get("verdict") == "mismatch")
    return credited, struck


# ------------------------------------------------------------------ the round
def compute_round(bundle, params, prev_state):
    """bundle: public inputs. params: the caller's PINNED parameters (must equal bundle['params']).
    prev_state: the caller's OWN state after the last finalized round (must equal bundle['prev'])."""
    if bundle.get("schema") != SCHEMA:
        raise RoundError("schema")
    if canonical(bundle["params"]) != canonical(params):
        raise RoundError("bundle params differ from pinned params (refusing a silent re-weighting)")
    if canonical(bundle["prev"]) != canonical(prev_state):
        raise RoundError("bundle prev-state differs from own previous-round state")
    if bundle["chainId"] != params["chainId"] or bundle["pot"].lower() != params["pot"].lower():
        raise RoundError("chain/pot mismatch")
    rnd = int(bundle["round"])
    S, E = int(bundle["startBlock"]), int(bundle["endBlock"])
    if rnd != prev_state["round"] + 1:
        raise RoundError("round number")
    if S != prev_state["endBlock"] or E <= S:
        raise RoundError("block range")
    startTs, endTs = int(bundle["startTs"]), int(bundle["endTs"])
    received = int(bundle["receivedTotal"])
    prev_cum = {a: int(v) for a, v in prev_state["cumulative"].items()}
    prev_total = int(prev_state["total"])
    if sum(prev_cum.values()) != prev_total:
        raise RoundError("prev total != sum of prev cumulative")
    prev_held = {a: int(v) for a, v in prev_state["held"].items()}
    prev_lf = {a: int(v) for a, v in prev_state.get("lostFound", {}).items()}
    strikes = {a: int(v) for a, v in prev_state["strikes"].items()}

    # ---- exclusions: only meaningful after a guardian veto of this round (signers enforce that rule);
    #      public, with reasons, so every exclusion is auditable.
    exc = bundle.get("exclusions") or {"shares": [], "jobs": [], "reason": ""}
    exc_shares = {tuple(x) for x in exc.get("shares", [])}
    exc_jobs = set(exc.get("jobs", []))

    # ---- hash shares
    unit_diff = int(params["unitDiff"])
    seen = set()
    hash_units = {}
    templates = bundle.get("templates") or {}
    for s in bundle["shares"]:
        if (s["nonce"], s["hashNoNonce"]) in exc_shares:
            continue
        a = s["login"]
        if not ADDR.match(a) or a in params["denyLogins"]:
            raise RoundError(f"share login {a} invalid/reserved")
        if not (S < int(s["height"]) <= E):
            raise RoundError(f"share height {s['height']} outside ({S},{E}]")
        if not (NONCE.match(s["nonce"]) and HEX32.match(s["hashNoNonce"]) and HEX32.match(s["mixDigest"])):
            raise RoundError("share fields malformed")
        if int(s["diff"]) < int(params["minShareDiff"]):
            raise RoundError("share below minimum difficulty")
        key = (s["nonce"], s["hashNoNonce"])
        if key in seen:
            raise RoundError(f"duplicate share {key}")
        seen.add(key)
        if params["requireTemplates"] and s["hashNoNonce"] not in templates:
            raise RoundError(f"share {s['nonce']} has no template header (binding required)")
        hash_units[a] = hash_units.get(a, Fraction(0)) + Fraction(int(s["diff"]), unit_diff)

    # ---- AI jobs
    ai_units = {}
    jobs = set()
    w = Fraction(str(params["aiWeight"]))
    for rec in bundle["ai"]:
        if rec["job"] in exc_jobs:
            continue
        if rec["job"] in jobs:
            raise RoundError(f"duplicate AI job {rec['job']}")
        jobs.add(rec["job"])
        if not (startTs < int(rec["verifiedAt"]) <= endTs):
            raise RoundError(f"AI job {rec['job']} verified outside the round window")
        credited, struck = check_ai(rec, params)
        for a in struck:
            strikes[a] = strikes.get(a, 0) + 1
        for a in credited:
            ai_units[a] = ai_units.get(a, Fraction(0)) + Fraction(int(rec["milliWU"]), 1000) * w
    ban = int(params["banStrikes"])
    banned = {a for a, n in strikes.items() if n >= ban}

    # ---- release last round's vested AI earnings (forfeit if banned since)
    cum = dict(prev_cum)
    released, forfeited = {}, {}
    for a, amt in prev_held.items():
        if a in banned:
            forfeited[a] = amt
        else:
            cum[a] = cum.get(a, 0) + amt
            released[a] = amt

    # ---- Lost-and-Found: issuance from blocks/uncles whose HEADER coinbase is not the pool's is not share
    #      money; it is reserved for that coinbase address and released once it mines a valid pool share.
    pool_cb = {a.lower() for a in params["poolCoinbases"]}
    blocks = bundle["blocks"]
    if [b["number"] for b in blocks] != list(range(S + 1, E + 1)):
        raise RoundError("blocks list must cover exactly (startBlock, endBlock]")
    inflow = sum(int(b["amount"]) + sum(int(u["amount"]) for u in b["uncles"]) for b in blocks)
    if inflow != received - int(bundle["receivedAtStart"]):
        raise RoundError("per-block attribution does not add up to the pot's measured inflow")
    lf = dict(prev_lf)
    lf_entries, outside_new = [], 0
    for b in blocks:
        parts = [("winner", b["coinbase"], int(b["amount"]), b["number"], b["hash"])] + \
                [("uncle", u["coinbase"], int(u["amount"]), u["number"], u["hash"]) for u in b["uncles"]]
        for kind, cb, amt, num, h in parts:
            if not ADDR.match(cb):
                raise RoundError("bad coinbase")
            if cb in pool_cb or amt == 0:
                continue
            lf[cb] = lf.get(cb, 0) + amt
            outside_new += amt
            lf_entries.append({"address": cb, "kind": kind, "block": num, "hash": h, "inBlock": b["number"], "amount": str(amt)})
    miners_with_share = set(hash_units)          # valid pool share(s) this round under that exact login
    lf_released = {}
    for a in sorted(lf):
        if a in miners_with_share and lf[a] > 0:
            lf_released[a] = lf.pop(a)

    # ---- pre-fork baseline: whatever sat at the pot address before fork block F (round 1 starts at F-1) is
    #      pinned once and never distributed as shares; only issuance from F onward is.
    pre_fork = int(bundle["receivedAtStart"]) if prev_state.get("preFork") is None else int(prev_state["preFork"])
    if rnd == 1 and S != int(params["genesisStartBlock"]):
        raise RoundError("round 1 must start at genesisStartBlock (F-1)")

    # ---- distribute this round's inflow
    D = received - pre_fork - prev_total - sum(prev_held.values()) - sum(prev_lf.values()) - outside_new
    if D < 0:
        raise RoundError("receivedTotal below previous allocations")
    for a in banned:
        ai_units.pop(a, None)
    addrs = sorted(set(hash_units) | set(ai_units))
    U = sum(hash_units.values(), Fraction(0)) + sum(ai_units.values(), Fraction(0))
    hash_amt, held = {}, {}
    if U > 0:
        for a in addrs:
            h = int(Fraction(D) * hash_units.get(a, 0) / U)
            x = int(Fraction(D) * ai_units.get(a, 0) / U)
            if h:
                hash_amt[a] = h
                cum[a] = cum.get(a, 0) + h
            if x:
                held[a] = x
    for a, v in lf_released.items():
        cum[a] = cum.get(a, 0) + v
    cum = {a: v for a, v in cum.items() if v > 0}
    total = sum(cum.values())
    if pre_fork + total + sum(held.values()) + sum(lf.values()) > received:
        raise RoundError("solvency: allocations exceed receivedTotal")
    root, proofs, _ = merkle_build(cum)
    state = {"round": rnd, "root": root, "total": str(total), "endBlock": E,
             "cumulative": {a: str(v) for a, v in sorted(cum.items())},
             "held": {a: str(v) for a, v in sorted(held.items())},
             "strikes": {a: n for a, n in sorted(strikes.items())},
             "lostFound": {a: str(v) for a, v in sorted(lf.items()) if v > 0},
             "preFork": str(pre_fork)}
    return {
        "round": rnd, "root": root, "total": total, "endBlock": E, "inputsHash": inputs_hash(bundle),
        "distributable": D, "units": {a: {"hash": str(hash_units.get(a, 0)), "ai": str(ai_units.get(a, 0))} for a in addrs},
        "paidHash": hash_amt, "heldAI": held, "releasedAI": released, "forfeitedAI": forfeited,
        "banned": sorted(banned), "proofs": proofs, "state": state,
        "lostFoundEntries": lf_entries, "lostFoundReleased": lf_released,
    }


def receiver_csv(result):
    """Devcoin-style receiver_N.csv: address, cumulative, this-round hash, released AI, held AI."""
    st = result["state"]
    lines = ["address,cumulative_wei,round_hash_wei,released_ai_wei,held_ai_wei,lost_found_released_wei,lost_found_held_wei"]
    addrs = sorted(set(st["cumulative"]) | set(st["held"]) | set(st.get("lostFound", {})))
    for a in addrs:
        lines.append(f"{a},{st['cumulative'].get(a, '0')},{result['paidHash'].get(a, 0)},"
                     f"{result['releasedAI'].get(a, 0)},{st['held'].get(a, '0')},"
                     f"{result['lostFoundReleased'].get(a, 0)},{st.get('lostFound', {}).get(a, '0')}")
    return "\n".join(lines) + "\n"
