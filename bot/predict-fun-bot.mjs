#!/usr/bin/env node
/**
 * predict.fun AI trading bot
 * --------------------------
 * An autonomous agent that scans predict.fun (BNB Chain) markets, asks Gemini
 * to estimate the true probability of each outcome, and trades when it finds
 * an edge — with strict, configurable money management:
 *
 *   - standard entry:   BASE_STAKE_USD per trade (confidence 60–79%)
 *   - high conviction:  HIGH_CONF_STAKE_PCT % of bankroll (confidence >= 80%)
 *   - circuit breaker:  MAX_LOSS_STREAK consecutive losses halts trading for
 *                       the rest of the day; the bot resumes the next day
 *
 * Usage:
 *   node bot/predict-fun-bot.mjs --check       diagnostics (env, API, LLM, wallet)
 *   node bot/predict-fun-bot.mjs               DRY RUN: analyzes + simulates, no real orders
 *   node bot/predict-fun-bot.mjs --live        real trading (requires all credentials)
 *   node bot/predict-fun-bot.mjs --once        run a single scan cycle then exit
 *   node bot/predict-fun-bot.mjs --reset-eval  archive ledgers and start all brains at 0/10
 *   node bot/predict-fun-bot.mjs --reset-pnl   zero SIM PnL/history (keep live opens; do not switch LLM)
 *   node bot/predict-fun-bot.mjs --test-order  one real $1 connectivity buy, then exit
 */

import process from "node:process";
import { applyLlmProvider, config, hasAnyLlmKey, hasLlmKey, providerHasKey } from "./predictfun/config.mjs";
import * as api from "./predictfun/api.mjs";
import { analyzeMarket, analyzeCryptoUpDown, probeLlm } from "./predictfun/llm.mjs";
import { getPriceContext, probeBinance } from "./predictfun/pricefeed.mjs";
import * as strategy from "./predictfun/strategy.mjs";
import * as rotation from "./predictfun/rotation.mjs";
import { indicatorGate, alignWithIndicators, mlEnsembleGate } from "./predictfun/discipline.mjs";
import { mlFeatures, modelsReady, readMeta, resolvePython, scoreFeatures } from "./predictfun/ml.mjs";

const argv = new Set(process.argv.slice(2));
const LIVE = argv.has("--live");
const ONCE = argv.has("--once");
const CHECK = argv.has("--check");
const RESET_EVAL = argv.has("--reset-eval");
const RESET_PNL = argv.has("--reset-pnl");
const TEST_ORDER = argv.has("--test-order");

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ---------------------------------------------------------------------------
// Telegram notifications (optional)
// ---------------------------------------------------------------------------

function rotationSwitchMessage(rot) {
  if (rot.cycled) {
    return (
      `🔁 Siklus eval ${rot.cycle}: ${rot.from ?? "—"} → ${rot.to} / ${config.llmModel}\n` +
        `DeepSeek → GLM → Gemini sudah dapat satu ronde penuh. Kuota kembali 0/10, PnL akumulasi tetap.\n` +
        `${rotation.statusSummary()}\n` +
        strategy.statusLine()
    );
  }
  return (
    `🔁 Auto-switch LLM: ${rot.from} → ${rot.to} / ${config.llmModel}\n` +
      `Alasan: ${rot.from} sudah mencapai batas uji (${config.evalTradesPerModel} trade atau circuit breaker).\n` +
      `${rotation.statusSummary()}\n` +
      strategy.statusLine()
  );
}

