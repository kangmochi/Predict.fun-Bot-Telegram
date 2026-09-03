/**
 * Strategy engine: position sizing, confidence tiers, and the daily
 * loss-streak circuit breaker. State survives restarts via a JSON file.
 *
 * Sizing rules (all configurable via env, see config.mjs):
 *   confidence <  MIN_CONFIDENCE        -> no trade
 *   confidence <  HIGH_CONF_THRESHOLD   -> BASE_STAKE_PCT % of live USDT
 *                                         (floor BASE_STAKE_USD if the wallet can pay it)
 *   confidence >= HIGH_CONF_THRESHOLD   -> HIGH_CONF_STAKE_PCT % of live USDT
 *   every entry is capped at MAX_STAKE_USD
 *   BANKROLL_LIVE=on (default): bankroll is the predict.fun USDT balance,
 *   so wins compound size and losses shrink it. BANKROLL_USD is fallback only.
 *
 * Circuit breaker:
 *   MAX_LOSS_STREAK consecutive losses ends this brain's eval round and
 *   the rotator moves to the next LLM. Midnight does not reset the quota.
 */

import fs from "node:fs";
import path from "node:path";
import { config, tradingDay } from "./config.mjs";

const S = config.strategy;

const DEFAULT_STATE = {
  day: null, // current trading day (YYYY-MM-DD in BOT_TIMEZONE)
  lossStreak: 0, // consecutive losses (resets on a win)
  haltedUntilNextDay: false,
  tradesToday: 0,
  realizedPnlUsd: 0,
  // Trades the bot has entered and is waiting on. Keyed by marketId.
  openTrades: {},
  // Closed/resolved trade log (most recent last).
  history: [],
};

let state = null;

export function loadState() {
  const file = config.stateFile;
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    state = structuredClone(DEFAULT_STATE);
  }
  rolloverIfNewDay();
  return state;
}

