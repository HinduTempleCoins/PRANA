#!/usr/bin/env python3
"""Hathor fleet worker: lease a job, run it, submit the output, earn pool shares when verified.

Anyone can run this. You need: Python 3 + torch (CPU is fine) + tokenizers, the Hathor-0 weights
(ckpt.pt + tokenizer.json + model.py), and a PRANA address to be credited. No keys, no signing:
credit goes to the address you name; payouts come from the pool wallet by shares.

  python fleet_worker.py --queue https://<queue-host> --address 0xYourPRANAaddress \
      --types llm.generate,embed.text --ckpt ckpt.pt --tok tokenizer.json --model-dir <dir with model.py>
"""
import argparse, hashlib, json, os, sys, time, urllib.request

def post(url, body):
    r = urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(),
                               {"Content-Type": "application/json"}), timeout=60)
    return json.loads(r.read())

def file_sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

class Hathor0:
    """Deterministic CPU inference on Hathor's own LM: greedy decode + mean-pooled embeddings."""
    def __init__(self, ckpt, tok, model_dir, threads=2):
        import torch
        sys.path.insert(0, model_dir)
        from model import GPT, Config
        from tokenizers import Tokenizer
        torch.set_num_threads(threads); torch.use_deterministic_algorithms(True)
        c = torch.load(ckpt, map_location="cpu", weights_only=False)
        self.m = GPT(Config(**c["config"])); self.m.load_state_dict(c["model"]); self.m.eval()
        self.tok = Tokenizer.from_file(tok); self.eot = self.tok.token_to_id("<|endoftext|>")
        self.torch = torch; self.sha = file_sha256(ckpt); self.id = "hathor0-v1"

    def generate(self, prompt, max_tokens):
        t = self.torch
        ids = t.tensor([self.tok.encode(prompt).ids]); out = []
        with t.no_grad():
            for _ in range(max_tokens):
                logits, _ = self.m(ids[:, -self.m.config.block_size:])
                nxt = int(t.argmax(logits[0, -1]))          # greedy: no sampling, no seed dependence
                out.append(nxt); ids = t.cat((ids, t.tensor([[nxt]])), 1)
                if nxt == self.eot: break
        return {"text": self.tok.decode(out), "token_ids": out}

    def embed(self, text):
        t = self.torch; m = self.m
        ids = t.tensor([self.tok.encode(text).ids[: m.config.block_size]])
        with t.no_grad():
            x = m.wte(ids)
            for b in m.blocks: x = b(x, m.cos, m.sin)
            v = m.norm(x)[0].mean(0)
            v = v / v.norm()
        return [round(float(z), 6) for z in v]

class SDRender:
    """image.sd: render through a local Stable Diffusion backend (the genai_cpu_worker contract: POST /generate
    {prompt, negativePrompt, seed, steps, size} -> {base64 PNG}) and fingerprint the PNG for verification."""
    def __init__(self, url, token, unet):
        self.url, self.token = url.rstrip("/"), token
        self.sha = file_sha256(unet); self.id = "dreamshaper-8+lcm"

    def render(self, prompt, neg, seed, steps, size):
        body = {"prompt": prompt, "seed": int(seed), "steps": int(steps), "size": size, "priority": "low"}
        if neg: body["negativePrompt"] = neg
        r = urllib.request.urlopen(urllib.request.Request(self.url + "/generate", json.dumps(body).encode(),
            {"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"}), timeout=1800)
        out = json.loads(r.read())
        if not out.get("ok"): raise RuntimeError(out.get("error") or "render failed")
        return out["base64"]

def fingerprint(png_b64, n=16):
    """16x16 grayscale, mean-centred, unit length, 6 decimals: two renders of the same job agree at cosine ~1,
    different images do not (raw grayscale would agree with everything)."""
    import base64, io, math
    from PIL import Image
    im = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("L").resize((n, n), Image.BILINEAR)
    v = [p / 255 for p in im.tobytes()]; m = sum(v) / len(v); v = [x - m for x in v]
    s = math.sqrt(sum(x * x for x in v)) or 1.0
    return [round(x / s, 6) for x in v]

