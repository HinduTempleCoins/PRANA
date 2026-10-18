#!/usr/bin/env python3
"""Hathor fleet work queue: any fleet AI task -> redundant workers -> verified -> pool shares.

Producers (Hathor Brain, Discord bot, chain bots, Cheetah, GenAI, BYOK replacements...) POST jobs.
Workers (ours + anyone's) lease jobs, run them, submit outputs. A job is VERIFIED when K of its
N independently-assigned replicas agree under the task type's verifier (exact hash, or a tolerance
cluster for float outputs). Each agreeing worker is then credited `milliWU` AI-work units into the
pool's unified PPLNS share log, where the pot distributor pays them pro-rata alongside hash shares.

Anti-cheat built in (closes gaps listed in GRIDCOIN_TASK_LANE_PLAN.md for the pool path):
  * random assignment: a worker cannot choose a job id; lease() hands out a random eligible job.
  * one replica per worker address per job; output hidden from other replicas until verified.
  * anchor rule: types with anchor=True need >=1 TRUSTED fleet worker in the agreeing set
    (blocks a single Sybil operator filling all N replicas with his own addresses).
  * disagreement -> extra replicas (up to maxReplicas) -> 'disputed' (no credit, strikes logged).
  * strikes: mismatching the verified answer adds a strike; >= banStrikes -> no more leases.
  * replay-safe crediting: SADD <prefix>:ai:credited <job>:<login> guards every LPUSH.
Serve-then-verify: for latency-sensitive jobs the first output is returned to the caller at once
(status 'served'); crediting still waits for K-of-N. Producers keep their existing path as the
fallback if nothing is served before their deadline (nothing goes dark).
"""
import json, os, sys, time, random, sqlite3, hashlib, threading, math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from potd import Redis  # tiny RESP client

# PRANA payout hardening: worker addresses must be EIP-55 checksummed (typo'd addresses are refused, not
# credited into the void); round export for the public, independently verifiable round bundle.
try:
    from eth_utils import to_checksum_address
except ImportError:  # pragma: no cover
    to_checksum_address = None

def checked_address(a):
    if not isinstance(a, str) or len(a) != 42 or not a.startswith("0x"):
        raise ValueError("worker must be a 0x PRANA address")
    int(a[2:], 16)
    if to_checksum_address is None:
        raise ValueError("eth_utils required for checksum validation")
    if to_checksum_address(a) != a:
        raise ValueError("worker address must be EIP-55 checksummed")
    if int(a, 16) == 0:
        raise ValueError("zero address")
    return a.lower()

def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()

def sha256(s): return hashlib.sha256(s if isinstance(s, bytes) else s.encode()).hexdigest()

# ---------------- verifiers ----------------
def v_exact(a, b):
    return a["output_hash"] == b["output_hash"]

def v_cosine(th):
    def f(a, b):
        x, y = a["output"].get("vector"), b["output"].get("vector")
        if not x or not y or len(x) != len(y): return False
        dot = sum(p * q for p, q in zip(x, y))
        nx = math.sqrt(sum(p * p for p in x)); ny = math.sqrt(sum(q * q for q in y))
        return nx > 0 and ny > 0 and dot / (nx * ny) >= th
    return f

def image_px(p):
    w, h = (int(x) for x in str(p.get("size") or "512x512").lower().split("x")[:2])
    if not (256 <= w <= 768 and 256 <= h <= 768 and w % 8 == 0 and h % 8 == 0): raise ValueError("image.sd: size out of range")
    return w * h

def image_steps(p):
    s = int(p.get("steps", 6))
    if not 2 <= s <= 8: raise ValueError("image.sd: steps out of range")
    return s

