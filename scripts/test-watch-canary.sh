#!/usr/bin/env bash
#
# test-watch-canary.sh — publish a fresh test warrant canary to Nostr, then print the
# npub + /watch URL so you can verify it in the browser reader.
#
# Runs the real auspex lifecycle end to end, sequentially:
#     keygen → init → define → attest   (+ a final CLI `check`)
# Each run generates a NEW key (a new npub) and an independent canary.
#
# Relays: it publishes to the three relays the browser reader queries by default
# (relay.damus.io, nos.lol, relay.primal.net), so /watch finds it without a NIP-65 list.
#
# ⚠  This publishes real events to PUBLIC Nostr relays. The key is throwaway and the content
#    is the example template, but Nostr events propagate and cannot be unpublished.
#
# Usage:
#     bash scripts/test-watch-canary.sh
#     WATCH_BASE=http://localhost:3100 bash scripts/test-watch-canary.sh   # custom host/port
#     STAMP=1 bash scripts/test-watch-canary.sh                            # also initiate OpenTimestamps
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH_BASE="${WATCH_BASE:-http://localhost:3000}"
RELAYS='["wss://relay.damus.io","wss://nos.lol","wss://relay.primal.net"]'

TESTDIR="$(mktemp -d -t auspex-canary-XXXXXX)"
CONFIG="$TESTDIR/canary.config.json"

# Run the project CLI (`npm run cli`) from the repo root, quietly.
cli() { ( cd "$REPO" && npm --silent run cli -- "$@" ); }

echo "▶ auspex keygen"
KEYS="$(cli keygen)" || { echo "keygen failed"; exit 1; }
echo "$KEYS"
NSEC="$(printf '%s\n' "$KEYS" | awk '/^nsec:/{print $2}')"
NPUB="$(printf '%s\n' "$KEYS" | awk '/^npub:/{print $2}')"
HEX="$(printf  '%s\n' "$KEYS" | awk '/^hex:/{print $2}')"
if [ -z "${NSEC:-}" ] || [ -z "${NPUB:-}" ]; then echo "could not parse keypair from keygen output"; exit 1; fi
export CANARY_NSEC="$NSEC"

# Print the npub up front, so you have it even if a later publish step has a hiccup.
echo
echo "  new npub: $NPUB"
echo "  watch:    $WATCH_BASE/watch/$NPUB"
echo

echo "▶ auspex init  ($CONFIG)"
cli init -c "$CONFIG" || { echo "init failed"; exit 1; }

# Point it at the reader's default relays and keep the OTS store inside the temp dir.
node -e '
const fs = require("fs");
const [p, relays, store] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.relays = JSON.parse(relays);
c.storePath = store;
fs.writeFileSync(p, JSON.stringify(c, null, 2));
' "$CONFIG" "$RELAYS" "$TESTDIR/pending.json"
echo "  relays → $RELAYS"

echo "▶ auspex define"
cli define -c "$CONFIG"

# OpenTimestamps can't be Bitcoin-confirmed instantly, so skip stamping by default for a fast,
# reliable test (the canary is still ALIVE; OTS is the optional not-later-than upper bound).
STAMP_FLAG="--no-stamp"
[ "${STAMP:-0}" = "1" ] && STAMP_FLAG=""
echo "▶ auspex attest ${STAMP_FLAG:-(with OpenTimestamps)}"
cli attest -c "$CONFIG" $STAMP_FLAG

echo
echo "▶ auspex check  (CLI-side verdict — should match the browser)"
cli check -c "$CONFIG" --pubkey "$HEX" || true

echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Verify it in the browser reader:"
echo
echo "    $WATCH_BASE/watch/$NPUB"
echo
echo "  npub: $NPUB"
echo "  hex:  $HEX"
if [ -n "$STAMP_FLAG" ]; then
  echo "  (OTS skipped → expect ALIVE with an 'OTS pending' note)"
else
  echo "  (OTS initiated → run 'CANARY_NSEC=$NSEC npm run cli -- upgrade -c $CONFIG'"
  echo "   ~1h later, after Bitcoin confirmation, to publish the proof)"
fi
echo "  config: $CONFIG"
echo "════════════════════════════════════════════════════════════════════"
