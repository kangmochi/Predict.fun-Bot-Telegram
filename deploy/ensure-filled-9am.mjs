#!/usr/bin/env node
/**
 * After the false VOID on BTC 9AM ET 22 Sep (filled on the website), make sure
 * THAT ticket is in data/state-vikey.json history + data/trades.jsonl.
 *
 * Older Bitcoin 9AM rows must not count as "already recorded".
 * Feature vectors were dropped at VOID; train.py still needs those, but the
 * row still teaches report.py (ticket/asset/hour/edge).
 *
 *   node deploy/ensure-filled-9am.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(ROOT, "data/state-vikey.json");
const LOG = path.join(ROOT, "data/trades.jsonl");

const TITLE = "Bitcoin Up or Down - September 22, 9AM ET";

function isTarget(t) {
  const title = String(t?.title ?? "");
  return /bitcoin/i.test(title) && /september\s*22/i.test(title) && /9\s*AM\s*ET/i.test(title);
}

function loadState() {
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}

function jsonlRows() {
  if (!fs.existsSync(LOG)) return [];
  const out = [];
  for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (isTarget(t)) out.push(t);
    } catch {
      /* skip */
    }
  }
  return out;
}

const s = loadState();
const histHits = (s.history || []).filter(isTarget);
const logHits = jsonlRows();
const histWin = histHits.find((t) => t.won === true);
const histLoss = histHits.filter((t) => t.won === false);
const logWin = logHits.some((t) => t.won === true);

console.log("history 22 Sep 9AM:", histHits.length, "won=", histHits.map((t) => t.won));
for (const t of histHits) {
  console.log("  hist", t.won, "pnl=", t.pnlUsd, "at", t.settledAt || t.enteredAt);
}
console.log("jsonl 22 Sep 9AM WIN:", logWin ? "ADA" : "BELUM");

if (histWin && logWin) {
  console.log("pipeline: tiket 22 Sep 9AM ET sudah di ledger. Tidak menulis ulang.");
  process.exit(0);
}

const stake = 3.39;
const price = 0.52;
const filledUsd = 3.27;
const pnlUsd = Number((filledUsd * (1 / price - 1)).toFixed(2));
const now = new Date().toISOString();
const row = {
  title: TITLE,
  side: "UP",
  outcomeName: "Up",
  price,
  stakeUsd: stake,
  filledUsd,
  pnlUsd,
  won: true,
  dryRun: false,
  llmProvider: "vikey",
  llmModel: "openai/gpt-5.6-luna",
  enteredAt: now,
  settledAt: now,
  fillSource: "revive-after-false-void",
  revived: true,
  entry: {
    asset: "BTCUSDT",
    horizonMin: 60,
    upAsk: 0.52,
    indicatorAgree: 4,
    notes: "false VOID 21:01 WIB; website Order Complete 6.3/6.32 then 6.39 Up 52c->99.1c. Feature vector lost at abandon; report still uses this row.",
  },
};

const bak = `${STATE}.bak-9am-${now.replace(/[:.]/g, "-")}`;
fs.copyFileSync(STATE, bak);

if (!histWin) {
  s.history = s.history || [];
  if (histLoss.length) {
    for (const t of histLoss) {
      const old = Number(t.pnlUsd) || 0;
      t.won = true;
      t.filledUsd = filledUsd;
      t.fillSource = "revive-after-false-void";
      t.pnlUsd = pnlUsd;
      t.revived = true;
      s.realizedPnlUsd = Number(((s.realizedPnlUsd ?? 0) + (pnlUsd - old)).toFixed(2));
      s.lifetimePnlUsd = Number(((s.lifetimePnlUsd ?? 0) + (pnlUsd - old)).toFixed(2));
      console.log(`history: LOSS palsu → WIN pnl $${old} → $${pnlUsd}`);
    }
  } else {
    s.history.push(row);
    s.realizedPnlUsd = Number(((s.realizedPnlUsd ?? 0) + pnlUsd).toFixed(2));
    s.lifetimePnlUsd = Number(((s.lifetimePnlUsd ?? 0) + pnlUsd).toFixed(2));
    console.log(`history + WIN pnl=$${pnlUsd} (backup ${path.basename(bak)})`);
  }
  if (s.lossStreak > 0) s.lossStreak = 0;
  for (const [id, t] of Object.entries(s.openTrades || {})) {
    if (isTarget(t)) delete s.openTrades[id];
  }
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
} else {
  console.log("history 22 Sep sudah WIN, skip state");
}

if (!logWin) {
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  console.log("trades.jsonl + 1 baris WIN 22 Sep 9AM");
} else {
  console.log("jsonl sudah ada, skip");
}

console.log("SELESAI. ml:report melihat tiket ini. ml:train butuh entry.features — vektor 9AM hilang saat VOID palsu; settle baru ke depan yang lengkap.");
