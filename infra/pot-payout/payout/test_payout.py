"""Offline unit tests for the round math, the AI-verdict validator and the Merkle tree."""
import copy, hashlib, json, os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import merkle, roundlib
from roundlib import RoundError, compute_round, genesis_state, llm_hash, embed_hash, sha256hex, canonical

A = "0x" + "aa" * 20
B = "0x" + "bb" * 20
C = "0x" + "cc" * 20
ANCHOR = "0x" + "a0" * 20
MSHA = "ab" * 32
POT = "0x" + "99" * 20

PARAMS = {"chainId": 7122179, "pot": POT, "unitDiff": 1000, "aiWeight": "1.0", "minShareDiff": 1000,
          "ecip1099FBlock": 0, "requireTemplates": False, "denyLogins": [POT], "banStrikes": 3,
          "anchors": [ANCHOR], "modelSha256": [MSHA], "genesisStartBlock": 10,
          "poolCoinbases": ["0x" + "11" * 20], "blockReward": "2000000000000000000", "feeBps": 200, "eraRounds": 2427507,
          "aiTypes": {"llm.generate": {"minQuorum": 2, "anchor": True},
                      "embed.text": {"minQuorum": 2, "anchor": True, "cosine": 0.9999}}}


def share(login, h, n, diff=1000):
    return {"login": login, "worker": "w", "height": h, "nonce": "0x%016x" % n, "hashNoNonce": "0x" + ("%064x" % (h * 7 + 1)),
            "mixDigest": "0x" + "11" * 32, "diff": diff, "tsMs": 0}


def llm_job(jid, workers, tokens, verdicts, credited=None, max_tokens=8, t=150, bad_tokens=None):
    params = {"max_tokens": max_tokens, "model_sha256": MSHA}
    inp = {"prompt": "hi"}
    subs = []
    for w, v in zip(workers, verdicts):
        tk = tokens if v == "match" else (bad_tokens or [9, 9])
        subs.append({"worker": w, "outputHash": llm_hash(tk), "output": {"token_ids": tk}, "verdict": v, "trusted": w == ANCHOR})
    return {"job": jid, "type": "llm.generate", "modelSha256": MSHA, "params": params, "input": inp,
            "inputHash": sha256hex(canonical(inp)), "paramsHash": sha256hex(canonical(params)), "k": 2,
            "milliWU": 1000 + 10 * max_tokens, "resultHash": llm_hash(tokens), "verifiedAt": t, "status": "verified",
            "submissions": subs, "credited": credited if credited is not None else sorted(w for w, v in zip(workers, verdicts) if v == "match")}


POOLCB = "0x" + "11" * 20
OUTSIDER = "0x" + "0e" * 20


def mkblocks(S, E, amount, start=0, outside=None):
    """(S,E]: block S+1 carries `amount` (pool coinbase); `outside` = [(offset, coinbase, amt, uncles)]."""
    bl = [{"number": n, "hash": "0x" + ("%064x" % n), "coinbase": POOLCB, "amount": "0", "uncles": []} for n in range(S + 1, E + 1)]
    bl[0]["amount"] = str(amount)
    for off, cb, amt, uncles in (outside or []):
        bl[off]["coinbase"] = cb; bl[off]["amount"] = str(amt); bl[off]["uncles"] = uncles
    return bl


