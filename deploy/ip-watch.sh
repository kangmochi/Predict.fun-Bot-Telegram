#!/usr/bin/env bash
# Watch the LAN IPv4 on the home-lab NIC and Telegram when it changes.
set -euo pipefail

APP_DIR="${IP_WATCH_DIR:-$HOME/labs/ip-watch}"
ENV_FILE="${IP_WATCH_ENV:-$HOME/labs/predict-fun-bot/.env}"
IFACE="${IP_WATCH_IFACE:-eno1}"
STATE="$APP_DIR/last-ip.txt"
PY="${IP_WATCH_PYTHON:-python3}"
mkdir -p "$APP_DIR"

lan_ip() {
  local ip=""
  ip=$(ip -4 -o addr show dev "$IFACE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)
  if [ -z "$ip" ]; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.' | head -n1 || true)
  fi
  printf '%s' "$ip"
}

tg() {
  local text="$1"
  "$PY" - "$ENV_FILE" "$text" <<'PY'
import json, sys, urllib.request
env_path, text = sys.argv[1], sys.argv[2]
token = chat = ""
try:
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            token = line.split("=", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("TELEGRAM_CHAT_ID="):
            chat = line.split("=", 1)[1].strip().strip('"').strip("'")
except FileNotFoundError:
    print(f"[ip-watch] missing {env_path}", file=sys.stderr)
    sys.exit(1)
if not token or not chat:
    print("[ip-watch] TELEGRAM_BOT_TOKEN/CHAT_ID not set", file=sys.stderr)
    sys.exit(1)
body = json.dumps({"chat_id": chat, "text": text}).encode()
url = f"https://api.telegram.org/bot{token}/sendMessage"
last = "no attempt"
for i in range(1, 4):
    try:
        req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as res:
            if 200 <= res.status < 300:
                sys.exit(0)
            last = f"HTTP {res.status}"
    except Exception as err:
        last = str(err)
    if i < 3:
        import time
        time.sleep(1.5 * i)
print(f"[ip-watch] Telegram notify failed: {last}", file=sys.stderr)
sys.exit(1)
PY
}

now=$(lan_ip)
host=$(hostname)
old=""
if [ -f "$STATE" ]; then
  old=$(cat "$STATE" | tr -d '[:space:]')
fi

if [ -z "$now" ]; then
  echo "[ip-watch] no LAN IPv4 on $IFACE"
  if [ "$old" != "DOWN" ]; then
    tg "⚠️ Mini PC ($host) tidak punya IP lokal di $IFACE.
SSH: cek monitor (banner IPv4) atau modem DHCP."
    echo DOWN > "$STATE"
  fi
  exit 0
fi

if [ "$now" = "$old" ]; then
  echo "[ip-watch] unchanged $now"
  exit 0
fi

echo "$now" > "$STATE"
if [ -z "$old" ] || [ "$old" = "DOWN" ]; then
  tg "📡 Mini PC ($host) IP lokal: $now
SSH: ssh ${IP_WATCH_SSH_USER:-$USER}@$now
interface: $IFACE"
else
  tg "📡 Mini PC ($host) IP lokal BERUBAH
lama: $old
baru: $now
SSH: ssh ${IP_WATCH_SSH_USER:-$USER}@$now
interface: $IFACE"
fi
echo "[ip-watch] notified $old -> $now"
