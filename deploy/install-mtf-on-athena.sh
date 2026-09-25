#!/bin/bash
set -euo pipefail
cd "$HOME/labs/predict-fun-bot"
sudo systemctl stop predict-fun-bot
mkdir -p bot/predictfun
cat > bot/predictfun/mtf.mjs << 'ENDMTF'
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
ENDMTF

cat > bot/predictfun/indicators.mjs << 'ENDIND'
/**
 * Mechanical crypto indicators from OHLCV + Binance book.
 * No third-party indicator API — everything is computed locally.
 */

function sma(values, period) {
  if (!period || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values, period) {
  const series = emaSeries(values, period);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Average True Range as a percent of last close. */
export function atrPct(highs, lows, closes, period = 14) {
  if (!closes.length || closes.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < closes.length; i++) {
    ranges.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  const avg = sma(ranges, Math.min(period, ranges.length));
  const close = closes[closes.length - 1];
  if (avg == null || !close) return null;
  return (avg / close) * 100;
}

/**
 * Wilder ADX (default 14). Needs ~2×period bars. Null if the series is too short.
 */
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2) return null;
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  if (tr.length < period * 2 - 1) return null;
  let atr = 0;
  let p = 0;
  let m = 0;
  for (let i = 0; i < period; i++) {
    atr += tr[i];
    p += plusDM[i];
    m += minusDM[i];
  }
  const dxs = [];
  for (let i = period; i < tr.length; i++) {
    atr = atr - atr / period + tr[i];
    p = p - p / period + plusDM[i];
    m = m - m / period + minusDM[i];
    const plusDI = atr > 0 ? (100 * p) / atr : 0;
    const minusDI = atr > 0 ? (100 * m) / atr : 0;
    const den = plusDI + minusDI;
    dxs.push(den > 0 ? (100 * Math.abs(plusDI - minusDI)) / den : 0);
  }
  if (dxs.length < period) return null;
  let val = 0;
  for (let i = 0; i < period; i++) val += dxs[i];
  val /= period;
  for (let i = period; i < dxs.length; i++) val = (val * (period - 1) + dxs[i]) / period;
  return val;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastE[i] != null && slowE[i] != null) macdLine.push(fastE[i] - slowE[i]);
  }
  if (macdLine.length < signalPeriod) return { macd: null, signal: null, hist: null };
  const signalSeries = emaSeries(macdLine, signalPeriod);
  const last = macdLine.length - 1;
  const signal = signalSeries[last];
  if (signal == null) return { macd: null, signal: null, hist: null };
  return { macd: macdLine[last], signal, hist: macdLine[last] - signal };
}