def bundle(prev, shares=(), ai=(), received=10**18, rnd=None, S=None, E=None, start=None, outside=None):
    S = prev["endBlock"] if S is None else S
    E = E or S + 100
    if start is None:
        start = int(prev["total"]) + sum(int(v) for v in prev["held"].values()) + sum(int(v) for v in prev.get("lostFound", {}).values()) \
            + int(prev.get("preFork") or 0)
        start = min(start, received)
    out_total = sum(a + sum(int(u["amount"]) for u in us) for _, _, a, us in (outside or []))
    blocks = mkblocks(S, E, received - start - out_total, start, outside)
    return {"receivedAtStart": str(start), "blocks": blocks,"schema": roundlib.SCHEMA, "chainId": PARAMS["chainId"], "pot": POT, "round": rnd or prev["round"] + 1,
            "startBlock": S, "endBlock": E, "endBlockHash": "0x" + "00" * 32, "startTs": 100, "endTs": 200,
            "receivedTotal": str(received), "params": PARAMS, "prev": prev, "shares": list(shares),
            "templates": {}, "ai": list(ai), "exclusions": {"shares": [], "jobs": [], "reason": ""}}


class TestLostFound(unittest.TestCase):
    def test_outside_block_held_then_released_on_share(self):
        g = genesis_state(10)
        # 1000 in: 600 from a pool block, 300 from a block sealed by OUTSIDER, 100 from an uncle mined by OUTSIDER
        unc = [{"number": 15, "hash": "0x" + "ab" * 32, "coinbase": OUTSIDER, "amount": "100"}]
        r = compute_round(bundle(g, [share(A, 11, 1)], received=1000, start=0, outside=[(5, OUTSIDER, 300, unc)]), PARAMS, g)
        self.assertEqual(r["state"]["cumulative"], {A: "600"})           # share-holders get ONLY pool issuance
        self.assertEqual(r["state"]["lostFound"], {OUTSIDER: "400"})
        self.assertEqual(len(r["lostFoundEntries"]), 2)
        # outsider mines nothing in the pool next round: still held, never expires
        r2 = compute_round(bundle(r["state"], [share(A, 120, 2)], received=1000), PARAMS, r["state"])
        self.assertEqual(r2["state"]["lostFound"], {OUTSIDER: "400"})
        # it connects to the pool and gets one valid share: whole balance + its share earnings
        st = r2["state"]
        r3 = compute_round(bundle(st, [share(OUTSIDER, 220, 3), share(A, 221, 4)], received=1200), PARAMS, st)
        self.assertEqual(r3["state"]["lostFound"], {})
        self.assertEqual(r3["lostFoundReleased"], {OUTSIDER: 400})
        self.assertEqual(r3["state"]["cumulative"][OUTSIDER], str(400 + 100))  # 400 L&F + half of the 200 new
        self.assertLessEqual(r3["total"], 1200)

    def test_prefork_balance_never_distributed(self):
        g = genesis_state(10)
        # 5000 already at the pot address before F (pre-deploy credit); 1000 issued from F on
        r = compute_round(bundle(g, [share(A, 11, 1)], received=6000, start=5000), PARAMS, g)
        self.assertEqual(r["total"], 1000)
        self.assertEqual(r["state"]["preFork"], "5000")
        r2 = compute_round(bundle(r["state"], [share(A, 120, 2)], received=6500), PARAMS, r["state"])
        self.assertEqual(r2["total"], 1500)

    def test_attribution_must_add_up(self):
        g = genesis_state(10)
        b = bundle(g, [share(A, 11, 1)], received=1000, start=0)
        b["blocks"][0]["amount"] = "1001"
        with self.assertRaises(RoundError):
            compute_round(b, PARAMS, g)


class TestMerkle(unittest.TestCase):
    def test_roundtrip(self):
        cum = {A: 5, B: 7, C: 11, ANCHOR: 1}
        root, proofs, accts = merkle.build(cum)
        for a in accts:
            self.assertTrue(merkle.verify(root, a, cum[a], proofs[a]))
            self.assertFalse(merkle.verify(root, a, cum[a] + 1, proofs[a]))
        self.assertEqual(len(accts), 4)

    def test_single_leaf(self):
        root, proofs, _ = merkle.build({A: 3})
        self.assertEqual(root, "0x" + merkle.leaf(A, 3).hex())
        self.assertEqual(proofs[A], [])


