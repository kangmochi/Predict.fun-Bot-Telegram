#!/usr/bin/env python3
"""Pasang gate spreadsheet MTF (5m trigger + 15m/60m context).

Menimpa mtf.mjs / indicators.mjs / pricefeed.mjs (dari sibling repo atau
payload yang sudah ditulis installer shell), menambah field config,
mengalihkan bot ke sheetGate, dan mengisi .env MTF_GATE=on.

Paket A (MARKETS_PER_CYCLE / SCAN / MIN_TIME_LEFT / MAX_OPEN) tidak diubah.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

ROOT = Path(os.environ.get("PREDICT_BOT_ROOT", str(Path.home() / "labs/predict-fun-bot")))
if "__file__" in globals():
    HERE = Path(__file__).resolve().parent
    REPO = HERE.parent
else:
    REPO = Path.cwd()
    HERE = REPO / "deploy"

MTF = ROOT / "bot/predictfun/mtf.mjs"
INDICATORS = ROOT / "bot/predictfun/indicators.mjs"
PRICEFEED = ROOT / "bot/predictfun/pricefeed.mjs"
CFG = ROOT / "bot/predictfun/config.mjs"
BOT = ROOT / "bot/predict-fun-bot.mjs"
ENV = ROOT / ".env"

SOURCES = {
    MTF: REPO / "bot/predictfun/mtf.mjs",
    INDICATORS: REPO / "bot/predictfun/indicators.mjs",
    PRICEFEED: REPO / "bot/predictfun/pricefeed.mjs",
}


def replace_once(path: Path, old: str, new: str, label: str, already_mark: str) -> None:
    t = path.read_text()
    if already_mark in t:
        print(f"{label}: sudah")
        return
    if old not in t:
        raise SystemExit(f"GAGAL {label} — pola tidak ketemu")
    path.write_text(t.replace(old, new, 1))
    print(f"{label}: OK")


def copy_sources() -> None:
    for dest, src in SOURCES.items():
        if dest.exists() and dest.resolve() == src.resolve():
            print(f"{dest.name}: sumber=tujuan, skip copy")
            continue
        if not src.exists():
            if dest.exists() and dest.stat().st_size > 0:
                print(f"{dest.name}: pakai file yang sudah ada")
                continue
            raise SystemExit(f"GAGAL: sumber {src} tidak ada")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        print(f"{dest.name}: OK ({dest.stat().st_size} B)")


def upsert_env(path: Path, pairs: list[tuple[str, str]]) -> None:
    text = path.read_text() if path.exists() else ""
    lines = text.splitlines()
    wanted = dict(pairs)
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        raw = line.strip()
        key = raw.split("=", 1)[0].strip() if raw and not raw.startswith("#") and "=" in raw else None
        if key in wanted:
            out.append(f"{key}={wanted[key]}")
            seen.add(key)
        else:
            out.append(line)
    missing = [kv for kv in pairs if kv[0] not in seen]
    if missing:
        if out and out[-1] != "":
            out.append("")
        out.append("# Spreadsheet MTF gates (5m trigger + 15m/60m context)")
        for key, val in missing:
            out.append(f"{key}={val}")
    for key, val in pairs:
        print(f".env {key}: {val}")
    path.write_text("\n".join(out) + "\n")


def patch_bot_import() -> None:
    t = BOT.read_text()
    if 'from "./predictfun/mtf.mjs"' in t and "getMtfFrames" in t:
        print("bot import: sudah")
        return
    old = 'import { getPriceContext, probeBinance } from "./predictfun/pricefeed.mjs";'
    new = (
        'import { getPriceContext, getMtfFrames, probeBinance } from "./predictfun/pricefeed.mjs";\n'
        'import { sheetGate } from "./predictfun/mtf.mjs";'
    )
    if old in t:
        BOT.write_text(t.replace(old, new, 1))
        print("bot import: OK")
        return
    old2 = 'import { getPriceContext, getMtfFrames, probeBinance } from "./predictfun/pricefeed.mjs";'
    if old2 in t and 'from "./predictfun/mtf.mjs"' not in t:
        BOT.write_text(t.replace(old2, old2 + '\nimport { sheetGate } from "./predictfun/mtf.mjs";', 1))
        print("bot import: OK (sheetGate)")
        return
    raise SystemExit("GAGAL bot import — pola tidak ketemu")


def patch_bot_gate() -> None:
    t = BOT.read_text()
    if "config.strategy.mtfGate" in t:
        print("bot gate: sudah")
        return
    old = """        const gate = indicatorGate({
          snapshot: priceCtx.snapshot,
          startPrice: d.startPrice,
          currentPrice: priceCtx.currentPrice,
          upAsk: yesAsk,
          downAsk: noAsk,
        });
"""
    new = """        let gate;
        if (config.strategy.mtfGate) {
          const frames = await getMtfFrames(d.priceFeedSymbol);
          gate = sheetGate({
            frames,
            startPrice: d.startPrice,
            currentPrice: priceCtx.currentPrice,
            upAsk: yesAsk,
            downAsk: noAsk,
            symbol: d.priceFeedSymbol,
          });
        } else {
          gate = indicatorGate({
            snapshot: priceCtx.snapshot,
            startPrice: d.startPrice,
            currentPrice: priceCtx.currentPrice,
            upAsk: yesAsk,
            downAsk: noAsk,
          });
        }
"""
    if old not in t:
        raise SystemExit("GAGAL bot gate — pola tidak ketemu")
    BOT.write_text(t.replace(old, new, 1))
    print("bot gate: OK")


def main() -> None:
    for p in (CFG, BOT):
        if not p.exists():
            raise SystemExit(f"GAGAL: {p} tidak ada — cek folder {ROOT}")

    copy_sources()
    if not MTF.exists() or MTF.stat().st_size == 0:
        raise SystemExit("GAGAL: mtf.mjs kosong — tulis file dulu lewat installer shell")

    replace_once(
        CFG,
        """    minMlAgree: num("MIN_ML_AGREE", 2),
    bankrollLive:""",
        """    minMlAgree: num("MIN_ML_AGREE", 2),
    mtfGate: str("MTF_GATE", "on").toLowerCase() !== "off",
    adxMin: num("ADX_MIN", 20),
    atrPct5mMin: num("ATR_PCT_5M_MIN", 0.04),
    atrPct5mMax: num("ATR_PCT_5M_MAX", 1.2),
    minVolumeRatioBnb: num("MIN_VOLUME_RATIO_BNB", 1.0),
    bankrollLive:""",
        "config mtf fields",
        "mtfGate:",
    )

    patch_bot_import()
    patch_bot_gate()

    upsert_env(
        ENV,
        [
            ("MTF_GATE", "on"),
            ("ADX_MIN", "20"),
            ("ATR_PCT_5M_MIN", "0.04"),
            ("ATR_PCT_5M_MAX", "1.2"),
            ("MIN_VOLUME_RATIO_BNB", "1.0"),
        ],
    )

    feed = PRICEFEED.read_text()
    bot = BOT.read_text()
    ind = INDICATORS.read_text()
    print("INSTALL MTF SELESAI")
    print("grep getMtfFrames", feed.count("getMtfFrames"))
    print("grep sheetGate", bot.count("sheetGate"))
    print("grep export function adx", ind.count("export function adx"))
    print("grep mtfGate", CFG.read_text().count("mtfGate"))


if __name__ == "__main__":
    main()