function trueRange(h, l, prevClose) {
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function voteEma(close, emaFast, emaSlow) {
  if (emaFast == null || emaSlow == null) return "FLAT";
  if (close > emaFast && emaFast > emaSlow) return "UP";
  if (close < emaFast && emaFast < emaSlow) return "DOWN";
  return "FLAT";
}

function voteRsi(value, rsiUp, rsiDown) {
  if (value == null) return "FLAT";
  if (value >= rsiUp) return "UP";
  if (value <= rsiDown) return "DOWN";
  return "FLAT";
}

function voteMacd({ macd: line, signal, hist }) {
  if (line == null || signal == null || hist == null) return "FLAT";
  if (hist > 0 && line > signal) return "UP";
  if (hist < 0 && line < signal) return "DOWN";
  return "FLAT";
}

function voteBook(imbalance, upThresh, downThresh) {
  if (imbalance == null) return "FLAT";
  if (imbalance >= upThresh) return "UP";
  if (imbalance <= downThresh) return "DOWN";
  return "FLAT";
}

/**
 * Build a full indicator snapshot from Binance-style klines
 * `[openTime, open, high, low, close, volume, ...]` plus optional book.
 */
export function snapshotFromKlines(klines, book = {}, opts = {}) {
  const emaFastN = opts.emaFast ?? 9;
  const emaSlowN = opts.emaSlow ?? 21;
  const rsiUp = opts.rsiUp ?? 55;
  const rsiDown = opts.rsiDown ?? 45;
  const bookUp = opts.bookImbalanceUp ?? 0.55;
  const bookDown = opts.bookImbalanceDown ?? 0.45;

  const opens = klines.map((k) => Number(k[1]));
  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));
  const closes = klines.map((k) => Number(k[4]));
  const volumes = klines.map((k) => Number(k[5]));
  const close = closes[closes.length - 1];

  const emaFast = ema(closes, emaFastN);
  const emaSlow = ema(closes, emaSlowN);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const closedVols = volumes.length > 1 ? volumes.slice(0, -1) : volumes;
  const avgVol = sma(closedVols.slice(0, -1), Math.min(20, closedVols.length - 1));
  const lastClosedVol = closedVols[closedVols.length - 1];
  const volumeRatio = avgVol > 0 ? lastClosedVol / avgVol : 1;

  const ranges = [];
  for (let i = 1; i < klines.length; i++) {
    ranges.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  const lastRange = ranges[ranges.length - 1] ?? 0;
  const medianRange = median(ranges.slice(-30));
  const atrPct = close > 0 ? (sma(ranges, Math.min(14, ranges.length)) / close) * 100 : 0;
  const lastRangePct = close > 0 ? (lastRange / close) * 100 : 0;
  const medianAtrPct = close > 0 ? (medianRange / close) * 100 : 0;

  const bid = Number(book.bid);
  const ask = Number(book.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : close;
  const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : null;

  const bidVol = Number(book.bidVol);
  const askVol = Number(book.askVol);
  const bookDen = bidVol + askVol;
  const bookImbalance = bookDen > 0 ? bidVol / bookDen : null;

  const votes = {
    ema: voteEma(close, emaFast, emaSlow),
    rsi: voteRsi(rsiVal, rsiUp, rsiDown),
    macd: voteMacd(macdVal),
    book: voteBook(bookImbalance, bookUp, bookDown),
  };

  return {
    close,
    emaFast,
    emaSlow,
    rsi: rsiVal,
    macd: macdVal.macd,
    macdSignal: macdVal.signal,
    macdHist: macdVal.hist,
    volumeRatio,
    atrPct,
    lastRangePct,
    medianAtrPct,
    spreadBps,
    bookImbalance,
    votes,
    opens,
    highs,
    lows,
    closes,
    volumes,
  };
}

export function formatIndicatorLine(snap) {
  const v = snap.votes;
  const rsi = snap.rsi == null ? "?" : snap.rsi.toFixed(0);
  const macdH = snap.macdHist == null ? "?" : (snap.macdHist >= 0 ? "+" : "") + snap.macdHist.toFixed(4);
  const book = snap.bookImbalance == null ? "?" : `${(snap.bookImbalance * 100).toFixed(0)}%bid`;
  const spread = snap.spreadBps == null ? "?" : `${snap.spreadBps.toFixed(1)}bps`;
  return (
    `EMA ${v.ema} RSI ${v.rsi}(${rsi}) MACD ${v.macd}(${macdH}) ` +
    `BOOK ${v.book}(${book}) vol ${snap.volumeRatio.toFixed(2)}x spread ${spread}`
  );
}
ENDIND

cat > bot/predictfun/pricefeed.mjs << 'ENDFEED'
/**
 * Live price context for Crypto Up/Down markets.
 *
 * Primary: Binance public market data (no API key). Hosts are raced with a
 * short timeout because a hung api.binance.com used to abort the whole cycle
 * ("All Binance hosts failed") and skip a tradable ticket.
 *
 * Depth / bookTicker are optional: klines alone are enough for EMA/RSI/MACD.
 * If every live host fails, a snapshot younger than 90s is reused. After that
 * Bybit public spot is the last resort. Never invent candles.
 */

import { snapshotFromKlines } from "./indicators.mjs";

export const BINANCE_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
];

const BYBIT_BASE = "https://api.bybit.com";
const FETCH_TIMEOUT_MS = 4000;
const CACHE_MS = 90_000;
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "predict-fun-bot/1.1",
};

let lastGoodHost = BINANCE_HOSTS[0];
const cache = new Map();

export function resetPricefeedForTests() {
  lastGoodHost = BINANCE_HOSTS[0];
  cache.clear();
}

export function cacheSetForTests(symbol, ctx, at = Date.now()) {
  cache.set(symbol, { ctx, at });
}

function orderedHosts() {
  const rest = BINANCE_HOSTS.filter((h) => h !== lastGoodHost);
  return lastGoodHost ? [lastGoodHost, ...rest] : [...BINANCE_HOSTS];
}

