#!/usr/bin/env bash
#
# test-watch-canary.sh — publish a fresh test warrant canary to Nostr, then print the
# npub + /watch URL so you can verify it in the browser reader.
#
# Runs the real auspex lifecycle end to end, sequentially:
#     keygen → init → define → attest → check → notify → remind
# Each run generates a NEW key (a new npub) and an independent canary.
#
# Relays: it publishes to the three relays the browser reader queries by default
# (relay.damus.io, nos.lol, relay.primal.net), so /watch finds it without a NIP-65 list.
#
# ⚠  This publishes real events to PUBLIC Nostr relays. The key is throwaway and the content
#    is the example template, but Nostr events propagate and cannot be unpublished.
#
# After publishing, it also exercises the notify/remind commands against the live canary:
# state-change alerting, the `confirmations` debounce, de-duplication, and re-attestation reminders.
#
# Usage:
#     bash scripts/test-watch-canary.sh
#     WATCH_BASE=http://localhost:3100 bash scripts/test-watch-canary.sh   # custom host/port
#     STAMP=1 bash scripts/test-watch-canary.sh                            # also initiate OpenTimestamps
#     WEBHOOK=1 bash scripts/test-watch-canary.sh                          # also test the webhook channel
#     RELAYS='["ws://localhost:7777"]' bash scripts/test-watch-canary.sh   # publish to your own relay
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WATCH_BASE="${WATCH_BASE:-http://localhost:3000}"
DEFAULT_RELAYS='["wss://relay.damus.io","wss://nos.lol","wss://relay.primal.net"]'
RELAYS="${RELAYS:-$DEFAULT_RELAYS}"

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

# ── New: notification + reminder features, exercised against the live canary ──────────
CANARY_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).canaryId)' "$CONFIG" 2>/dev/null || echo primary)"

echo
echo "▶ auspex notify  (fresh state — evaluates the live canary; stays quiet while ALIVE)"
cli notify -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/notify.json" || true

echo
echo "▶ auspex notify  (seed a prior DEAD reading → confirm a recovery alert + debounce)"
echo "   confirmations=2 in the config ⇒ run 1 is debounced (silent), run 2 fires the alert."
printf '{"%s":{"lastState":"dead","notifiedAlarms":[]}}\n' "$CANARY_ID" > "$TESTDIR/recovery.json"
echo "   — run 1/2 (debounced, expect: no new notifications):"
cli notify -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/recovery.json" || true
echo "   — run 2/2 (expect: ℹ canary-alive, 'Recovered (dead → alive)'):"
cli notify -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/recovery.json" || true

echo
echo "▶ auspex remind  (default lead times 3d/1d/1h — deadline ~37d out ⇒ nothing due)"
cli remind -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/remind.json" || true

echo
echo "▶ auspex remind  (--lead 5000000 ≈ 58d ⇒ deadline is inside the window ⇒ should REMIND)"
cli remind -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/remind-fire.json" --lead 5000000 || true

if [ "${WEBHOOK:-0}" = "1" ]; then
  echo
  echo "▶ webhook channel (WEBHOOK=1): POST a recovery alert to a local listener"
  node -e '
    const http = require("http"), fs = require("fs");
    const dir = process.argv[1];
    const server = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => { fs.appendFileSync(dir + "/webhook.log", body + "\n"); res.statusCode = 204; res.end(); });
    });
    server.listen(0, "127.0.0.1", () => fs.writeFileSync(dir + "/webhook.port", String(server.address().port)));
    setTimeout(() => process.exit(0), 30000);
  ' "$TESTDIR" &
  WH_PID=$!
  for _ in $(seq 1 50); do [ -s "$TESTDIR/webhook.port" ] && break; sleep 0.1; done
  WH_PORT="$(cat "$TESTDIR/webhook.port" 2>/dev/null || true)"
  if [ -n "${WH_PORT:-}" ]; then
    # Seed candidateStreak:1 so a single live ALIVE read confirms the recovery (one fetch can read
    # `unknown` if a relay is slow — re-seed and retry to absorb that blip).
    seed='{"'"$CANARY_ID"'":{"lastState":"dead","candidateState":"alive","candidateStreak":1,"notifiedAlarms":[]}}'
    for _ in 1 2 3 4; do
      printf '%s\n' "$seed" > "$TESTDIR/webhook-state.json"
      cli notify -c "$CONFIG" --pubkey "$HEX" --state "$TESTDIR/webhook-state.json" --webhook "http://127.0.0.1:$WH_PORT" || true
      [ -s "$TESTDIR/webhook.log" ] && break
      sleep 1
    done
    sleep 0.3
    if [ -s "$TESTDIR/webhook.log" ]; then
      echo "   ✓ listener received the POST:"
      node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop(); const o=JSON.parse(l); console.log("     kind:",o.kind,"| severity:",o.severity,"| title:",o.title)' "$TESTDIR/webhook.log" 2>/dev/null || sed "s/^/     /" "$TESTDIR/webhook.log"
    else
      echo "   (no POST received — the recovery alert may not have fired; check relay connectivity)"
    fi
  else
    echo "   could not start a local listener; skipping the webhook test"
  fi
  kill "$WH_PID" 2>/dev/null || true
fi

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
echo "  notify/remind state files: $TESTDIR/*.json"
echo "════════════════════════════════════════════════════════════════════"
