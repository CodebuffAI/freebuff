#!/usr/bin/env bash
# doctor.sh — periksa sendiri kenapa https://domain-anda.com belum jalan.
#
# Skrip ini hanya MEMBACA keadaan VPS: DNS, port 80/443, container, sertifikat
# Caddy, dan /api/health. Tidak mengubah apa pun, jadi aman dijalankan kapan saja.
# Tiap kegagalan disertai saran perbaikan.
#
# Contoh:
#   sudo ./doctor.sh                       # domain dibaca dari deploy/.env
#   ./doctor.sh --domain opencode.contoh.com
#   ./doctor.sh --help
#
# Kode keluar: 0 = semua lolos, 1 = ada yang gagal, 2 = salah pemakaian.
set -uo pipefail
cd "$(dirname "$0")"

DOMAIN=""

usage() {
  cat <<'EOF'
Pemakaian: ./doctor.sh [opsi]

  --domain NAMA   domain yang diperiksa (default: HUB_DOMAIN dari deploy/.env)
  -h, --help      tampilkan bantuan ini

Skrip hanya membaca keadaan (tidak mengubah konfigurasi). Jalankan dengan sudo
supaya nama proses pemilik port 80/443 terlihat.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain butuh nilai}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'opsi tidak dikenal: %s\n' "$1" >&2; exit 2 ;;
  esac
done

FAILS=0
WARNS=0

