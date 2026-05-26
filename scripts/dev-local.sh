#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/spirevault-dev.pids"
WORKER_LOG="/tmp/spirevault-worker.log"
WEB_LOG="/tmp/spirevault-web.log"
DEV_VARS="$REPO_ROOT/Web/.dev.vars"
WORKER_ORIGIN_EXPECTED="http://127.0.0.1:8787"

"$REPO_ROOT/scripts/dev-local-stop.sh" >/dev/null 2>&1 || true

if [[ ! -f "$DEV_VARS" ]]; then
  echo "Missing $DEV_VARS — create it with:"
  echo "  WORKER_ORIGIN_OVERRIDE=$WORKER_ORIGIN_EXPECTED"
  exit 1
fi

if ! grep -qE '^WORKER_ORIGIN_OVERRIDE=http://127\.0\.0\.1:8787' "$DEV_VARS"; then
  echo "Warning: Web/.dev.vars should set WORKER_ORIGIN_OVERRIDE=$WORKER_ORIGIN_EXPECTED"
  echo "  (so /api/* proxies to your local worker, not production)."
fi

: > "$WORKER_LOG"
: > "$WEB_LOG"

(
  cd "$REPO_ROOT/Backend"
  npx wrangler dev --env localdev --port 8787 >>"$WORKER_LOG" 2>&1
) &
WORKER_PID=$!

(
  cd "$REPO_ROOT/Web"
  npx --yes wrangler@latest pages dev . --port 8788 --ip 127.0.0.1 >>"$WEB_LOG" 2>&1
) &
WEB_PID=$!

cat >"$PID_FILE" <<PIDS
WORKER_PID=$WORKER_PID
WEB_PID=$WEB_PID
PIDS

wait_for() {
  local url="$1"
  local name="$2"
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$WORKER_PID" 2>/dev/null || ! kill -0 "$WEB_PID" 2>/dev/null; then
      echo "✘ $name exited early. Last log lines:"
      tail -20 "$WORKER_LOG" 2>/dev/null || true
      tail -20 "$WEB_LOG" 2>/dev/null || true
      exit 1
    fi
    sleep 1
  done
  echo "✘ Timed out waiting for $name at $url"
  echo "  Worker log: $WORKER_LOG"
  echo "  Web log:    $WEB_LOG"
  exit 1
}

wait_for "http://127.0.0.1:8787/" "Backend worker"
wait_for "http://127.0.0.1:8788/" "Web pages dev"

echo ""
echo "Local dev is running."
echo "  Open:  http://127.0.0.1:8788   (SpireVault app — NOT the marketing site)"
echo "  Marketing site (optional): make -C Site dev — uses port 8788 too; run only one at a time, or: npx wrangler pages dev Site -p 4321"
echo "  Sign in (dev): http://127.0.0.1:8788/api/_dev-login?as=c3rooks"
echo "  Logs:  $WORKER_LOG  and  $WEB_LOG"
echo "  Stop:  $REPO_ROOT/scripts/dev-local-stop.sh"
echo ""