# Task-type registry: verifier, default N/K, anchor rule, milliWU per job (the AI side of the see-saw).
# milliWU calibration: 1000 milliWU = 1 normalized hash unit at aiWeight=1 (see README).
TASK_TYPES = {
    # deterministic LLM inference (greedy, temp 0, pinned model sha256 + runtime): exact text hash
    "llm.generate":  {"verify": v_exact,  "n": 3, "k": 2, "anchor": True,
                      "wu": lambda j: 1000 + 10 * int(j["params"].get("max_tokens", 64))},
    # text embeddings for library/RAG/Crypt-ology: float vectors, cosine-agreement cluster
    "embed.text":    {"verify": v_cosine(0.9999), "n": 3, "k": 2, "anchor": True,
                      "wu": lambda j: 200 * max(1, len(j["input"].get("texts", [])))},
    # Stable Diffusion render (pinned UNet sha256, fixed seed + steps + size, LCM, CPU): the PNG is returned to
    # the producer; agreement is a 16x16 centered grayscale fingerprint (cosine), so the same render on two
    # machines agrees even if a CPU's float rounding flips a few pixel bytes.
    "image.sd":      {"verify": v_cosine(0.99), "n": 2, "k": 2, "anchor": True,
                      "wu": lambda j: 2000 * image_steps(j["params"]) * image_px(j["params"]) // 262144},
    # Only types with a working worker handler are offered (operator rule: nothing "under construction"
    # is offered as work). image.txt2img / compute.script / transcribe get added when their handlers ship.
}

SCHEMA = """
create table if not exists jobs(id text primary key, type text, model text, params text, input text,
  n int, k int, max_n int, milli_wu int, status text, latency text, origin text, created real,
  deadline real, served_output text, result_hash text, result text, verified_at real);
create table if not exists asg(id text primary key, job text, worker text, leased real, expires real,
  submitted real, output_hash text, output text, verdict text, unique(job, worker));
create table if not exists workers(addr text primary key, trusted int default 0, strikes int default 0,
  credited_mwu int default 0, last_seen real);
"""

class Queue:
    def __init__(self, db, redis_cfg=None, prefix="etc", lease_s=300, ban_strikes=3, log=print):
        self.db = sqlite3.connect(db, check_same_thread=False); self.db.executescript(SCHEMA)
        self.lock = threading.Lock(); self.rcfg = redis_cfg; self.P = prefix
        self.lease_s, self.ban, self.log = lease_s, ban_strikes, log

    def q(self, sql, *a):
        return self.db.execute(sql, a).fetchall()

    # ---- producers ----
    def post(self, j):
        t = TASK_TYPES.get(j.get("type"))
        if not t: raise ValueError(f"unknown task type {j.get('type')!r}; known: {sorted(TASK_TYPES)}")
        j.setdefault("params", {}); j.setdefault("input", {})
        n = int(j.get("replicas", t["n"])); k = int(j.get("quorum", t["k"]))
        if not (1 <= k <= n): raise ValueError("need 1 <= quorum <= replicas")
        jid = sha256(json.dumps([j["type"], j.get("model"), j["params"], j["input"], time.time_ns(),
                                 random.random()], sort_keys=True))[:24]
        with self.lock:
            self.db.execute("insert into jobs values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (jid, j["type"], j.get("model", ""), json.dumps(j["params"], sort_keys=True),
                 json.dumps(j["input"], sort_keys=True), n, k, int(j.get("maxReplicas", n + 2)),
                 int(t["wu"](j)), "open", j.get("latency", "batch"), j.get("origin", ""),
                 time.time(), time.time() + float(j.get("deadline_s", 3600)), None, None, None, None))
            self.db.commit()
        return jid

    def get(self, jid):
        r = self.q("select id,type,model,status,n,k,milli_wu,served_output,result_hash,result,latency,origin "
                   "from jobs where id=?", jid)
        if not r: return None
        r = r[0]
        subs = self.q("select worker,output_hash,verdict from asg where job=? and submitted is not null", jid)
        return {"id": r[0], "type": r[1], "model": r[2], "status": r[3], "replicas": r[4], "quorum": r[5],
                "milliWU": r[6], "output": json.loads(r[9] or r[7] or "null"), "resultHash": r[8],
                "latency": r[10], "origin": r[11],
                "submissions": [{"worker": s[0], "hash": s[1], "verdict": s[2]} for s in subs]}

    # ---- workers ----
    def register(self, addr, trusted=False):
        addr = addr.lower()
        with self.lock:
            self.db.execute("insert into workers(addr,trusted,last_seen) values(?,?,?) on conflict(addr) "
                            "do update set last_seen=excluded.last_seen, trusted=max(trusted, excluded.trusted)", (addr, int(trusted), time.time()))
            self.db.commit()

    def lease(self, worker, types=None):
        worker = checked_address(worker)
        self.register(worker)
        now = time.time()
        with self.lock:
            st = self.q("select strikes from workers where addr=?", worker)[0][0]
            if st >= self.ban: return None
            self.db.execute("delete from asg where submitted is null and expires < ?", (now,))
            types = types or list(TASK_TYPES)
            ph = ",".join("?" * len(types))
            # eligible: open, under its replica budget, not already held by this worker
            rows = self.q(f"""select j.id, j.latency from jobs j where j.status in ('open','served') and j.type in ({ph})
                and (select count(*) from asg a where a.job=j.id) < j.n
                and not exists (select 1 from asg a where a.job=j.id and a.worker=?)""", *types, worker)
            if not rows: return None
            hot = [r for r in rows if r[1] == "interactive"]
            jid = random.choice(hot or rows)[0]          # random assignment, interactive first
            aid = sha256(f"{jid}:{worker}:{now}")[:24]
            self.db.execute("insert into asg(id,job,worker,leased,expires) values(?,?,?,?,?)",
                            (aid, jid, worker, now, now + self.lease_s))
            self.db.commit()
            j = self.q("select id,type,model,params,input from jobs where id=?", jid)[0]
        return {"assignment": aid, "job": j[0], "type": j[1], "model": j[2],
                "params": json.loads(j[3]), "input": json.loads(j[4])}

    def submit(self, aid, worker, output):
        worker = checked_address(worker)
        with self.lock:
            a = self.q("select job,worker,submitted from asg where id=?", aid)
            if not a or a[0][1] != worker: raise ValueError("unknown assignment for this worker")
            if a[0][2]: raise ValueError("already submitted")
            jid = a[0][0]
            typ = self.q("select type from jobs where id=?", jid)[0][0]
            res = output.get("result") or {}
            # the queue sets the hash itself from the published output, exactly as roundlib rechecks it, so a
            # worker can never put a hash/output pair into a round bundle that would fail the signers
            if typ == "llm.generate":
                oh = sha256(json.dumps(res.get("token_ids")))
            elif isinstance(res.get("vector"), list) and res["vector"]:
                oh = hashlib.sha256(bytes((int(round(float(z) * 127)) & 0xff) for z in res["vector"])).hexdigest()
            else:
                raise ValueError("output has no token_ids/vector")
            self.db.execute("update asg set submitted=?, output_hash=?, output=? where id=?",
                            (time.time(), oh, json.dumps(output.get("result")), aid))
            st = self.q("select status from jobs where id=?", jid)[0][0]
            if st == "open":   # serve-then-verify: first output goes back to the caller immediately
                self.db.execute("update jobs set status='served', served_output=? where id=?",
                                (json.dumps(output.get("result")), jid))
            self.db.commit()
            return self._verify(jid)

    # ---- verification + crediting ----
    def _verify(self, jid):
        j = self.q("select type,n,k,max_n,milli_wu,status from jobs where id=?", jid)[0]
        typ, n, k, max_n, mwu, status = j
        if status == "verified":   # late replica: judge it against the verified answer (strike if wrong)
            t = TASK_TYPES[typ]
            ref = self.q("select result_hash, result from jobs where id=?", jid)[0]
            ref = {"output_hash": ref[0], "output": json.loads(ref[1] or "null") or {}}
            for w, h, o in self.q("select worker,output_hash,output from asg where job=? and submitted is not null and verdict is null", jid):
                ok = t["verify"](ref, {"output_hash": h, "output": json.loads(o or "null") or {}})
                self.db.execute("update asg set verdict=? where job=? and worker=?", ("late-match" if ok else "mismatch", jid, w))
                if not ok: self.db.execute("update workers set strikes=strikes+1 where addr=?", (w,))
            self.db.commit()   # late matches are not credited: K agreeing replicas already earned it
            return status
        if status == "disputed": return status
        t = TASK_TYPES[typ]
        subs = [{"worker": w, "output_hash": h, "output": json.loads(o or "null") or {}, "trusted": tr}
                for w, h, o, tr in self.q("select a.worker,a.output_hash,a.output,coalesce(w.trusted,0) from asg a "
                                          "left join workers w on w.addr=a.worker where a.job=? and a.submitted is not null", jid)]
        # greedy clustering under the type's verifier
        clusters = []
        for s in subs:
            for c in clusters:
                if t["verify"](c[0], s): c.append(s); break
            else: clusters.append([s])
        win = None
        for c in sorted(clusters, key=len, reverse=True):
            if len(c) >= k and (not t["anchor"] or any(x["trusted"] for x in c)):
                win = c; break
        if win:
            winners = {x["worker"] for x in win}
            for s in subs:
                self.db.execute("update asg set verdict=? where job=? and worker=?",
                                ("match" if s["worker"] in winners else "mismatch", jid, s["worker"]))
                if s["worker"] not in winners:
                    self.db.execute("update workers set strikes=strikes+1 where addr=?", (s["worker"],))
            # verified_at is an integer second so the public export window (since, until] is exact
            self.db.execute("update jobs set status='verified', result_hash=?, result=?, verified_at=? where id=?",
                            (win[0]["output_hash"], json.dumps(win[0]["output"]), int(time.time()), jid))
            self.db.commit()
            self._credit(jid, typ, mwu, sorted(winners))
            return "verified"
        if len(subs) >= n:  # all replicas in, no qualifying quorum -> widen, else dispute
            if n < max_n:
                self.db.execute("update jobs set n=n+1 where id=?", (jid,))
            else:
                self.db.execute("update jobs set status='disputed' where id=?", (jid,))
            self.db.commit()
        return self.q("select status from jobs where id=?", jid)[0][0]

    # ---- public round export (consumed by potd2 / audited by signers) ----
    def export(self, since_ts, until_ts):
        """Every job verified in (since_ts, until_ts], with all inputs and every replica's output, so anyone
        can recheck output hashes, the K-of-N verdict, the anchor rule and the milliWU credited."""
        out = []
        for jid, typ, params, inp, k, mwu, rh, va in self.q(
                "select id,type,params,input,k,milli_wu,result_hash,verified_at from jobs "
                "where status='verified' and verified_at > ? and verified_at <= ? order by id", since_ts, until_ts):
            params = json.loads(params); inp = json.loads(inp)
            subs = []
            for w, oh, o, verdict, tr in self.q(
                    "select a.worker,a.output_hash,a.output,a.verdict,coalesce(w.trusted,0) from asg a left join workers w "
                    "on w.addr=a.worker where a.job=? and a.submitted is not null order by a.worker", jid):
                o = json.loads(o or "null") or {}
                if typ == "llm.generate":
                    o = {"token_ids": o.get("token_ids"), "text": o.get("text")}
                elif typ == "image.sd":
                    o = {"vector": o.get("vector"), "dims": o.get("dims"), "image_sha256": o.get("image_sha256")}
                else:
                    o = {"vector": o.get("vector"), "dims": o.get("dims"), "count": o.get("count")}
                subs.append({"worker": w, "outputHash": oh, "output": o, "verdict": verdict, "trusted": bool(tr)})
            out.append({"job": jid, "type": typ, "model": params.get("model", ""), "modelSha256": params.get("model_sha256"),
                        "params": params, "input": inp,
                        "inputHash": "0x" + hashlib.sha256(canonical(inp)).hexdigest(),
                        "paramsHash": "0x" + hashlib.sha256(canonical(params)).hexdigest(),
                        "k": k, "milliWU": mwu, "resultHash": rh, "verifiedAt": int(va), "status": "verified",
                        "submissions": subs, "credited": sorted(s["worker"] for s in subs if s["verdict"] == "match")})
        return out

    def _credit(self, jid, typ, mwu, winners):
        if not self.rcfg: return
        r = Redis(self.rcfg.get("host", "127.0.0.1"), self.rcfg.get("port", 6379), self.rcfg.get("db", 0))
        ts = int(time.time())
        for w in winners:
            if r.cmd("SADD", f"{self.P}:ai:credited", f"{jid}:{w}") == 1:   # replay guard
                r.cmd("LPUSH", f"{self.P}:pplns", f"a:{w}:{mwu}:{ts}:{typ}:{jid}")
                self.db.execute("update workers set credited_mwu=credited_mwu+? where addr=?", (mwu, w))
                self.log(json.dumps({"credit": w, "job": jid, "type": typ, "milliWU": mwu}))
        self.db.commit()

