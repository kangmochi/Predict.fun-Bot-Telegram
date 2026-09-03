#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu/Debian VPS.
# Usage: bash deploy/setup-vps.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing Node.js 22 (NodeSource) if missing"
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "==> Installing dependencies"
cd "$APP_DIR"
npm ci || npm install

echo "==> Installing Python ML venv (XGBoost, LightGBM, sklearn)"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip libgomp1
if [ ! -d "$APP_DIR/.venv" ]; then
  python3 -m venv "$APP_DIR/.venv"
fi
ML_PYTHON="$APP_DIR/.venv/bin/python3" bash "$APP_DIR/bot/ml/install.sh"
echo "    Train models after .env is filled:  cd $APP_DIR && npm run ml:train"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env — EDIT IT NOW with your keys: nano $APP_DIR/.env"
fi

echo "==> Installing systemd service"
sudo cp deploy/predict-fun-bot.service /etc/systemd/system/predict-fun-bot.service
sudo sed -i "s|__APP_DIR__|$APP_DIR|g" /etc/systemd/system/predict-fun-bot.service
sudo sed -i "s|__USER__|$USER|g" /etc/systemd/system/predict-fun-bot.service
sudo systemctl daemon-reload

cat <<EOF

Done. Next steps (full tutorial: README.md — never commit .env or private keys):
  1. Fill credentials on this VPS only:  nano $APP_DIR/.env && chmod 600 $APP_DIR/.env
  2. Train ML once:                     npm run ml:train
  3. Verify:                            node bot/predict-fun-bot.mjs --check
  4. Optional dry-run:                  node bot/predict-fun-bot.mjs --once
  5. One real \$1 geo/wallet test:      node bot/predict-fun-bot.mjs --test-order
  6. Only if that test succeeds, enable --live via systemd drop-in (see README).

Default systemd unit is DRY RUN (no --live). Do not enable 24/7 live until --test-order passes.
EOF
