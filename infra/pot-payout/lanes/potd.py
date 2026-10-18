#!/usr/bin/env python3
"""PRANA pot distributor (see-saw, DevCoin-simple).

The fork pays 98% of every block reward to the pool payout wallet by consensus.
Each epoch of E blocks this sidecar:
  1. measures what actually flowed INTO the payout wallet in that epoch, chain-side:
       inflow = bal(end) - bal(start) + sum(outgoing value + gas of txs sent BY the wallet in (start,end])
     (independent of the exact fork formula; any donation to the wallet is shared too),
  2. takes the PPLNS window = the newest `windowUnits` normalized share-units from the pool's
     unified share log (hash shares + verified AI-work credits, one table),
  3. credits each login pro-rata into the pool's own `miners:<login>.balance` (Shannon),
     which the stock open-etc-pool payer then pays. No pool fee (Hathor's 2% is consensus-side).

Normalization (the see-saw knobs, config):
  hash entry  "h:<login>:<diff>:<ts>"                   -> units = diff / unitDiff
  AI entry    "a:<login>:<milliWU>:<ts>:<type>:<jobid>" -> units = milliWU/1000 * aiWeight
Replay safety: SETNX <prefix>:pot:done:<endHeight> inside the commit; epochs are processed in order.
"""
import json, sys, time, argparse, urllib.request
from fractions import Fraction

SHANNON = 10**9

# ---------- pure functions (unit-tested) ----------
def parse_entry(e):
    p = e.split(":")
    if p[0] == "h" and len(p) >= 4:
        return {"kind": "hash", "login": p[1].lower(), "amount": int(p[2]), "ts": int(p[3])}
    if p[0] == "a" and len(p) >= 6:
        return {"kind": "ai", "login": p[1].lower(), "amount": int(p[2]), "ts": int(p[3]),
                "type": p[4], "job": ":".join(p[5:])}
    return None

def entry_units(ent, unit_diff, ai_weight):
    if ent["kind"] == "hash":
        return Fraction(ent["amount"], unit_diff)
    return Fraction(ent["amount"], 1000) * Fraction(str(ai_weight))

def pplns_window(entries, window_units, unit_diff, ai_weight, cutoff_ts=None):
    """entries newest-first. Returns ({login: Fraction units}, {login: {'hash':u,'ai':u}}, used_units)."""
    need = Fraction(str(window_units))
    got = Fraction(0)
    per, split = {}, {}
    for raw in entries:
        ent = parse_entry(raw) if isinstance(raw, str) else raw
        if ent is None or (cutoff_ts is not None and ent["ts"] > cutoff_ts):
            continue
        u = entry_units(ent, unit_diff, ai_weight)
        if u <= 0:
            continue
        if got + u > need:            # last share counted partially -> window is exactly N units
            u = need - got
        per[ent["login"]] = per.get(ent["login"], 0) + u
        s = split.setdefault(ent["login"], {"hash": Fraction(0), "ai": Fraction(0)})
        s[ent["kind"]] += u
        got += u
        if got >= need:
            break
    return per, split, got

def split_pot(pot_wei, per):
    """Floor to Shannon; remainder (wei) carried to the next epoch. Returns ({login: shannon}, carry_wei)."""
    total = sum(per.values())
    if pot_wei <= 0 or total == 0:
        return {}, max(pot_wei, 0)
    out, paid = {}, 0
    for login, u in sorted(per.items()):
        sh = int(Fraction(pot_wei) * u / total) // SHANNON
        if sh > 0:
            out[login] = sh
            paid += sh * SHANNON
    return out, pot_wei - paid

# ---------- chain ----------
class RPC:
    def __init__(self, url): self.url = url
    def __call__(self, m, p):
        r = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), {"Content-Type": "application/json"}), timeout=20)
        j = json.loads(r.read())
        if j.get("error"): raise RuntimeError(f"{m}: {j['error']}")
        return j["result"]

def epoch_inflow(rpc, addr, start_h, end_h, start_bal):
    addr = addr.lower()
    end_bal = int(rpc("eth_getBalance", [addr, hex(end_h)]), 16)
    out, n_out, coinbase_blocks = 0, 0, 0
    for h in range(start_h + 1, end_h + 1):
        b = rpc("eth_getBlockByNumber", [hex(h), True])
        if b["miner"].lower() == addr: coinbase_blocks += 1
        for tx in b["transactions"]:
            if tx["from"].lower() == addr:
                rc = rpc("eth_getTransactionReceipt", [tx["hash"]])
                gp = int(rc.get("effectiveGasPrice") or tx["gasPrice"], 16)
                out += int(tx["value"], 16) + int(rc["gasUsed"], 16) * gp
                n_out += 1
    inflow = end_bal - start_bal + out
    return {"endBalance": end_bal, "outflowWei": out, "outTxs": n_out,
            "inflowWei": max(inflow, 0), "blocksMinedToWallet": coinbase_blocks,
            "endTs": int(b["timestamp"], 16)}

