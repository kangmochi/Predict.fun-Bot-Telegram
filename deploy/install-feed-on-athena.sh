#!/bin/bash
set -euo pipefail
cd "$HOME/labs/predict-fun-bot"
sudo systemctl stop predict-fun-bot

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

async function klinesFromHost(host, symbol, candles) {
  const data = await fetchJson(`${host}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${candles}`);
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

async function firstHostKlines(symbol, candles) {
  const hosts = orderedHosts();
  const errors = [];
  for (let i = 0; i < hosts.length; i += 3) {
    const batch = hosts.slice(i, i + 3);
    const settled = await Promise.allSettled(batch.map((host) => klinesFromHost(host, symbol, candles).then((klines) => ({ host, klines }))));
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

python3 << 'PY'
#!/usr/bin/env python3
"""Patch config / executor / bot after pricefeed.mjs is already written."""
from pathlib import Path

ROOT = Path.home() / "labs/predict-fun-bot"
CFG = ROOT / "bot/predictfun/config.mjs"
EXE = ROOT / "bot/predictfun/executor.mjs"
BOT = ROOT / "bot/predict-fun-bot.mjs"
FEED = ROOT / "bot/predictfun/pricefeed.mjs"


def replace_once(path, old, new, label, already_mark):
    t = path.read_text()
    if already_mark in t:
        print(f"{label}: sudah")
        return
    if old not in t:
        raise SystemExit(f"GAGAL {label} — pola tidak ketemu")
    path.write_text(t.replace(old, new, 1))
    print(f"{label}: OK")


def main():
    if "CACHE_MS" not in FEED.read_text():
        raise SystemExit("GAGAL: pricefeed.mjs belum berisi CACHE_MS")
    print("pricefeed.mjs: ada CACHE_MS")

    replace_once(
        CFG,
        """const network = str("PREDICT_ENV", "mainnet").toLowerCase();
if (!["mainnet", "testnet"].includes(network)) {
  throw new Error(`PREDICT_ENV must be "mainnet" or "testnet", got "${network}"`);
}

const vikeyApiKey = str("VIKEY_API_KEY");
""",
        """const network = str("PREDICT_ENV", "mainnet").toLowerCase();
if (!["mainnet", "testnet"].includes(network)) {
  throw new Error(`PREDICT_ENV must be "mainnet" or "testnet", got "${network}"`);
}

const DEFAULT_BSC_RPCS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc.publicnode.com",
  "https://binance.llamarpc.com",
];

function rpcList() {
  const primary = str("BSC_RPC_URL", "");
  const extra = str("BSC_RPC_FALLBACKS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const url of [primary, ...extra, ...DEFAULT_BSC_RPCS]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

const bscRpcUrls = rpcList();

const vikeyApiKey = str("VIKEY_API_KEY");
""",
        "config rpc list",
        "const bscRpcUrls = rpcList();",
    )
    replace_once(
        CFG,
        '  bscRpcUrl: str("BSC_RPC_URL", "https://bsc-dataseed.binance.org"),',
        """  bscRpcUrl: bscRpcUrls[0],
  bscRpcUrls,""",
        "config rpc field",
        "bscRpcUrls,",
    )
    replace_once(
        EXE,
        """let builder = null;
let signer = null;
""",
        """let builder = null;
let signer = null;
let activeRpcUrl = null;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function rpcCandidates() {
  const urls = Array.isArray(config.bscRpcUrls) && config.bscRpcUrls.length ? config.bscRpcUrls : [config.bscRpcUrl];
  return urls.filter(Boolean);
}
""",
        "executor helpers",
        "function rpcCandidates()",
    )
    replace_once(
        EXE,
        """export async function initExecutor() {
  if (builder) return builder;
  if (!config.privateKey) throw new Error("PRIVY_WALLET_PRIVATE_KEY is not set");

  const provider = new JsonRpcProvider(config.bscRpcUrl);
  provider.pollingInterval = 300;
  signer = new Wallet(config.privateKey, provider);

  const chainId = config.network === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
  builder = await OrderBuilder.make(
    chainId,
    signer,
    config.predictAccount ? { predictAccount: config.predictAccount } : undefined,
  );
  return builder;
}
""",
        """export async function initExecutor({ force = false } = {}) {
  if (builder && !force) return builder;
  if (!config.privateKey) throw new Error("PRIVY_WALLET_PRIVATE_KEY is not set");

  const urls = rpcCandidates();
  const chainId = config.network === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
  let lastErr;
  for (const url of urls) {
    try {
      const provider = new JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
      provider.pollingInterval = 300;
      await withTimeout(provider.getBlockNumber(), 5000, `rpc ${url}`);
      signer = new Wallet(config.privateKey, provider);
      builder = await OrderBuilder.make(
        chainId,
        signer,
        config.predictAccount ? { predictAccount: config.predictAccount } : undefined,
      );
      activeRpcUrl = url;
      return builder;
    } catch (err) {
      lastErr = err;
      builder = null;
      signer = null;
      activeRpcUrl = null;
    }
  }
  throw new Error(`No BSC RPC reachable: ${lastErr?.message || "unknown"}`);
}
""",
        "executor init",
        "initExecutor({ force = false }",
    )
    replace_once(
        EXE,
        """export async function collateralBalanceUsd() {
  await initExecutor();
  const wei = await builder.balanceOf();
  return Number(formatEther(wei));
}
""",
        """export async function collateralBalanceUsd() {
  await initExecutor();
  try {
    const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll");
    return Number(formatEther(wei));
  } catch (firstErr) {
    builder = null;
    signer = null;
    await initExecutor({ force: true });
    try {
      const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll-retry");
      return Number(formatEther(wei));
    } catch (retryErr) {
      throw new Error(`${firstErr.message}; retry ${retryErr.message}`);
    }
  }
}
""",
        "executor bankroll",
        'withTimeout(builder.balanceOf(), 6000, "bankroll")',
    )
    replace_once(
        BOT,
        """        const priceCtx = await getPriceContext(d.priceFeedSymbol);
        const gapPct = ((priceCtx.currentPrice - d.startPrice) / d.startPrice) * 100;
        extraInfo = `strike ${d.startPrice} · now ${priceCtx.currentPrice} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(3)}%) · ${minutesRemaining === null ? "?" : minutesRemaining.toFixed(0)}m left`;
""",
        """        const priceCtx = await getPriceContext(d.priceFeedSymbol);
        const gapPct = ((priceCtx.currentPrice - d.startPrice) / d.startPrice) * 100;
        extraInfo = `strike ${d.startPrice} · now ${priceCtx.currentPrice} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(3)}%) · ${minutesRemaining === null ? "?" : minutesRemaining.toFixed(0)}m left`;
        if (priceCtx.fromCache) extraInfo += ` · feed cache ${priceCtx.cacheAgeSec}s`;
        else if (priceCtx.venue && priceCtx.venue !== "binance") extraInfo += ` · feed ${priceCtx.venue}`;
""",
        "bot feed tag",
        "feed cache",
    )
    replace_once(
        BOT,
        "    log(`live bankroll fetch failed (${err.message}) — fallback BANKROLL_USD=$${config.strategy.bankrollUsd}`);\n",
        """    const last = config.strategy.liveBankrollUsd;
    const keep = Number.isFinite(last) ? `keep last live $${Number(last).toFixed(2)}` : `fallback BANKROLL_USD=$${config.strategy.bankrollUsd}`;
    log(`live bankroll fetch failed (${err.message}) — ${keep}`);
""",
        "bot bankroll log",
        "keep last live",
    )
    print("INSTALL FEED SELESAI")
    print("grep CACHE_MS", FEED.read_text().count("CACHE_MS"))
    print("grep bybit", FEED.read_text().count("bybit"))
    print("grep rpcCandidates", EXE.read_text().count("rpcCandidates"))
    print("grep feed cache", BOT.read_text().count("feed cache"))


if __name__ == "__main__":
    main()
PY

echo "=== cek ==="
grep -c CACHE_MS bot/predictfun/pricefeed.mjs
grep -c bybit bot/predictfun/pricefeed.mjs
grep -c rpcCandidates bot/predictfun/executor.mjs
grep -c "feed cache" bot/predict-fun-bot.mjs
sudo systemctl start predict-fun-bot
sleep 2
systemctl is-active predict-fun-bot
