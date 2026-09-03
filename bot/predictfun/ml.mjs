/**
 * Bridge to the Python ML ensemble (XGBoost, LightGBM, Random Forest,
 * Logistic Regression). No extra API key — models are trained on public
 * Binance candles and stored under data/ml/.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREDICT_PY = path.join(ROOT, "bot/ml/predict.py");
const TRAIN_PY = path.join(ROOT, "bot/ml/train.py");
const MODEL_DIR = path.join(ROOT, "data/ml");

export const FEATURE_NAMES = [
  "gap_pct",
  "minutes_remaining",
  "ema_fast_rel",
  "ema_slow_rel",
  "rsi",
  "macd_hist_rel",
  "volume_ratio",
  "atr_pct",
  "last_range_pct",
  "change_5m",
  "change_15m",
  "change_30m",
  "vol1m_pct",
];

let worker = null;
let workerReady = false;
let queue = Promise.resolve();
let warnedOff = false;

export function resolvePython() {
  if (config.ml.python) return config.ml.python;
  const venv = path.join(ROOT, ".venv/bin/python3");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

export function modelsReady() {
  return ["xgboost", "lightgbm", "random_forest", "logistic"].some((name) =>
    fs.existsSync(path.join(MODEL_DIR, `${name}.joblib`)),
  );
}

export function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export function mlFeatures({ snapshot, startPrice, currentPrice, minutesRemaining, priceCtx }) {
  const close = Number(currentPrice);
  const gapPct = startPrice ? ((close - startPrice) / startPrice) * 100 : 0;
  const emaFast = snapshot.emaFast ?? close;
  const emaSlow = snapshot.emaSlow ?? close;
  const macdH = snapshot.macdHist ?? 0;
  return {
    gap_pct: gapPct,
    minutes_remaining: Number(minutesRemaining ?? 30),
    ema_fast_rel: close ? (emaFast / close - 1) * 100 : 0,
    ema_slow_rel: close ? (emaSlow / close - 1) * 100 : 0,
    rsi: snapshot.rsi ?? 50,
    macd_hist_rel: close ? (macdH / close) * 100 : 0,
    volume_ratio: snapshot.volumeRatio ?? 1,
    atr_pct: snapshot.atrPct ?? 0,
    last_range_pct: snapshot.lastRangePct ?? 0,
    change_5m: priceCtx?.change5mPct ?? 0,
    change_15m: priceCtx?.change15mPct ?? 0,
    change_30m: priceCtx?.change30mPct ?? 0,
    vol1m_pct: priceCtx?.vol1mPct ?? 0,
  };
}

function startWorker() {
  if (worker) return worker;
  const py = resolvePython();
  worker = spawn(py, [PREDICT_PY, "--serve"], {
    cwd: ROOT,
    env: { ...process.env, ML_MIN_PROBA: String(config.ml.minProba) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker.stderr.on("data", (buf) => {
    const text = String(buf).trim();
    if (text) console.log(`[ml] ${text}`);
  });
  worker.on("exit", () => {
    worker = null;
    workerReady = false;
  });
  workerReady = true;
  return worker;
}

function askWorker(features) {
  return new Promise((resolve, reject) => {
    const proc = startWorker();
    const timer = setTimeout(() => reject(new Error("ML worker timeout")), 8000);
    const onData = (buf) => {
      const lines = String(buf).split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return;
      proc.stdout.off("data", onData);
      clearTimeout(timer);
      try {
        resolve(JSON.parse(lines[0]));
      } catch (err) {
        reject(err);
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(`${JSON.stringify({ features })}\n`);
  });
}

/**
 * Score features. Never throws into the scan loop — failures pass through.
 */
export async function scoreFeatures(features) {
  if (!config.ml.enabled) {
    return { ok: true, ready: false, votes: {}, line: "ML off" };
  }
  if (!modelsReady()) {
    if (!warnedOff) {
      console.log("[ml] no trained models in data/ml — run: npm run ml:train");
      warnedOff = true;
    }
    return { ok: true, ready: false, votes: {}, line: "ML untrained" };
  }
  queue = queue.then(() => askWorker(features)).catch((err) => ({
    ok: false,
    error: err.message,
    votes: {},
    line: `ML error (${err.message})`,
  }));
  const raw = await queue;
  return { ...raw, ready: Boolean(raw.ok && raw.votes && Object.keys(raw.votes).length) };
}

export function stopWorker() {
  if (worker) {
    worker.kill();
    worker = null;
    workerReady = false;
  }
}

export { PREDICT_PY, TRAIN_PY, MODEL_DIR, workerReady };
