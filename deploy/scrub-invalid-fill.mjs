#!/usr/bin/env node
/**
 * One-shot: drop a LIMIT that Predict marked invalid / never filled but the
 * old bot booked as WIN/LOSS. Does not touch the wallet.
 *
 *   node deploy/scrub-invalid-fill.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

function isScrubTarget(t) {
  const title = String(t?.title ?? "");
  if (!/bitcoin/i.test(title)) return false;
  if (!/4:45\s*AM\s*-\s*5\s*AM\s*ET/i.test(title) && !/4:45AM-5AM ET/i.test(title)) return false;
  const px = Number(t.price);
  return !Number.isFinite(px) || Math.abs(px - 0.52) < 0.005;
}

function scrubState(file) {
  const raw = fs.readFileSync(file, "utf8");
  const s = JSON.parse(raw);
  const bak = `${file}.bak-invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.writeFileSync(bak, raw);
  let n = 0;
  const nextHist = [];
  for (const t of s.history ?? []) {
    if (!isScrubTarget(t)) {
      nextHist.push(t);
      continue;
    }
    const pnl = Number(t.pnlUsd) || 0;
    s.realizedPnlUsd = Number(((s.realizedPnlUsd ?? 0) - pnl).toFixed(2));
    s.lifetimePnlUsd = Number(((s.lifetimePnlUsd ?? 0) - pnl).toFixed(2));
    if (s.tradesToday > 0) s.tradesToday -= 1;
    n += 1;
    console.log(`  history - "${t.title}" pnl=${pnl} (reversed)`);
  }
  s.history = nextHist;
  for (const [id, t] of Object.entries(s.openTrades ?? {})) {
    if (!isScrubTarget(t)) continue;
    delete s.openTrades[id];
    if (s.tradesToday > 0) s.tradesToday -= 1;
    n += 1;
    console.log(`  openTrades - ${id} "${t.title}"`);
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  console.log(`  wrote ${path.basename(file)} (backup ${path.basename(bak)})`);
  return n;
}

function scrubJsonl(file) {
  if (!fs.existsSync(file)) return 0;
  const bak = `${file}.bak-invalid`;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const keep = [];
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) {
      keep.push(line);
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      keep.push(line);
      continue;
    }
    if (isScrubTarget(row)) {
      n += 1;
      console.log(`  trades.jsonl - drop "${row.title}"`);
      continue;
    }
    keep.push(line);
  }
  if (n) {
    fs.copyFileSync(file, bak);
    fs.writeFileSync(file, keep.join("\n"));
  }
  return n;
}

if (!fs.existsSync(DATA)) {
  console.error(`no data dir at ${DATA}`);
  process.exit(1);
}

let total = 0;
for (const name of fs.readdirSync(DATA)) {
  if (!name.startsWith("state") || !name.endsWith(".json")) continue;
  console.log(`==> ${name}`);
  total += scrubState(path.join(DATA, name));
}
total += scrubJsonl(path.join(DATA, "trades.jsonl"));
console.log(`done. scrubbed ${total} row(s).`);
if (total === 0) console.log("nothing matched — ledger already clean or title berbeda.");
