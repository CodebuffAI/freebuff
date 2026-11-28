# Panduan deploy opencode-hub ke VPS

Tujuan: opencode punya **alamat tetap** (`https://domain-anda.com`) yang tetap hidup walaupun
sesi chat ini (atau VM ini) sudah berakhir, dengan HTTPS otomatis dan login sendiri.

Semua yang dibutuhkan ada di folder ini: `install.sh`, `bootstrap.sh`, `doctor.sh`,
`docker-compose.yml`, `Caddyfile`, `auth.caddy`, `.env.example`. Tidak ada layanan pihak
ketiga selain VPS dan domain Anda.

## Yang berjalan di VPS

| Container | Port | Peran |
| --- | --- | --- |
| `caddy` | 80, 443 (satu-satunya yang terbuka) | HTTPS otomatis + login basic auth |
| `hub` | 3000 (internal) | meneruskan UI opencode asli, `/chat`, `/hub`, `/api/*` |
| `opencode` | 4096 (internal) | `opencode web` — server agen + UI web |
| `data` | 8788 (internal) | server data terpisah (registry JSON) |
| `hermes` | — (internal) | Hermes Agent, hanya kalau profil `hermes` dipakai |

`opencode` dan `data` ada di network `internal` tanpa akses masuk dari internet; hanya Caddy
yang menghadap publik. Password opencode disuntikkan oleh hub, jadi UI tetap terbuka di balik
login Caddy Anda.

## Prasyarat

1. **VPS**: 2 vCPU / 4 GB RAM / 20 GB disk, Ubuntu 22.04+ (Debian 12 juga bisa), IPv4 publik.
2. **Domain**: beli di registrar mana pun, lalu buat record DNS:

   | Tipe | Nama | Nilai | TTL |
   | --- | --- | --- | --- |
   | A | `opencode` (atau `@` untuk apex) | IP publik VPS | 300 |

   Cek dari komputer Anda: `dig +short opencode.domain-anda.com` harus mengembalikan IP VPS.
3. **Port 80 dan 443 bebas** di VPS (matikan nginx/apache kalau ada).
4. Akses SSH ke VPS.

## Cara tercepat — satu baris lewat curl

Di VPS baru, tanpa clone manual. Skrip `bootstrap.sh` memasang `git`, meng-clone repo
(hanya folder `opencode-hub`, `--sparse`, ke `/opt/freebuff`), lalu menjalankan `install.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/cramelolo291-bot/freebuff/main/opencode-hub/deploy/bootstrap.sh \
  | sudo bash -s -- --domain opencode.domain-anda.com --email anda@domain-anda.com
```

Tambah opsi `install.sh` setelah `--`, dan pilih branch/tag lain dengan `--ref`:

```bash
curl -fsSL https://raw.githubusercontent.com/cramelolo291-bot/freebuff/main/opencode-hub/deploy/bootstrap.sh \
  | sudo bash -s -- --domain opencode.domain-anda.com --email anda@domain-anda.com \
      -- --auth-user admin --hermes

# dari branch kerja, bukan main
... | sudo bash -s -- --ref freebuff/nama-branch --domain ... --email ...
```

Menjalankan perintah yang sama lagi akan `git fetch` versi terbaru lalu mengulang deploy
(cocok untuk update). Repo privat: tambahkan `--repo https://TOKEN@github.com/user/repo.git`.
Daftar opsi bootstrap: `| sudo bash -s -- --help` (tanpa `--domain`).

## Cara manual — clone lalu install.sh

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/cramelolo291-bot/freebuff.git
cd freebuff/opencode-hub/deploy
sudo ./install.sh --domain opencode.domain-anda.com --email anda@domain-anda.com
```

Kalau repo tidak bisa di-clone dari VPS (privat), kirim foldernya saja:

```bash
# dari komputer Anda
rsync -av --exclude .runtime --exclude .opencode-server-password \
  ./opencode-hub/ user@IP-VPS:/opt/opencode-hub/
