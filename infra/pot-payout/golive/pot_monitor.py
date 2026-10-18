#!/usr/bin/env python3
"""PRANA pot monitor (RUNBOOK sec. 9). Runs from a systemd timer, prints one JSON line per check to journald.
Lines with "level":"ALERT" are the ones to page on:  journalctl -t prana-pot-monitor | grep ALERT
Roles:  coordinator  -> pot inflow per block after F, contract state, pool, coordinator services, signer sig URLs
        signer       -> local signer services + own archive node lag vs the public RPC
Stdlib only. Reads chain state only; holds no key."""
import json, os, socket, subprocess, sys, time, urllib.request

POT = "0x0cF0AcbDEc814cD140b5e12A6E01EcE9F0D7410B"
F = 169532
MIN_INFLOW = 1960000000000000000          # 98% of 2 PRANA; uncles only add
TREASURY = "0xBD749b16E83D0c81fbCE8fC72005E81f3b3180ff"
PUBLIC_RPC = "https://rpc.prana.melek.salon"
STATE = "/var/lib/prana-pot-monitor/state.json"


def out(level, check, **kw):
    print(json.dumps({"level": level, "check": check, **kw}), flush=True)


def rpc(url, method, params=None, timeout=15):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    r = urllib.request.urlopen(urllib.request.Request(url, body, {"Content-Type": "application/json"}), timeout=timeout)
    j = json.loads(r.read())
    if j.get("error"):
        raise RuntimeError(f"{method}: {j['error']}")
    return j["result"]


def call(url, sig_hex, block="latest"):
    return rpc(url, "eth_call", [{"to": POT, "data": sig_hex}, block])


def units(names):
    for u in names:
        st = subprocess.run(["systemctl", "is-active", u], capture_output=True, text=True).stdout.strip()
        out("OK" if st == "active" else "ALERT", "unit", unit=u, state=st)


def port(host, p):
    try:
        socket.create_connection((host, p), timeout=5).close()
        out("OK", "port", port=p)
    except OSError as e:
        out("ALERT", "port", port=p, err=str(e))


def archive_lag(local="http://127.0.0.1:8597"):
    try:
        mine = int(rpc(local, "eth_blockNumber"), 16)
        ref = int(rpc(PUBLIC_RPC, "eth_blockNumber"), 16)
        code = rpc(local, "eth_getCode", [POT, "latest"])
        lvl = "OK" if ref - mine <= 10 and code not in ("0x", "0x0") else "ALERT"
        out(lvl, "archive_node", head=mine, publicHead=ref, lag=ref - mine, potCodeVisible=code not in ("0x", "0x0"))
    except Exception as e:
        out("ALERT", "archive_node", err=str(e)[:200])


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w") as f:
        json.dump(s, f)
    os.replace(STATE + ".tmp", STATE)


def received(url, block):
    bal = int(rpc(url, "eth_getBalance", [POT, block]), 16)
    tc = int(call(url, "0xd54ad2a1", block), 16)            # totalClaimed()
    return bal + tc


def coordinator(node="http://127.0.0.1:8557"):
    units(["prana-pool", "prana-pot-potd2", "prana-pot-fleetq", "prana-pot-publish-http", "prana-pot-archive",
           "prana-mainnet-node"])
    port("127.0.0.1", 3333); port("127.0.0.1", 8080)
    # signer sig endpoints: set POT_SIGNER_SIG_URLS="http://<signer-1>:8641/ http://<signer-2>:8641/ ..." (not committed)
    for u in os.environ.get("POT_SIGNER_SIG_URLS", "").split():
        try:
            urllib.request.urlopen(u, timeout=8)
            out("OK", "signer_sig_url", url=u)
        except Exception as e:
            out("ALERT", "signer_sig_url", url=u, err=str(e)[:120])
    s = load_state()
    head = int(rpc(node, "eth_blockNumber"), 16)
    cur = int(call(node, "0x8a19c8bc"), 16)                   # currentRound()
    paused = int(call(node, "0x5c975abb"), 16)                # paused()
    pend = call(node, "0xe20ccec3")                           # pending()
    pend_root = "0x" + pend[2:66]
    tot_claimed = int(call(node, "0xd54ad2a1"), 16)
    bal = int(rpc(node, "eth_getBalance", [POT, "latest"]), 16)
    out("OK", "pot_state", head=head, F=F, blocksToF=max(0, F - head), currentRound=cur, paused=bool(paused),
        pendingRoot=pend_root, totalClaimed=str(tot_claimed), balance=str(bal))
    if paused:
        out("ALERT", "pot_paused")
    if head < F:
        # before F nothing may move: no issuance into the pot, no round, nothing claimed
        if cur != 0 or tot_claimed != 0 or pend_root != "0x" + "0" * 64:
            out("ALERT", "pre_fork_activity", currentRound=cur, totalClaimed=str(tot_claimed), pendingRoot=pend_root)
    else:
        last = max(int(s.get("lastBlock", F - 1)), head - 120)  # non-archive node: stay inside the 128-state window
        prev = received(node, hex(last))
        bad = []
        for n in range(last + 1, head + 1):
            cur_r = received(node, hex(n))
            d = cur_r - prev; prev = cur_r
            if d < MIN_INFLOW:
                b = rpc(node, "eth_getBlockByNumber", [hex(n), False])
                bad.append({"block": n, "inflow": str(d), "miner": b["miner"]})
        out("ALERT" if bad else "OK", "pot_inflow", fromBlock=last + 1, toBlock=head, badBlocks=bad[:20])
        s["lastBlock"] = head
    tb = int(rpc(node, "eth_getBalance", [TREASURY, "latest"]), 16)
    if "treasury" in s and int(s["treasury"]) != tb and head >= F:
        out("WARN", "treasury_balance_changed", old=s["treasury"], new=str(tb))
    s["treasury"] = str(tb)
    save_state(s)


def signer():
    units(["prana-pot-signer", "prana-pot-sigs-http", "prana-pot-archive"])
    archive_lag()
    # surface signer refusals / alerts from the last interval
    j = subprocess.run(["journalctl", "-u", "prana-pot-signer", "--since", "-6min", "-o", "cat", "--no-pager"],
                       capture_output=True, text=True).stdout
    hits = [l for l in j.splitlines() if any(k in l for k in ("REFUSED", "ALERT", "EQUIVOCATION"))]
    errs = [l for l in j.splitlines() if '"error"' in l]
    out("ALERT" if hits else "OK", "signer_log", refusals=len(hits), sample=hits[-1][:300] if hits else None)
    out("WARN" if errs else "OK", "signer_errors", n=len(errs), sample=errs[-1][:200] if errs else None)


if __name__ == "__main__":
    role = sys.argv[1]
    try:
        coordinator() if role == "coordinator" else signer()
        if role == "coordinator":
            archive_lag()
    except Exception as e:
        out("ALERT", "monitor_failed", err=str(e)[:300])
