"""End-to-end payout devnet run (after up.sh + deploy.py). Prints a transcript of every step."""
import json, os, socket, subprocess, sys, time, urllib.request
sys.path.insert(0, "/root/prana-payout/payout")
from chain import RPC, Pot, encode_call, load_key, send_tx

D = os.path.dirname(os.path.abspath(__file__)); A = json.load(open(f"{D}/addresses.json"))
PY = "/root/prana-payout/venv/bin/python"; HPY = "/opt/hathor-lm/venv/bin/python"; B = "/root/prana-payout/bin"
rpc = RPC("http://127.0.0.1:8611"); pot = Pot(rpc, A["POT"]); F = A["F"]; CID = A["CHAIN_ID"]
cfg2 = json.load(open(f"{D}/potd2.json")); RB, DEPTH = cfg2["roundBlocks"], cfg2["depth"]
procs = []


def T(step, **kw):
    print(json.dumps({"t": time.strftime("%H:%M:%S"), "step": step, **kw}), flush=True)


def head():
    return int(rpc("eth_blockNumber"), 16)


def bal(a, blk="latest"):
    return int(rpc("eth_getBalance", [a, blk if isinstance(blk, str) else hex(blk)]), 16)


def wait_head(n):
    while head() < n:
        time.sleep(2)


def run(args, timeout=900):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=D)
    for line in (p.stdout + p.stderr).strip().splitlines():
        print("   | " + line[:400], flush=True)
    return p


def bg(name, args, nice=15):
    f = open(f"{D}/logs/{name}.log", "w")
    p = subprocess.Popen(["nice", "-n", str(nice)] + args, stdout=f, stderr=subprocess.STDOUT, cwd=D)
    procs.append(p); return p


def stratum_login(login, src="127.0.0.3"):
    s = socket.create_connection(("127.0.0.1", 8018), timeout=5, source_address=(src, 0))
    s.sendall((json.dumps({"id": 1, "method": "eth_submitLogin", "params": [login], "worker": "t"}) + "\n").encode())
    r = s.makefile().readline(); s.close(); return json.loads(r)