# ---------- redis (tiny RESP client: no third-party deps) ----------
import socket
class Redis:
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
            d = self.f.read(n + 2)[:-2]; return d.decode()
        if t == b"*":
            n = int(r); return None if n < 0 else [self._read() for _ in range(n)]
        raise RuntimeError("bad reply")

# ---------- one epoch ----------
def run_once(cfg, dry_run=True, entries_override=None, log=print):
    rpc, P = RPC(cfg["rpc"]), cfg["prefix"]
    r = Redis(cfg.get("redisHost", "127.0.0.1"), cfg.get("redisPort", 6379), cfg.get("redisDb", 0))
    tip = int(rpc("eth_blockNumber", []), 16)
    target = tip - cfg["depth"]
    st = r.cmd("HGETALL", f"{P}:pot:state") or []
    st = dict(zip(st[::2], st[1::2]))
    if not st and not dry_run:
        bal = int(rpc("eth_getBalance", [cfg["potAddress"], hex(target)]), 16)
        r.cmd("HSET", f"{P}:pot:state", "height", target, "balance", bal, "carry", 0)
        log(json.dumps({"init": True, "height": target})); return None
    if st:
        start_h, start_bal, carry = int(st["height"]), int(st["balance"]), int(st.get("carry", 0))
    else:  # dry run with no state: the epoch ending at target
        start_h = target - cfg["epochBlocks"]
        start_bal = int(rpc("eth_getBalance", [cfg["potAddress"], hex(start_h)]), 16); carry = 0
    end_h = start_h + cfg["epochBlocks"]
    if end_h > target:
        log(json.dumps({"wait": True, "need": end_h, "target": target})); return None
    flow = epoch_inflow(rpc, cfg["potAddress"], start_h, end_h, start_bal)
    pot = flow["inflowWei"] + carry
    entries = entries_override if entries_override is not None else \
        (r.cmd("LRANGE", f"{P}:pplns", 0, cfg.get("maxScan", 200000) - 1) or [])
    per, split, used = pplns_window(entries, cfg["windowUnits"], cfg["unitDiff"], cfg["aiWeight"], flow["endTs"])
    pay, new_carry = split_pot(pot, per)
    total = sum(per.values()) or 1
    table = [{"login": l, "hashUnits": float(split[l]["hash"]), "aiUnits": float(split[l]["ai"]),
              "sharePct": round(float(per[l] / total * 100), 4), "creditShannon": pay.get(l, 0),
              "creditPRANA": pay.get(l, 0) / 1e9} for l in sorted(per, key=lambda x: -per[x])]
    summary = {"epoch": [start_h, end_h], "tip": tip, "potWei": pot, "potPRANA": pot / 1e18, **flow,
               "carryInWei": carry, "carryOutWei": new_carry, "windowUnitsUsed": float(used),
               "windowUnitsTarget": cfg["windowUnits"], "unitDiff": cfg["unitDiff"], "aiWeight": cfg["aiWeight"],
               "poolFee": 0, "dryRun": dry_run, "payouts": table}
    if dry_run:
        return summary
    if r.cmd("SET", f"{P}:pot:done:{end_h}", int(time.time()), "NX") is None:
        raise RuntimeError(f"epoch {end_h} already distributed (replay refused)")
    r.cmd("MULTI")
    for l, sh in pay.items():
        r.cmd("HINCRBY", f"{P}:miners:{l}", "balance", sh)
        r.cmd("HSET", f"{P}:credits:pot:{end_h}", l, sh)
    r.cmd("HINCRBY", f"{P}:finances", "balance", sum(pay.values()))
    r.cmd("HSET", f"{P}:pot:state", "height", end_h, "balance", flow["endBalance"], "carry", new_carry)
    r.cmd("ZADD", f"{P}:pot:epochs", end_h, json.dumps({k: v for k, v in summary.items() if k != "payouts"}))
    r.cmd("EXEC")
    return summary

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("config"); ap.add_argument("--commit", action="store_true")
    ap.add_argument("--loop", type=int, default=0, help="seconds between ticks (0 = once)")
    a = ap.parse_args(); cfg = json.load(open(a.config))
    while True:
        try:
            s = run_once(cfg, dry_run=not a.commit)
            if s: print(json.dumps(s, indent=1))
        except Exception as e:
            print(json.dumps({"error": str(e)}), file=sys.stderr)
        if not a.loop: break
        time.sleep(a.loop)
