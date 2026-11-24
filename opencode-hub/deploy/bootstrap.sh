#!/usr/bin/env bash
# bootstrap.sh — satu perintah dari VPS baru:
#   curl -fsSL https://raw.githubusercontent.com/cramelolo291-bot/freebuff/main/opencode-hub/deploy/bootstrap.sh \
#     | sudo bash -s -- --domain opencode.contoh.com --email anda@contoh.com
#
# Skrip ini: pasang git+curl -> clone repo (sparse, hanya folder opencode-hub)
# -> jalankan opencode-hub/deploy/install.sh dengan domain & email Anda.
#
# Catatan: karena skrip dikirim lewat pipe, stdin habis dipakai skrip. Prompt
# interaktif tetap jalan karena stdin install.sh diarahkan ke /dev/tty.
set -euo pipefail

REPO="https://github.com/cramelolo291-bot/freebuff.git"
REF="main"
DIR="/opt/freebuff"
DOMAIN=""
EMAIL=""
PASSTHRU=()

info() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] peringatan: %s\n' "$*" >&2; }
die() { printf '[bootstrap] GAGAL: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Pemakaian:
  curl -fsSL <url-bootstrap.sh> | sudo bash -s -- --domain D --email E [opsi]

Opsi bootstrap:
  --domain NAMA      domain untuk install.sh (mis. opencode.contoh.com)
  --email ALAMAT     email Let's Encrypt untuk install.sh
  --repo URL         repo git lain (default: github.com/cramelolo291-bot/freebuff)
  --ref BRANCH       branch/tag yang dipakai (default: main)
  --dir PATH         tempat clone (default: /opt/freebuff)
  --                 sisanya diteruskan ke install.sh
  -h, --help         bantuan ini

Contoh dengan opsi install.sh (login custom, sekaligus Hermes):
  curl -fsSL <url-bootstrap.sh> | sudo bash -s -- \
    --domain opencode.contoh.com --email anda@contoh.com -- --auth-user admin --hermes

Repo privat: kirim token di URL, mis.
  --repo https://TOKEN@github.com/user/repo.git
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain butuh nilai}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --email) EMAIL="${2:?--email butuh nilai}"; shift 2 ;;
    --email=*) EMAIL="${1#*=}"; shift ;;
    --repo) REPO="${2:?--repo butuh nilai}"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --ref) REF="${2:?--ref butuh nilai}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --dir) DIR="${2:?--dir butuh nilai}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; PASSTHRU=("$@"); break ;;
    *) usage >&2; die "opsi tidak dikenal: $1 (argumen install.sh taruh setelah --)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "butuh root. Jalankan: curl -fsSL <url> | sudo bash -s -- --domain ... --email ..."

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$@"
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install "$@"
  else
    die "tidak tahu cara memasang paket di distro ini; pasang manual: $*"
  fi
}

command -v git >/dev/null 2>&1 || { info "memasang git"; install_pkg git; }
command -v curl >/dev/null 2>&1 || { info "memasang curl"; install_pkg curl; }

# --- clone / update repo ------------------------------------------------------
mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR/.git" ]; then
  info "checkout sudah ada di $DIR — mengambil versi terbaru dari $REF"
  git -C "$DIR" fetch --depth 1 origin "$REF" || die "git fetch gagal (repo/branch salah, atau butuh --repo dengan token)"
  git -C "$DIR" checkout -q FETCH_HEAD
  git -C "$DIR" sparse-checkout set opencode-hub 2>/dev/null || warn "sparse-checkout tidak didukung git ini; folder lain ikut ada"
else
  [ -e "$DIR" ] && die "$DIR sudah ada tetapi bukan repo git. Hapus/pindahkan dulu, atau pakai --dir PATH-LAIN."
  info "clone $REPO (ref: $REF, sparse: opencode-hub/) ke $DIR"
  if git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO" "$DIR" 2>/dev/null; then
    git -C "$DIR" sparse-checkout set opencode-hub || true
  else
    warn "clone sparse gagal — mencoba clone biasa"
    rm -rf "$DIR"
    git clone --depth 1 --branch "$REF" "$REPO" "$DIR" \
      || die "clone gagal. Repo privat? Pakai --repo https://TOKEN@github.com/user/repo.git"
  fi
fi

DEPLOY="$DIR/opencode-hub/deploy"
[ -f "$DEPLOY/install.sh" ] || die "tidak menemukan $DEPLOY/install.sh di branch '$REF' — pastikan perubahan deploy sudah di-push ke branch itu"

# --- teruskan ke install.sh ---------------------------------------------------
ARGS=()
if [ -n "$DOMAIN" ]; then ARGS+=(--domain "$DOMAIN"); fi
if [ -n "$EMAIL" ]; then ARGS+=(--email "$EMAIL"); fi
if [ ${#PASSTHRU[@]} -gt 0 ]; then ARGS+=("${PASSTHRU[@]}"); fi

# /dev/tty bisa ada tapi tidak bisa dibuka (tanpa controlling terminal, mis. lewat cron).
HAVE_TTY=0
if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi
if { [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; } && [ "$HAVE_TTY" -eq 0 ]; then
  die "tanpa terminal interaktif, sebutkan --domain dan --email di perintah curl"
fi

info "menjalankan install.sh ${ARGS[*]:-}"
cd "$DEPLOY"
chmod +x install.sh
if [ "$HAVE_TTY" -eq 1 ]; then
  bash ./install.sh "${ARGS[@]}" </dev/tty
else
  bash ./install.sh "${ARGS[@]}" </dev/null
fi

cat <<EOF

Pemasangan selesai.
  Repo    : $DIR (branch $REF)
  Deploy  : $DEPLOY
  Domain  : ${DOMAIN:-lihat deploy/.env}

Perintah berikutnya:
  cd $DEPLOY && sudo docker compose ps
  cd $DEPLOY && sudo docker compose logs -f caddy hub opencode
  cd $DEPLOY && sudo docker compose up -d --build     # update kode
  sudo bash $DEPLOY/bootstrap.sh --dir $DIR --ref $REF   # update + jalankan ulang
EOF
