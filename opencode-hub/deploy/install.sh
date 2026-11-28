#!/usr/bin/env bash
# install.sh — satu perintah untuk VPS baru:
#   1. memasang Docker + plugin compose (kalau belum ada)
#   2. mengisi deploy/.env (domain, email ACME, password server opencode)
#   3. menulis deploy/auth.caddy (login basic auth untuk domain Anda)
#   4. menjalankan Caddy + hub + data + opencode lewat docker compose
#
# Contoh:
#   sudo ./install.sh --domain opencode.contoh.com --email saya@contoh.com
#   ./install.sh --help
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN=""
EMAIL=""
AUTH_USER="admin"
AUTH_PASSWORD=""
ENABLE_AUTH=1
WITH_HERMES=0
SKIP_DNS=0
ASSUME_YES=0
FORCE=0

usage() {
  cat <<'EOF'
Pemakaian: ./install.sh [opsi]

  --domain NAMA          domain yang dipakai, mis. opencode.contoh.com
  --email ALAMAT         email untuk Let's Encrypt (ACME)
  --auth-user NAMA       user login basic auth (default: admin)
  --auth-password PASS   password login; kalau tidak diisi, dibuatkan acak
  --no-auth              jangan pasang basic auth (SIAPA PUN bisa memakai opencode)
  --hermes               sekaligus build image Hermes Agent (setup manual sesudahnya)
  --skip-dns-check       lewati pemeriksaan record A (DNS belum propagasi)
  -y, --yes              jangan bertanya, pakai default
  --force                tetap lanjut walau port 80/443 terpakai atau DNS tidak cocok
  -h, --help             tampilkan bantuan ini

Tanpa opsi, skrip menanyakan domain dan email. Password opencode untuk API
dibuat otomatis dan hanya disimpan di deploy/.env (mode 600).
EOF
}

info() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] peringatan: %s\n' "$*" >&2; }
die() { printf '[deploy] GAGAL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain butuh nilai}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --email) EMAIL="${2:?--email butuh nilai}"; shift 2 ;;
    --email=*) EMAIL="${1#*=}"; shift ;;
    --auth-user) AUTH_USER="${2:?--auth-user butuh nilai}"; shift 2 ;;
    --auth-password) AUTH_PASSWORD="${2:?--auth-password butuh nilai}"; shift 2 ;;
    --no-auth) ENABLE_AUTH=0; shift ;;
    --hermes) WITH_HERMES=1; shift ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "opsi tidak dikenal: $1" ;;
  esac
done

# --- 1. hak akses -------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "jalankan sebagai root, atau pasang sudo dulu"
  SUDO="sudo"
fi

install_pkg() {
  local pkgs=("$@")
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y && $SUDO apt-get install -y "${pkgs[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y "${pkgs[@]}"
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y "${pkgs[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    $SUDO zypper --non-interactive install "${pkgs[@]}"
  else
    die "tidak tahu cara memasang paket di distro ini; pasang manual: ${pkgs[*]}"
  fi
}

# --- 2. Docker ----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  info "Docker belum ada — memasang dari https://get.docker.com"
  command -v curl >/dev/null 2>&1 || install_pkg curl
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  $SUDO sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  if [ -n "$SUDO" ] && ! id -nG "$USER" 2>/dev/null | grep -qw docker; then
    $SUDO usermod -aG docker "$USER" || true
    info "user $USER ditambahkan ke grup docker (aktif setelah login ulang)"
  fi
fi

# Pakai sudo kalau daemon docker belum bisa diakses user ini.
if docker info >/dev/null 2>&1; then
  DK="docker"
else
  $SUDO docker info >/dev/null 2>&1 || die "daemon docker tidak jalan. Coba: sudo systemctl enable --now docker"
  DK="$SUDO docker"
fi

$DK compose version >/dev/null 2>&1 || die \
  "plugin 'docker compose' tidak ada. Pasang: sudo apt install docker-compose-plugin (Debian/Ubuntu) atau lihat https://docs.docker.com/compose/install/linux/"

command -v curl >/dev/null 2>&1 || install_pkg curl

