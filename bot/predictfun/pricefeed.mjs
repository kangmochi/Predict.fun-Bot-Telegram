/**
 * Live price context for Crypto Up/Down markets, from Binance public market
 * data (no API key needed). Several hosts are tried because some VPS regions
 * are geo-blocked on the main api.binance.com domain.
 */

import { snapshotFromKlines } from "./indicators.mjs";

const BINANCE_HOSTS = [
  "https://data-api.binance.vision", // public market-data mirror, rarely blocked
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
];

async function binance(path) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`All Binance hosts failed: ${lastErr?.message}`);
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

/**
 * Snapshot of the market context for `symbol` (e.g. "BTCUSDT"):
 * current price, indicators, spread, and book imbalance.
 */
export async function getPriceContext(symbol, { candles = 80 } = {}) {
  const [klines, ticker, depth] = await Promise.all([
    binance(`/api/v3/klines?symbol=${symbol}&interval=1m&limit=${candles}`),
    binance(`/api/v3/ticker/bookTicker?symbol=${symbol}`),
    binance(`/api/v3/depth?symbol=${symbol}&limit=20`),
  ]);
  if (!Array.isArray(klines) || klines.length === 0) throw new Error(`No klines for ${symbol}`);

  const snapshot = snapshotFromKlines(klines, {
    bid: ticker?.bidPrice,
    ask: ticker?.askPrice,
    bidVol: depthNotional(depth?.bids),
    askVol: depthNotional(depth?.asks),
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
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol1mPct = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * 100;

  const candleLines = klines.slice(-20).map((k) => {
    const t = new Date(k[0]).toISOString().slice(11, 16);
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
  };
}

/** Probe used by --check. */
export async function probeBinance() {
  try {
    const ctx = await getPriceContext("BTCUSDT", { candles: 80 });
    const spr = ctx.snapshot.spreadBps;
    return {
      ok: true,
      detail: `BTCUSDT @ ${ctx.currentPrice} · spread ${spr == null ? "?" : spr.toFixed(1)}bps · RSI ${ctx.snapshot.rsi?.toFixed(0)}`,
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