section() { printf '\n== %s ==\n' "$*"; }
ok() { printf '[ ok ] %s\n' "$*"; }
note() { printf '[info] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
bad() { printf '[FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
hint() { printf '       -> %s\n' "$*"; }

BODY_FILE="$(mktemp 2>/dev/null || echo /tmp/doctor-body.$$)"
trap 'rm -f "$BODY_FILE"' EXIT

env_get() { # env_get KEY  -> nilai dari .env (tanpa tanda kutip)
  [ -f .env ] || return 0
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# --- 1. berkas konfigurasi ----------------------------------------------------
section "Berkas konfigurasi"

if [ -f .env ]; then
  MODE="$(stat -c '%a' .env 2>/dev/null || true)"
  ok ".env ditemukan"
  if [ -n "$MODE" ] && [ "$MODE" != "600" ] && [ "$MODE" != "400" ]; then
    warn ".env bermode $MODE (berisi password opencode)"
    hint "chmod 600 .env"
  fi
else
  bad ".env tidak ada di $(pwd)"
  hint "jalankan installer: sudo ./install.sh --domain DOMAIN --email EMAIL"
fi

[ -z "$DOMAIN" ] && DOMAIN="$(env_get HUB_DOMAIN)"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##')"

ACME_EMAIL="$(env_get ACME_EMAIL)"
OC_PASS="$(env_get OPENCODE_SERVER_PASSWORD)"
# Nilai pengganti supaya saran perintah tetap bisa disalin walau .env belum ada.
D_ARG="${DOMAIN:-DOMAIN}"
E_ARG="${ACME_EMAIL:-EMAIL}"

if [ -z "$DOMAIN" ]; then
  bad "domain belum diketahui (HUB_DOMAIN kosong dan --domain tidak diisi)"
  hint './doctor.sh --domain opencode.contoh.com'
  hint "atau isi HUB_DOMAIN di .env lewat: sudo ./install.sh --domain ... --email ..."
elif [ "$DOMAIN" = "opencode.contoh.com" ]; then
  bad "HUB_DOMAIN masih nilai contoh: $DOMAIN"
  hint "ganti: sudo ./install.sh --domain domain-anda.com --email anda@domain-anda.com"
else
  ok "domain: $DOMAIN"
fi

if [ -z "$ACME_EMAIL" ] || [ "$ACME_EMAIL" = "you@example.com" ]; then
  warn "ACME_EMAIL kosong/masih contoh — Let's Encrypt tidak bisa menerbitkan sertifikat"
  hint "sudo ./install.sh --domain $D_ARG --email $E_ARG"
else
  ok "email ACME: $ACME_EMAIL"
fi

if [ -z "$OC_PASS" ]; then
  bad "OPENCODE_SERVER_PASSWORD kosong di .env"
  hint "jalankan ulang: sudo ./install.sh --domain $D_ARG --email $E_ARG"
else
  ok "password server opencode terisi (tidak ditampilkan)"
fi

if [ -f auth.caddy ] && grep -qE '^[[:space:]]*basic_auth' auth.caddy; then
  AUTH_USER="$(awk '/basic_auth/{f=1; next} f&&/}/{exit} f&&NF{print $1; exit}' auth.caddy)"
  ok "login basic auth aktif${AUTH_USER:+ (user: $AUTH_USER)}"
elif [ -f auth.caddy ]; then
  warn "auth.caddy tanpa basic_auth: siapa pun yang tahu domain bisa memakai opencode"
  hint "sudo ./install.sh --domain $D_ARG --email $E_ARG   (membuat password login)"
else
  bad "auth.caddy tidak ada — Caddy akan menolak start (import auth.caddy)"
  hint "sudo ./install.sh --domain $D_ARG --email $E_ARG"
fi

# --- 2. docker ----------------------------------------------------------------
section "Docker"

DK="docker"
HAVE_DOCKER=0
HAVE_COMPOSE=0

if ! command -v docker >/dev/null 2>&1; then
  bad "docker tidak terpasang"
  hint "installer memasangnya otomatis: sudo ./install.sh --domain $D_ARG --email $E_ARG"
else
  HAVE_DOCKER=1
  if docker info >/dev/null 2>&1; then
    DK="docker"
    ok "daemon docker jalan (tanpa sudo)"
  elif [ "$(id -u)" -eq 0 ]; then
    DK="docker"
    bad "daemon docker tidak menjawab (walaupun berjalan sebagai root)"
    hint "sudo systemctl enable --now docker"
    hint "sudo journalctl -u docker --no-pager -n 50"
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DK="sudo docker"
    ok "daemon docker jalan (lewat sudo)"
  else
    bad "tidak bisa mengakses daemon docker"
    hint "jalankan skrip ini dengan sudo: sudo ./doctor.sh"
    hint "atau: sudo usermod -aG docker \$USER ; lalu logout dan login lagi"
    hint "kalau service mati: sudo systemctl enable --now docker"
  fi

  if $DK compose version >/dev/null 2>&1; then
    HAVE_COMPOSE=1
    ok "plugin docker compose tersedia"
  else
    bad "plugin 'docker compose' tidak tersedia"
    hint "sudo apt install docker-compose-plugin   (Debian/Ubuntu)"
  fi
fi

COMPOSE_OK=0
[ "$HAVE_DOCKER" -eq 1 ] && [ "$HAVE_COMPOSE" -eq 1 ] && $DK info >/dev/null 2>&1 && COMPOSE_OK=1

# --- 3. container -------------------------------------------------------------
section "Container"

RUNNING=""
if [ "$COMPOSE_OK" -eq 1 ]; then
  PS_OUT="$($DK compose ps --format '{{.Service}}|{{.State}}|{{.Status}}|{{.Health}}' 2>/dev/null || true)"
  if [ -z "$PS_OUT" ]; then
    bad "tidak ada container stack ini yang berjalan"
    hint "cd $(pwd) && sudo docker compose up -d --build"
    hint "atau lihat sebabnya: sudo docker compose logs --tail=80"
  else
    for svc in caddy hub data opencode; do
      ROW="$(printf '%s\n' "$PS_OUT" | awk -F'|' -v s="$svc" '$1 == s {print; exit}')"
      if [ -z "$ROW" ]; then
        bad "container '$svc' tidak ada / tidak jalan"
        hint "sudo docker compose up -d --build $svc"
        hint "sudo docker compose logs --tail=50 $svc"
        continue
      fi
      STATE="$(printf '%s' "$ROW" | cut -d'|' -f2)"
      STATUS="$(printf '%s' "$ROW" | cut -d'|' -f3)"
      HEALTH="$(printf '%s' "$ROW" | cut -d'|' -f4)"

      if [ "$STATE" != "running" ]; then
        bad "$svc: state '$STATE' ($STATUS)"
        case "$STATUS" in
          *Restarting*) hint "$svc crash-loop. Lihat: sudo docker compose logs --tail=80 $svc" ;;
          *) hint "sudo docker compose up -d $svc ; sudo docker compose logs --tail=50 $svc" ;;
        esac
        continue
      fi

      RUNNING="$RUNNING $svc"
      case "$HEALTH" in
        ""|"<no value>") ok "$svc: running (tanpa healthcheck compose)" ;;
        healthy) ok "$svc: running, healthy" ;;
        *) bad "$svc: running tapi health '$HEALTH'"; hint "sudo docker compose logs --tail=50 $svc" ;;
      esac
    done
  fi
