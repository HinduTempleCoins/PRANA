# Repo backup / mirror runbook (gickup)

Disaster-recovery mirroring of the PRANA repositories to an **independent host**
(Codeberg/Forgejo or GitLab) so the code survives a GitHub outage, a repo
deletion, or account loss. The mirror is full-history (all branches + tags), not
a snapshot.

Tool: [`gickup`](https://github.com/cooperspencer/gickup) — a single static Go
binary that, per run, clones each source repo and pushes a mirror to the
destination. Stateless: re-running just fast-forwards the mirror.

> **Never commit a real token.** `gickup.yml.example` uses `${GITHUB_TOKEN}` /
> `${MIRROR_TOKEN}` env interpolation. Copy it to `gickup.yml` (gitignored on
> the server) and supply secrets via an `EnvironmentFile`, never inline.

---

## 1. Install

No package manager / curl-pipe-bash needed — grab the release binary:

```sh
# Pick the asset for your arch from the releases page; example for linux/amd64:
VER=v0.10.31   # check https://github.com/cooperspencer/gickup/releases for current
curl -fsSL -o /usr/local/bin/gickup \
  "https://github.com/cooperspencer/gickup/releases/download/${VER}/gickup_linux_amd64"
chmod +x /usr/local/bin/gickup
gickup --version
```

(Or `go install github.com/cooperspencer/gickup@latest` if Go is available.)

## 2. Configure

```sh
cp gickup.yml.example gickup.yml
```

Then edit `gickup.yml`:

1. Pick the destination block — **Option A (Codeberg/Forgejo)** or
   **Option B (GitLab)** — and delete the other.
2. Replace `<MIRROR_TARGET>` with the org/user that will own the mirrors on the
   destination host.
3. Replace `<SECOND_REPO>` with the next ecosystem repo to mirror — or remove
   that line to mirror PRANA only.
4. Create the tokens (do **not** put them in `gickup.yml`):
   - **Source** `GITHUB_TOKEN`: a GitHub fine-grained PAT, **read-only**
     (Contents: Read) on the repos in `include:`.
   - **Destination** `MIRROR_TOKEN`: a write PAT on the mirror host (Codeberg or
     GitLab) able to create + push repos under `<MIRROR_TARGET>`.

Keep the tokens in a root-only env file, e.g. `/etc/gickup/gickup.env`:

```sh
# /etc/gickup/gickup.env  (chmod 600, owned by the service user)
GITHUB_TOKEN=ghp_xxx_readonly
MIRROR_TOKEN=xxx_destination_write
```

## 3. First (dry) run

```sh
set -a; . /etc/gickup/gickup.env; set +a
gickup gickup.yml --dry      # prints what it WOULD mirror, pushes nothing
gickup gickup.yml            # real run — creates + populates the mirrors
```

## 4. Schedule

Two options — use **one**, not both:

- **gickup's built-in cron** (`cron:` key in `gickup.yml`): run gickup as a
  long-lived process (e.g. under systemd `Type=simple`) and it self-schedules.
- **System cron / systemd timer** (recommended on the brain server): leave the
  `cron:` key out (or ignore it) and trigger one-shot runs. Example crontab:

  ```cron
  # daily 04:00 — mirror PRANA repos for disaster recovery
  0 4 * * * root . /etc/gickup/gickup.env; /usr/local/bin/gickup /etc/gickup/gickup.yml >> /var/log/gickup.log 2>&1
  ```

  Or a systemd timer pair (`gickup.service` `Type=oneshot` +
  `EnvironmentFile=/etc/gickup/gickup.env`, paired with `gickup.timer`
  `OnCalendar=*-*-* 04:00:00`).

## 5. Restore test (do this — a backup you haven't restored isn't a backup)

Quarterly, prove the mirror is usable:

```sh
# 1. Clone FROM the mirror (not GitHub) into a scratch dir:
git clone https://<MIRROR_TARGET-host>/<MIRROR_TARGET>/PRANA.git /tmp/restore-PRANA
cd /tmp/restore-PRANA

# 2. Confirm history depth + tags survived:
git log --oneline | tail -n 1        # should show the initial commit
git tag                              # tags present?
git branch -a                        # all branches mirrored?

# 3. Diff the mirror tip against the GitHub tip (should be identical):
git ls-remote https://github.com/HinduTempleCoins/PRANA.git HEAD
git rev-parse HEAD

# 4. Sanity-build (optional): run the contracts test gate from the restored copy.
rm -rf /tmp/restore-PRANA           # clean up the scratch clone
```

If steps 1–3 succeed, the DR path is live. Record the date you last ran the
restore test.

## Scope discipline

This config and runbook touch **only** the backup function. If the backup host
also runs other services, do not point gickup at, or run it from, their
directories. Keep `gickup.yml` + the env file in their own `/etc/gickup/` (or
the backup tool's own dir), gitignored, server-local.