# --- 3. port 80/443 harus bebas ----------------------------------------------
port_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
}
BUSY=""
for p in 80 443; do
  port_busy "$p" && BUSY="$BUSY $p"
done
if [ -n "$BUSY" ]; then
  if [ "$FORCE" -eq 1 ]; then
    warn "port$BUSY sudah dipakai proses lain — lanjut karena --force"
  else
    die "port$BUSY sudah dipakai proses lain (nginx/apache/caddy lama?). Hentikan dulu, atau pakai --force kalau itu Caddy milik stack ini."
  fi
fi

# --- 4. domain + email --------------------------------------------------------
ask() {
  local prompt=$1 default=${2:-} answer=""
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " answer || true
  else
    read -r -p "$prompt: " answer || true
  fi
  printf '%s' "${answer:-$default}"
}

ask_secret() {
  local prompt=$1 answer=""
  read -r -s -p "$prompt: " answer || true
  printf '\n' >&2
  printf '%s' "$answer"
}

if [ -z "$DOMAIN" ]; then
  if [ ! -t 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
    die "domain belum diisi. Jalankan: ./install.sh --domain opencode.contoh.com --email anda@contoh.com"
  fi
  DOMAIN="$(ask 'Domain (mis. opencode.contoh.com)')"
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##')"
printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' \
  || die "domain tidak valid: '$DOMAIN' (contoh yang benar: opencode.contoh.com)"

if [ -z "$EMAIL" ]; then
  if [ -t 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    EMAIL="$(ask 'Email untuk sertifikat HTTPS (Let'"'"'s Encrypt)')"
  else
    die "email belum diisi. Tambahkan --email anda@contoh.com"
  fi
fi
case "$EMAIL" in
  *@*.*) ;;
  *) die "email tidak valid: '$EMAIL'" ;;
esac

# --- 5. DNS harus menunjuk ke server ini -------------------------------------
if [ "$SKIP_DNS" -eq 0 ]; then
  info "memeriksa DNS $DOMAIN"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
  if [ -z "$RESOLVED" ]; then
    die "DNS $DOMAIN belum punya record A. Buat dulu: A $DOMAIN -> IP publik VPS ini, tunggu propagasi, lalu jalankan lagi. (Paksa lewat: --skip-dns-check)"
  fi
  PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$PUBLIC_IP" ]; then
    warn "IP publik server tidak terdeteksi; DNS tidak bisa dicocokkan"
  else
    case " $RESOLVED " in
      *" $PUBLIC_IP "*) info "DNS cocok: $DOMAIN -> $PUBLIC_IP" ;;
      *)
        if [ "$FORCE" -eq 1 ]; then
          warn "DNS $DOMAIN -> $RESOLVED, IP server $PUBLIC_IP (lanjut karena --force)"
        else
          die "DNS $DOMAIN -> $RESOLVED, tetapi IP publik server ini $PUBLIC_IP. Perbaiki record A dulu, atau pakai --force / --skip-dns-check."
        fi
        ;;
    esac
  fi
fi

# --- 6. .env ------------------------------------------------------------------
umask 077
if [ -f .env ]; then
  BACKUP=".env.bak.$(date +%Y%m%d%H%M%S)"
  cp .env "$BACKUP"
  info ".env sudah ada — disimpan cadangannya di $BACKUP"
else
  cp .env.example .env
  info ".env dibuat dari .env.example"
fi

set_env() { # set_env KEY VALUE  -> upsert satu baris, aman untuk nilai apa pun
  local key=$1 value=$2
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$value" '$0 ~ "^"k"=" {print k"="v; next} {print}' .env > .env.tmp
    mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

gen_pass() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '/+=\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '/+=\n'
  fi
}

set_env HUB_DOMAIN "$DOMAIN"
set_env ACME_EMAIL "$EMAIL"

CUR_PASS="$(grep -E '^OPENCODE_SERVER_PASSWORD=' .env | head -n1 | cut -d= -f2- || true)"
if [ -z "$CUR_PASS" ]; then
  set_env OPENCODE_SERVER_PASSWORD "$(gen_pass)"
  info "password API opencode dibuat acak dan disimpan di deploy/.env (mode 600)"
