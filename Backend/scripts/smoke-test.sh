#!/usr/bin/env bash
# End-to-end smoke test for vault-coop. Hits every public route, then
# attempts the auth-gated routes against a session token you supply.
#
# Usage:
#   ./scripts/smoke-test.sh https://vault-coop.you.workers.dev [SESSION_TOKEN]
#
# Get a SESSION_TOKEN by signing in once through The Vault macOS app, then
#   cat ~/Library/Application\ Support/AscensionCompanion/vault/steam-session.json
# and copy the `sessionToken` field.
#
# This is a developer convenience — there is no fake/mock data path. Every
# entry that gets created is a real entry tied to your verified SteamID.

set -euo pipefail

BASE="${1:-}"
TOKEN="${2:-}"

if [[ -z "$BASE" ]]; then
  echo "Usage: $0 <base-url> [session-token]" >&2
  exit 2
fi

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

echo
bold "→ GET /  (health)"
curl -fsS "$BASE/" && echo

echo
bold "→ GET /presence  (public list)"
curl -fsS "$BASE/presence" | jq . || curl -fsS "$BASE/presence"

if [[ -z "$TOKEN" ]]; then
  echo
  red "No session token provided. Skipping auth-gated routes."
  echo "    Sign in via the macOS app once, then re-run with the session token."
  exit 0
fi

AUTH=("-H" "Authorization: Bearer $TOKEN")
BODY='{"status":"looking","note":"smoke-test heartbeat","discordHandle":"","stats":{"totalRuns":42,"wins":7,"maxAscension":3,"preferredCharacter":"silent"}}'

echo
bold "→ POST /presence  (heartbeat)"
curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "$BODY" "$BASE/presence" | jq . || true

echo
bold "→ GET /presence  (should now contain your row)"
curl -fsS "$BASE/presence" | jq . || true

echo
bold "→ DELETE /presence  (sign-off)"
curl -fsS -X DELETE "${AUTH[@]}" "$BASE/presence" | jq . || true

echo
green "✓ smoke test complete"
