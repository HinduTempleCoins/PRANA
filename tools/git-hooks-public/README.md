# Public git hooks

Shareable, public-safe git hooks for the PRANA repo. Everything here is checked
into the open repo and is safe for anyone who clones it to use.

## What's here

- **`pre-commit.example`** — a public-safe pre-commit hook that runs:
  1. `gitleaks protect --staged` (only if `gitleaks` is installed) — scans the
     staged changes for secrets and blocks the commit on a finding.
  2. `node tools/adapters/check-consumer-matrix.mjs` — the adapter
     consumer-matrix lint (every data adapter must map to a consumer, and no
     consumer may reference a missing adapter).

## Install

```sh
cp tools/git-hooks-public/pre-commit.example .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or, to track hooks in-repo, point `core.hooksPath` at a directory that contains
a copy named `pre-commit`:

```sh
git config core.hooksPath .githooks
```

To bypass intentionally for a single commit: `git commit --no-verify`.

## What is NOT here (and why)

This repo is **public**. The *real* keyword-guard — the hook that blocks private
brand/identity strings, server IPs, and credentials from ever being committed —
lives in the **gitignored** `tools/git-hooks/` directory and is deliberately not
published. That guard is specific to our private design context and would leak
the very strings it exists to protect if it were shipped here.

`tools/git-hooks-public/` is therefore the **public floor**: secret-scanning
plus the adapter lint, usable by anyone, with no dependency on the private
guard. Contributors with access to the private guard layer the two together
(public floor + private keyword-guard) locally.
