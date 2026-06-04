#!/usr/bin/env bash
# sync-to-server.sh — push the PRANA brain to the always-on server.
#
# The SERVER is the durable home of the brain (survives Codespace deletion).
# state/ is the curated memory (NEVER wiped on the server). transcripts/ is the
# raw safety-net copy (the server's twice-daily job wipes it after the smart
# layer has distilled what's worth keeping).
#
# Configure the destination once (e.g. in ~/.bashrc or a Codespaces secret):
#   export BRAIN_REMOTE="user@YOUR.SERVER.IP:/path/to/brain-prana"
# Requires an SSH key reachable by this Codespace (BRAIN_SSH_KEY optional).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${BRAIN_REMOTE:?Set BRAIN_REMOTE=user@host:/path/to/brain-prana}"
SSH_OPTS=()
[ -n "${BRAIN_SSH_KEY:-}" ] && SSH_OPTS=(-e "ssh -i $BRAIN_SSH_KEY -o StrictHostKeyChecking=accept-new")

# 1) curated state — never deleted on the server (no --delete)
rsync -az "${SSH_OPTS[@]}" "$ROOT/state/" "$BRAIN_REMOTE/state/"

# 2) raw transcript safety-net copy (server wipes these on its own schedule)
if [ -d "$ROOT/transcripts" ]; then
  rsync -az "${SSH_OPTS[@]}" "$ROOT/transcripts/" "$BRAIN_REMOTE/transcripts/"
fi

echo "brain synced -> $BRAIN_REMOTE"
