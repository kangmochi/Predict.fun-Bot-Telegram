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