try:
    T("fork-config", potAddress=A["POT"], F=F, chainId=CID, head=head())
    # ---------------------------------------------------------------- pool hardening checks
    m2 = A["miner2"]["address"]
    for name, login in [("lowercase (not EIP-55)", m2.lower()), ("pot contract (reserved)", A["POT"]),
                        ("Hathor treasury (reserved)", "0xF129608bF3BA681012CF82DFfCfBB92563df987e"),
                        ("bad checksum", m2[:-1] + ("a" if m2[-1] != "a" else "b")), ("garbage", "0x1234"),
                        ("valid EIP-55", m2)]:
        r = stratum_login(login)
        T("stratum-login", case=name, login=login, result=r.get("result"), error=(r.get("error") or {}).get("message"))
    bg("miner2-adversarial", [f"{B}/devminer", "-pool", "127.0.0.1:8018", "-bind", "127.0.0.2", "-login", m2, "-worker",
                              "rig2", "-threads", "1", "-forge-every", "3", "-dup-every", "4", "-stale-test"])
    # ---------------------------------------------------------------- AI fleet
    bg("fleetq", [PY, "/root/prana-payout/lanes/fleetq.py", "--db", f"{D}/fleetq.sqlite", "--port", "8621",
                  "--redis-port", "0", "--trusted", A["anchor"]["address"]], nice=5)
    bg("pubhttp", [PY, "-m", "http.server", "8631", "--bind", "127.0.0.1", "--directory", f"{D}/pub"], nice=5)
    for i in (1, 2, 3):
        os.makedirs(f"{D}/sigs/signer{i}", exist_ok=True)
        bg(f"sighttp{i}", [PY, "-m", "http.server", str(8640 + i), "--bind", "127.0.0.1", "--directory", f"{D}/sigs/signer{i}"], nice=5)
    time.sleep(2)
    wait_head(F + 1)
    sha = "88021b98a2bc3138b2d8f7cb48754822d3f29322f5e96291133cc8a512be787d"
    jobs = [{"type": "llm.generate", "origin": "hathor-brain/perceive", "params": {"max_tokens": 24, "model_sha256": sha}, "input": {"prompt": "I am"}},
            {"type": "llm.generate", "origin": "annals", "params": {"max_tokens": 24, "model_sha256": sha}, "input": {"prompt": "In the beginning the Watchers"}},
            {"type": "llm.generate", "origin": "discord-bot", "params": {"max_tokens": 16, "model_sha256": sha}, "input": {"prompt": "Rule 1:"}},
            {"type": "embed.text", "origin": "library-rag", "params": {"model_sha256": sha}, "input": {"texts": ["Library of Ashurbanipal", "Hathor of the Sycamore"]}},
            {"type": "embed.text", "origin": "crypt-ology", "params": {"model_sha256": sha}, "input": {"texts": ["MELEK witness"]}}]
    ids = []
    for j in jobs:
        j["model"] = "hathor0-v1"
        req = urllib.request.Request("http://127.0.0.1:8621/jobs", json.dumps(j).encode(), {"Content-Type": "application/json"})
        ids.append(json.loads(urllib.request.urlopen(req).read())["id"])
    T("ai-jobs-posted", ids=ids, head=head())
    for w, extra in [("anchor", []), ("ext1", []), ("ext2", []), ("cheat", ["--tamper"])]:
        bg(f"worker-{w}", [HPY, "/root/prana-payout/lanes/fleet_worker.py", "--queue", "http://127.0.0.1:8621", "--address",
                           A[w]["address"], "--idle-exit", "6", "--threads", "2"] + extra)
    # ---------------------------------------------------------------- rounds
    relay_cfg = json.load(open(f"{D}/relay.json")); relayer = load_key(relay_cfg["key"])
    max_rounds = int(os.environ.get("ROUNDS", "9"))
    veto_done = False; released_done = False
    out_addr = A["outsider"]["address"]
    for rnd in range(1, max_rounds + 1):
        end = F - 1 + rnd * RB
        if rnd == 2:
            T("OUTSIDER-JOINS-POOL", note="the outside miner's coinbase address now logs in to the pool (EIP-55) and submits shares")
            bg("outsider-pool-miner", [f"{B}/devminer", "-pool", "127.0.0.1:8018", "-bind", "127.0.0.6", "-login", out_addr,
                                       "-worker", "joined", "-threads", "1"])
        T("round-wait", round=rnd, endBlock=end, need=end + DEPTH, head=head())
        wait_head(end + DEPTH)
        if rnd == 1:
            st = [json.loads(urllib.request.urlopen(f"http://127.0.0.1:8621/jobs/{i}").read()) for i in ids]
            T("ai-verdicts", jobs=[{"id": j["id"], "type": j["type"], "status": j["status"], "milliWU": j["milliWU"],
                                    "subs": [(s["worker"][-4:], s["hash"][:10], s["verdict"]) for s in j["submissions"]]} for j in st])
        run([PY, "/root/prana-payout/payout/potd2.py", f"{D}/potd2.json"])
        prop = json.load(open(f"{D}/pub/round_{rnd}/proposal.json"))
        T("proposal", **prop)
        if rnd == 2:
            T("ATTACK-forged-share-bundle", note="compromised coordinator injects a forged share for the attacker")
            run([PY, f"{D}/forged_round.py", str(rnd), A["attacker"]["address"]])
        for i in (1, 2):
            run([PY, "/root/prana-payout/payout/signer.py", f"{D}/signer{i}.json"])
        T("ATTACK-malicious-signer", note="signer3 signs a root paying everything to the attacker")
        run([PY, f"{D}/evil_signer.py", f"{D}/signer3.json", A["attacker"]["address"], str(rnd), f"{D}/sigs/signer1/round_{rnd}.json"])
        run([PY, "/root/prana-payout/payout/relay.py", f"{D}/relay.json"])
        pend = pot.pending(); T("pending", **{k: v for k, v in pend.items()})
        assert pend["root"] == prop["root"], "honest root not pending"
        logins_in_round = {sh["login"] for sh in json.loads(open(f"{D}/pub/round_{rnd}/inputs.json", "rb").read())["shares"]}
        if not veto_done and len(logins_in_round) >= 2:
            veto_done = True
            T("GUARDIAN-VETO", note=f"guardian vetoes round {rnd} inside the window (simulating a dispute)")
            g = load_key({"keyFile": f"{D}/keys/guardian.key"})
            rc = send_tx(rpc, g, A["POT"], encode_call("veto(uint64)", ["uint64"], [rnd]), chain_id=CID)
            old = [json.load(open(f"{D}/sigs/signer{i}/round_{rnd}.json")) for i in (1, 2)]
            old.sort(key=lambda x: int(x["signer"], 16))
            data = encode_call("postRoot(uint64,bytes32,uint256,bytes32,uint64,bytes[])",
                               ["uint64", "bytes32", "uint256", "bytes32", "uint64", "bytes[]"],
                               [rnd, bytes.fromhex(old[0]["root"][2:]), int(old[0]["total"]), bytes.fromhex(old[0]["inputsHash"][2:]),
                                old[0]["endBlock"], [bytes.fromhex(x["sig"][2:]) for x in old]])
            try:
                rpc("eth_call", [{"from": relayer.address, "to": A["POT"], "data": "0x" + data.hex()}, "latest"])
                T("repost-vetoed-root", result="UNEXPECTEDLY SUCCEEDS")
            except RuntimeError as e:
                T("repost-vetoed-root", note="re-post of the vetoed root with its 2 original valid signatures", result="reverted", err=str(e)[:110])
            T("vetoed", status=rc["status"], pendingAfter=pot.pending()["root"], vetoedRoots=sorted(pot.vetoed_roots(rnd)))
            # operator publishes an auditable exclusion (one share) and the round is recomputed + re-signed
            b = json.loads(open(f"{D}/pub/round_{rnd}/inputs.json", "rb").read())
            # exclude one share of the least-represented login so the split (and root) actually changes
            cnt = {}
            for sh in b["shares"]: cnt[sh["login"]] = cnt.get(sh["login"], 0) + 1
            x = [sh for sh in b["shares"] if sh["login"] == min(cnt, key=cnt.get)][0]
            T("veto-drill-exclusion", login=x["login"], nonce=x["nonce"], loginsInRound=cnt)
            c2 = json.load(open(f"{D}/potd2.json"))
            c2["exclusions"] = {str(rnd): {"shares": [[x["nonce"], x["hashNoNonce"]]], "jobs": [], "reason": "devnet veto drill"}}
            json.dump(c2, open(f"{D}/potd2.json", "w"), indent=1)
            run([PY, "/root/prana-payout/payout/potd2.py", f"{D}/potd2.json"])
            prop = json.load(open(f"{D}/pub/round_{rnd}/proposal.json")); T("re-proposal", **prop)
            for i in (1, 2):
                run([PY, "/root/prana-payout/payout/signer.py", f"{D}/signer{i}.json"])
            for i in (1, 2):
                run([PY, "/root/prana-payout/payout/signer.py", f"{D}/signer{i}.json"])
            run([PY, "/root/prana-payout/payout/relay.py", f"{D}/relay.json"])
            pend = pot.pending(); T("pending-after-veto", **pend)
            assert pend["root"] == prop["root"]
        # early claim must fail during the window
        rf = json.load(open(f"{D}/pub/round_{rnd}/round.json"))
        a0 = sorted(rf["cumulative"])[0]
        try:
            rpc("eth_call", [{"to": A["POT"], "data": "0x" + encode_call("claim(address,uint256,bytes32[])", ["address", "uint256", "bytes32[]"],
                [a0, int(rf["cumulative"][a0]), [bytes.fromhex(p[2:]) for p in rf["proofs"][a0]]]).hex()}, "latest"])
            T("early-claim", result="UNEXPECTEDLY SUCCEEDS")
        except RuntimeError as e:
            T("early-claim-in-window", result="reverted", err=str(e)[:140])
        time.sleep(pot.challenge_period() + 5)
        for _ in range(60):
            run([PY, "/root/prana-payout/payout/relay.py", f"{D}/relay.json"])
            if pot.current_round() == rnd:
                break
            time.sleep(5)
        T("finalized", currentRound=pot.current_round(), active=pot.active(), receivedTotal=pot.received_total("latest"))
        for i in (1, 2):
            run([PY, "/root/prana-payout/payout/signer.py", f"{D}/signer{i}.json"])  # promote own state
        rf = json.load(open(f"{D}/pub/round_{rnd}/round.json"))
        T("lost-and-found", round=rnd, held=rf.get("lostFound"), released=rf.get("lostFoundReleased"),
          newEntries=len(rf.get("lostFoundEntries", [])), sample=rf.get("lostFoundEntries", [])[:3],
          outsiderInCumulative=rf["cumulative"].get(out_addr.lower(), "0"))
        print("   receiver csv:\n" + "".join("   | " + l for l in open(f"{D}/pub/round_{rnd}/receiver_{rnd}.csv")), flush=True)
        if not released_done and out_addr.lower() in rf.get("lostFoundReleased", {}):
            released_done = True
            cum = int(rf["cumulative"][out_addr.lower()]); prf = [bytes.fromhex(p[2:]) for p in rf["proofs"][out_addr.lower()]]
            atk = load_key({"keyFile": f"{D}/keys/attacker.key"})
            sig = "claim(address,uint256,bytes32[])"; ty = ["address", "uint256", "bytes32[]"]
            try:   # attacker presents the outsider's amount+proof for ITSELF
                rpc("eth_call", [{"from": atk.address, "to": A["POT"], "data": "0x" + encode_call(sig, ty, [atk.address, cum, prf]).hex()}, "latest"])
                T("LF-theft-attempt", result="UNEXPECTEDLY SUCCEEDS")
            except RuntimeError as e:
                T("LF-theft-attempt", how="claim(attacker, outsiderAmount, outsiderProof)", result="reverted", err=str(e)[:120])
            ab, ob = bal(atk.address), bal(out_addr)
            rc = send_tx(rpc, atk, A["POT"], encode_call(sig, ty, [out_addr, cum, prf]), chain_id=CID)
            gas = int(rc["gasUsed"], 16) * int(rc["effectiveGasPrice"], 16)
            T("LF-redirect-attempt", how="attacker calls claim(outsider, ...) hoping to receive it", status=rc["status"],
              attackerGain=bal(atk.address) - ab + gas, outsiderGain=bal(out_addr) - ob, outsiderCumulative=cum)
            T("outsider-own-claim", note="already paid in full -> NothingToClaim expected")
            run([PY, f"{D}/claim.py", "http://127.0.0.1:8611", "http://127.0.0.1:8631", f"{D}/keys/outsider.key", A["POT"], str(CID)])
        if A["miner1"]["address"].lower() in rf["cumulative"]:
            T("pull-claim", who="miner1")
            run([PY, f"{D}/claim.py", "http://127.0.0.1:8611", "http://127.0.0.1:8631", A["miner1"]["address"] and f"{D}/keys/miner1.key", A["POT"], str(CID)])
        T("push-claimMany", note="relayer pushes every remaining balance (recipients pay no gas)")
        run([PY, "/root/prana-payout/payout/relay.py", f"{D}/relay.json", "--push-max-wei", str(10**30)])
        accts = {n: A[n]["address"] for n in ("miner1", "miner2", "anchor", "ext1", "ext2", "cheat", "attacker", "outsider")}
        T("balances", **{n: {"claimed": pot.claimed(a), "cumulative": rf["cumulative"].get(a.lower(), "0"),
                             "held": rf["heldAI"].get(a.lower(), "0")} for n, a in accts.items()})
        T("solvency", potBalance=bal(A["POT"]), totalClaimed=pot.total_claimed(), receivedTotal=pot.received_total("latest"),
          activeTotal=pot.active()["total"], lostFoundHeld=sum(int(v) for v in rf.get("lostFound", {}).values()))
        if released_done and veto_done:
            break
    # ---------------------------------------------------------------- pool adversary: forged + stale shares
    for name, args, ip in [("forger", ["-forge-every", "1", "-shares", "4"], "127.0.0.4"),
                           ("stale", ["-stale-test", "-shares", "400"], "127.0.0.5")]:
        p = subprocess.run(["timeout", "240", f"{B}/devminer", "-pool", "127.0.0.1:8018", "-bind", ip, "-login", m2,
                            "-worker", name, "-threads", "1"] + args, capture_output=True, text=True, cwd=D)
        replies = [json.loads(l) for l in p.stdout.splitlines() if '"event":"reply"' in l]
        bad = [r for r in replies if r["kind"] != "share"]
        T("pool-adversary", miner=name, sharesAccepted=sum(1 for r in replies if r["kind"] == "share" and r["accepted"]),
          adversarial=[{"kind": r["kind"], "accepted": r["accepted"], "reply": r["reply"][:80], "nonce": r["nonce"]} for r in bad])
        log = subprocess.run(["redis-cli", "-p", "6395", "zrange", "etc:sharelog", "0", "-1"], capture_output=True, text=True).stdout
        T("pool-adversary-sharelog", miner=name, adversarialNoncesInShareLog=[r["nonce"] for r in bad if r["nonce"] in log])
    # ---------------------------------------------------------------- consensus check around F
    rows = []
    cb = {}
    for n in range(F, head()):
        m = rpc("eth_getBlockByNumber", [hex(n), False])["miner"].lower(); cb[m] = cb.get(m, 0) + 1
    T("block-coinbases-since-F", counts=cb)
    for n in range(F - 2, F + 4):
        b = rpc("eth_getBlockByNumber", [hex(n), False])
        rows.append({"block": n, "sealer": b["miner"], "dSealer": bal(b["miner"], n) - bal(b["miner"], n - 1),
                     "dTreasury": bal("0xF129608bF3BA681012CF82DFfCfBB92563df987e", n) - bal("0xF129608bF3BA681012CF82DFfCfBB92563df987e", n - 1),
                     "dPot": bal(A["POT"], n) - bal(A["POT"], n - 1), "txs": len(b["transactions"]), "uncles": len(b["uncles"])})
    T("fork-reward-split", rows=rows)
    T("share-log", recorded=int(subprocess.run(["redis-cli", "-p", "6395", "zcard", "etc:sharelog"], capture_output=True, text=True).stdout))
    T("DONE")
finally:
    for p in procs:
        p.terminate()
