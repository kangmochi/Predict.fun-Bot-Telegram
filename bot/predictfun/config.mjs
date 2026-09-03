/**
 * Central configuration for the predict.fun AI trading bot.
 * All values come from environment variables; see .env.example.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

// Load the repo-root .env so manual runs (node bot/... --check) see the same
// variables as the systemd service. Real environment variables win over the
// file, and a missing .env is fine.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env"));
} catch {
  try {
    process.loadEnvFile(); // fallback: ./.env relative to the working directory
  } catch {
    // no .env anywhere — rely on the process environment
  }
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for env ${name}: "${raw}"`);
  return value;
}

// Empty lines in .env (e.g. "BSC_RPC_URL=") mean "not set, use the default".
function str(name, fallback = "") {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

const network = str("PREDICT_ENV", "mainnet").toLowerCase();
if (!["mainnet", "testnet"].includes(network)) {
  throw new Error(`PREDICT_ENV must be "mainnet" or "testnet", got "${network}"`);
}

const vikeyApiKey = str("VIKEY_API_KEY");
const geminiApiKey = str("GEMINI_API_KEY");
const vikeyModel = str("VIKEY_MODEL", "deepseek/deepseek-v4-flash");
const geminiModel = str("GEMINI_MODEL", "gemini-3.6-flash");

const glmModel = str("GLM_MODEL", "glm/glm-5.3-flash");
const BRAINS = ["vikey", "glm", "gemini"];

const llmMode = str("LLM_PROVIDER").toLowerCase(); // vikey | glm | gemini | auto
const rotationOrder = str("LLM_ROTATION", "vikey,glm,gemini")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => BRAINS.includes(s));

function inferLlmProvider() {
  if (BRAINS.includes(llmMode)) return llmMode;
  if (vikeyApiKey) return "vikey";
  if (geminiApiKey) return "gemini";
  return "vikey";
}

function modelFor(name) {
  if (name === "glm") return glmModel;
  if (name === "gemini") return geminiModel;
  return vikeyModel;
}

function transportFor(name) {
  return name === "gemini" ? "gemini" : "vikey";
}

let llmProvider = inferLlmProvider();

export const config = {
  network,
  apiBase: network === "mainnet" ? "https://api.predict.fun" : "https://api-testnet.predict.fun",
  predictApiKey: str("PREDICT_API_KEY"),

  privateKey: str("PRIVY_WALLET_PRIVATE_KEY"),
  predictAccount: str("PREDICT_ACCOUNT_ADDRESS"),
  bscRpcUrl: str("BSC_RPC_URL", "https://bsc-dataseed.binance.org"),

  llmMode: llmMode === "auto" ? "auto" : llmMode,
  llmRotation: rotationOrder.length ? rotationOrder : ["vikey", "glm", "gemini"],
  evalTradesPerModel: num("EVAL_TRADES_PER_MODEL", 10),
  llmProvider,
  llmTransport: transportFor(llmProvider),
  llmModel: modelFor(llmProvider),
  vikeyApiKey,
  vikeyBaseUrl: str("VIKEY_BASE_URL", "https://api.vikey.ai/v1"),
  vikeyModel,
  glmModel,
  geminiApiKey,
  geminiModel,

  telegramToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),

  marketVariant: str("MARKET_VARIANT", "CRYPTO_UP_DOWN").toUpperCase(),

  strategy: {
    bankrollUsd: num("BANKROLL_USD", 100),
    baseStakeUsd: num("BASE_STAKE_USD", 5),
    minConfidence: num("MIN_CONFIDENCE", 0.6),
    highConfThreshold: num("HIGH_CONF_THRESHOLD", 0.8),
    highConfStakePct: num("HIGH_CONF_STAKE_PCT", 5),
    maxStakeUsd: num("MAX_STAKE_USD", 25),
    minEdge: num("MIN_EDGE", 0.08),
    maxLossStreak: num("MAX_LOSS_STREAK", 3),
    maxDailyTrades: num("MAX_DAILY_TRADES", 10),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 500),
    priceBandMin: num("PRICE_BAND_MIN", 0.05),
    priceBandMax: num("PRICE_BAND_MAX", 0.6),
    timezone: str("BOT_TIMEZONE", "Asia/Jakarta"),
    marketsPerCycle: num("MARKETS_PER_CYCLE", 3),
    scanIntervalSec: num("SCAN_INTERVAL_SEC", 120),
    minTimeLeftSec: num("MIN_TIME_LEFT_SEC", 180),
    maxSpreadBps: num("MAX_SPREAD_BPS", 12),
    maxMarketSpread: num("MAX_MARKET_SPREAD", 0.06),
    minVolumeRatio: num("MIN_VOLUME_RATIO", 0.8),
    maxAtrMult: num("MAX_ATR_MULT", 3.5),
    minIndicatorAgree: num("MIN_INDICATOR_AGREE", 3),
    minMlAgree: num("MIN_ML_AGREE", 2),
    bankrollLive: str("BANKROLL_LIVE", "on").toLowerCase() !== "off",
    baseStakePct: num("BASE_STAKE_PCT", 4),
    liveBankrollUsd: null,
  },

  ml: {
    enabled: str("ML_FILTER", "on").toLowerCase() !== "off",
    minProba: num("ML_MIN_PROBA", 0.55),
    python: str("ML_PYTHON"),
  },

  // One ledger per LLM so Gemini vs Vikey/DeepSeek can be compared fairly.
  stateFile: str("STATE_FILE") || `data/state-${llmProvider}.json`,
};

export function applyLlmProvider(name) {
  if (!BRAINS.includes(name)) throw new Error(`Unknown LLM brain: ${name}`);
  llmProvider = name;
  config.llmProvider = name;
  config.llmTransport = transportFor(name);
  config.llmModel = modelFor(name);
  if (!str("STATE_FILE")) config.stateFile = `data/state-${name}.json`;
}

export function hasLlmKey() {
  return config.llmTransport === "vikey" ? Boolean(config.vikeyApiKey) : Boolean(config.geminiApiKey);
}

export function hasAnyLlmKey() {
  return Boolean(config.vikeyApiKey || config.geminiApiKey);
}

export function providerHasKey(name) {
  if (name === "gemini") return Boolean(config.geminiApiKey);
  if (name === "vikey" || name === "glm") return Boolean(config.vikeyApiKey);
  return false;
}

/** Current date string (YYYY-MM-DD) in the configured trading timezone. */
export function tradingDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.strategy.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