async function notify(text) {
  log(text.replaceAll("\n", " | "));
  if (!config.telegramToken || !config.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text }),
    });
  } catch (err) {
    log(`Telegram notify failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Market helpers
// ---------------------------------------------------------------------------

function priceOf(level) {
  // PriceLevel may be an object with a price field or a plain number string.
  if (level == null) return undefined;
  const raw = typeof level === "object" ? (level.price ?? level.value) : level;
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  // Prices may come back in wei (1e18) or as probabilities; normalize.
  return num > 1 ? num / 1e18 : num;
}

function tradableBinary(market) {
  if (!Array.isArray(market.outcomes) || market.outcomes.length !== 2) return false;
  // REGISTERED = live market; PRICE_PROPOSED/RESOLVED are (near) settlement.
  if (market.status !== "REGISTERED" || market.tradingStatus !== "OPEN") return false;
  const [a, b] = market.outcomes;
  const yesAsk = priceOf(a.bestAsk);
  const noAsk = priceOf(b.bestAsk);
  if (yesAsk === undefined || noAsk === undefined) return false;
  // At least one side must be inside the sane price band to be worth analyzing.
  const { priceBandMin, priceBandMax } = config.strategy;
  return (
    (yesAsk >= priceBandMin && yesAsk <= priceBandMax) ||
    (noAsk >= priceBandMin && noAsk <= priceBandMax)
  );
}

function liquidityOk(market) {
  const liq = market.stats?.liquidity3cAskUsd;
  if (liq == null) return true; // stats not always inlined; don't block
  return Number(liq) >= config.strategy.minLiquidityUsd;
}

// ---------------------------------------------------------------------------
// Crypto Up/Down helpers
// ---------------------------------------------------------------------------

function cryptoDetails(market) {
  const d = market.variantDetails ?? market.variantData;
  return d?.type === "CRYPTO_UP_DOWN" ? d : null;
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

/** Epoch ms for a wall-clock time in America/New_York (handles EDT/EST). */
function etToEpochMs(year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(utcGuess));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-04:00";
  const om = tz.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offsetMs = om ? (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 3600 + Number(om[3]) * 60) * 1000 : -4 * 3600 * 1000;
  return utcGuess - offsetMs;
}

/**
 * Round close time parsed from the market title. Known formats:
 *   "Bitcoin Up or Down - August 29, 3PM ET"            hourly -> closes 4PM ET
 *   "... - August 29, 3:10PM-3:15PM ET"                 5m/15m -> closes at range end
 *   "Bitcoin Up or Down on August 30?"                  daily  -> closes midnight ET
 * Returns epoch ms, or null when the title doesn't match.
 */
function parseCloseTimeMs(title, referenceYear = new Date().getFullYear()) {
  const dateM = title.match(/(\w+)\s+(\d{1,2})/);
  if (!dateM) return null;
  const month = MONTHS.indexOf(dateM[1].toLowerCase());
  if (month === -1) return null;
  const day = Number(dateM[2]);

  // Collect every time token; for a range like "3:10PM-3:15PM ET" the last
  // one is the close time.
  const times = [...title.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi)];
  if (times.length === 0) {
    // Daily round: closes at midnight ET at the end of that day.
    return etToEpochMs(referenceYear, month, day + 1, 0, 0);
  }

  const last = times[times.length - 1];
  let hour = Number(last[1]) % 12;
  if (last[3].toUpperCase() === "PM") hour += 12;
  const minute = last[2] ? Number(last[2]) : 0;
  const epoch = etToEpochMs(referenceYear, month, day, hour, minute);

  // A single time token means an hourly round labeled by its START hour.
  return times.length === 1 ? epoch + 60 * 60 * 1000 : epoch;
}

/** A crypto round we can trade: live, strike set, not yet ended, priced. */
function tradableCryptoRound(market) {
  const d = cryptoDetails(market);
  if (!d) return false;
  if (market.status !== "REGISTERED" || market.tradingStatus !== "OPEN") return false;
  if (d.startPrice == null || d.endPrice != null) return false;
  const up = market.outcomes?.find((o) => /up/i.test(o.name));
  const down = market.outcomes?.find((o) => /down/i.test(o.name));
  if (!up || !down) return false;
  const upAsk = priceOf(up.bestAsk);
  const downAsk = priceOf(down.bestAsk);
  if (upAsk === undefined || downAsk === undefined) return false;
  const { priceBandMin, priceBandMax } = config.strategy;
  return (
    (upAsk >= priceBandMin && upAsk <= priceBandMax) ||
    (downAsk >= priceBandMin && downAsk <= priceBandMax)
  );
}

// ---------------------------------------------------------------------------
// Settlement: check tracked trades against resolved markets
// ---------------------------------------------------------------------------

async function settleResolvedTrades() {
  const open = { ...strategy.getState().openTrades };
  for (const [marketId, trade] of Object.entries(open)) {
    let market;
    try {
      market = await api.getMarket(marketId);
    } catch (err) {
      log(`settle: failed to fetch market ${marketId}: ${err.message}`);
      continue;
    }
    let won = null;
    if (market?.resolution) {
      won = String(market.resolution.onChainId) === String(trade.tokenId);
    } else {
      // Crypto rounds: settle as soon as the end price is published, without
      // waiting for the on-chain resolution to finalize.
      const d = cryptoDetails(market ?? {});
      if (d && d.endPrice != null && d.startPrice != null && d.endPrice !== d.startPrice) {
        const upWon = d.endPrice > d.startPrice;
        won = trade.side === "UP" ? upWon : !upWon;
      }
    }
    if (won === null) continue;
    const pnlUsd = won
      ? Number((trade.stakeUsd * (1 / trade.price - 1)).toFixed(2))
      : -trade.stakeUsd;

    const { halted } = strategy.settleTrade(marketId, { won, pnlUsd });
    await notify(
      `${won ? "🟢 WIN" : "🔴 LOSS"} ${trade.dryRun ? "[SIM] " : ""}"${trade.title}"\n` +
        `Side: ${trade.side} @ ${trade.price} · stake $${trade.stakeUsd} · PnL ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd}\n` +
        strategy.statusLine(),
    );
    if (halted) {
      await notify(
        `⛔ Circuit breaker: ${config.strategy.maxLossStreak} consecutive losses.\n` +
          `Round ${config.llmProvider} selesai — giliran LLM berikutnya (bukan tunggu tengah malam).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// One scan cycle
// ---------------------------------------------------------------------------

async function settleEveryLedger() {
  const names = rotation.isAuto()
    ? config.llmRotation.filter((name) => providerHasKey(name))
    : [config.llmProvider];
  const current = config.llmProvider;
  for (const name of names) {
    applyLlmProvider(name);
    strategy.loadState();
    await settleResolvedTrades();
  }
  applyLlmProvider(current);
  strategy.loadState();
}

async function refreshLiveBankroll() {
  if (!config.strategy.bankrollLive || !config.privateKey) return;
  try {
    const { collateralBalanceUsd } = await import("./predictfun/executor.mjs");
    const usd = await collateralBalanceUsd();
    if (Number.isFinite(usd) && usd >= 0) {
      config.strategy.liveBankrollUsd = usd;
      log(`live bankroll $${usd.toFixed(2)} USDT → base $${strategy.currentStakes().base.toFixed(2)} / high $${strategy.currentStakes().high.toFixed(2)}`);
    }
  } catch (err) {
    log(`live bankroll fetch failed (${err.message}) — fallback BANKROLL_USD=$${config.strategy.bankrollUsd}`);
  }
}

async function scanCycle() {
  await settleEveryLedger();
  await refreshLiveBankroll();
  const rot = rotation.syncActiveProvider();
  if (rot.switched && rot.from) {
    await notify(rotationSwitchMessage(rot));
  }
  if (rot.allDone) {
    log(`skip cycle — no LLM keys for rotation (${rotation.statusSummary()})`);
    return;
  }

  const gate = strategy.tradingAllowed();
  if (!gate.allowed) {
    log(`skip cycle — ${gate.reason}`);
    return;
  }

  const isCrypto = config.marketVariant === "CRYPTO_UP_DOWN";

  let markets;
  try {
    markets = await api.getMarkets({
      status: "OPEN",
      sort: "VOLUME_24H_DESC",
      first: 25,
      marketVariant: config.marketVariant,
    });
  } catch (err) {
    log(`failed to fetch markets: ${err.message}`);
    return;
  }

  const candidates = markets
    .filter(isCrypto ? tradableCryptoRound : tradableBinary)
    .filter(liquidityOk)
    .filter((m) => !strategy.hasOpenTrade(String(m.id)))
    .slice(0, config.strategy.marketsPerCycle);

  if (candidates.length === 0) {
    log(`no tradable ${isCrypto ? "crypto up/down rounds" : "candidates"} this cycle`);
    return;
  }

  for (const market of candidates) {
    const stillAllowed = strategy.tradingAllowed();
    if (!stillAllowed.allowed) break;

    // For crypto rounds, UP plays the role of YES throughout.
    const outcomeA = isCrypto ? market.outcomes.find((o) => /up/i.test(o.name)) : market.outcomes[0];
    const outcomeB = isCrypto ? market.outcomes.find((o) => /down/i.test(o.name)) : market.outcomes[1];
    const yesAsk = priceOf(outcomeA.bestAsk);
    const noAsk = priceOf(outcomeB.bestAsk);

    let analysis;
    let extraInfo = "";
    try {
      if (isCrypto) {
        const d = cryptoDetails(market);
        const closeMs = parseCloseTimeMs(market.title);
        const minutesRemaining = closeMs ? (closeMs - Date.now()) / 60000 : null;
        if (minutesRemaining !== null && minutesRemaining * 60 < config.strategy.minTimeLeftSec) {
          log(`PASS "${market.title}" — only ${(minutesRemaining * 60).toFixed(0)}s left (< MIN_TIME_LEFT_SEC)`);
          continue;
        }
        const priceCtx = await getPriceContext(d.priceFeedSymbol);
        const gapPct = ((priceCtx.currentPrice - d.startPrice) / d.startPrice) * 100;
        extraInfo = `strike ${d.startPrice} · now ${priceCtx.currentPrice} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(3)}%) · ${minutesRemaining === null ? "?" : minutesRemaining.toFixed(0)}m left`;
        const gate = indicatorGate({
          snapshot: priceCtx.snapshot,
          startPrice: d.startPrice,
          currentPrice: priceCtx.currentPrice,
          upAsk: yesAsk,
          downAsk: noAsk,
        });
        extraInfo += ` · ${gate.line}`;
        if (gate.skip) {
          log(`PASS "${market.title}" — ${extraInfo} → ${gate.skip}`);
          continue;
        }
        extraInfo += ` · lead ${gate.favored}`;
        const favoredAsk = gate.favored === "UP" ? yesAsk : noAsk;
        const { priceBandMin, priceBandMax } = config.strategy;
        if (favoredAsk < priceBandMin || favoredAsk > priceBandMax) {
          log(
            `PASS "${market.title}" — ${extraInfo} → leader ${gate.favored} @ ${favoredAsk} outside [${priceBandMin}, ${priceBandMax}] (not fading the ${gate.favored === "UP" ? "DOWN" : "UP"} underdog)`,
          );
          continue;
        }
        const mlScore = await scoreFeatures(
          mlFeatures({
            snapshot: priceCtx.snapshot,
            startPrice: d.startPrice,
            currentPrice: priceCtx.currentPrice,
            minutesRemaining: minutesRemaining ?? 30,
            priceCtx,
          }),
        );
        const mlGate = mlScore.ready
          ? mlEnsembleGate({
              votes: mlScore.votes,
              favored: gate.favored,
              minAgree: config.strategy.minMlAgree,
              minProba: config.ml.minProba,
            })
          : { skip: null, line: mlScore.line };
        extraInfo += ` · ${mlGate.line}`;
        if (mlGate.skip) {
          log(`PASS "${market.title}" — ${extraInfo} → ${mlGate.skip}`);
          continue;
        }
        const crypto = await analyzeCryptoUpDown({
          title: market.title,
          startPrice: d.startPrice,
          minutesRemaining: minutesRemaining ?? 30,
          priceCtx,
          upAsk: yesAsk,
          downAsk: noAsk,
        });
        const aligned = alignWithIndicators(crypto, gate);
        extraInfo += ` · raw P(Up)=${(aligned.rawP * 100).toFixed(0)}%→${(aligned.probabilityUp * 100).toFixed(0)}%`;
        if (aligned.skip) {
          log(`PASS "${market.title}" — ${extraInfo} → ${aligned.skip}`);
          continue;
        }
        analysis = {
          probabilityYes: aligned.probabilityYes,
          confidence: aligned.confidence,
          reasoning: aligned.reasoning,
          favored: gate.favored,
        };
      } else {
        analysis = await analyzeMarket(market, { yesPrice: yesAsk, noPrice: noAsk });
      }
    } catch (err) {
      log(`analysis failed for "${market.title}": ${err.message}`);
      continue;
    }

    const decision = strategy.decideEntry(analysis, { yesAsk, noAsk });
    const confPct = (analysis.confidence * 100).toFixed(0);
    const probPct = (analysis.probabilityYes * 100).toFixed(0);

    if (decision.skip) {
      log(`PASS "${market.title}" — ${extraInfo ? extraInfo + " — " : ""}P(${outcomeA.name})=${probPct}% conf=${confPct}% → ${decision.skip}`);
      continue;
    }

    const outcome = decision.side === "YES" ? outcomeA : outcomeB;
    const price = decision.side === "YES" ? yesAsk : noAsk;

    const trade = {
      marketId: String(market.id),
      title: market.title,
      side: isCrypto ? (decision.side === "YES" ? "UP" : "DOWN") : decision.side,
      outcomeName: outcome.name,
      tokenId: String(outcome.onChainId),
      price,
      stakeUsd: decision.stakeUsd,
      tier: decision.tier,
      confidence: analysis.confidence,
      probabilityYes: analysis.probabilityYes,
      dryRun: !LIVE,
      llmProvider: config.llmProvider,
    };

    if (LIVE) {
      try {
        const { placeBuyOrder } = await import("./predictfun/executor.mjs");
        const { orderId, orderHash } = await placeBuyOrder({ market, outcome, price, stakeUsd: decision.stakeUsd });
        trade.orderId = orderId;
        trade.orderHash = orderHash;
      } catch (err) {
        log(`ORDER FAILED "${market.title}": ${err.message}`);
        await notify(
          `❌ ORDER FAILED\n"${market.title}"\n${err.message}\n` +
            (String(err.message).includes("jurisdiction")
              ? "VPS IP ditolak predict.fun (geo). Wallet sudah sign; order tidak masuk, USDT tidak terpotong.\n"
              : "") +
            strategy.statusLine(),
        );
        continue;
      }
    }

    strategy.recordEntry(trade);
    await notify(
      `${LIVE ? "🎯 ORDER PLACED" : "🧪 SIMULATED ENTRY"} [${trade.tier === "high" ? `HIGH CONF ≥${config.strategy.highConfThreshold * 100}%` : "base"}]\n` +
        `"${market.title}"\n` +
        (extraInfo ? `${extraInfo}\n` : "") +
        `Buy ${outcome.name} @ ${price} · stake $${decision.stakeUsd} · edge +${(decision.edge * 100).toFixed(1)}c\n` +
        `LLM: P=${probPct}% conf=${confPct}%\n${analysis.reasoning.slice(0, 300)}\n` +
        strategy.statusLine(),
    );
  }

  const after = rotation.syncActiveProvider();
  if (after.switched && after.from) {
    await notify(rotationSwitchMessage(after));
  }
}

// ---------------------------------------------------------------------------
// Bot runner
// ---------------------------------------------------------------------------

async function runBot() {
  rotation.syncActiveProvider();

  if (LIVE) {
    if (config.network === "mainnet" && !config.predictApiKey) {
      console.error("PREDICT_API_KEY is required for live mainnet trading."); process.exit(1);
    }
    if (!config.privateKey) {
      console.error("PRIVY_WALLET_PRIVATE_KEY is required for live trading."); process.exit(1);
    }
    if (!hasAnyLlmKey()) {
      console.error("Set VIKEY_API_KEY and/or GEMINI_API_KEY — the bot has no brain without one.");
      process.exit(1);
    }
    const { login, ensureApprovals } = await import("./predictfun/executor.mjs");
    const address = await login();
    log(`authenticated as ${address}`);
    await ensureApprovals();
    log("protocol approvals verified");
  } else {
    if (!hasAnyLlmKey()) {
      console.error("Set VIKEY_API_KEY and/or GEMINI_API_KEY — required even in dry-run.");
      process.exit(1);
    }
    log("DRY RUN mode — analyses and simulated entries only, no real orders. Use --live to trade.");
  }

  await refreshLiveBankroll();
  const stakes = strategy.currentStakes();
  await notify(
    `🤖 predict.fun bot started (${LIVE ? "LIVE" : "DRY RUN"}, ${config.network})\n` +
      `brain: ${config.llmProvider} / ${config.llmModel}` +
      (rotation.isAuto() ? `  (auto-rotate after ${config.evalTradesPerModel} trades/model; loop after all 3 finish — no midnight reset)\n${rotation.statusSummary()}\n` : "\n") +
      `bankroll $${stakes.bankroll.toFixed(2)}${stakes.live ? " live" : " (BANKROLL_USD)"} · base $${stakes.base.toFixed(2)} · ` +
      `high-conf ≥${config.strategy.highConfThreshold * 100}% → $${stakes.high.toFixed(2)} (cap $${config.strategy.maxStakeUsd}) · ` +
      `stop after ${config.strategy.maxLossStreak} losses/round\n` +
      `ML: ${config.ml.enabled ? (modelsReady() ? "XGBoost+LightGBM+RF+Logistic ready" : "untrained — npm run ml:train") : "off"}\n` +
      strategy.statusLine(),
  );

  for (;;) {
    try {
      await scanCycle();
    } catch (err) {
      log(`cycle error: ${err.message}`);
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, config.strategy.scanIntervalSec * 1000));
  }
}