ssh user@IP-VPS 'cd /opt/opencode-hub/deploy && sudo ./install.sh --domain ... --email ...'
```

Apa yang dilakukan `install.sh`:

1. memasang Docker + plugin `docker compose` (via `get.docker.com`) kalau belum ada;
2. memeriksa port 80/443 dan mencocokkan DNS domain dengan IP publik VPS;
3. menulis `deploy/.env` (mode 600): domain, email ACME, dan `OPENCODE_SERVER_PASSWORD` acak;
4. membuat hash password login dan menulisnya ke `deploy/auth.caddy`;
5. `docker compose up -d --build` untuk `caddy`, `hub`, `data`, `opencode`;
6. menunggu `https://domain-anda.com/api/health` menjawab `200`, lalu menampilkan URL,
   user, dan **password login (hanya sekali)**.

Opsi lain:

```bash
sudo ./install.sh --help
sudo ./install.sh --domain ... --email ... --auth-user admin --auth-password 'PASSWORD-ANDA'
sudo ./install.sh --domain ... --email ... --no-auth        # TIDAK disarankan
sudo ./install.sh --domain ... --email ... --hermes         # sekaligus build image Hermes
sudo ./install.sh --domain ... --email ... --skip-dns-check # DNS belum propagasi
```

Build pertama mengunduh `node:22` + paket `opencode-ai` + `caddy`, jadi butuh 3–8 menit
tergantung jaringan. Kalau koneksi SSH putus di tengah build, jalankan lagi perintahnya —
Docker melanjutkan dari cache.

## Verifikasi setelah selesai

```bash
cd /opt/opencode-hub/deploy      # atau freebuff/opencode-hub/deploy
sudo docker compose ps           # semua service "running"
sudo docker compose logs --tail=30 caddy   # "certificate obtained successfully"
curl -fsS -u admin 'https://opencode.domain-anda.com/api/health'
```

Lalu buka `https://opencode.domain-anda.com` di browser: muncul prompt login (user `admin` +
password dari install.sh), setelah itu **UI opencode asli** (Projects / New session / Search
sessions). `https://opencode.domain-anda.com/hub` = dashboard status, `/chat` = chat ringkas.

## Kalau ada yang tidak jalan — `doctor.sh`

Skrip pemeriksa mandiri. Hanya membaca keadaan VPS (tidak mengubah apa pun): resolusi DNS,
port 80/443, status + health container, sertifikat Caddy, dan `curl /api/health`. Setiap
kegagalan disertai saran perbaikan, dan kode keluarnya `0` (sehat) atau `1` (ada masalah).

```bash
cd /opt/freebuff/opencode-hub/deploy   # folder yang berisi .env & docker-compose.yml
sudo ./doctor.sh                        # domain dibaca dari .env
sudo ./doctor.sh --domain opencode.domain-anda.com   # kalau .env belum ada/beda domain
```

Belum punya salinan skripnya di VPS?

```bash
cd /opt/freebuff/opencode-hub/deploy
curl -fsSL https://raw.githubusercontent.com/cramelolo291-bot/freebuff/main/opencode-hub/deploy/doctor.sh -o doctor.sh
sudo bash doctor.sh
```

Contoh keluaran sehat:

```
== DNS: opencode.domain-anda.com ==
[ ok ] opencode.domain-anda.com -> 203.0.113.10 (sama dengan IP publik server ini)
== Sertifikat HTTPS (127.0.0.1:443) ==
[ ok ] sertifikat publik (Let's Encrypt)
[ ok ] sertifikat masih berlaku 87 hari
== HTTP https://opencode.domain-anda.com/api/health ==
[ ok ] 401 tanpa password = login basic auth aktif, hub sehat di baliknya
```

Skrip ini juga menandai kondisi yang sering terlewat: `.env` yang tidak mode 600,
`auth.caddy` tanpa `basic_auth` (situs terbuka), container crash-loop, health check gagal,
sertifikat internal Caddy (ACME belum berhasil), dan sertifikat yang tinggal < 14 hari.

## Kalau memilih langkah manual (tanpa install.sh)

```bash
cd freebuff/opencode-hub/deploy
cp .env.example .env && chmod 600 .env
# isi HUB_DOMAIN, ACME_EMAIL, dan:
openssl rand -base64 32 | tr -d '/+=\n'    # -> OPENCODE_SERVER_PASSWORD

# login (opsional tapi sangat disarankan)
sudo docker compose run --rm caddy caddy hash-password --plaintext 'PASSWORD-PANJANG'
# tulis hasilnya ke auth.caddy:
#   basic_auth {
#       admin $2a$14$...
#   }

sudo docker compose up -d --build
sudo docker compose logs -f caddy
```

