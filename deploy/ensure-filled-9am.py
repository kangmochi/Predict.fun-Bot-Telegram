#!/usr/bin/env python3
"""Revive the 22 Sep BTC 9AM ET fill after VOID v1 dropped it."""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.home() / "labs/predict-fun-bot"
STATE = ROOT / "data/state-vikey.json"
LOG = ROOT / "data/trades.jsonl"
TITLE = "Bitcoin Up or Down - September 22, 9AM ET"


def is_target(t: dict) -> bool:
    title = str(t.get("title") or "")
    low = title.lower()
    return "bitcoin" in low and "september 22" in low and "9am et" in low


def is_any_9am_btc(t: dict) -> bool:
    title = str(t.get("title") or "")
    return "9AM" in title and "Bitcoin" in title


def main() -> None:
    if not STATE.exists():
        raise SystemExit(f"GAGAL: {STATE} tidak ada")

    s = json.loads(STATE.read_text())
    hist = list(s.get("history") or [])
    hits = [t for t in hist if is_target(t)]
    any9 = [t for t in hist if is_any_9am_btc(t)]
    print(f"history semua BTC 9AM: {len(any9)} won={[t.get('won') for t in any9]}")
    for t in any9:
        print(f"  {t.get('title')} won={t.get('won')} pnl={t.get('pnlUsd')} at={t.get('settledAt') or t.get('enteredAt')}")
    print(f"history 22 Sep 9AM: {len(hits)} won={[t.get('won') for t in hits]}")

    log_win = False
    if LOG.exists():
        for line in LOG.read_text().splitlines():
            if not line.strip():
                continue
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            if is_target(t) and t.get("won") is True:
                log_win = True
                break
    print(f"jsonl 22 Sep 9AM WIN: {'ADA' if log_win else 'BELUM'}")

    hist_win = next((t for t in hits if t.get("won") is True), None)
    hist_loss = [t for t in hits if t.get("won") is False]
    if hist_win and log_win:
        print("pipeline: tiket 22 Sep 9AM ET sudah di ledger. Tidak menulis ulang.")
        return

    stake, price, filled = 3.39, 0.52, 3.27
    pnl = round(filled * (1 / price - 1), 2)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    row = {
        "title": TITLE,
        "side": "UP",
        "outcomeName": "Up",
        "price": price,
        "stakeUsd": stake,
        "filledUsd": filled,
        "pnlUsd": pnl,
        "won": True,
        "dryRun": False,
        "llmProvider": "vikey",
        "llmModel": "openai/gpt-5.6-luna",
        "enteredAt": now,
        "settledAt": now,
        "fillSource": "revive-after-false-void",
        "revived": True,
        "entry": {
            "asset": "BTCUSDT",
            "horizonMin": 60,
            "upAsk": 0.52,
            "indicatorAgree": 4,
            "notes": (
                "false VOID 21:01 WIB; website Order Complete 6.3/6.32 then 6.39 Up 52c->99.1c. "
                "Feature vector lost at abandon; report still uses this row."
            ),
        },
    }

    bak = STATE.with_name(STATE.name + f".bak-9am-{now.replace(':', '-').replace('.', '-')}")
    shutil.copy2(STATE, bak)

    if not hist_win:
        if hist_loss:
            for t in hist_loss:
                old = float(t.get("pnlUsd") or 0)
                t["won"] = True
                t["filledUsd"] = filled
                t["fillSource"] = "revive-after-false-void"
                t["pnlUsd"] = pnl
                t["revived"] = True
                s["realizedPnlUsd"] = round(float(s.get("realizedPnlUsd") or 0) + (pnl - old), 2)
                s["lifetimePnlUsd"] = round(float(s.get("lifetimePnlUsd") or 0) + (pnl - old), 2)
                print(f"history: LOSS palsu → WIN pnl ${old} → ${pnl}")
        else:
            hist.append(row)
            s["history"] = hist
            s["realizedPnlUsd"] = round(float(s.get("realizedPnlUsd") or 0) + pnl, 2)
            s["lifetimePnlUsd"] = round(float(s.get("lifetimePnlUsd") or 0) + pnl, 2)
            print(f"history + WIN pnl=${pnl} (backup {bak.name})")
        if float(s.get("lossStreak") or 0) > 0:
            s["lossStreak"] = 0
        opens = s.get("openTrades") or {}
        for mid, t in list(opens.items()):
            if is_target(t):
                del opens[mid]
        s["openTrades"] = opens
        STATE.write_text(json.dumps(s, indent=2) + "\n")
    else:
        print("history 22 Sep sudah WIN, skip state")

    if not log_win:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        print("trades.jsonl + 1 baris WIN 22 Sep 9AM")
    else:
        print("jsonl sudah ada, skip")

    print(
        "SELESAI. ml:report melihat tiket ini. ml:train butuh entry.features — "
        "vektor 9AM hilang saat VOID palsu; settle baru ke depan yang lengkap."
    )


if __name__ == "__main__":
    main()