class TestRound(unittest.TestCase):
    def test_pro_rata_and_carry(self):
        g = genesis_state(10)
        r = compute_round(bundle(g, [share(A, 11, 1), share(A, 12, 2), share(B, 13, 3)], received=100), PARAMS, g)
        self.assertEqual(r["state"]["cumulative"], {A: "66", B: "33"})
        self.assertEqual(r["total"], 99)  # 1 wei remainder stays unallocated -> next round
        r2 = compute_round(bundle(r["state"], [share(B, 120, 9)], received=100), PARAMS, r["state"])
        self.assertEqual(r2["state"]["cumulative"], {A: "66", B: "34"})

    def test_ai_vests_one_round_then_releases(self):
        g = genesis_state(10)
        job = llm_job("j1", [ANCHOR, B, C], [1, 2, 3], ["match", "match", "mismatch"])
        r = compute_round(bundle(g, [share(A, 11, 1, diff=1080)], [job], received=1000), PARAMS, g)
        # A: 1.08 hash units, ANCHOR and B: 1.08 AI units each -> 333 each; AI part held
        self.assertEqual(r["state"]["cumulative"], {A: "333"})
        self.assertEqual(r["state"]["held"], {ANCHOR: "333", B: "333"})
        self.assertEqual(r["state"]["strikes"], {C: 1})
        r2 = compute_round(bundle(r["state"], [], [], received=1000), PARAMS, r["state"])
        self.assertEqual(r2["state"]["cumulative"], {A: "333", ANCHOR: "333", B: "333"})
        self.assertEqual(r2["total"], 999)

    def test_banned_worker_forfeits_held(self):
        g = genesis_state(10)
        j1 = llm_job("j1", [ANCHOR, B, C], [1, 2], ["match", "match", "match"])
        g2 = dict(g, strikes={C: 2})
        r = compute_round(bundle(g2, [], [j1], received=900), PARAMS, g2)
        self.assertIn(C, r["state"]["held"])
        # next round C gets a third strike -> banned -> held forfeited (stays in the pot)
        j2 = llm_job("j2", [ANCHOR, B, C], [5], ["match", "match", "mismatch"], t=150)
        b2 = bundle(r["state"], [], [j2], received=900); b2["startTs"], b2["endTs"] = 100, 200
        r2 = compute_round(b2, PARAMS, r["state"])
        self.assertIn(C, r2["banned"])
        self.assertNotIn(C, r2["state"]["cumulative"])
        self.assertEqual(r2["forfeitedAI"][C], 300)
        self.assertLessEqual(r2["total"] + sum(int(v) for v in r2["state"]["held"].values()), 900)

    def test_rejects_duplicate_share(self):
        g = genesis_state(10)
        with self.assertRaises(RoundError):
            compute_round(bundle(g, [share(A, 11, 1), share(B, 11, 1)]), PARAMS, g)

    def test_rejects_param_reweighting(self):
        g = genesis_state(10)
        b = bundle(g, [share(A, 11, 1)]); b["params"] = dict(PARAMS, aiWeight="5.0")
        with self.assertRaises(RoundError):
            compute_round(b, PARAMS, g)

    def test_rejects_forged_prev_state(self):
        g = genesis_state(10)
        b = bundle(g, [share(A, 11, 1)]); b["prev"] = dict(g, cumulative={A: "0"})
        with self.assertRaises(RoundError):
            compute_round(b, PARAMS, g)

    def test_rejects_out_of_range_and_reserved(self):
        g = genesis_state(10)
        for bad in (share(A, 10, 1), share(A, 111, 1), share(POT, 11, 1), share(A, 11, 1, diff=10)):
            with self.assertRaises(RoundError):
                compute_round(bundle(g, [bad]), PARAMS, g)

    def test_ai_tamper_cases(self):
        g = genesis_state(10)
        ok = llm_job("j", [ANCHOR, B, C], [1, 2], ["match", "match", "mismatch"])
        compute_round(bundle(g, [], [ok]), PARAMS, g)
        cases = {}
        x = copy.deepcopy(ok); x["credited"] = [ANCHOR, B, C]; cases["credit a mismatching worker"] = x
        x = copy.deepcopy(ok); x["milliWU"] = 99999; cases["inflated milliWU"] = x
        x = llm_job("j", [B, C, A], [1, 2], ["match", "match", "mismatch"]); cases["no anchor (Sybil)"] = x
        x = copy.deepcopy(ok); x["submissions"][1]["output"]["token_ids"] = [7]; cases["output hash forged"] = x
        x = copy.deepcopy(ok); x["submissions"][2]["verdict"] = "match"; x["credited"] = [ANCHOR, B, C]; cases["disagreeing worker marked match"] = x
        x = copy.deepcopy(ok); x["modelSha256"] = "cd" * 32; cases["unpinned model"] = x
        x = copy.deepcopy(ok); x["input"] = {"prompt": "other"}; cases["input hash mismatch"] = x
        x = copy.deepcopy(ok); x["verifiedAt"] = 250; cases["verified outside round window"] = x
        x = llm_job("j", [ANCHOR, B], [1, 2], ["match", "mismatch"]); x["credited"] = [ANCHOR]; cases["below quorum"] = x
        for name, rec in cases.items():
            with self.subTest(name):
                with self.assertRaises(RoundError):
                    compute_round(bundle(g, [], [rec]), PARAMS, g)
        with self.assertRaises(RoundError):
            compute_round(bundle(g, [], [ok, copy.deepcopy(ok)]), PARAMS, g)  # replayed job id

    def test_embed_cosine(self):
        g = genesis_state(10)
        v = [0.6, 0.8, 0.0]; v2 = [0.600001, 0.799999, 0.0]; bad = [0.0, 0.0, 1.0]
        params = {"model_sha256": MSHA}; inp = {"texts": ["x"]}
        subs = [{"worker": ANCHOR, "outputHash": embed_hash(v), "output": {"vector": v}, "verdict": "match"},
                {"worker": B, "outputHash": embed_hash(v2), "output": {"vector": v2}, "verdict": "match"},
                {"worker": C, "outputHash": embed_hash(bad), "output": {"vector": bad}, "verdict": "mismatch"}]
        rec = {"job": "e1", "type": "embed.text", "modelSha256": MSHA, "params": params, "input": inp,
               "inputHash": sha256hex(canonical(inp)), "paramsHash": sha256hex(canonical(params)), "k": 2, "milliWU": 200,
               "resultHash": embed_hash(v), "verifiedAt": 150, "status": "verified", "submissions": subs, "credited": [ANCHOR, B]}
        r = compute_round(bundle(g, [], [rec], received=1000), PARAMS, g)
        self.assertEqual(set(r["state"]["held"]), {ANCHOR, B})

    def test_solvency_negative_distributable(self):
        g = dict(genesis_state(10), cumulative={A: "500"}, total="500")
        with self.assertRaises(RoundError):
            compute_round(bundle(g, [share(B, 11, 1)], received=400), PARAMS, g)

    def test_exclusions_skip(self):
        g = genesis_state(10)
        s1, s2 = share(A, 11, 1), share(B, 12, 2)
        b = bundle(g, [s1, s2], received=100)
        b["exclusions"] = {"shares": [[s2["nonce"], s2["hashNoNonce"]]], "jobs": [], "reason": "test"}
        r = compute_round(b, PARAMS, g)
        self.assertEqual(r["state"]["cumulative"], {A: "100"})

    def test_deterministic(self):
        g = genesis_state(10)
        b = bundle(g, [share(A, 11, 1), share(B, 13, 3)], received=12345)
        self.assertEqual(compute_round(b, PARAMS, g)["root"], compute_round(json.loads(canonical(b)), PARAMS, g)["root"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
