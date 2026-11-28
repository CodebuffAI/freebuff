#!/usr/bin/env bash
# Menjalankan tiga proses: server data, server opencode, dan server halaman hub.
# Password opencode dibuat otomatis dan tidak pernah ditulis ke dalam kode.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p .runtime

PASS_FILE=.opencode-server-password
if [ ! -f "$PASS_FILE" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$PASS_FILE"
  chmod 600 "$PASS_FILE"
  echo "[start] password opencode dibuat di $PASS_FILE (jangan di-commit)"
fi

export OPENCODE_SERVER_PASSWORD="$(tr -d '\n' <"$PASS_FILE")"
export OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:4096}"
export OPENCODE_HOST="${OPENCODE_HOST:-0.0.0.0}"
export OPENCODE_PORT="${OPENCODE_PORT:-4096}"
export DATA_URL="${DATA_URL:-http://127.0.0.1:8788}"
export DATA_PORT="${DATA_PORT:-8788}"
export HUB_PORT="${HUB_PORT:-3000}"
export DATA_HOST="${DATA_HOST:-127.0.0.1}"
export HUB_HOST="${HUB_HOST:-0.0.0.0}"

is_running() {
  [ -f ".runtime/$1.pid" ] && kill -0 "$(cat ".runtime/$1.pid")" 2>/dev/null
}

launch() {
  local name=$1
  shift
  if is_running "$name"; then
    echo "[start] $name sudah jalan (pid $(cat ".runtime/$name.pid"))"
    return
  fi
  nohup "$@" >".runtime/$name.log" 2>&1 &
  echo $! >".runtime/$name.pid"
  echo "[start] $name pid $(cat ".runtime/$name.pid")"
}

launch data node data-server.mjs

if command -v opencode >/dev/null 2>&1; then
  launch opencode opencode web --port "$OPENCODE_PORT" --hostname "$OPENCODE_HOST"
else
  echo "[start] peringatan: perintah 'opencode' tidak ditemukan."
  echo "        pasang dulu: npm i -g @opencode/cli@latest  (atau lihat https://opencode.ai/docs)"
fi

launch hub node hub-server.mjs

echo "[start] selesai. Halaman: http://127.0.0.1:${HUB_PORT}"
echo "[start] log: .runtime/*.log"
