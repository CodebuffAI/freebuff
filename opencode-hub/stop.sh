#!/usr/bin/env bash
# Menghentikan proses yang diluncurkan start.sh (hanya PID yang dicatat sendiri).
set -euo pipefail
cd "$(dirname "$0")"

for name in hub opencode data; do
  pid_file=".runtime/$name.pid"
  [ -f "$pid_file" ] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "[stop] $name (pid $pid) dihentikan"
  fi
  rm -f "$pid_file"
done
