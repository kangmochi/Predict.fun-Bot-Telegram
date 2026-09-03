/**
 * Auto-switch the LLM after one model's evaluation quota is used up
 * (EVAL_TRADES_PER_MODEL trades, or a circuit-breaker halt).
 * Each provider keeps its own ledger: data/state-<provider>.json
 */

import fs from "node:fs";
import path from "node:path";
import { applyLlmProvider, config, providerHasKey, tradingDay } from "./config.mjs";
import * as strategy from "./strategy.mjs";

const ROTATION_FILE = "data/llm-rotation.json";

function availableProviders() {
  return config.llmRotation.filter((name) => providerHasKey(name));
}

function stateFileFor(name) {
  return `data/state-${name}.json`;
}

function readRotation() {
  try {
    return JSON.parse(fs.readFileSync(ROTATION_FILE, "utf8"));
  } catch {
    return { day: null, active: null, cycle: 1 };
  }
}

function writeRotation(data) {
  fs.mkdirSync(path.dirname(ROTATION_FILE), { recursive: true });
  fs.writeFileSync(ROTATION_FILE, JSON.stringify(data, null, 2));
}

function isDone(name) {
  return strategy.evalQuotaReached(strategy.peekState(stateFileFor(name)));
}

function pickActive(preferred) {
  const names = availableProviders();
  if (names.length === 0) return null;
  if (preferred && names.includes(preferred) && !isDone(preferred)) return preferred;
  return names.find((name) => !isDone(name)) ?? null;
}

export function isAuto() {
  return config.llmMode === "auto";
}

export function applyAndLoad(name) {
  applyLlmProvider(name);
  strategy.loadState();
  return name;
}

/**
 * Restore the correct brain for this process. Call once at startup and
 * at the start of every scan. A round is 10 trades or a 3-loss halt —
 * midnight does not reset. When DeepSeek, GLM, and Gemini have all
 * finished one round, counters go back to 0/10 and the cycle restarts
 * at the first brain (PnL stays accumulated).
 */
export function syncActiveProvider() {
  if (!isAuto()) {
    strategy.loadState();
    return { allDone: false, switched: false, cycled: false, from: null, to: config.llmProvider };
  }

  const rot = readRotation();
  let cycled = false;
  let next = pickActive(rot.active);
  if (!next) {
    const names = availableProviders();
    if (names.length === 0) {
      applyAndLoad(config.llmProvider);
      return { allDone: true, switched: false, cycled: false, from: rot.active, to: config.llmProvider };
    }
    rot.cycle = beginNextCycle(rot);
    next = names[0];
    cycled = true;
  }

  const switched = rot.active !== next || cycled;
  const from = rot.active;
  applyAndLoad(next);
  writeRotation({ ...rot, active: next, cycle: rot.cycle ?? 1 });
  return { allDone: false, switched, cycled, cycle: rot.cycle ?? 1, from, to: next };
}

function beginNextCycle(rot) {
  const today = tradingDay();
  for (const name of availableProviders()) {
    applyLlmProvider(name);
    strategy.loadState();
    const s = strategy.getState();
    s.day = today;
    s.lossStreak = 0;
    s.haltedUntilNextDay = false;
    s.tradesToday = 0;
    strategy.saveState();
  }
  return (rot.cycle ?? 1) + 1;
}

export function statusSummary() {
  return availableProviders()
    .map((name) => {
      const s = strategy.peekState(stateFileFor(name));
      const cap = Math.min(config.evalTradesPerModel, config.strategy.maxDailyTrades);
      return `${name} ${s.tradesToday}/${cap} pnl=$${s.realizedPnlUsd}${s.haltedUntilNextDay ? " HALTED" : ""}`;
    })
    .join(" · ");
}

/**
 * Archive today's ledgers and start every brain at 0/10, streak 0, not halted.
 * Rotation goes back to the first model in LLM_ROTATION (vikey by default).
 */
export function resetEvalCountdowns() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join("data", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  const extras = ["data/llm-rotation.json", "data/state.json"];
  const files = [
    ...availableProviders().map((name) => stateFileFor(name)),
    ...extras,
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const dest = path.join(archiveDir, `${path.basename(file, ".json")}-${stamp}.json`);
    fs.renameSync(file, dest);
  }

  const today = tradingDay();
  const first = availableProviders()[0] ?? "vikey";
  for (const name of availableProviders()) {
    applyLlmProvider(name);
    strategy.loadState();
    const s = strategy.getState();
    s.day = today;
    s.lossStreak = 0;
    s.haltedUntilNextDay = false;
    s.tradesToday = 0;
    s.realizedPnlUsd = 0;
    s.openTrades = {};
    s.history = [];
    strategy.saveState();
  }
  applyAndLoad(first);
  writeRotation({ day: today, active: first, cycle: 1 });
  return { first, summary: statusSummary() };
}