// ---------------------------------------------------------------------------
// --check: diagnostics
// ---------------------------------------------------------------------------

const PASS = "✅", WARN = "⚠️", FAIL = "❌";

async function runCheck() {
  console.log(`predict.fun bot — diagnostics (--check) · target: ${config.network}\n`);
  let failed = false;
  const S = config.strategy;

  // 1. Credentials inventory (the "4 bahan")
  console.log("— Credentials —");
  if (config.predictApiKey) console.log(`${PASS} 1. PREDICT_API_KEY set`);
  else if (config.network === "testnet") console.log(`${WARN} 1. PREDICT_API_KEY not set (OK on testnet)`);
  else { console.log(`${FAIL} 1. PREDICT_API_KEY missing — required on mainnet`); failed = true; }

  if (config.llmMode === "auto") {
    console.log(`${PASS} 2. LLM_PROVIDER=auto · rotation ${config.llmRotation.join(" → ")} · ${config.evalTradesPerModel} trades/model`);
    if (!config.vikeyApiKey) { console.log(`${FAIL}    VIKEY_API_KEY missing (needed for DeepSeek + GLM)`); failed = true; }
    else {
      console.log(`${PASS}    VIKEY_API_KEY set`);
      console.log(`${PASS}    DeepSeek (vikey): ${config.vikeyModel}`);
      console.log(`${PASS}    GLM (glm): ${config.glmModel}`);
    }
    if (!config.geminiApiKey) { console.log(`${FAIL}    GEMINI_API_KEY missing`); failed = true; }
    else console.log(`${PASS}    Gemini: ${config.geminiModel}`);
  } else if (config.llmTransport === "vikey") {
    console.log(config.vikeyApiKey ? `${PASS} 2. VIKEY_API_KEY set (brain ${config.llmProvider} / ${config.llmModel})` : `${FAIL} 2. VIKEY_API_KEY missing — the bot cannot think`);
    if (!config.vikeyApiKey) failed = true;
    if (config.geminiApiKey) console.log(`${PASS}    GEMINI_API_KEY also set (auto-rotate: LLM_PROVIDER=auto)`);
  } else {
    console.log(config.geminiApiKey ? `${PASS} 2. GEMINI_API_KEY set (provider gemini / ${config.geminiModel})` : `${FAIL} 2. GEMINI_API_KEY missing — the bot cannot think`);
    if (!config.geminiApiKey) failed = true;
    if (config.vikeyApiKey) console.log(`${PASS}    VIKEY_API_KEY also set (DeepSeek + GLM)`);
  }

  if (config.privateKey) {
    try {
      const { walletAddress, makerAddress } = await import("./predictfun/executor.mjs");
      console.log(`${PASS} 3. Wallet key set — signer ${walletAddress()}, maker ${makerAddress()}`);
      if (!config.predictAccount) {
        console.log(`${WARN}    PREDICT_ACCOUNT_ADDRESS not set — assuming plain EOA (set it if you use the predict.fun web app / smart wallet)`);
      }
    } catch (err) {
      console.log(`${FAIL} 3. Wallet key invalid: ${err.message}`); failed = true;
    }
  } else {
    console.log(`${WARN} 3. PRIVY_WALLET_PRIVATE_KEY not set — dry-run only, cannot place real orders`);
  }
  console.log(`${PASS} 4. VPS/runtime: Node ${process.version} on ${process.platform}`);

  // 2. predict.fun API
  console.log("\n— predict.fun API —");
  const probe = await api.probeApi();
  if (probe.ok) {
    console.log(`${PASS} ${config.apiBase} reachable (${probe.detail})`);
    try {
      const markets = await api.getMarkets({ first: 10, marketVariant: config.marketVariant });
      const live = markets.filter((m) => config.marketVariant !== "CRYPTO_UP_DOWN" || tradableCryptoRound(m));
      const names = (live.length ? live : markets).slice(0, 3).map((m) => `"${m.title}"`).join(", ");
      console.log(`${PASS} Markets OK (variant ${config.marketVariant}) — ${live.length} live now, e.g. ${names}`);
    } catch (err) {
      console.log(`${FAIL} Markets fetch failed: ${err.message}`); failed = true;
    }
  } else if (probe.status === 401) {
    console.log(`${WARN} ${config.apiBase}: ${probe.detail}`);
    if (config.network === "mainnet") { failed = failed || !config.predictApiKey; }
  } else {
    console.log(`${FAIL} ${config.apiBase} unreachable: ${probe.detail}`); failed = true;
  }

  // 3. LLM brain
  console.log(`\n— LLM brain (${config.llmProvider} / ${config.llmModel}) —`);
  const brain = await probeLlm();
  console.log(brain.ok ? `${PASS} ${brain.provider} OK — ${brain.detail}` : `${hasLlmKey() ? FAIL : WARN} ${brain.provider}: ${brain.detail}`);
  if (!brain.ok && hasLlmKey()) failed = true;

  // 3b. Binance price feed (needed for crypto up/down analysis)
  if (config.marketVariant === "CRYPTO_UP_DOWN") {
    const bn = await probeBinance();
    console.log(bn.ok ? `${PASS} Binance price feed OK — ${bn.detail}` : `${FAIL} Binance price feed: ${bn.detail}`);
    if (!bn.ok) failed = true;
  }

  // 4. Wallet balances + auth (only when a key is present)
  if (config.privateKey) {
    console.log("\n— Wallet & auth —");
    try {
      const executor = await import("./predictfun/executor.mjs");
      const gas = await executor.gasBalanceBnb();
      console.log(`${gas > 0.002 ? PASS : WARN} Privy wallet gas: ${gas.toFixed(5)} BNB${gas <= 0.002 ? " — top up! needed for approvals/cancels" : ""}`);
      const usd = await executor.collateralBalanceUsd();
      console.log(`${usd > 0 ? PASS : WARN} Trading balance: $${usd.toFixed(2)} USDT${usd === 0 ? " — deposit funds to trade" : ""}`);
      if (Number.isFinite(usd) && usd >= 0) config.strategy.liveBankrollUsd = usd;
      if (config.predictApiKey || config.network === "testnet") {
        const address = await executor.login();
        console.log(`${PASS} JWT auth OK — authenticated as ${address}`);
      }
    } catch (err) {
      console.log(`${FAIL} Wallet/auth check failed: ${err.message}`); failed = true;
    }
  }

  // 5. Telegram (optional)
  console.log("\n— Telegram (optional) —");
  if (config.telegramToken && config.telegramChatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      console.log(`${PASS} Notifications ready — bot @${data.result.username} → chat ${config.telegramChatId}`);
    } catch (err) {
      console.log(`${FAIL} Telegram check failed: ${err.message}`); failed = true;
    }
  } else {
    console.log(`${WARN} TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — no notifications (bot still works)`);
  }

  // 6. Strategy summary
  console.log("\n— Strategy —");
  const stakes = strategy.currentStakes();
  console.log(
    `   bankroll $${stakes.bankroll.toFixed(2)}${stakes.live ? " live USDT" : ` (BANKROLL_USD fallback; live ${S.bankrollLive ? "on" : "off"})`} · ` +
      `base $${stakes.base.toFixed(2)} (${S.baseStakePct}% of live, floor $${S.baseStakeUsd}) · ` +
      `high-conf ≥${S.highConfThreshold * 100}% → ${S.highConfStakePct}% ($${stakes.high.toFixed(2)}) · cap $${S.maxStakeUsd}`,
  );
  console.log(`   min confidence ${S.minConfidence * 100}% · min edge ${S.minEdge * 100}c · entry price ${S.priceBandMin}–${S.priceBandMax} · stop after ${S.maxLossStreak} straight losses (day = ${S.timezone})`);
  console.log(`   guards: ≤${S.maxDailyTrades} trades/day · ≤${S.maxOpenPositions} open positions · ≥$${S.minLiquidityUsd} liquidity`);
  if (config.llmMode === "auto") console.log(`   auto-rotate: ${config.llmRotation.join(" → ")} after ${config.evalTradesPerModel} trades or a halt, then loop (no midnight reset)`);
  console.log(`   discipline: EMA+RSI+MACD+book (≥${S.minIndicatorAgree} agree) · spread ≤${S.maxSpreadBps}bps · vol ≥${S.minVolumeRatio}x · never fade the leader`);
  console.log(`   ML filter: ${config.ml.enabled ? "on" : "off"} · need ${S.minMlAgree} of XGB/LGB/RF/LR aligned with indicators · p≥${config.ml.minProba}`);

  console.log("\n— ML ensemble (XGBoost · LightGBM · Random Forest · Logistic) —");
  const py = resolvePython();
  console.log(`${PASS} python: ${py}`);
  if (!config.ml.enabled) {
    console.log(`${WARN} ML_FILTER=off — ensemble is not used`);
  } else if (!modelsReady()) {
    console.log(`${WARN} no trained models in data/ml — run: npm run ml:train`);
  } else {
    const meta = readMeta();
    const rows = meta?.models ? Object.entries(meta.models) : [];
    if (rows.length === 0) console.log(`${PASS} models present in data/ml`);
    for (const [name, info] of rows) {
      const tag = info.kept ? PASS : WARN;
      console.log(`${tag} ${name}: acc=${info.acc} auc=${info.auc}${info.kept ? "" : " (dropped)"}`);
    }
  }

  console.log(failed ? "\nResult: FAIL — fix the ❌ items above." : "\nResult: OK — ready to run (dry-run by default, --live to trade).");
  process.exit(failed ? 1 : 0);
}