fi
chmod 600 .env

# --- 7. login basic auth di Caddy --------------------------------------------
AUTH_GENERATED=0
if [ "$ENABLE_AUTH" -eq 1 ]; then
  if [ -z "$AUTH_PASSWORD" ] && [ -t 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    AUTH_PASSWORD="$(ask_secret "Password login https://$DOMAIN (kosongkan = dibuatkan acak)")"
  fi
  if [ -z "$AUTH_PASSWORD" ]; then
    AUTH_PASSWORD="$(gen_pass)"
    AUTH_GENERATED=1
  fi
  info "membuat hash password login (butuh image caddy:2-alpine)"
  HASH="$($DK run --rm caddy:2-alpine caddy hash-password --plaintext "$AUTH_PASSWORD" | tr -d '\r\n')"
  case "$HASH" in
    \$2*) ;;
    *) die "gagal membuat hash password Caddy (keluaran: '$HASH')" ;;
  esac
  {
    printf '# Dibuat otomatis oleh install.sh. Jalankan ulang install.sh untuk mengganti password.\n'
    printf 'basic_auth {\n\t%s %s\n}\n' "$AUTH_USER" "$HASH"
  } > auth.caddy
  chmod 600 auth.caddy
  info "basic auth aktif untuk user '$AUTH_USER'"
else
  printf '# Basic auth dimatikan (install.sh --no-auth). Siapa pun bisa memakai opencode di domain ini.\n' > auth.caddy
  warn "basic auth dimatikan: domain Anda terbuka untuk siapa saja yang tahu alamatnya"
fi

# --- 8. jalankan stack --------------------------------------------------------
info "build + start: caddy, hub, data, opencode"
$DK compose up -d --build caddy hub data opencode

if [ "$WITH_HERMES" -eq 1 ]; then
  info "build image Hermes Agent (tanpa start; setup butuh terminal interaktif)"
  $DK compose --profile hermes build hermes
fi

# --- 9. tunggu sertifikat + health -------------------------------------------
CURL_AUTH=()
[ "$ENABLE_AUTH" -eq 1 ] && CURL_AUTH=(-u "$AUTH_USER:$AUTH_PASSWORD")

info "menunggu https://$DOMAIN siap (sertifikat Let's Encrypt bisa butuh ~30 detik)"
READY=0
for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    --resolve "$DOMAIN:443:127.0.0.1" "${CURL_AUTH[@]}" \
    "https://$DOMAIN/api/health" 2>/dev/null || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 3
done

echo
if [ "$READY" -eq 1 ]; then
  echo "=== Selesai — opencode sudah online di domain Anda ==="
else
  echo "=== Stack sudah jalan, tetapi https://$DOMAIN belum menjawab 200 ==="
  echo "Cek log sertifikat:  $DK compose logs --tail=50 caddy"
fi
echo "URL        : https://$DOMAIN"
if [ "$ENABLE_AUTH" -eq 1 ]; then
  echo "Login      : user '$AUTH_USER'"
  if [ "$AUTH_GENERATED" -eq 1 ]; then
    echo "Password   : $AUTH_PASSWORD"
    echo "             (hanya ditampilkan sekali; ganti dengan menjalankan install.sh lagi)"
  else
    echo "Password   : yang Anda masukkan tadi"
  fi
else
  echo "Login      : tidak ada (--no-auth)"
fi
echo
echo "Perintah harian (jalankan di folder ini):"
echo "  $DK compose ps"
echo "  $DK compose logs -f hub opencode caddy"
echo "  $DK compose up -d --build          # update"
echo "  $DK compose restart                # restart"
echo "  $DK compose down                   # stop (volume tetap)"
if [ "$WITH_HERMES" -eq 1 ]; then
  echo
  echo "Hermes Agent (image sudah dibangun, belum start):"
  echo "  $DK compose run --rm -it hermes hermes setup"
  echo "  $DK compose --profile hermes up -d hermes"
fi
