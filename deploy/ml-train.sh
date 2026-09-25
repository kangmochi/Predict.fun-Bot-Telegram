#!/usr/bin/env bash
# Weekly (or on-demand) ML retrain. Sends Telegram start/success/fail.
# Restarts the live bot only after a successful train so predict.py reloads joblib.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
export ML_DAYS="${ML_DAYS:-60}"
PY="${APP_DIR}/.venv/bin/python3"
ENV_FILE="${APP_DIR}/.env"
LOG="/tmp/predict-ml-train.log"

if [ ! -x "$PY" ]; then
  echo "[ml-train] missing $PY — create the venv first" >&2
  exit 1
fi

tg() {
  local text="$1"
  "$PY" - "$ENV_FILE" "$text" <<'PY'
import json, os, sys, urllib.error, urllib.request
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
    sys.exit(0)
if not token or not chat:
    sys.exit(0)
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
print(f"[ml-train] Telegram notify failed: {last}", file=sys.stderr)
PY
}

summary_from_meta() {
  "$PY" - <<'PY'
import json
from pathlib import Path
p = Path("data/ml/meta.json")
if not p.exists():
    print("(meta.json belum ada)")
    raise SystemExit
m = json.loads(p.read_text())
lines = [
    f"days={m.get('days')} symbols={','.join(m.get('symbols') or [])}",
    f"kept {m.get('kept')}/4",
]
for name, info in (m.get("models") or {}).items():
    flag = "KEEP" if info.get("kept") else "DROP"
    lines.append(f"{name}: acc={info.get('acc')} auc={info.get('auc')} {flag}")
print("\n".join(lines))
PY
}

echo "[ml-train] start $(date -Is) days=$ML_DAYS" | tee "$LOG"
tg "🧠 ML train mulai
hari: $(date '+%Y-%m-%d %H:%M %Z')
ML_DAYS=$ML_DAYS
mesin: $(hostname)
Bot live tetap jalan; restart singkat hanya jika latih sukses."

set +e
"$PY" bot/ml/train.py >>"$LOG" 2>&1
rc=$?
set -e
tail -n 40 "$LOG"

if [ "$rc" -ne 0 ]; then
  err=$(tail -n 12 "$LOG" | cut -c1-400)
  tg "❌ ML train GAGAL (exit $rc)
Bot live tidak di-restart.

$err"
  echo "[ml-train] failed exit=$rc"
  exit "$rc"
fi

sum=$(summary_from_meta)
echo "[ml-train] done $(date -Is)"
restart_note="bot tidak di-restart (sudoers belum ada) — jalankan: sudo systemctl restart predict-fun-bot"
if sudo -n /usr/bin/systemctl restart predict-fun-bot 2>/dev/null; then
  restart_note="bot di-restart, model baru di-load"
fi
tg "✅ ML train selesai
$restart_note

$sum"
echo "[ml-train] $restart_note"
