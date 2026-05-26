#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/spirevault-dev.pids"

kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

if [[ -f "$PID_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$PID_FILE"
  kill_pid "${WORKER_PID:-}"
  kill_pid "${WEB_PID:-}"
  rm -f "$PID_FILE"
fi

for port in 8787 8788; do
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
done

echo "Stopped local dev (ports 8787 and 8788)."
