#!/usr/bin/env bash
# capture-loop.sh — the "live capture" layer, adapted for an EPHEMERAL Codespace.
#
# On the always-on always-on server this is a systemd timer. A Codespace sleeps
# when idle, so instead we run a foreground loop WHILE the session is active:
# every ~60s it copies the newest transcript into transcripts/, regenerates the
# mechanical state via brain-continue.mjs, and (if BRAIN_REMOTE is set) pushes to
# the server. When the Codespace sleeps, nothing is changing anyway, so missing
# ticks lose nothing — the server already has the latest pause-state.
#
# Run it backgrounded at the start of a work session:
#   nohup bash tools/brain/capture-loop.sh >/tmp/prana-brain.log 2>&1 &
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRANSCRIPTS_DIR="${TRANSCRIPTS:-$HOME/.claude/projects/-workspaces-PRANA}"
INTERVAL="${BRAIN_INTERVAL:-60}"
mkdir -p "$ROOT/transcripts"

echo "brain capture-loop: every ${INTERVAL}s  (transcripts: $TRANSCRIPTS_DIR)"
while true; do
  newest="$(ls -t "$TRANSCRIPTS_DIR"/*.jsonl 2>/dev/null | head -1 || true)"
  if [ -n "$newest" ]; then
    cp -f "$newest" "$ROOT/transcripts/"                 # raw safety-net copy
    node "$ROOT/brain-continue.mjs" >/dev/null 2>&1 || true   # refresh state
    if [ -n "${BRAIN_REMOTE:-}" ]; then
      bash "$ROOT/sync-to-server.sh" >/dev/null 2>&1 || true  # push to server
    fi
  fi
  sleep "$INTERVAL"
done