else
  note "pemeriksaan container dilewati (docker/compose tidak siap)"
fi

# Probe HTTP internal: membuktikan tiap layanan benar-benar menjawab, bukan cuma hidup.
if [ "$COMPOSE_OK" -eq 1 ] && [ -n "$RUNNING" ]; then
  case " $RUNNING " in
    *" caddy "*)
      case " $RUNNING " in
        *" hub "*)
          if $DK compose exec -T caddy wget -q -T 5 -O /dev/null http://hub:3000/api/health >/dev/null 2>&1; then
            ok "hub menjawab http://hub:3000/api/health"
          else
            bad "caddy tidak bisa menghubungi hub:3000"
            hint "sudo docker compose logs --tail=80 hub"
            hint "pastikan container hub ada di network 'edge' (docker compose config)"
          fi
          ;;
      esac
      ;;
  esac
  case " $RUNNING " in
    *" hub "*)
      if $DK compose exec -T hub wget -q -T 5 -O /dev/null http://opencode:4096/ >/dev/null 2>&1; then
        ok "opencode menjawab di :4096 (UI web)"
      else
        bad "hub tidak bisa menghubungi opencode:4096"
        hint "sudo docker compose logs --tail=80 opencode"
        hint "kalau log menampilkan 'serve' atau 404 di akar, image lama: sudo docker compose build --no-cache opencode && sudo docker compose up -d opencode"
      fi
      if $DK compose exec -T hub wget -q -T 5 -O /dev/null http://data:8788/health >/dev/null 2>&1; then
        ok "server data menjawab di :8788/health"
      else
        bad "hub tidak bisa menghubungi data:8788"
        hint "sudo docker compose logs --tail=80 data"
      fi
      ;;
  esac
fi

# --- 4. port 80/443 -----------------------------------------------------------
section "Port 80 dan 443"

if ! command -v ss >/dev/null 2>&1; then
  warn "perintah 'ss' tidak ada, pemeriksaan port dilewati"
  hint "sudo apt install iproute2"