export async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`timeout ${timeoutMs}ms`);
    throw new Error(err?.message || "fetch failed");
  } finally {
    clearTimeout(timer);
  }
}

function depthNotional(levels) {
  if (!Array.isArray(levels)) return 0;
  let sum = 0;
  for (const row of levels) {
    const price = Number(Array.isArray(row) ? row[0] : row.price);
    const qty = Number(Array.isArray(row) ? row[1] : row.qty ?? row.quantity);
    if (Number.isFinite(price) && Number.isFinite(qty)) sum += price * qty;
  }
  return sum;
}

function asKlines(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows;
}

export function assemblePriceContext(symbol, klines, ticker, depth, extra = {}) {
  if (!Array.isArray(klines) || klines.length === 0) throw new Error(`No klines for ${symbol}`);

  const snapshot = snapshotFromKlines(klines, {
    bid: ticker?.bidPrice ?? ticker?.bid1Price,
    ask: ticker?.askPrice ?? ticker?.ask1Price,
    bidVol: depthNotional(depth?.bids ?? depth?.b),
    askVol: depthNotional(depth?.asks ?? depth?.a),
  });

  const closes = snapshot.closes;
  const currentPrice = snapshot.close;

  const pctChange = (minutesAgo) => {
    const idx = closes.length - 1 - minutesAgo;
    if (idx < 0) return null;
    return ((currentPrice - closes[idx]) / closes[idx]) * 100;
  };

  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const vol1mPct = rets.length
    ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * 100
    : 0;

  const candleLines = klines.slice(-20).map((k) => {
    const t = new Date(Number(k[0])).toISOString().slice(11, 16);
    return `${t} O:${Number(k[1])} H:${Number(k[2])} L:${Number(k[3])} C:${Number(k[4])} V:${Number(k[5]).toFixed(0)}`;
  });

  return {
    symbol,
    currentPrice,
    change5mPct: pctChange(5),
    change15mPct: pctChange(15),
    change30mPct: pctChange(Math.min(29, closes.length - 1)),
    vol1mPct,
    candleLines,
    snapshot,
    venue: extra.venue || "binance",
    fromCache: Boolean(extra.fromCache),
    cacheAgeSec: extra.cacheAgeSec ?? null,
  };
}

async function klinesFromHost(host, symbol, candles, interval = "1m") {
  const data = await fetchJson(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${candles}`);
  const klines = asKlines(data);
  if (!klines) throw new Error("empty klines");
  return klines;
}

async function bookFromHost(host, symbol) {
  const [ticker, depth] = await Promise.all([
    fetchJson(`${host}/api/v3/ticker/bookTicker?symbol=${symbol}`).catch(() => null),
    fetchJson(`${host}/api/v3/depth?symbol=${symbol}&limit=20`).catch(() => null),
  ]);
  return { ticker, depth };
}

async function firstHostKlines(symbol, candles, interval = "1m") {
  const hosts = orderedHosts();
  const errors = [];
  for (let i = 0; i < hosts.length; i += 3) {
    const batch = hosts.slice(i, i + 3);
    const settled = await Promise.allSettled(
      batch.map((host) => klinesFromHost(host, symbol, candles, interval).then((klines) => ({ host, klines }))),
    );
    const ok = settled.find((r) => r.status === "fulfilled");
    if (ok) {
      lastGoodHost = ok.value.host;
      return ok.value;
    }
    for (const r of settled) {
      if (r.status === "rejected") errors.push(r.reason?.message || String(r.reason));
    }
  }
  throw new Error(errors[0] || "all hosts rejected");
}

function bybitToBinanceKlines(list) {
  // Bybit spot kline: [start, open, high, low, close, volume, turnover], newest first.
  const rows = (list || [])
    .map((k) => [Number(k[0]), k[1], k[2], k[3], k[4], k[5], Number(k[0]) + 59_999])
    .sort((a, b) => a[0] - b[0]);
  return asKlines(rows);
}

const BYBIT_INTERVAL = { "1m": "1", "5m": "5", "15m": "15", "1h": "60" };

async function fromBybitKlines(symbol, candles, interval = "1m") {
  const iv = BYBIT_INTERVAL[interval] || "1";
  const klineJson = await fetchJson(
    `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=${iv}&limit=${candles}`,
  );
  const klines = bybitToBinanceKlines(klineJson?.result?.list);
  if (!klines) throw new Error("Bybit empty klines");
  return klines;
}

async function fromBybit(symbol, candles) {
  const klineJson = await fetchJson(
    `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${symbol}&interval=1&limit=${candles}`,
  );
  const klines = bybitToBinanceKlines(klineJson?.result?.list);
  if (!klines) throw new Error("Bybit empty klines");

  let ticker = null;
  let depth = null;
  try {
    const t = await fetchJson(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=${symbol}`);
    const row = t?.result?.list?.[0];
    if (row) ticker = { bidPrice: row.bid1Price, askPrice: row.ask1Price };
  } catch {
    /* optional */
  }
  try {
    const d = await fetchJson(`${BYBIT_BASE}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=20`);
    depth = { bids: d?.result?.b, asks: d?.result?.a };
  } catch {
    /* optional */
  }
  return assemblePriceContext(symbol, klines, ticker, depth, { venue: "bybit" });
}