def run(job, h0, tamper=False, sd=None):
    p, i = job["params"], job["input"]
    if job["type"] == "image.sd":
        import base64
        if not sd: raise RuntimeError("no SD backend configured (--sd-url)")
        if p.get("model_sha256") != sd.sha:
            raise RuntimeError("UNet weights mismatch (refusing: output would not verify)")
        png = sd.render(i["prompt"], i.get("negativePrompt", ""), p["seed"], p.get("steps", 6), p.get("size", "512x512"))
        v = fingerprint(png)
        if tamper: v = [-z for z in v]
        q = bytes((int(round(z * 127)) & 0xff) for z in v)
        return {"result": {"vector": v, "dims": len(v), "image_sha256": hashlib.sha256(base64.b64decode(png)).hexdigest(),
                           "mime": "image/png", "png_b64": png},
                "output_hash": hashlib.sha256(q).hexdigest()}
    if p.get("model_sha256") and p["model_sha256"] != h0.sha:
        raise RuntimeError("model weights mismatch (refusing: output would not verify)")
    if job["type"] == "llm.generate":
        r = h0.generate(i["prompt"], int(p.get("max_tokens", 64)))
        if tamper: r["token_ids"] = r["token_ids"][:-1] + [0]; r["text"] += "?"
        return {"result": r, "output_hash": hashlib.sha256(json.dumps(r["token_ids"]).encode()).hexdigest()}
    if job["type"] == "embed.text":
        vecs = [h0.embed(t) for t in i["texts"]]
        if tamper: vecs = [[-z for z in v] for v in vecs]
        flat = [z for v in vecs for z in v]
        q = bytes((int(round(z * 127)) & 0xff) for z in flat)
        return {"result": {"vector": flat, "dims": len(vecs[0]), "count": len(vecs)},
                "output_hash": hashlib.sha256(q).hexdigest()}
    raise RuntimeError(f"no handler for {job['type']}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", required=True); ap.add_argument("--address", required=True)
    ap.add_argument("--types", default="llm.generate,embed.text")
    ap.add_argument("--ckpt", default="/opt/hathor-lm/runs/hathor0-v1/ckpt.pt")
    ap.add_argument("--tok", default="/opt/hathor-lm/data/tokenizer.json")
    ap.add_argument("--model-dir", default="/opt/hathor-lm/train")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--max-jobs", type=int, default=0, help="exit after N jobs (0 = forever)")
    ap.add_argument("--idle-exit", type=int, default=0, help="exit after N idle polls (0 = never)")
    ap.add_argument("--sd-url", default="", help="image.sd: Stable Diffusion backend (genai_cpu_worker contract)")
    ap.add_argument("--sd-token-file", default="", help="file holding the backend's bearer token")
    ap.add_argument("--unet", default="", help="image.sd: the pinned UNet safetensors (its sha256 must match the job)")
    ap.add_argument("--tamper", action="store_true", help="TEST ONLY: submit corrupted outputs")
    a = ap.parse_args()
    types = a.types.split(",")
    h0 = Hathor0(a.ckpt, a.tok, a.model_dir, a.threads) if {"llm.generate", "embed.text"} & set(types) else None
    sd = None
    if "image.sd" in types:
        tok = open(a.sd_token_file).read().strip() if a.sd_token_file else ""
        sd = SDRender(a.sd_url, tok, a.unet)
    print(json.dumps({"worker": a.address, "types": types, "model_sha256": h0.sha if h0 else None,
                      "unet_sha256": sd.sha if sd else None}), flush=True)
    done = idle = 0
    while True:
        job = post(a.queue + "/lease", {"worker": a.address, "types": types})
        if job.get("idle"):
            idle += 1
            if a.idle_exit and idle >= a.idle_exit: break
            time.sleep(5 if sd and not h0 else 2); continue
        idle = 0; t0 = time.time()
        try:
            out = run(job, h0, a.tamper, sd)
        except Exception as e:
            print(json.dumps({"job": job["job"], "error": str(e)}), flush=True); continue
        st = post(a.queue + "/submit", {"assignment": job["assignment"], "worker": a.address, "output": out})
        print(json.dumps({"job": job["job"], "type": job["type"], "hash": out["output_hash"][:16],
                          "secs": round(time.time() - t0, 2), "jobStatus": st.get("status")}), flush=True)
        done += 1
        if a.max_jobs and done >= a.max_jobs: break

if __name__ == "__main__":
    main()