else
  for p in 80 443; do
    BUSY_LINE="$(ss -ltnH 2>/dev/null | grep -E "[:.]$p[[:space:]]" | head -n1 || true)"
    OWNER_LINE="$(ss -ltnpH 2>/dev/null | grep -E "[:.]$p[[:space:]]" | head -n1 || true)"
    if [ -z "$BUSY_LINE" ]; then
      bad "tidak ada yang mendengarkan di port $p"
      if [ "$p" = "80" ]; then
        hint "port 80 wajib terbuka untuk verifikasi sertifikat (HTTP-01)"
        hint "kalau provider memblokir 80: pakai DNS-01 atau Cloudflare Tunnel"
      else
        hint "container caddy belum jalan: sudo docker compose ps"
        hint "cek firewall: sudo iptables -S ; sudo ufw status"
      fi
      continue
    fi
    case "$OWNER_LINE" in
      *docker-proxy*|*caddy*)
        ok "port $p dipakai container caddy"
        ;;
      "")
        warn "port $p sudah terpakai, pemilik proses tidak terlihat"
        hint "ulangi dengan sudo supaya nama prosesnya muncul: sudo ss -ltnp | grep :$p"
        ;;
      *)
        PROC="$(printf '%s' "$OWNER_LINE" | grep -o 'users:(([^)]*)' | head -n1)"
        bad "port $p dipakai proses lain: ${PROC:-tidak diketahui}"
        hint "sudo ss -ltnp | grep :$p"
        hint "hentikan pemakainya, mis. sudo systemctl stop nginx   (atau apache2)"
        hint "kalau ternyata itu caddy milik stack ini, abaikan saja"
        ;;
    esac
  done
fi

# --- 5. DNS -------------------------------------------------------------------
PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://ifconfig.me/ip 2>/dev/null || true)"

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "opencode.contoh.com" ]; then
  section "DNS"
  note "pemeriksaan DNS dilewati karena domain belum valid"
else
  section "DNS: $DOMAIN"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  PUBLIC_DNS=""
  if command -v dig >/dev/null 2>&1; then
    PUBLIC_DNS="$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  fi

  if [ -z "$RESOLVED" ]; then
    bad "$DOMAIN belum punya record A (resolver server ini tidak menemukannya)"
    hint "buat di DNS: A  $DOMAIN  ->  ${PUBLIC_IP:-IP-PUBLIK-VPS}"
    hint "tunggu propagasi (TTL, biasanya 1-10 menit), lalu jalankan lagi"
    hint "uji dari luar: dig +short $DOMAIN   atau   nslookup $DOMAIN 1.1.1.1"
  elif [ -z "$PUBLIC_IP" ]; then
    warn "DNS $DOMAIN -> $RESOLVED, tetapi IP publik server tidak terdeteksi"
    hint "bandingkan manual dengan IP VPS Anda (ip addr / panel provider)"
  else
    case " $RESOLVED " in
      *" $PUBLIC_IP "*)
        ok "$DOMAIN -> $RESOLVED (sama dengan IP publik server ini)"
        ;;
      *)
        bad "$DOMAIN -> $RESOLVED, tetapi IP publik server ini $PUBLIC_IP"
        hint "perbaiki record A menjadi: A  $DOMAIN  ->  $PUBLIC_IP"
        case " $RESOLVED " in
          *" 104."*|*" 172.6"*|*" 172.7"*)
            note "IP 104.x / 172.6x-172.7x biasanya proxy Cloudflare: matikan proxy (awan oranye -> abu-abu)"
            ;;
        esac
        hint "kalau VPS di balik NAT/load balancer, pastikan port 80/443 diteruskan ke server ini"
        ;;
    esac
  fi

  if [ -n "$PUBLIC_DNS" ] && [ -n "$RESOLVED" ] && [ "$PUBLIC_DNS" != "$RESOLVED" ]; then
    warn "resolver lokal ($RESOLVED) beda dengan 1.1.1.1 ($PUBLIC_DNS): propagasi belum merata"
    hint "tunggu beberapa menit; Caddy akan mencoba lagi sendiri"
  fi
fi

# --- 6. sertifikat HTTPS ------------------------------------------------------
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "opencode.contoh.com" ]; then
  section "Sertifikat HTTPS"
  note "pemeriksaan sertifikat dilewati karena domain belum valid"