function cached(symbol) {
  const hit = cache.get(symbol);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age > CACHE_MS) return null;
  return {
    ...hit.ctx,
    fromCache: true,
    cacheAgeSec: Number((age / 1000).toFixed(1)),
  };
}

/**
 * Snapshot of the market context for `symbol` (e.g. "BTCUSDT"):
 * current price, indicators, spread, and book imbalance.
 */
export async function getPriceContext(symbol, { candles = 80 } = {}) {
  let liveErr;
  try {
    const { host, klines } = await firstHostKlines(symbol, candles);
    const { ticker, depth } = await bookFromHost(host, symbol);
    const ctx = assemblePriceContext(symbol, klines, ticker, depth, { venue: "binance" });
    cache.set(symbol, { ctx, at: Date.now() });
    return ctx;
  } catch (err) {
    liveErr = err;
  }

  const warm = cached(symbol);
  if (warm) return warm;

  try {
    const ctx = await fromBybit(symbol, candles);
    cache.set(symbol, { ctx, at: Date.now() });
    return ctx;
  } catch (err) {
    throw new Error(`All Binance hosts failed: ${liveErr?.message}; Bybit: ${err.message}`);
  }
}

async function loadTfKlines(symbol, interval, candles) {
  try {
    const { klines } = await firstHostKlines(symbol, candles, interval);
    return klines;
  } catch {
    return fromBybitKlines(symbol, candles, interval);
  }
}

/**
 * Closed-ish 5m / 15m / 1h candles for the spreadsheet MTF gates.
 * Drop the still-forming last bar so 15m/60m context cannot look ahead.
 */
export async function getMtfFrames(symbol) {
  const key = `mtf:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ctx;
  const [raw5, raw15, raw60] = await Promise.all([
    loadTfKlines(symbol, "5m", 80),
    loadTfKlines(symbol, "15m", 80),
    loadTfKlines(symbol, "1h", 80),
  ]);
  const closed = (rows) => (Array.isArray(rows) && rows.length > 2 ? rows.slice(0, -1) : rows);
  const ctx = {
    "5m": closed(raw5),
    "15m": closed(raw15),
    "60m": closed(raw60),
  };
  cache.set(key, { ctx, at: Date.now() });
  return ctx;
}

/** Probe used by --check. */
export async function probeBinance() {
  try {
    const ctx = await getPriceContext("BTCUSDT", { candles: 80 });
    const spr = ctx.snapshot.spreadBps;
    const via = ctx.fromCache ? `cache ${ctx.cacheAgeSec}s` : ctx.venue;
    return {
      ok: true,
      detail: `BTCUSDT @ ${ctx.currentPrice} · ${via} · spread ${spr == null ? "?" : spr.toFixed(1)}bps · RSI ${ctx.snapshot.rsi?.toFixed(0)}`,
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
ENDFEED

python3 - <<'PY'
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
PY
echo "=== cek ==="
grep -c getMtfFrames bot/predictfun/pricefeed.mjs
grep -c sheetGate bot/predict-fun-bot.mjs
grep -c "export function adx" bot/predictfun/indicators.mjs
test -f bot/predictfun/mtf.mjs && echo mtf.mjs: ada
grep -E '^(MTF_GATE|ADX_MIN|ATR_PCT_5M|MIN_VOLUME_RATIO_BNB)=' .env || true
sudo systemctl start predict-fun-bot
sleep 2
systemctl is-active predict-fun-bot