export function saveState() {
  const file = config.stateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function getState() {
  if (!state) loadState();
  return state;
}

/** Read a ledger without changing the in-memory active state. */
export function peekState(file) {
  let s;
  try {
    s = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    s = structuredClone(DEFAULT_STATE);
  }
  return s;
}

export function evalQuotaReached(s = getState()) {
  const cap = Math.min(config.evalTradesPerModel, S.maxDailyTrades);
  return Boolean(s.haltedUntilNextDay || s.tradesToday >= cap);
}

/** Stamp the calendar day for display; do not reset eval quotas at midnight. */
export function rolloverIfNewDay() {
  const today = tradingDay();
  if (state.day !== today) {
    state.day = today;
    saveState();
  }
}

/** Whether the bot is allowed to open new positions right now. */
export function tradingAllowed() {
  rolloverIfNewDay();
  if (state.haltedUntilNextDay) {
    return { allowed: false, reason: `circuit breaker: ${state.lossStreak} losses in a row — this brain's round is done` };
  }
  if (state.tradesToday >= S.maxDailyTrades) {
    return { allowed: false, reason: `eval round cap reached (${S.maxDailyTrades})` };
  }
  if (Object.keys(state.openTrades).length >= S.maxOpenPositions) {
    return { allowed: false, reason: `max open positions reached (${S.maxOpenPositions})` };
  }
  return { allowed: true };
}

/**
 * Decide whether (and how big) to enter, given the LLM analysis and current
 * best prices. Prices are probabilities in [0,1] (e.g. YES ask 0.42).
 *
 * `favored` (crypto Up/Down): lock the side to the mechanical leader.
 * Without this, max(yesEdge, noEdge) always buys the cheap underdog —
 * a 5¢ DOWN ticket looks like +38c of "edge" even when price is already
 * above the strike. We never fade.
 *
 * Returns { skip } when there is no trade, otherwise:
 *   { side: "YES"|"NO", stakeUsd, edge, tier: "base"|"high" }
 */
export function decideEntry({ probabilityYes, confidence, favored }, { yesAsk, noAsk }) {
  if (confidence < S.minConfidence) {
    return { skip: `confidence ${(confidence * 100).toFixed(0)}% < minimum ${(S.minConfidence * 100).toFixed(0)}%` };
  }

  // Edge = our estimated value minus what the market charges for that side.
  const yesEdge = yesAsk !== undefined ? probabilityYes - yesAsk : -Infinity;
  const noEdge = noAsk !== undefined ? 1 - probabilityYes - noAsk : -Infinity;

  let side;
  let edge;
  if (favored === "UP" || favored === "YES") {
    side = "YES";
    edge = yesEdge;
  } else if (favored === "DOWN" || favored === "NO") {
    side = "NO";
    edge = noEdge;
  } else {
    side = yesEdge >= noEdge ? "YES" : "NO";
    edge = Math.max(yesEdge, noEdge);
  }
  if (edge < S.minEdge) {
    const fadeNote =
      favored === "UP" || favored === "DOWN"
        ? ` (leader ${favored} — will not fade the other side)`
        : "";
    return { skip: `edge ${(edge * 100).toFixed(1)}c < minimum ${(S.minEdge * 100).toFixed(1)}c${fadeNote}` };
  }

  const entryPrice = side === "YES" ? yesAsk : noAsk;
  if (entryPrice < S.priceBandMin || entryPrice > S.priceBandMax) {
    return { skip: `leader ${favored ?? side} @ ${entryPrice} outside sane band [${S.priceBandMin}, ${S.priceBandMax}]` };
  }

  const tier = confidence >= S.highConfThreshold ? "high" : "base";
  const { base, high } = currentStakes();
  const rawStake = tier === "high" ? high : base;
  const stakeUsd = Math.min(rawStake, S.maxStakeUsd);

  return { side, stakeUsd: Number(stakeUsd.toFixed(2)), edge, tier };
}

/** Live USDT if BANKROLL_LIVE is on, else BANKROLL_USD. Size compounds with the wallet. */
export function currentStakes() {
  const live = S.liveBankrollUsd;
  const useLive = S.bankrollLive && Number.isFinite(live) && live > 0;
  const bankroll = useLive ? live : S.bankrollUsd;
  let base = S.baseStakeUsd;
  if (useLive && S.baseStakePct > 0) {
    const pct = (bankroll * S.baseStakePct) / 100;
    // Floor at BASE_STAKE_USD only while the wallet can actually pay it.
    base = S.baseStakeUsd <= bankroll ? Math.max(S.baseStakeUsd, pct) : pct;
  }
  base = Math.min(base, S.maxStakeUsd);
  let high = Math.min(S.maxStakeUsd, Math.max((bankroll * S.highConfStakePct) / 100, base));
  if (useLive) {
    const payable = Math.max(0, bankroll * 0.9);
    base = Math.min(base, payable);
    high = Math.min(high, payable);
  }
  return { bankroll, base, high, live: useLive };
}

/** Record a newly entered trade (real or simulated). */
export function recordEntry(trade) {
  state.openTrades[trade.marketId] = { ...trade, enteredAt: new Date().toISOString(), day: state.day };
  state.tradesToday += 1;
  saveState();
}

export function hasOpenTrade(marketId) {
  return Boolean(state.openTrades[marketId]);
}

/**
 * Settle a tracked trade as a win or a loss. Updates the streak and trips the
 * circuit breaker when needed. Returns { halted: boolean }.
 */
export function settleTrade(marketId, { won, pnlUsd }) {
  const trade = state.openTrades[marketId];
  if (!trade) return { halted: false };

  delete state.openTrades[marketId];
  state.history.push({ ...trade, settledAt: new Date().toISOString(), won, pnlUsd });
  if (state.history.length > 500) state.history = state.history.slice(-500);
  state.realizedPnlUsd = Number((state.realizedPnlUsd + pnlUsd).toFixed(2));

  if (won) {
    state.lossStreak = 0;
  } else {
    state.lossStreak += 1;
    if (state.lossStreak >= S.maxLossStreak) {
      state.haltedUntilNextDay = true;
    }
  }
  saveState();
  return { halted: state.haltedUntilNextDay };
}

/** Human-readable one-line status, used in logs and Telegram messages. */
export function statusLine() {
  const s = getState();
  const open = Object.keys(s.openTrades).length;
  const stakes = currentStakes();
  return (
    `brain=${config.llmProvider} day=${s.day} trades=${s.tradesToday}/${S.maxDailyTrades} open=${open}/${S.maxOpenPositions} ` +
    `streak=${s.lossStreak}/${S.maxLossStreak} pnl=$${s.realizedPnlUsd}` +
    ` · bankroll $${stakes.bankroll.toFixed(2)}${stakes.live ? " live" : ""}` +
    (s.haltedUntilNextDay ? " [HALTED round done]" : "")
  );
}

/**
 * Zero SIM PnL/history for a live start. Archives the current ledger first.
 * Simulated open positions are dropped; real live opens are kept.
 */
export function resetSimHistoryToLive() {
  loadState();
  const file = config.stateFile;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join("data", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  if (fs.existsSync(file)) {
    const dest = path.join(archiveDir, `${path.basename(file, ".json")}-prelive-${stamp}.json`);
    fs.copyFileSync(file, dest);
  }

  const oldPnl = state.realizedPnlUsd;
  const kept = {};
  let droppedSim = 0;
  for (const [id, trade] of Object.entries(state.openTrades)) {
    if (trade.dryRun) droppedSim += 1;
    else kept[id] = trade;
  }

  state.realizedPnlUsd = 0;
  state.history = [];
  state.openTrades = kept;
  state.lossStreak = 0;
  state.haltedUntilNextDay = false;
  state.tradesToday = 0;
  state.day = tradingDay();
  saveState();

  return {
    file,
    brain: config.llmProvider,
    oldPnl,
    droppedSim,
    keptLive: Object.keys(kept).length,
  };
}
