/**
 * Spreadsheet gates (Feature Schema BTC/ETH/BNB — TF 5m / 15m / 60m):
 *   adx_ok          ADX 60m ≥ 20
 *   mtf_aligned     bias 5m = 15m = 60m
 *   volatility_ok   ATR% 5m inside a sane band
 *   volume_ok       last closed 5m volume vs SMA
 *
 * Funding / OI / CVD are listed on the sheet but need extra APIs; skipped.
 * Closed candles only (pricefeed drops the in-progress bar) — no 15m/60m lookahead.
 */

import { config } from "./config.mjs";
import { adx, atrPct, ema, macd, rsi, snapshotFromKlines } from "./indicators.mjs";

function closesOf(klines) {
  return (klines || []).map((k) => Number(k[4]));
}
function highsOf(klines) {
  return (klines || []).map((k) => Number(k[2]));
}
function lowsOf(klines) {
  return (klines || []).map((k) => Number(k[3]));
}

function majority(votes) {
  let up = 0;
  let down = 0;
  for (const v of Object.values(votes)) {
    if (v === "UP") up += 1;
    if (v === "DOWN") down += 1;
  }
  if (up >= 2 && up > down) return "UP";
  if (down >= 2 && down > up) return "DOWN";
  return "FLAT";
}

/** One TF bias from EMA distance, RSI14, MACD histogram (sheet trigger/context). */
export function tfBias(klines, { emaPeriod = 21 } = {}) {
  if (!Array.isArray(klines) || klines.length < 30) {
    return { side: "FLAT", rsi: null, emaDistPct: null, macdHist: null, votes: {} };
  }
  const closes = closesOf(klines);
  const price = closes[closes.length - 1];
  const e = ema(closes, emaPeriod);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const emaDistPct = e && price ? ((price - e) / price) * 100 : null;
  const votes = {
    ema: emaDistPct == null ? "FLAT" : emaDistPct > 0.02 ? "UP" : emaDistPct < -0.02 ? "DOWN" : "FLAT",
    rsi: r == null ? "FLAT" : r >= 55 ? "UP" : r <= 45 ? "DOWN" : "FLAT",
    macd: m.hist == null ? "FLAT" : m.hist > 0 ? "UP" : m.hist < 0 ? "DOWN" : "FLAT",
  };
  return { side: majority(votes), rsi: r, emaDistPct, macdHist: m.hist, votes };
}

export function volumeRatio5m(klines) {
  const snap = snapshotFromKlines(klines);
  return snap.volumeRatio;
}

/**
 * @returns gate in the same shape as indicatorGate()
 */
export function sheetGate({ frames, startPrice, currentPrice, upAsk, downAsk, symbol }) {
  const S = config.strategy;
  const f5 = frames?.["5m"];
  const f15 = frames?.["15m"];
  const f60 = frames?.["60m"];

  const b5 = tfBias(f5, { emaPeriod: 9 });
  const b15 = tfBias(f15, { emaPeriod: 21 });
  const b60 = tfBias(f60, { emaPeriod: 50 });
  const adx60 = adx(highsOf(f60), lowsOf(f60), closesOf(f60), 14);
  const atr5 = atrPct(highsOf(f5), lowsOf(f5), closesOf(f5), 14);
  const vol5 = volumeRatio5m(f5);
  const volMin = /bnb/i.test(String(symbol || "")) ? S.minVolumeRatioBnb : S.minVolumeRatio;

  const line =
    `MTF 5m ${b5.side} 15m ${b15.side} 60m ${b60.side} ` +
    `ADX ${adx60 == null ? "?" : adx60.toFixed(0)} ` +
    `atr5 ${atr5 == null ? "?" : atr5.toFixed(2)}% ` +
    `vol5 ${vol5.toFixed(2)}x`;

  const marketSpread = upAsk != null && downAsk != null ? upAsk + downAsk - 1 : 0;
  if (marketSpread > S.maxMarketSpread) {
    return { skip: `predict.fun spread ${(marketSpread * 100).toFixed(1)}c > ${(S.maxMarketSpread * 100).toFixed(1)}c`, line };
  }

  if (adx60 == null) {
    return { skip: "adx_ok unavailable (60m too short)", line };
  }
  if (adx60 < S.adxMin) {
    return { skip: `adx_ok ADX60 ${adx60.toFixed(1)} < ${S.adxMin} (sideways)`, line };
  }

  if (b5.side === "FLAT" || b15.side === "FLAT" || b60.side === "FLAT") {
    return { skip: `mtf_aligned mixed (${line})`, line };
  }
  if (b5.side !== b15.side || b5.side !== b60.side) {
    return { skip: `mtf_aligned 5m ${b5.side} ≠ 15m ${b15.side} ≠ 60m ${b60.side}`, line };
  }

  if (atr5 == null) {
    return { skip: "volatility_ok ATR 5m unavailable", line };
  }
  if (atr5 < S.atrPct5mMin || atr5 > S.atrPct5mMax) {
    return {
      skip: `volatility_ok ATR5 ${atr5.toFixed(2)}% outside [${S.atrPct5mMin}, ${S.atrPct5mMax}]`,
      line,
    };
  }

  if (vol5 < volMin) {
    return { skip: `volume_ok vol5 ${vol5.toFixed(2)}x < ${volMin}x`, line };
  }

  const favored = b5.side;
  const strikeSide = currentPrice >= startPrice ? "UP" : "DOWN";
  if (favored !== strikeSide) {
    return {
      skip: `indicators ${favored} fight the strike (${strikeSide} — price vs start); not fading`,
      line,
      favored,
    };
  }

  const strength = Math.min(1, adx60 / 40);
  const confidence = Math.min(0.82, 0.6 + 0.2 * strength);
  const pFavored = 0.5 + 0.16 * strength;
  return {
    skip: null,
    favored,
    confidence,
    probabilityUp: favored === "UP" ? pFavored : 1 - pFavored,
    agree: 3,
    line,
    adx60,
    atr5,
    mtf: { "5m": b5.side, "15m": b15.side, "60m": b60.side },
  };
}