else
  section "Sertifikat HTTPS (127.0.0.1:443)"
  if ! command -v openssl >/dev/null 2>&1; then
    warn "openssl tidak ada, pemeriksaan sertifikat dilewati"
    hint "sudo apt install openssl"
  else
    TLS_RAW="$(echo | timeout 12 openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null || true)"
    if ! printf '%s' "$TLS_RAW" | grep -q 'BEGIN CERTIFICATE'; then
      bad "TLS di 127.0.0.1:443 tidak memberikan sertifikat"
      hint "container caddy jalan? sudo docker compose ps caddy"
      hint "log penerbitan: sudo docker compose logs --tail=80 caddy"
      hint "kalau log menyebut 'no such host'/'NXDOMAIN', perbaiki DNS dulu (bagian di atas)"
    else
      CERT="$(printf '%s\n' "$TLS_RAW" | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)"
      SUBJECT="$(printf '%s\n' "$CERT" | sed -n 's/^subject=//p')"
      ISSUER="$(printf '%s\n' "$CERT" | sed -n 's/^issuer=//p')"
      NOT_AFTER="$(printf '%s\n' "$CERT" | sed -n 's/^notAfter=//p')"
      VERIFY="$(printf '%s\n' "$TLS_RAW" | grep -o 'Verify return code: [0-9]* ([^)]*)' | tail -n1 || true)"

      note "subject: ${SUBJECT:-?}"
      note "issuer : ${ISSUER:-?}"
      note "berakhir: ${NOT_AFTER:-?}"

      case "$SUBJECT" in
        *"$DOMAIN"*) ok "sertifikat berlaku untuk $DOMAIN" ;;
        *) warn "sertifikat tidak menyebut $DOMAIN — kemungkinan domain belum cocok dengan HUB_DOMAIN" ;;
      esac

      case "$ISSUER" in
        *"Let's Encrypt"*|*"ZeroSSL"*)
          ok "sertifikat publik (${ISSUER})"
          ;;
        *"Caddy"*|*"local"*|*"Local"*)
          bad "sertifikat internal Caddy, bukan sertifikat publik"
          hint "ini terjadi kalau ACME gagal. Lihat: sudo docker compose logs --tail=80 caddy"
          hint "penyebab umum: DNS belum menunjuk server ini, atau port 80 diblokir"
          ;;
        *)
          warn "penerbit sertifikat tidak dikenali (${ISSUER:-kosong})"
          ;;
      esac

      case "$VERIFY" in
        *"code: 0"*) ok "rantai sertifikat valid di mesin ini" ;;
        "") note "status verifikasi rantai tidak terbaca" ;;
        *) warn "verifikasi rantai: $VERIFY"
           hint "sering karena CA lokal belum dikenal; cek juga dari browser/HP" ;;
      esac

      END_EPOCH="$(date -d "$NOT_AFTER" +%s 2>/dev/null || true)"
      NOW_EPOCH="$(date +%s)"
      if [ -n "$END_EPOCH" ]; then
        DAYS=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))
        if [ "$DAYS" -lt 0 ]; then
          bad "sertifikat sudah kedaluwarsa $((-DAYS)) hari lalu"
          hint "sudo docker compose restart caddy ; atau sudo docker compose down && sudo docker compose up -d"
        elif [ "$DAYS" -lt 14 ]; then
          warn "sertifikat tinggal $DAYS hari — perpanjangan otomatis Caddy mungkin gagal"
          hint "sudo docker compose logs --tail=80 caddy"
        else
          ok "sertifikat masih berlaku $DAYS hari"
        fi
      fi
    fi
  fi
fi

# --- 7. HTTP /api/health ------------------------------------------------------
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "opencode.contoh.com" ]; then
  section "HTTP /api/health"
  note "pemeriksaan HTTP dilewati karena domain belum valid"
