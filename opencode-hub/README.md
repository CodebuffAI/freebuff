# opencode-hub

Halaman server untuk [opencode](https://github.com/anomalyco/opencode) plus **server data yang
terpisah**. Dibuat di dalam repo Freebuff, memakai gaya visual gelap yang sama, tanpa menyentuh
kode Freebuff yang sudah ada.

Bukan produk resmi opencode maupun Freebuff, dan tidak berafiliasi dengan tim opencode.

## Tiga proses, tiga port

| Proses | Port | Bind | Peran |
| --- | --- | --- | --- |
| `opencode web` | 4096 | `0.0.0.0` | agen opencode + UI web di `/` (HTTP API & OpenAPI di `/doc`) |
| `data-server.mjs` | 8788 | `127.0.0.1` | menyajikan registry tautan/versi sebagai JSON |
| `hub-server.mjs` | 3000 | `0.0.0.0` | halaman dashboard + agregasi status |

Server data sengaja dipisah: ia tidak menyimpan sesi, tidak menyentuh filesystem proyek, dan
hanya membaca `data/resources.json`. Kalau server opencode mati, halaman tetap tampil dan
melaporkan statusnya.

## Menjalankan

```bash
cd opencode-hub
./start.sh          # data + opencode + hub
# atau satu per satu:
node data-server.mjs
node hub-server.mjs
```

`start.sh` membuat password acak di `.opencode-server-password` (mode 600, di-gitignore) dan
memakainya untuk `OPENCODE_SERVER_PASSWORD`, jadi API opencode tidak terbuka tanpa autentikasi.
Log ada di `.runtime/*.log`; hentikan dengan `./stop.sh` (hanya memakai PID yang dicatat sendiri).

Butuh CLI opencode: `npm i -g @opencode/cli@latest`, atau lihat
<https://opencode.ai/docs>.

## Endpoint

Hub:

- `GET /api/state` — status opencode + data + hub
- `GET /api/resources` — proxy ke server data
- `GET /api/opencode/sessions` — 20 sesi terbaru (read-only)
- `GET /api/health`

Server data:

- `GET /health`
- `GET /api/resources` — semua grup
- `GET /api/resources?group=opencode` — filter grup

## Variabel lingkungan

| Nama | Default | Keterangan |
| --- | --- | --- |
| `HUB_PORT` / `HUB_HOST` | `3000` / `0.0.0.0` | halaman |
| `DATA_PORT` / `DATA_HOST` | `8788` / `127.0.0.1` | server data |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | target server opencode |
| `OPENCODE_SERVER_PASSWORD` | — | password API opencode |

## Keamanan — baca sebelum mengekspos ke publik

`opencode serve` memberi kendali penuh atas sesi agen dan filesystem proyek. API-nya tidak
dirancang untuk internet terbuka. Repo
[nexusrootlab/incident](https://github.com/nexusrootlab/incident) mendokumentasikan kebocoran
data lintas-sesi pada OpenCode Zen (2026-04-02), jadi:

1. selalu set `OPENCODE_SERVER_PASSWORD` (mode `opencode web` menolak request tanpa password
   dengan `401`, jadi UI-nya tetap terkunci); set `OPENCODE_HOST=127.0.0.1` kalau hanya mau lokal;
2. taruh reverse proxy dengan HTTPS + autentikasi di depannya;
3. hub ini hanya memanggil endpoint read-only (`/global/health`, `/session`) dan tidak
   memproksikan API agen secara mentah.

## Menjalankan permanen dengan domain sendiri

Stack Docker Compose + Caddy (HTTPS otomatis) ada di [`deploy/`](deploy/README.md):
Caddy → hub → data, sementara `opencode web` dan Hermes hanya di jaringan internal.

Di VPS baru, satu baris lewat curl sudah cukup — skrip itu clone repo, memasang Docker,
mengisi `.env`, membuat login, lalu menjalankan semua container:

```bash
curl -fsSL https://raw.githubusercontent.com/cramelolo291-bot/freebuff/main/opencode-hub/deploy/bootstrap.sh \
  | sudo bash -s -- --domain opencode.contoh.com --email anda@contoh.com
```

Atau dari repo yang sudah di-clone:

```bash
cd opencode-hub/deploy
sudo ./install.sh --domain opencode.contoh.com --email anda@contoh.com
```

Panduan lengkap (DNS, verifikasi, backup, troubleshooting) ada di
[`deploy/README.md`](deploy/README.md).

Proses di sandbox/VM sementara tidak bertahan setelah sesi berakhir. Untuk server yang benar-benar
hidup terus di mesin/VPS Anda tanpa Docker, jalankan dengan systemd:

Proses di sandbox/VM sementara tidak bertahan setelah sesi berakhir. Untuk server yang benar-benar
hidup terus di mesin/VPS Anda tanpa Docker, jalankan dengan process manager:

```ini
# /etc/systemd/system/opencode.service
[Unit]
Description=opencode headless server
After=network.target

[Service]
Environment=OPENCODE_SERVER_PASSWORD=GANTI_DI_SINI
ExecStart=/usr/local/bin/opencode serve --port 4096 --hostname 127.0.0.1
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode
```

Untuk hub + server data, unit serupa dengan `ExecStart=/usr/bin/node /path/opencode-hub/hub-server.mjs`
dan `data-server.mjs` (dua unit terpisah, `Restart=always`).

## Data

`data/resources.json` memuat tautan yang dipakai halaman. Field `verified` menandai entri yang
sumbernya benar-benar diperiksa saat pembuatan; entri `false` hanya tautan yang dikirim pengguna.

## URL publik sementara (tanpa domain sendiri)

```bash
./start.sh     # opencode web :4096, data server :8788, hub :3000
./tunnel.sh    # menerbitkan https://<acak>.app.lhr.life -> hub :3000
```

`cloudflared` quick tunnel **tidak bisa** dipakai di VM ini: edge Cloudflare hanya lewat
UDP/TCP 7844 dan port itu diblokir (hasil precheck: `hard_fail=true`, halaman jadi error 1033).
`localhost.run` lewat SSH port 22 berhasil, jadi itu yang dipakai.

Batasannya: URL acak dan bisa berputar, tunnel mati kalau proses SSH-nya mati, dan hub tidak
memasang login sendiri — siapa pun yang memegang URL bisa memakai opencode. Untuk alamat tetap
(`opencode.lo`) pakai stack di `deploy/` (Docker + Caddy) di VPS dengan domain yang DNS-nya kamu
kendalikan.

Tunnel yang dipakai sekarang: **serveo.net** (`./tunnel.sh`, fallback `localhost.run`).
localhost.run membatasi bandwidth free tier (permintaan ditahan sampai puluhan detik), jadi hanya
dipakai kalau serveo mati.