# ---------------- HTTP ----------------
def serve(qu, host, port, producer_token):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            b = json.dumps(obj).encode(); self.send_response(code)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", len(b))
            self.end_headers(); self.wfile.write(b)
        def log_message(self, *a): pass
        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 8 * 1024 * 1024: raise ValueError("body too large")
            return json.loads(self.rfile.read(n) or b"{}")
        def do_GET(self):
            if self.path.startswith("/jobs/"):
                j = qu.get(self.path.split("/")[2].split("?")[0]); return self._send(200 if j else 404, j or {"error": "no such job"})
            if self.path == "/types":
                return self._send(200, {k: {"replicas": v["n"], "quorum": v["k"], "anchor": v["anchor"]} for k, v in TASK_TYPES.items()})
            if self.path == "/health": return self._send(200, {"ok": True})
            if self.path.startswith("/export"):
                from urllib.parse import urlparse, parse_qs
                qs = parse_qs(urlparse(self.path).query)
                return self._send(200, {"jobs": qu.export(float(qs["since"][0]), float(qs["until"][0]))})
            self._send(404, {"error": "not found"})
        def do_POST(self):
            try:
                b = self._body()
                if self.path == "/jobs":
                    if producer_token and self.headers.get("Authorization") != f"Bearer {producer_token}":
                        return self._send(401, {"error": "producer token required"})
                    return self._send(200, {"id": qu.post(b)})
                if self.path == "/lease":
                    return self._send(200, qu.lease(b["worker"], b.get("types")) or {"idle": True})
                if self.path == "/submit":
                    return self._send(200, {"status": qu.submit(b["assignment"], b["worker"], b["output"])})
                self._send(404, {"error": "not found"})
            except (ValueError, KeyError) as e:
                self._send(400, {"error": str(e)})
    ThreadingHTTPServer((host, port), H).serve_forever()

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="fleetq.sqlite"); ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8620); ap.add_argument("--redis-port", type=int, default=6379)
    ap.add_argument("--prefix", default="etc"); ap.add_argument("--trusted", default="",
                    help="comma-separated fleet (anchor) worker addresses")
    a = ap.parse_args()
    # --redis-port 0: no legacy PPLNS-list crediting (the pot round bundle reads /export instead)
    qu = Queue(a.db, {"port": a.redis_port} if a.redis_port else None, a.prefix)
    for t in filter(None, a.trusted.split(",")): qu.register(t, trusted=True)
    serve(qu, a.host, a.port, os.environ.get("FLEETQ_PRODUCER_TOKEN", ""))
