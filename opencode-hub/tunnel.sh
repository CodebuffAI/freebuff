#!/usr/bin/env bash
# Tunnel publik untuk hub (port 3000) yang auto-reconnect.
#
# Free tier serveo memutus port forwarding setelah beberapa saat; loop di bawah
# langsung menyambung lagi dan mencatat URL terbaru di .runtime/public-url.txt.
# Subdomain tetap tidak bisa tanpa akun serveo (butuh SSH key terdaftar), jadi
# URL-nya berganti setiap reconnect. Untuk alamat yang benar-benar tetap, pakai
# deploy/ (Docker + Caddy + domain sendiri) di VPS.
#
# cloudflared quick tunnel tidak bisa dipakai di VM ini: edge Cloudflare hanya
# lewat UDP/TCP 7844 dan port itu diblokir (precheck hard_fail, halaman 1033).
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p .runtime

: > .runtime/tunnel.log

log() { echo "[$(date -u +%H:%M:%SZ)] $*" >> .runtime/tunnel.log; }
URL=""
while :; do
  : > .runtime/lhr.log
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R 80:localhost:3000 serveo.net > .runtime/lhr.log 2>&1 &
  SSH_PID=$!
  echo "$SSH_PID" > .runtime/tunnel.pid

  NEW=""
  for _ in $(seq 1 20); do
    NEW=$(tr -d '\r' < .runtime/lhr.log \
          | grep -aoE "https://[a-z0-9.-]+serveousercontent\.com" | sort -u | head -1 || true)
    [ -n "$NEW" ] && break
    kill -0 "$SSH_PID" 2>/dev/null || break
    sleep 2
  done

  if [ -n "$NEW" ]; then
    URL="$NEW"
    echo "$URL" > .runtime/public-url.txt
    log "tunnel up: $URL (ssh pid $SSH_PID)"
  else
    log "tunnel gagal naik, ulang 3s"
  fi

  wait "$SSH_PID"
  log "tunnel putus (ssh pid $SSH_PID), sambung ulang 3s"
  sleep 3
done
