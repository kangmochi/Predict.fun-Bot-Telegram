# predict.fun AI Trading Bot

**Bot otomatis untuk round Crypto Up or Down di predict.fun. Filter indikator + ML, LLM hanya konfirmasi, ukuran tiket ikut saldo USDT live.**

![Node 22](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![Chain](https://img.shields.io/badge/Chain-BNB%20Chain-F0B90B)
![SDK](https://img.shields.io/badge/SDK-%40predictdotfun%2Fsdk-6D28D9)
![License](https://img.shields.io/badge/License-MIT-059669)

---

⭐ Ringkasan ⭐

Bot ini memindai pasar [predict.fun](https://predict.fun) setiap 2 menit, membaca candle dan order book Binance, lalu hanya membeli sisi yang lolos filter **EMA · RSI · MACD · volume · spread** dan (opsional) ensemble **XGBoost · LightGBM · Random Forest · Logistic**. LLM tidak boleh melawan arah filter. Order dikirim lewat SDK resmi Predict sebagai **limit order** — tidak makan BNB per transaksi.

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
git clone https://github.com/USERNAME/NAMA_REPO.git predict-bot
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
| `ORDER PLACED` | Order masuk, USDT terpotong. |
| `WIN` / `LOSS` di Telegram | Round selesai menurut harga tutup. |
| Website masih **Sell** | Market harian belum tutup (tengah malam ET). |
| History **Claimed** kosong | Bot tidak menekan Claim. Itu berbeda dari ledger bot. |

---

🧭 Troubleshooting 🧭

| Masalah | Solusi |
|---|---|
| `Cannot find module '@predictdotfun/sdk'` | `npm install @predictdotfun/sdk ethers` di folder repo. |
| `HTTP 403 … jurisdiction` | IP VPS diblok. Pindah region, bukan VPN. |
| `Privy wallet gas … top up` | Kirim ~0.01 BNB ke alamat signer, bukan alamat deposit. |
| Telegram sepi berjam-jam | Cek `journalctl -f`. Banyak `PASS` = bot hidup dan menolak setup jelek. |
| `Welcome to Ubuntu` muncul di log | SSH login ulang, bukan reboot. Cek `uptime`. |
| Dua VPS sama-sama `--live` | Matikan salah satu. Satu wallet = satu bot. |
| `No module named xgboost/lightgbm` | Aktifkan venv yang benar: `.venv/bin/python -m pip install lightgbm` dan `--no-deps xgboost`. |
| `libgomp.so.1: cannot open shared object` | `sudo apt install -y libgomp1`, lalu latih ulang. |
| `no trained models in data/ml` | Jalankan `npm run ml:train` sekali. |
---

📜 Lisensi 📜

MIT. Anda bertanggung jawab penuh atas dana, hukum setempat, dan [Terms of Service predict.fun](https://docs.predict.fun/terms-of-service).