## Hermes Agent

Image `hermes` memakai installer resmi NousResearch. Setup butuh terminal interaktif:

```bash
sudo docker compose --profile hermes build hermes
sudo docker compose run --rm -it hermes hermes setup     # pilih provider + API key
sudo docker compose --profile hermes up -d hermes
sudo docker compose exec hermes hermes doctor
```

Tanpa kunci model (`NOUS_API_KEY` atau provider lain di `.env`), Hermes terpasang tetapi belum
bisa menjawab.

## Operasi harian

```bash
cd /path/ke/opencode-hub/deploy

sudo docker compose ps
sudo docker compose logs -f hub opencode caddy
sudo docker compose restart hub opencode     # restart tanpa menyentuh sertifikat
sudo docker compose up -d --build            # ambil perubahan kode / image terbaru
sudo docker compose down                     # stop, volume & data tetap

# ganti password login
sudo ./install.sh --domain ... --email ... --auth-password 'PASSWORD-BARU'

# ganti domain
sudo ./install.sh --domain domain-baru.com --email ...   # lalu perbarui record A
```

Backup state opencode (sesi, konfigurasi, workspace):

```bash
sudo docker run --rm \
  -v opencode-hub_opencode_state:/data \
  -v opencode-hub_workspace:/ws \
  -v "$PWD":/backup alpine \
  sh -c 'tar czf /backup/opencode-backup-$(date +%F).tgz -C / data ws'
```

Restore:

```bash
sudo docker compose down
sudo docker run --rm -v opencode-hub_opencode_state:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/opencode-backup-YYYY-MM-DD.tgz -C /'
sudo docker compose up -d
```

## Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Belum tahu bagian mana yang salah | `sudo ./doctor.sh` — memeriksa DNS, port, container, sertifikat, `/api/health` sekaligus dengan saran perbaikan. |
| `caddy` log: `no such host` / `DNS problem: NXDOMAIN` | Record A belum ada/salah. `dig +short domain` harus = IP VPS. Perbaiki, lalu `docker compose restart caddy`. |
| `caddy` log: `address already in use` | Port 80/443 dipakai nginx/apache. `sudo systemctl stop nginx` (atau `ss -ltnp \| grep :80`). |
| Halaman 502 | Container `hub`/`opencode` belum siap atau crash. `docker compose logs hub opencode`. |
| Halaman 404 di `/` | Image opencode lama yang menjalankan `serve`. `docker compose build --no-cache opencode && docker compose up -d`. |
| Sertifikat gagal berulang | Let's Encrypt membatasi percobaan; pastikan DNS benar sebelum mengulang, atau uji dengan `--skip-dns-check` setelah DNS beres. |
| Login terus ditolak | Hash di `auth.caddy` tidak cocok. Jalankan ulang `install.sh --auth-password '...'` lalu `docker compose restart caddy`. |
| `permission denied` saat `docker` | `sudo usermod -aG docker $USER`, logout lalu login lagi. |

## Batasan yang perlu Anda tahu

- **Ini bukan produk resmi opencode atau Freebuff.** opencode (MIT) milik timnya sendiri;
  hub di repo ini hanya halaman/penghubung.
- **Domain tetap sepenuhnya bergantung pada DNS Anda.** Selama record A menunjuk VPS dan
  container jalan, alamatnya tetap. Kalau VPS mati, alamatnya mati — tidak ada sihir
  "permanen" di luar server yang hidup.
- **Jangan pakai `--no-auth`.** API opencode memberi kendali penuh atas filesystem dan sesi
  agen. Kalau butuh akses mesin-ke-mesin, lebih aman lewat WireGuard/Tailscale daripada
  membuka `oc.` ke internet.
- **HTTPS butuh port 80 terbuka** untuk verifikasi ACME (HTTP-01). Kalau 80 diblokir provider,
  pakai DNS-01 (perlu kredensial DNS API) atau Cloudflare Tunnel.
