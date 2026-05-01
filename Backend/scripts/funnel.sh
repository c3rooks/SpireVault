#!/usr/bin/env bash
#
# funnel.sh — print the live sign-in funnel straight from KV.
#
# Reads the same `funnel:*` keys the /admin dashboard reads, but does it
# through wrangler so you don't need the ADMIN_TOKEN. Useful when you want
# to answer "is this thing converting?" without firing up a browser.
#
# Usage:
#   ./scripts/funnel.sh           # today
#   ./scripts/funnel.sh 20260430  # a specific YYYYMMDD
#
# Requires: npx, an authenticated wrangler session for the vault-coop worker.

set -uo pipefail

cd "$(dirname "$0")/.."

KV_ID="050406109a854de7b516c057cdbf75f6"
DAY="${1:-$(date +%Y%m%d)}"

# Get a single KV value as plain text. Wrangler's `kv key get` writes the
# raw value to stdout on success and emits decorative chrome (emojis,
# "Using fallback value in non-interactive context") to stderr / stdout
# on misses. We redirect 2>/dev/null AND filter out everything that
# obviously isn't our value (any line containing wrangler ornamentation
# or that fallback string).
get() {
  local key="$1"
  local raw exit_code
  # Wrangler exits non-zero when the key is missing AND would normally
  # emit an interactive "report this error?" prompt. Closing stdin with
  # </dev/null prevents the prompt from firing and lets us treat missing
  # keys as zero. We also discard stderr so banner/chrome doesn't leak.
  raw=$(npx --yes wrangler@latest kv key get \
        --namespace-id="$KV_ID" --remote "$key" </dev/null 2>/dev/null)
  exit_code=$?
  if [[ $exit_code -ne 0 ]]; then echo "0"; return; fi
  # Wrangler writes the raw value to stdout with no trailing newline on
  # success. If the value is just "5" we want "5" — not the result of
  # filtering. Print the trimmed raw and call it a day.
  local v
  v=$(printf '%s' "$raw" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ -z "$v" ]]; then echo "0"; else printf '%s\n' "$v"; fi
}

count_prefix() {
  local prefix="$1"
  npx --yes wrangler@latest kv key list \
    --namespace-id="$KV_ID" --remote --prefix="$prefix" 2>/dev/null \
    | python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
    print(len(d))
except Exception:
    print('?')" 2>/dev/null
}

list_failures_for_day() {
  local day="$1"
  npx --yes wrangler@latest kv key list \
    --namespace-id="$KV_ID" --remote --prefix="funnel:cb-fail:" 2>/dev/null \
    | python3 -c "
import json, sys
try:
    keys = json.load(sys.stdin)
except Exception:
    keys = []
for k in keys:
    name = k.get('name','')
    if name.endswith(':$day'):
        parts = name.split(':')
        if len(parts) >= 4:
            reason = ':'.join(parts[2:-1])
        else:
            reason = parts[2] if len(parts) > 2 else 'unknown'
        print(reason)
" 2>/dev/null
}

roster_size() {
  # Reads the canonical {"entries": [...]} shape but tolerates legacy bare
  # arrays and anything malformed — returning 0 keeps the funnel dashboard
  # readable instead of showing a stack trace.
  local raw
  raw=$(npx --yes wrangler@latest kv key get \
        --namespace-id="$KV_ID" --remote "presence:roster" </dev/null 2>/dev/null) || { echo "0"; return; }
  printf '%s' "$raw" | python3 -c "
import json, sys
data = sys.stdin.read().strip()
try:
    parsed = json.loads(data) if data else None
    if isinstance(parsed, dict) and isinstance(parsed.get('entries'), list):
        print(len(parsed['entries']))
    elif isinstance(parsed, list):
        print(len(parsed))
    else:
        print(0)
except Exception:
    print(0)" 2>/dev/null
}

echo "── SpireVault sign-in funnel for $DAY ──"
echo

START=$(get "funnel:start:$DAY")
CB_ATT=$(get "funnel:cb-attempt:$DAY")
CB_OK=$(get "funnel:cb-ok:$DAY")
ROSTER_FIRST=$(count_prefix "funnel:roster-first:")
ROSTER_NOW=$(roster_size)
SESSIONS=$(count_prefix "session:")
PROFILES=$(count_prefix "session-profile:")

printf "  [1] Sign-in clicked    funnel:start         = %s\n" "$START"
printf "  [2] Steam → callback   funnel:cb-attempt    = %s\n" "$CB_ATT"
printf "  [3] Verified by Steam  funnel:cb-ok         = %s\n" "$CB_OK"
printf "  [4] Ever reached feed  funnel:roster-first  = %s (lifetime)\n" "$ROSTER_FIRST"
printf "  [5] On roster now      presence:roster      = %s (live)\n" "$ROSTER_NOW"
echo
printf "  Active sessions        session:             = %s\n" "$SESSIONS"
printf "  Saved profiles         session-profile:     = %s\n" "$PROFILES"
echo

if [[ "$CB_OK" =~ ^[0-9]+$ ]] && [[ "$START" =~ ^[0-9]+$ ]] && [[ "$START" != "0" ]]; then
  CONV=$(python3 -c "print(f'{$CB_OK/$START*100:.1f}')")
  echo "  Click → verified conversion: ${CONV}%"
fi

FAIL_LIST=$(list_failures_for_day "$DAY" || true)
if [[ -n "$FAIL_LIST" ]]; then
  echo
  echo "── callback failures today ──"
  while IFS= read -r reason; do
    [[ -z "$reason" ]] && continue
    n=$(get "funnel:cb-fail:$reason:$DAY")
    printf "  %-40s %s\n" "$reason" "$n"
  done <<< "$FAIL_LIST"
fi

echo
echo "Note: KV counters are eventually-consistent — small undercount possible"
echo "      under heavy concurrency. Roster, sessions, profiles are exact."
