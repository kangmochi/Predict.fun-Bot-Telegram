#!/usr/bin/env python3
"""Rebuild deploy/install-mtf-on-athena.sh from the current MTF source files."""
from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SH = HERE / "install-mtf-on-athena.sh"
PATCH = HERE / "install-mtf-gate.py"

MARKERS = {
    "mtf.mjs": ("ENDMTF", ROOT / "bot/predictfun/mtf.mjs"),
    "indicators.mjs": ("ENDIND", ROOT / "bot/predictfun/indicators.mjs"),
    "pricefeed.mjs": ("ENDFEED", ROOT / "bot/predictfun/pricefeed.mjs"),
}


def heredoc(rel: str, marker: str, path: Path) -> str:
    body = path.read_text()
    if f"\n{marker}\n" in f"\n{body}\n":
        raise SystemExit(f"GAGAL: {path} mengandung marker {marker}")
    if not body.endswith("\n"):
        body += "\n"
    return f"cat > bot/predictfun/{rel} << '{marker}'\n{body}{marker}\n"


parts = [
    "#!/bin/bash\n",
    "set -euo pipefail\n",
    'cd "$HOME/labs/predict-fun-bot"\n',
    "sudo systemctl stop predict-fun-bot\n",
    "mkdir -p bot/predictfun\n",
]
for rel, (marker, path) in MARKERS.items():
    parts.append(heredoc(rel, marker, path))
    parts.append("\n")

parts.append("python3 - <<'PY'\n")
parts.append(PATCH.read_text())
if not PATCH.read_text().endswith("\n"):
    parts.append("\n")
parts.append("PY\n")
parts.append(
    """echo "=== cek ==="
grep -c getMtfFrames bot/predictfun/pricefeed.mjs
grep -c sheetGate bot/predict-fun-bot.mjs
grep -c "export function adx" bot/predictfun/indicators.mjs
test -f bot/predictfun/mtf.mjs && echo mtf.mjs: ada
grep -E '^(MTF_GATE|ADX_MIN|ATR_PCT_5M|MIN_VOLUME_RATIO_BNB)=' .env || true
sudo systemctl start predict-fun-bot
sleep 2
systemctl is-active predict-fun-bot
"""
)
SH.write_text("".join(parts))
SH.chmod(0o755)
print(f"wrote {SH} ({SH.stat().st_size} B)")