else
  section "HTTP https://$DOMAIN/api/health"

  CODE_LOCAL="$(curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 12 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || true)"
  case "$CODE_LOCAL" in
    200)
      ok "200 dari Caddy lokal: $(head -c 200 "$BODY_FILE" 2>/dev/null)"
      ;;
    401)
      ok "401 tanpa password = login basic auth aktif, hub sehat di baliknya"
      ;;
    000|"")
      bad "tidak ada jawaban HTTPS dari Caddy lokal"
      hint "cek bagian sertifikat/port di atas"
      hint "sudo docker compose logs --tail=80 caddy"
      ;;
    502|503|504)
      bad "$CODE_LOCAL: Caddy hidup tetapi hub tidak menjawab"
      hint "sudo docker compose logs --tail=80 hub opencode"
      hint "sudo docker compose ps hub opencode"
      ;;
    404)
      bad "404 di /api/health — rute hub tidak ada (image hub lama?)"
      hint "sudo docker compose build --no-cache hub && sudo docker compose up -d hub"
      ;;
    *)
      warn "kode tak terduga dari jalur lokal: $CODE_LOCAL"
      hint "sudo docker compose logs --tail=80 caddy hub"
      ;;
  esac

  # Pengalihan HTTP -> HTTPS (dibutuhkan juga oleh ACME HTTP-01).
  REDIR_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/" 2>/dev/null || true)"
  case "$REDIR_CODE" in
    301|302|307|308)
      ok "port 80 mengalihkan ke HTTPS ($REDIR_CODE)"
      ;;
    000|"")
      bad "port 80 tidak menjawab — HTTP-01 bisa gagal"
      hint "pastikan tidak ada firewall provider yang menutup 80"
      hint "sudo ss -ltnp | grep :80"
      ;;
    *)
      warn "port 80 menjawab $REDIR_CODE (biasanya 308)"
      hint "kalau halaman http://$DOMAIN tampil tanpa redirect, cek blok domain di Caddyfile"
      ;;
  esac

  # Jalur internet sebenarnya: DNS publik + port terbuka dari luar.
  CODE_PUBLIC="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://$DOMAIN/api/health" 2>/dev/null || true)"
  case "$CODE_PUBLIC" in
    200) ok "200 lewat DNS publik (alamat bisa diakses dari internet)" ;;
    401) ok "401 lewat DNS publik = login aktif, alamat bisa diakses dari internet" ;;
    000|"")
      bad "domain tidak bisa dihubungi lewat internet"
      hint "DNS/port/firewall: cek record A dan port 80/443 di firewall provider"
      hint "kalau memakai Cloudflare proxy, matikan sementara (awan oranye -> abu-abu)"
      ;;
    502|503|504)
      bad "$CODE_PUBLIC lewat internet — permintaan sampai tapi hub tidak menjawab"
      hint "sudo docker compose logs --tail=80 caddy hub"
      ;;
    *)
      warn "kode $CODE_PUBLIC lewat internet (lokal: ${CODE_LOCAL:-?})"
      hint "bandingkan dengan hasil di browser; cek log caddy"
      ;;
  esac
fi

# --- 8. ringkasan -------------------------------------------------------------
section "Ringkasan"
if [ "$FAILS" -eq 0 ]; then
  if [ "$WARNS" -eq 0 ]; then
    echo "Semua pemeriksaan lolos. Buka https://$DOMAIN dan login."
  else
    echo "Tidak ada kegagalan, tetapi ada $WARNS peringatan — lihat baris [WARN] di atas."
  fi
  exit 0
fi

echo "$FAILS pemeriksaan gagal, $WARNS peringatan."
echo
echo "Urutan perbaikan yang paling sering menyelesaikan:"
echo "  1. DNS     : A  ${DOMAIN:-domain-anda.com}  ->  ${PUBLIC_IP:-IP-PUBLIK-VPS}"
echo "  2. Port    : pastikan 80 dan 443 bebas (hentikan nginx/apache) dan dibuka firewall"
echo "  3. Stack   : sudo docker compose up -d --build"
echo "  4. Log     : sudo docker compose logs --tail=80 caddy hub opencode"
echo "  5. Ulangi  : sudo ./doctor.sh"
echo
echo "Panduan lengkap: deploy/README.md (bagian Troubleshooting)."
exit 1
