"""OHLCV features that match the Node indicator snapshot (no extra API)."""

from __future__ import annotations

FEATURE_NAMES = [
    "gap_pct",
    "minutes_remaining",
    "ema_fast_rel",
    "ema_slow_rel",
    "rsi",
    "macd_hist_rel",
    "volume_ratio",
    "atr_pct",
    "last_range_pct",
    "change_5m",
    "change_15m",
    "change_30m",
    "vol1m_pct",
]


def _ema_series(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def _ema(values: list[float], period: int) -> float | None:
    series = _ema_series(values, period)
    for v in reversed(series):
        if v is not None:
            return v
    return None


def _rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gain = loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    gain /= period
    loss /= period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = (gain * (period - 1) + max(d, 0.0)) / period
        loss = (loss * (period - 1) + max(-d, 0.0)) / period
    if loss == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + gain / loss)


def _macd_hist(closes: list[float]) -> float | None:
    fast = _ema_series(closes, 12)
    slow = _ema_series(closes, 26)
    line = [f - s for f, s in zip(fast, slow) if f is not None and s is not None]
    if len(line) < 9:
        return None
    signal = _ema(line, 9)
    if signal is None:
        return None
    return line[-1] - signal


def _sma(values: list[float], period: int) -> float | None:
    if not period or len(values) < period:
        return None
    return sum(values[-period:]) / period


def _true_range(h: float, low: float, prev_close: float) -> float:
    return max(h - low, abs(h - prev_close), abs(low - prev_close))


def snapshot_from_klines(klines: list) -> dict:
    """Binance kline rows: [openTime, open, high, low, close, volume, ...]."""
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    closes = [float(k[4]) for k in klines]
    volumes = [float(k[5]) for k in klines]
    close = closes[-1]
    closed = volumes[:-1] if len(volumes) > 1 else volumes
    avg_vol = _sma(closed[:-1], min(20, max(0, len(closed) - 1))) if len(closed) > 1 else None
    last_closed = closed[-1] if closed else volumes[-1]
    volume_ratio = (last_closed / avg_vol) if avg_vol and avg_vol > 0 else 1.0

    ranges = [_true_range(highs[i], lows[i], closes[i - 1]) for i in range(1, len(klines))]
    last_range = ranges[-1] if ranges else 0.0
    atr = _sma(ranges, min(14, len(ranges))) or 0.0

    rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1]]
    mean = sum(rets) / len(rets) if rets else 0.0
    var = sum((r - mean) ** 2 for r in rets) / len(rets) if rets else 0.0
    vol1m = (var ** 0.5) * 100.0

    def pct(minutes: int) -> float:
        idx = len(closes) - 1 - minutes
        if idx < 0 or closes[idx] == 0:
            return 0.0
        return (close - closes[idx]) / closes[idx] * 100.0

    ema_fast = _ema(closes, 9)
    ema_slow = _ema(closes, 21)
    macd_h = _macd_hist(closes)
    rsi = _rsi(closes, 14)

    return {
        "close": close,
        "ema_fast": ema_fast,
        "ema_slow": ema_slow,
        "rsi": rsi if rsi is not None else 50.0,
        "macd_hist": macd_h if macd_h is not None else 0.0,
        "volume_ratio": volume_ratio,
        "atr_pct": (atr / close) * 100.0 if close else 0.0,
        "last_range_pct": (last_range / close) * 100.0 if close else 0.0,
        "change_5m": pct(5),
        "change_15m": pct(15),
        "change_30m": pct(min(29, len(closes) - 1)),
        "vol1m_pct": vol1m,
    }


def feature_row(snapshot: dict, start_price: float, minutes_remaining: float) -> dict[str, float]:
    close = float(snapshot["close"])
    gap = ((close - start_price) / start_price) * 100.0 if start_price else 0.0
    ema_fast = snapshot.get("ema_fast") or close
    ema_slow = snapshot.get("ema_slow") or close
    macd_h = float(snapshot.get("macd_hist") or 0.0)
    return {
        "gap_pct": gap,
        "minutes_remaining": float(minutes_remaining),
        "ema_fast_rel": (ema_fast / close - 1.0) * 100.0 if close else 0.0,
        "ema_slow_rel": (ema_slow / close - 1.0) * 100.0 if close else 0.0,
        "rsi": float(snapshot.get("rsi") or 50.0),
        "macd_hist_rel": (macd_h / close) * 100.0 if close else 0.0,
        "volume_ratio": float(snapshot.get("volume_ratio") or 1.0),
        "atr_pct": float(snapshot.get("atr_pct") or 0.0),
        "last_range_pct": float(snapshot.get("last_range_pct") or 0.0),
        "change_5m": float(snapshot.get("change_5m") or 0.0),
        "change_15m": float(snapshot.get("change_15m") or 0.0),
        "change_30m": float(snapshot.get("change_30m") or 0.0),
        "vol1m_pct": float(snapshot.get("vol1m_pct") or 0.0),
    }


def vector(row: dict) -> list[float]:
    return [float(row[name]) for name in FEATURE_NAMES]