/**
 * One real $1 limit buy on the current favorite of a live crypto round.
 * Used to prove wallet signing + POST /v1/orders from this VPS. Exits after
 * one attempt. Not a strategy trade — skip filters on purpose.
 */
async function runTestOrder() {
  const STAKE = 1;
  if (!config.privateKey) {
    console.error("PRIVY_WALLET_PRIVATE_KEY is required for --test-order.");
    process.exit(1);
  }
  if (config.network === "mainnet" && !config.predictApiKey) {
    console.error("PREDICT_API_KEY is required for --test-order on mainnet.");
    process.exit(1);
  }

  const { login, ensureApprovals, placeBuyOrder, collateralBalanceUsd, makerAddress } = await import(
    "./predictfun/executor.mjs"
  );
  const address = await login();
  log(`authenticated as ${address} (maker ${makerAddress()})`);
  await ensureApprovals();
  log("protocol approvals verified");

  const usd = await collateralBalanceUsd();
  log(`trading balance $${usd.toFixed(2)} USDT`);
  if (!(usd >= STAKE)) {
    console.error(`Need at least $${STAKE} USDT on predict.fun to run the test (have $${usd.toFixed(2)}).`);
    process.exit(1);
  }

  const markets = await api.getMarkets({
    status: "OPEN",
    sort: "VOLUME_24H_DESC",
    first: 25,
    marketVariant: "CRYPTO_UP_DOWN",
  });

  let pick = null;
  for (const market of markets) {
    const d = cryptoDetails(market);
    if (!d || market.status !== "REGISTERED" || market.tradingStatus !== "OPEN") continue;
    if (d.startPrice == null || d.endPrice != null) continue;
    const closeMs = parseCloseTimeMs(market.title);
    const leftSec = closeMs ? (closeMs - Date.now()) / 1000 : 3600;
    if (leftSec < 300) continue;
    const outcomeA = market.outcomes.find((o) => /up/i.test(o.name));
    const outcomeB = market.outcomes.find((o) => /down/i.test(o.name));
    if (!outcomeA || !outcomeB) continue;
    const yesAsk = priceOf(outcomeA.bestAsk);
    const noAsk = priceOf(outcomeB.bestAsk);
    if (yesAsk == null || noAsk == null) continue;
    const favored = yesAsk >= noAsk ? "UP" : "DOWN";
    const outcome = favored === "UP" ? outcomeA : outcomeB;
    const price = favored === "UP" ? yesAsk : noAsk;
    if (!(price > 0.02 && price < 0.98)) continue;
    pick = { market, outcome, price, favored, leftSec };
    break;
  }

  if (!pick) {
    console.error("No live crypto Up/Down round with ≥5 minutes left. Try again in a minute.");
    process.exit(1);
  }

  const msg =
    `🧪 TEST ORDER 1× (bukan strategi, cek koneksi wallet)\n` +
    `"${pick.market.title}"\n` +
    `Buy ${pick.outcome.name} @ ${pick.price} · stake $${STAKE} · ~${(pick.leftSec / 60).toFixed(0)}m left`;
  await notify(msg);

  try {
    const { orderId, orderHash } = await placeBuyOrder({
      market: pick.market,
      outcome: pick.outcome,
      price: pick.price,
      stakeUsd: STAKE,
    });
    await notify(
      `✅ TEST ORDER MASUK\n` +
        `"${pick.market.title}" Buy ${pick.outcome.name} @ ${pick.price} · $${STAKE}\n` +
        `orderId ${orderId}\n` +
        `hash ${orderHash || "—"}\n` +
        `Wallet + API dari VPS ini TERHUBUNG. Cek posisi di predict.fun.`,
    );
    log(`TEST ORDER OK orderId=${orderId}`);
  } catch (err) {
    const geo = String(err.message).includes("jurisdiction");
    await notify(
      `❌ TEST ORDER GAGAL\n` +
        `"${pick.market.title}"\n${err.message}\n` +
        (geo
          ? "Wallet sudah sign. Yang menolak: IP VPS (geo). USDT tidak terpotong. Pindah VPS ke region yang predict.fun izinkan."
          : "Cek pesan di atas. Bukan tes acak lagi sampai ini beres."),
    );
    log(`TEST ORDER FAILED: ${err.message}`);
    process.exit(1);
  }
}

if (RESET_PNL) {
  rotation.syncActiveProvider();
  const result = strategy.resetSimHistoryToLive();
  console.log(`Live ledger reset for brain=${result.brain}`);
  console.log(`  archived previous file, old SIM pnl=$${result.oldPnl} → $0`);
  console.log(`  dropped ${result.droppedSim} simulated open trade(s), kept ${result.keptLive} live open`);
  console.log(strategy.statusLine());
  process.exit(0);
} else if (RESET_EVAL) {
  const { first, summary } = rotation.resetEvalCountdowns();
  console.log(`Eval countdowns reset. Active brain: ${first}`);
  console.log(summary);
  process.exit(0);
} else if (TEST_ORDER) {
  runTestOrder().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
} else if (CHECK) {
  runCheck().catch((err) => { console.error(`${FAIL} Unexpected error: ${err.message}`); process.exit(1); });
} else {
  runBot().catch((err) => { console.error(`Fatal: ${err.message}`); process.exit(1); });
}
