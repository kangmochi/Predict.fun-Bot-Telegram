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
