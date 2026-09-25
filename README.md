# predict.fun AI Trading Bot

**Bot otomatis untuk round Crypto Up or Down di predict.fun. Filter indikator + ML, LLM hanya konfirmasi, ukuran tiket ikut saldo USDT live.**

![Node 22](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Chain](https://img.shields.io/badge/Chain-BNB%20Chain-F0B90B)
![SDK](https://img.shields.io/badge/SDK-%40predictdotfun%2Fsdk-6D28D9)
![License](https://img.shields.io/badge/License-MIT-059669)

---

⭐ Ringkasan ⭐

Bot ini memindai pasar [predict.fun](https://predict.fun) setiap 2 menit, membaca candle Binance (1m untuk ML, 5m/15m/60m untuk gate), lalu hanya membeli sisi yang lolos gate **spreadsheet MTF** — ADX 60m ≥ 20, bias 5m = 15m = 60m, ATR% 5m di pita wajar, volume (BNB lebih ketat), plus spread dan **no-fade** — lalu (opsional) ensemble **XGBoost · LightGBM · Random Forest · Logistic**. LLM tidak boleh melawan arah filter. Kalau leader sudah murah (ask ≤ 30¢ dan edge ≥ 20¢) tiket naik ke ~12% saldo live dan LIMIT disilang +1¢ supaya mengambil buku — tetap sisi strike, bukan fade. Order dikirim lewat SDK resmi Predict sebagai **limit order** — tidak makan BNB per transaksi. `MTF_GATE=off` mengembalikan vote 1m EMA/RSI/MACD/BOOK ≥ 3/4.

1. **Siapkan** VPS Ubuntu 24.04 (2 vCPU / 2 GB) di region yang **diizinkan** predict.fun.
2. **Pasang** Node.js dan SDK resmi.
3. **Isi** `.env` hanya di VPS.
4. **Uji** koneksi dengan satu order $1.
5. **Jalankan** 24/7 lewat systemd.

**Peringatan:** `--live` membelanjakan USDT asli. Tidak ada jaminan untung. Jangan pernah mempublikasikan `.env`, private key, atau API key.

---

🌍 Pilih Region VPS 🌍

Predict menolak order dengan `HTTP 403 … not available in your jurisdiction` berdasarkan IP server. Daftar terlarang di [Terms of Service](https://docs.predict.fun/terms-of-service) antara lain **US, UK, Prancis, Singapore, Thailand, Taiwan, Australia, Polandia, Belgia, Ontario**. Contoh yang umum dipakai: **Jepang**. Jangan pakai VPN untuk menembus blokir.

---

🐧 Instalasi (Ubuntu 24.04) 🐧

**Masuk VPS dan pasang Node.js 22 + Git.**

```bash
sudo apt update
sudo apt install -y curl git python3 python3-venv python3-pip libgomp1
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**Verifikasi.**

```bash
node --version
npm --version
git --version
```

**Clone repo dan pasang SDK resmi Predict.** SDK membutuhkan `ethers` v6 sebagai peer dependency ([docs](https://dev.predict.fun/how-to-create-or-cancel-orders-679306m0)).

```bash
git clone https://github.com/kangmochi/Predict.fun-Bot-Telegram.git predict-bot
cd predict-bot
npm install @predictdotfun/sdk ethers
npm install
```

**Pasang Python ML dan unit systemd.**

```bash
bash deploy/setup-vps.sh
```

---

✅ Verifikasi Instalasi ✅

```bash
node -e "require('@predictdotfun/sdk'); console.log('sdk ok')"
node bot/predict-fun-bot.mjs --check
```

`--check` harus menampilkan API, LLM, Binance, wallet, dan Telegram tanpa tanda ❌. Sebelum `.env` diisi, bagian wallet akan gagal — itu wajar.

---

🔑 Isi `.env` 🔑

**Buat sekali, hanya di VPS. Jangan commit.**

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Yang wajib:

| Variabel | Dari mana |
|---|---|
| `PREDICT_API_KEY` | Tiket di [Discord predict.fun](https://discord.gg/predictdotfun) |
| `PRIVY_WALLET_PRIVATE_KEY` | predict.fun → Account → Settings → export |
| `PREDICT_ACCOUNT_ADDRESS` | Alamat deposit / smart wallet Anda |
| `VIKEY_API_KEY` atau `GEMINI_API_KEY` | [vikey.ai](https://vikey.ai) / [Google AI Studio](https://aistudio.google.com) |
| `LLM_PROVIDER` | `glm`, `vikey`, `gemini`, atau `auto` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Opsional, dari [@BotFather](https://t.me/BotFather) |

Contoh ukuran untuk modal kecil:

```env
BANKROLL_LIVE=on
BASE_STAKE_USD=1.5
BASE_STAKE_PCT=4
MAX_STAKE_USD=5
```

Deposit **USDT** ke alamat deposit predict.fun. Isi **~0.01 BNB** ke alamat signer Privy (untuk approval), bukan ke alamat deposit.

---

🧠 Pasang & Latih ML (XGBoost · LightGBM · Random Forest · Logistic) 🧠

Empat model Python. **Random Forest** dan **Logistic Regression** datang dari `scikit-learn`; **LightGBM** dan **XGBoost** paket terpisah. Semua CPU, tanpa GPU, tanpa API key.

**Buat virtualenv dan pasang paket.**

```bash
cd ~/predict-bot
python3 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install numpy scipy scikit-learn joblib lightgbm
.venv/bin/python -m pip install --no-deps "xgboost>=2.0,<3"
```

`--no-deps` pada XGBoost mencegah pip menarik paket NVIDIA NCCL ±300 MB yang tidak dipakai. Atau satu perintah yang sama: `bash bot/ml/install.sh`.

**Verifikasi keempat model.**

```bash
.venv/bin/python -c "import xgboost, lightgbm, sklearn; from sklearn.ensemble import RandomForestClassifier; from sklearn.linear_model import LogisticRegression; print('xgboost', xgboost.__version__); print('lightgbm', lightgbm.__version__); print('sklearn', sklearn.__version__)"
```

Kalau `lightgbm` gagal impor dengan `libgomp.so.1`, pasang `sudo apt install -y libgomp1` lalu ulangi.

**Latih.** Mengunduh candle 1 menit BTC/ETH/BNB (default 40 hari) dari Binance, membangun round Up/Down 5m/15m/60m, lalu melatih keempat model. Model dengan AUC di bawah 0.52 dibuang otomatis.

```bash
npm run ml:train
```

Hasil di `data/ml/*.joblib` + `data/ml/meta.json`. `--check` menampilkan akurasi/AUC tiap model. Latih ulang kapan saja dengan perintah yang sama; opsional `ML_DAYS=60 npm run ml:train` untuk data lebih panjang.

Tanpa langkah ini bot tetap jalan pakai indikator saja (`ML untrained` di log).

**Validasi jujur.** Hold-out adalah 20% candle **terbaru** lintas aset (bukan acak), ditambah walk-forward 4 lipatan (`ML_WF_FOLDS`). Probabilitas dikalibrasi (`ML_CALIBRATE=off` untuk mematikan) supaya `ML_MIN_PROBA=0.55` benar-benar berarti 55%.

**Belajar dari trade nyata.** Setiap entry menyimpan fitur indikator, suara ML, harga tiket, aset, dan durasi round. Saat settle, baris lengkap ditambahkan ke `data/trades.jsonl` (append-only, tidak pernah dipangkas). `npm run ml:train` otomatis:

1. menilai model sintetis pada trade nyata secara out-of-sample (`real trades (out-of-sample)` di log, mulai ≥30 baris), lalu
2. mencampur baris nyata ke fit akhir dengan bobot `ML_REAL_WEIGHT` (default 3).

Lihat di mana edge-nya:

```bash
npm run ml:report          # trade live saja
npm run ml:report -- --sim # termasuk dry-run
```

Laporan memecah winrate/PnL per harga tiket, durasi (5m/15m/1h/harian), aset, jam ET, hari, brain, kesepakatan indikator/ML, dan tabel kalibrasi ML (p rata-rata vs hasil nyata). Bagian **Findings** menandai bucket yang lemah (edge < −5 poin) dan ML yang over-confident.

---

🧪 Tes Order $1 🧪

**Wajib sebelum live.** Membeli satu tiket ±$1 di round yang sedang jalan.

```bash
node bot/predict-fun-bot.mjs --test-order
```

| Hasil | Arti |
|---|---|
| `TEST ORDER MASUK` | Wallet + IP lolos. Lanjut. |
| `HTTP 403 … jurisdiction` | Region VPS ditolak. Ganti region. Jangan live. |

---

🚀 Jalankan 24/7 🚀

```bash
sudo mkdir -p /etc/systemd/system/predict-fun-bot.service.d
sudo tee /etc/systemd/system/predict-fun-bot.service.d/live.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/node bot/predict-fun-bot.mjs --live
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now predict-fun-bot
```

Feed harga: Binance dipanggil dengan timeout 4 detik, host yang hidup dipakai dulu, buku/depth boleh gagal (candle tetap cukup). Kalau semua host Binance blip, snapshot <90 detik dipakai ulang; sesudah itu Bybit publik. `analysis failed All Binance hosts` hanya muncul jika ketiganya gagal. Bankroll BSC yang 524/timeout tidak membatalkan siklus — RPC cadangan dicoba, saldo live terakhir tetap dipakai.

Pantau log (Ctrl+C hanya menutup log, bot tetap jalan):

```bash
sudo journalctl -u predict-fun-bot -f
```

Berhenti / jalan lagi:

```bash
sudo systemctl stop predict-fun-bot
sudo systemctl start predict-fun-bot
```

---

📖 Membaca Log 📖

| Yang terlihat | Arti |
|---|---|
| `PASS "…"` | Filter menolak round ini. Normal, bisa berjam-jam. |
| `PASS … adx_ok` | 60m sideways (ADX < 20). |
| `PASS … mtf_aligned` | Arah 5m / 15m / 60m tidak sama. |
| `PASS … volatility_ok` / `volume_ok` | ATR% 5m di luar pita, atau volume 5m tipis. |
| `ORDER PLACED [CHEAP EDGE]` | Leader murah (≤30¢) + edge gemuk — tiket lebih besar, LIMIT +1¢. |
| `ORDER PLACED` | Limit **masuk buku**, belum tentu terisi. Cek Open Orders di web. |
| `VOID (tidak terisi)` | Limit 0 fill sampai round tutup. **Bukan** WIN/LOSS, PnL tidak berubah. |
| `WIN` / `LOSS` di Telegram | Round selesai **dan ada fill**. PnL dihitung dari shares terisi. |
| Website masih **Sell** | Market harian belum tutup (tengah malam ET). |
| History **Claimed** kosong | Bot tidak menekan Claim. Itu berbeda dari ledger bot. |

---

🧭 Troubleshooting 🧭

| Masalah | Solusi |
|---|---|
| `Cannot find module '@predictdotfun/sdk'` | `npm install @predictdotfun/sdk ethers` di folder repo. |
| `HTTP 403 … jurisdiction` | IP VPS diblok. Pindah region, bukan VPN. |
| `Privy wallet gas … top up` | Kirim ~0.01 BNB ke alamat signer, bukan alamat deposit. |
| `No module named xgboost/lightgbm` | Aktifkan venv yang benar: `.venv/bin/python -m pip install lightgbm` dan `--no-deps xgboost`. |
| `libgomp.so.1: cannot open shared object` | `sudo apt install -y libgomp1`, lalu latih ulang. |
| `no trained models in data/ml` | Jalankan `npm run ml:train` sekali. |
| Telegram sepi berjam-jam | Cek `journalctl -f`. Banyak `PASS` = bot hidup dan menolak setup jelek. |
| `Welcome to Ubuntu` muncul di log | SSH login ulang, bukan reboot. Cek `uptime`. |
| Dua VPS sama-sama `--live` | Matikan salah satu. Satu wallet = satu bot. |

---

📜 Lisensi 📜

MIT. Anda bertanggung jawab penuh atas dana, hukum setempat, dan [Terms of Service predict.fun](https://docs.predict.fun/terms-of-service).
