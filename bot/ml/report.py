#!/usr/bin/env python3
"""Where is the edge? Read every settled trade (data/trades.jsonl plus the
history inside data/state-*.json) and break win-rate / PnL down by ticket
price, round length, asset, hour (ET), side and brain. Also checks whether
the ML ensemble's probabilities match what actually happened.

Usage:
  python bot/ml/report.py            # live trades only
  python bot/ml/report.py --sim      # include dry-run rows
  python bot/ml/report.py --json     # machine-readable
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
TRADES_LOG = Path(os.environ.get("TRADES_LOG") or (DATA / "trades.jsonl"))
ET = ZoneInfo("America/New_York")

TICKET_BUCKETS = [(0.0, 0.30, "≤0.30"), (0.30, 0.45, "0.30–0.45"), (0.45, 0.55, "0.45–0.55"), (0.55, 0.60, "0.55–0.60"), (0.60, 1.01, ">0.60")]
ML_BUCKETS = [(0.0, 0.55, "<0.55"), (0.55, 0.60, "0.55–0.60"), (0.60, 0.70, "0.60–0.70"), (0.70, 1.01, "≥0.70")]
MIN_N = int(os.environ.get("REPORT_MIN_N", "8"))


def horizon_from_title(title: str) -> int:
    times = re.findall(r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)", title or "", flags=re.I)
    if not times:
        return 1440
    if len(times) == 1:
        return 60

    def to_min(m):
        hour = int(m[0]) % 12
        if m[2].upper() == "PM":
            hour += 12
        return hour * 60 + (int(m[1]) if m[1] else 0)

    diff = to_min(times[-1]) - to_min(times[0])
    return diff if diff > 0 else diff + 24 * 60


def asset_from_title(title: str) -> str:
    t = (title or "").lower()
    if "bitcoin" in t or t.startswith("btc"):
        return "BTC"
    if "ethereum" in t or t.startswith("eth"):
        return "ETH"
    if "bnb" in t:
        return "BNB"
    if "solana" in t or t.startswith("sol"):
        return "SOL"
    return "other"


def horizon_label(minutes: int) -> str:
    if minutes <= 5:
        return "5m"
    if minutes <= 15:
        return "15m"
    if minutes <= 60:
        return "1h"
    return "daily"


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_rows(include_sim: bool) -> tuple[list[dict], dict]:
    rows: dict[str, dict] = {}
    src = {"trades_log": 0, "state_history": 0, "sim_skipped": 0}

    def add(t: dict, source: str) -> None:
        if t.get("won") is None:
            return
        if t.get("dryRun") and not include_sim:
            src["sim_skipped"] += 1
            return
        key = f"{t.get('marketId')}|{t.get('llmProvider')}|{t.get('enteredAt')}"
        if key in rows:
            # trades.jsonl rows carry the entry context; prefer them.
            if source == "trades_log":
                rows[key] = t
            return
        rows[key] = t
        src[source] += 1

    if TRADES_LOG.exists():
        for raw in TRADES_LOG.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                add(json.loads(raw), "trades_log")
            except json.JSONDecodeError:
                continue
    for f in sorted(glob.glob(str(DATA / "state-*.json"))) + sorted(glob.glob(str(DATA / "archive" / "*.json"))):
        try:
            s = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for t in s.get("history") or []:
            add(t, "state_history")
    out = sorted(rows.values(), key=lambda t: t.get("enteredAt") or t.get("settledAt") or "")
    return out, src


def agg(rows: list[dict]) -> dict:
    n = len(rows)
    w = sum(1 for t in rows if t.get("won"))
    pnl = sum(float(t.get("pnlUsd") or 0) for t in rows)
    stake = sum(float(t.get("stakeUsd") or 0) for t in rows)
    prices = [float(t.get("price") or 0) for t in rows if t.get("price")]
    avg_price = sum(prices) / len(prices) if prices else 0.0
    winrate = w / n if n else 0.0
    return {
        "n": n,
        "wins": w,
        "losses": n - w,
        "winrate": winrate,
        "pnl": pnl,
        "roi": (pnl / stake) if stake else 0.0,
        "avg_ticket": avg_price,
        # A binary ticket at price p breaks even at winrate p.
        "edge": winrate - avg_price,
    }


def bucket(value: float, table) -> str:
    for lo, hi, label in table:
        if lo <= value < hi:
            return label
    return table[-1][2]


def group(rows: list[dict], keyfn) -> dict[str, dict]:
    g: dict[str, list[dict]] = defaultdict(list)
    for t in rows:
        k = keyfn(t)
        if k is None:
            continue
        g[str(k)].append(t)
    return {k: agg(v) for k, v in g.items()}


def favored_ml_p(t: dict) -> float | None:
    votes = (t.get("entry") or {}).get("mlVotes") or {}
    if not votes:
        return None
    ps = [float(p) for p in votes.values() if p is not None]
    if not ps:
        return None
    mean_up = sum(ps) / len(ps)
    return mean_up if t.get("side") == "UP" else 1.0 - mean_up


def build(rows: list[dict]) -> dict:
    def hour_et(t):
        d = parse_iso(t.get("enteredAt"))
        return None if d is None else f"{d.astimezone(ET).hour:02d} ET"

    def horizon(t):
        h = (t.get("entry") or {}).get("horizonMin")
        return horizon_label(int(h) if h else horizon_from_title(t.get("title")))

    def asset(t):
        a = (t.get("entry") or {}).get("asset")
        if a:
            return re.sub(r"USDT$", "", str(a))
        return asset_from_title(t.get("title"))

    def ml_bucket(t):
        p = favored_ml_p(t)
        return None if p is None else bucket(p, ML_BUCKETS)

    def ml_agree(t):
        e = t.get("entry") or {}
        return None if "mlAgree" not in e else f"{e.get('mlAgree')} agree / {e.get('mlAgainst')} against"

    def ind_agree(t):
        e = t.get("entry") or {}
        return None if e.get("indicatorAgree") is None else f"{e.get('indicatorAgree')} of 4"

    def weekday(t):
        d = parse_iso(t.get("enteredAt"))
        return None if d is None else d.astimezone(ET).strftime("%a")

    def brain(t):
        m = t.get("llmModel")
        return f"{t.get('llmProvider')}/{m}" if m else str(t.get("llmProvider"))

    return {
        "overall": agg(rows),
        "by_ticket": group(rows, lambda t: bucket(float(t.get("price") or 0), TICKET_BUCKETS)),
        "by_horizon": group(rows, horizon),
        "by_asset": group(rows, asset),
        "by_side": group(rows, lambda t: t.get("side")),
        "by_hour_et": group(rows, hour_et),
        "by_weekday": group(rows, weekday),
        "by_brain": group(rows, brain),
        "by_indicator_agree": group(rows, ind_agree),
        "by_ml_agree": group(rows, ml_agree),
        "ml_calibration": group(rows, ml_bucket),
        "with_entry_context": sum(1 for t in rows if (t.get("entry") or {}).get("features")),
    }


def findings(rep: dict) -> list[str]:
    out: list[str] = []
    o = rep["overall"]
    if o["n"] == 0:
        return ["Belum ada trade yang settle."]
    out.append(
        f"Total {o['n']} trade · winrate {o['winrate']*100:.0f}% · avg tiket {o['avg_ticket']:.2f} → edge {o['edge']*100:+.0f} poin · PnL ${o['pnl']:+.2f} (ROI {o['roi']*100:+.0f}%)"
    )
    for section, label in (("by_ticket", "tiket"), ("by_horizon", "durasi"), ("by_asset", "aset"), ("by_hour_et", "jam ET"), ("by_weekday", "hari")):
        neg = [(k, v) for k, v in rep[section].items() if v["n"] >= MIN_N and v["edge"] < -0.05]
        pos = [(k, v) for k, v in rep[section].items() if v["n"] >= MIN_N and v["edge"] > 0.10]
        for k, v in sorted(neg, key=lambda kv: kv[1]["edge"]):
            out.append(f"LEMAH {label} {k}: {v['wins']}W/{v['losses']}L ({v['winrate']*100:.0f}%) vs tiket {v['avg_ticket']:.2f} → edge {v['edge']*100:+.0f}, PnL ${v['pnl']:+.2f}")
        for k, v in sorted(pos, key=lambda kv: -kv[1]["edge"])[:2]:
            out.append(f"KUAT {label} {k}: {v['wins']}W/{v['losses']}L ({v['winrate']*100:.0f}%) vs tiket {v['avg_ticket']:.2f} → edge {v['edge']*100:+.0f}, PnL ${v['pnl']:+.2f}")
    cal = rep["ml_calibration"]
    if cal:
        worst = None
        for k, v in cal.items():
            if v["n"] < MIN_N:
                continue
            lo = {"<0.55": 0.5, "0.55–0.60": 0.55, "0.60–0.70": 0.60, "≥0.70": 0.70}[k]
            gap = v["winrate"] - lo
            if worst is None or gap < worst[1]:
                worst = (k, gap, v)
        if worst and worst[1] < -0.05:
            out.append(f"ML over-confident di bucket {worst[0]}: winrate nyata {worst[2]['winrate']*100:.0f}% (n={worst[2]['n']}) — naikkan ML_MIN_PROBA atau latih ulang dengan trades.jsonl")
    if rep["with_entry_context"] < 150:
        out.append(f"Baris dengan fitur entry: {rep['with_entry_context']} (butuh ±150 sebelum ML dilatih dari trade nyata dengan berarti)")
    return out


def fmt_table(title: str, table: dict[str, dict]) -> str:
    if not table:
        return ""
    lines = [f"\n{title}", f"{'bucket':<26}{'n':>5}{'W':>5}{'L':>5}{'win%':>7}{'tiket':>7}{'edge':>7}{'PnL$':>9}"]
    for k, v in sorted(table.items(), key=lambda kv: (-kv[1]['n'], kv[0])):
        lines.append(
            f"{k:<26}{v['n']:>5}{v['wins']:>5}{v['losses']:>5}{v['winrate']*100:>6.0f}%{v['avg_ticket']:>7.2f}{v['edge']*100:>+6.0f}p{v['pnl']:>+9.2f}"
        )
    return "\n".join(lines)


def main() -> int:
    include_sim = "--sim" in sys.argv
    as_json = "--json" in sys.argv
    rows, src = load_rows(include_sim)
    rep = build(rows)
    rep["sources"] = src
    rep["findings"] = findings(rep)
    if as_json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
        return 0
    o = rep["overall"]
    print(f"predict.fun trade report · {o['n']} settled {'(incl. sim) ' if include_sim else ''}· sources: log {src['trades_log']} / history {src['state_history']} · sim skipped {src['sim_skipped']}")
    print(f"winrate {o['winrate']*100:.1f}% · avg ticket {o['avg_ticket']:.2f} · edge {o['edge']*100:+.1f} points · PnL ${o['pnl']:+.2f} · ROI {o['roi']*100:+.1f}%")
    for title, key in (
        ("By ticket price", "by_ticket"),
        ("By round length", "by_horizon"),
        ("By asset", "by_asset"),
        ("By side", "by_side"),
        ("By hour (ET)", "by_hour_et"),
        ("By weekday (ET)", "by_weekday"),
        ("By brain", "by_brain"),
        ("By indicator agreement", "by_indicator_agree"),
        ("By ML agreement", "by_ml_agree"),
        ("ML calibration (mean p of chosen side → actual)", "ml_calibration"),
    ):
        block = fmt_table(title, rep[key])
        if block:
            print(block)
    print("\nFindings")
    for line in rep["findings"]:
        print(f"- {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
