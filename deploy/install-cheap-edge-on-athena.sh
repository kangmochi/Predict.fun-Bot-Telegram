#!/bin/bash
set -euo pipefail
cd "$HOME/labs/predict-fun-bot"
sudo systemctl stop predict-fun-bot
python3 - <<'PY'
#!/usr/bin/env python3
"""Size up + take 1¢ when the locked leader is cheap (no fade)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("PREDICT_BOT_ROOT", str(Path.home() / "labs/predict-fun-bot")))
CFG = ROOT / "bot/predictfun/config.mjs"
STRAT = ROOT / "bot/predictfun/strategy.mjs"
BOT = ROOT / "bot/predict-fun-bot.mjs"
ENV = ROOT / ".env"


def replace_once(path: Path, old: str, new: str, label: str, already_mark: str) -> None:
    t = path.read_text()
    if already_mark in t:
        print(f"{label}: sudah")
        return
    if old not in t:
        raise SystemExit(f"GAGAL {label} — pola tidak ketemu")
    path.write_text(t.replace(old, new, 1))
    print(f"{label}: OK")


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
        out.append("# Cheap-leader size-up (no fade)")
        for key, val in missing:
            out.append(f"{key}={val}")
    for key, val in pairs:
        print(f".env {key}: {val}")
    path.write_text("\n".join(out) + "\n")


def main() -> None:
    for p in (CFG, STRAT, BOT):
        if not p.exists():
            raise SystemExit(f"GAGAL: {p} tidak ada — cek folder {ROOT}")

    replace_once(
        CFG,
        """    priceBandMin: num("PRICE_BAND_MIN", 0.05),
    priceBandMax: num("PRICE_BAND_MAX", 0.6),""",
        """    priceBandMin: num("PRICE_BAND_MIN", 0.05),
    priceBandMax: num("PRICE_BAND_MAX", 0.6),
    cheapEdge: str("CHEAP_EDGE", "on").toLowerCase() !== "off",
    cheapAskMax: num("CHEAP_ASK_MAX", 0.3),
    cheapEdgeMin: num("CHEAP_EDGE_MIN", 0.2),
    cheapEdgeStakePct: num("CHEAP_EDGE_STAKE_PCT", 12),
    cheapTakeCents: num("CHEAP_TAKE_CENTS", 0.01),""",
        "config cheap fields",
        "cheapEdge:",
    )

    replace_once(
        STRAT,
        """  base = Math.min(base, S.maxStakeUsd);
  let high = Math.min(S.maxStakeUsd, Math.max((bankroll * S.highConfStakePct) / 100, base));
  if (useLive) {
    const payable = Math.max(0, bankroll * 0.9);
    base = Math.min(base, payable);
    high = Math.min(high, payable);
  }
  return { bankroll, base, high, live: useLive };
}""",
        """  base = Math.min(base, S.maxStakeUsd);
  let high = Math.min(S.maxStakeUsd, Math.max((bankroll * S.highConfStakePct) / 100, base));
  const cheapPct = S.cheapEdgeStakePct > 0 ? S.cheapEdgeStakePct : S.highConfStakePct;
  let cheap = Math.min(S.maxStakeUsd, Math.max((bankroll * cheapPct) / 100, high));
  if (useLive) {
    const payable = Math.max(0, bankroll * 0.9);
    base = Math.min(base, payable);
    high = Math.min(high, payable);
    cheap = Math.min(cheap, payable);
  }
  return { bankroll, base, high, cheap, live: useLive };
}""",
        "strategy currentStakes cheap",
        "cheapEdgeStakePct",
    )

    replace_once(
        STRAT,
        """  const entryPrice = side === "YES" ? yesAsk : noAsk;
  if (entryPrice < S.priceBandMin || entryPrice > S.priceBandMax) {
    return { skip: `leader ${favored ?? side} @ ${entryPrice} outside sane band [${S.priceBandMin}, ${S.priceBandMax}]` };
  }

  const tier = confidence >= S.highConfThreshold ? "high" : "base";
  const { base, high } = currentStakes();
  const rawStake = tier === "high" ? high : base;
  const stakeUsd = Math.min(rawStake, S.maxStakeUsd);

  return { side, stakeUsd: Number(stakeUsd.toFixed(2)), edge, tier };
}""",
        """  const entryPrice = side === "YES" ? yesAsk : noAsk;
  if (entryPrice < S.priceBandMin || entryPrice > S.priceBandMax) {
    return { skip: `leader ${favored ?? side} @ ${entryPrice} outside sane band [${S.priceBandMin}, ${S.priceBandMax}]` };
  }

  const locked = favored === "UP" || favored === "DOWN" || favored === "YES" || favored === "NO";
  const isCheap =
    S.cheapEdge &&
    locked &&
    entryPrice <= S.cheapAskMax &&
    edge >= S.cheapEdgeMin;

  let limitPrice = entryPrice;
  let paidEdge = edge;
  if (isCheap && S.cheapTakeCents > 0) {
    const crossed = Math.min(Number((entryPrice + S.cheapTakeCents).toFixed(4)), S.priceBandMax);
    const crossedEdge = (side === "YES" ? probabilityYes : 1 - probabilityYes) - crossed;
    if (crossed >= S.priceBandMin && crossedEdge >= S.minEdge) {
      limitPrice = crossed;
      paidEdge = crossedEdge;
    }
  }

  const { base, high, cheap } = currentStakes();
  let tier = confidence >= S.highConfThreshold ? "high" : "base";
  let rawStake = tier === "high" ? high : base;
  if (isCheap) {
    tier = "cheap";
    rawStake = cheap;
  }
  const stakeUsd = Math.min(rawStake, S.maxStakeUsd);

  return {
    side,
    stakeUsd: Number(stakeUsd.toFixed(2)),
    edge: paidEdge,
    tier,
    price: limitPrice,
    ask: entryPrice,
  };
}""",
        "strategy decideEntry cheap",
        'tier = "cheap"',
    )

    replace_once(
        BOT,
        "    const price = decision.side === \"YES\" ? yesAsk : noAsk;\n",
        "    const price = decision.price ?? (decision.side === \"YES\" ? yesAsk : noAsk);\n",
        "bot decision.price",
        "decision.price ??",
    )

    replace_once(
        BOT,
        """      `${LIVE ? "🎯 ORDER PLACED (limit di buku, belum tentu terisi)" : "🧪 SIMULATED ENTRY"} [${trade.tier === "high" ? `HIGH CONF ≥${config.strategy.highConfThreshold * 100}%` : "base"}]\\n` +
        `"${market.title}"\\n` +
        (extraInfo ? `${extraInfo}\\n` : "") +
        `Buy ${outcome.name} @ ${price} · stake $${decision.stakeUsd} · edge +${(decision.edge * 100).toFixed(1)}c\\n` +""",
        """      `${LIVE ? "🎯 ORDER PLACED (limit di buku, belum tentu terisi)" : "🧪 SIMULATED ENTRY"} [${
        trade.tier === "cheap"
          ? `CHEAP EDGE ≤${config.strategy.cheapAskMax * 100}¢`
          : trade.tier === "high"
            ? `HIGH CONF ≥${config.strategy.highConfThreshold * 100}%`
            : "base"
      }]\\n` +
        `"${market.title}"\\n` +
        (extraInfo ? `${extraInfo}\\n` : "") +
        `Buy ${outcome.name} @ ${price}` +
        (decision.ask != null && decision.ask !== price
          ? ` (ask ${decision.ask} +${(config.strategy.cheapTakeCents * 100).toFixed(0)}¢)`
          : "") +
        ` · stake $${decision.stakeUsd} · edge +${(decision.edge * 100).toFixed(1)}c\\n` +""",
        "bot cheap telegram",
        "CHEAP EDGE",
    )

    upsert_env(
        ENV,
        [
            ("CHEAP_EDGE", "on"),
            ("CHEAP_ASK_MAX", "0.30"),
            ("CHEAP_EDGE_MIN", "0.20"),
            ("CHEAP_EDGE_STAKE_PCT", "12"),
            ("CHEAP_TAKE_CENTS", "0.01"),
        ],
    )

    print("INSTALL CHEAP EDGE SELESAI")
    print("grep cheapEdge", CFG.read_text().count("cheapEdge"))
    print("grep tier cheap", STRAT.read_text().count('tier = "cheap"'))
    print("grep CHEAP EDGE", BOT.read_text().count("CHEAP EDGE"))
    print("grep decision.price", BOT.read_text().count("decision.price"))


if __name__ == "__main__":
    main()
PY
echo "=== cek ==="
grep -c cheapEdge bot/predictfun/config.mjs
grep -c 'tier = "cheap"' bot/predictfun/strategy.mjs
grep -c "CHEAP EDGE" bot/predict-fun-bot.mjs
grep -E '^(CHEAP_EDGE|CHEAP_ASK_MAX|CHEAP_EDGE_MIN|CHEAP_EDGE_STAKE_PCT|CHEAP_TAKE_CENTS)=' .env || true
sudo systemctl start predict-fun-bot
sleep 2
systemctl is-active predict-fun-bot
