#!/usr/bin/env python3
"""Install VOID-unfilled settlement on the mini PC copy. Idempotent."""
from pathlib import Path
import subprocess
import sys

ROOT = Path.home() / "labs/predict-fun-bot"
FILLS = ROOT / "bot/predictfun/fills.mjs"
STRAT = ROOT / "bot/predictfun/strategy.mjs"
BOT = ROOT / "bot/predict-fun-bot.mjs"

FILLS_SRC = r'''/**
 * How much of a recorded LIMIT actually filled.
 */
const MIN_FILL_USD = 0.05;
function asList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["data", "items", "orders", "positions", "results"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}
function num(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function idOf(row) {
  return String(row?.id ?? row?.orderId ?? row?.hash ?? row?.orderHash ?? "");
}
export function orderMatches(order, trade) {
  if (!order || !trade) return false;
  const oid = idOf(order);
  if (trade.orderId && oid && oid === String(trade.orderId)) return true;
  if (trade.orderHash && (oid === String(trade.orderHash) || String(order.hash ?? "") === String(trade.orderHash))) return true;
  const mid = String(order.marketId ?? order.market_id ?? order.market?.id ?? "");
  const tok = String(order.tokenId ?? order.token_id ?? order.onChainId ?? "");
  if (mid && mid === String(trade.marketId)) {
    if (!trade.tokenId || !tok || tok === String(trade.tokenId)) return true;
  }
  return false;
}
function orderStatus(order) {
  return String(order.status ?? order.state ?? order.orderStatus ?? "").toUpperCase();
}
export function orderFilledUsd(order, trade) {
  const direct = num(order.filledUsd, order.filledAmountUsd, order.filledValue, order.executedUsd, order.filledNotional);
  if (direct != null) return Math.max(0, direct);
  const shares = num(order.filled, order.filledSize, order.filledQuantity, order.quantityFilled, order.sizeFilled, order.filledAmount);
  const px = num(order.price, order.avgPrice, trade?.price);
  if (shares != null && px != null && px > 0) return Math.max(0, shares * px);
  const st = orderStatus(order);
  if (["FILLED", "MATCHED", "EXECUTED", "COMPLETE", "COMPLETED"].includes(st)) return Number(trade?.stakeUsd) || 0;
  if (["CANCELLED", "CANCELED", "EXPIRED", "REJECTED"].includes(st)) return 0;
  return null;
}
export function positionFilledUsd(pos, trade) {
  if (!pos || !trade) return 0;
  const mid = String(pos.marketId ?? pos.market_id ?? pos.market?.id ?? "");
  if (mid && mid !== String(trade.marketId)) return 0;
  const tok = String(pos.tokenId ?? pos.token_id ?? pos.onChainId ?? pos.outcomeId ?? pos.outcome?.onChainId ?? "");
  if (trade.tokenId && tok && tok !== String(trade.tokenId)) return 0;
  if (!mid && !tok) return 0;
  const shares = num(pos.amount, pos.size, pos.quantity, pos.balance, pos.shares, pos.value);
  const px = num(pos.avgPrice, pos.price, trade.price);
  if (shares == null || shares <= 0) return 0;
  if (px != null && px > 0 && shares <= 1000) return shares * px;
  if (shares > 0 && shares <= Number(trade.stakeUsd) * 1.05) return shares;
  return 0;
}
export function resolveFilledStake(trade, { orders = [], positions = [] } = {}) {
  if (trade?.dryRun) return { filledUsd: Number(trade.stakeUsd) || 0, source: "sim" };
  const orderList = asList(orders);
  const posList = asList(positions);
  const order = orderList.find((o) => orderMatches(o, trade));
  const posUsd = posList.reduce((s, p) => s + positionFilledUsd(p, trade), 0);
  if (order) {
    const fromOrder = orderFilledUsd(order, trade);
    if (fromOrder != null) {
      const filledUsd = Math.max(fromOrder, posUsd);
      return { filledUsd, source: fromOrder >= posUsd ? "order" : "position" };
    }
  }
  if (posUsd >= MIN_FILL_USD) return { filledUsd: posUsd, source: "position" };
  if (order) return { filledUsd: 0, source: "order-unfilled" };
  return { filledUsd: 0, source: "missing" };
}
export function isDustFill(filledUsd) {
  return !Number.isFinite(filledUsd) || filledUsd < MIN_FILL_USD;
}
export { MIN_FILL_USD, asList };
'''

ABANDON = '''export function abandonTrade(marketId, { reason } = {}) {
  getState();
  const trade = state.openTrades[marketId];
  if (!trade) return null;
  delete state.openTrades[marketId];
  if (state.tradesToday > 0) state.tradesToday -= 1;
  saveState();
  return { ...trade, voidedAt: new Date().toISOString(), voidReason: reason || "unfilled" };
}

export function settleTrade(marketId, { won, pnlUsd, filledUsd, fillSource } = {}) {'''

LOAD_FILL = r'''async function loadFillSnapshot() {
  try {
    const [orders, positions] = await Promise.all([api.getMyOrders(), api.getPositions()]);
    return { orders, positions, ok: true };
  } catch (err) {
    if (err.status === 401) {
      try {
        const { login } = await import("./predictfun/executor.mjs");
        await login();
        const [orders, positions] = await Promise.all([api.getMyOrders(), api.getPositions()]);
        return { orders, positions, ok: true };
      } catch (retryErr) {
        log(`settle: orders/positions retry failed (${retryErr.message})`);
        return { orders: [], positions: [], ok: false };
      }
    }
    log(`settle: orders/positions fetch failed (${err.message})`);
    return { orders: [], positions: [], ok: false };
  }
}

async function settleResolvedTrades() {
  const open = { ...strategy.getState().openTrades };
  if (Object.keys(open).length === 0) return;
  const fills = LIVE ? await loadFillSnapshot() : { orders: [], positions: [], ok: true };

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
      const d = cryptoDetails(market ?? {});
      if (d && d.endPrice != null && d.startPrice != null && d.endPrice !== d.startPrice) {
        const upWon = d.endPrice > d.startPrice;
        won = trade.side === "UP" ? upWon : !upWon;
      }
    }
    if (won === null) continue;

    let filledUsd = Number(trade.stakeUsd) || 0;
    let fillSource = trade.dryRun ? "sim" : "assumed";
    if (LIVE && !trade.dryRun) {
      if (!fills.ok) {
        log(`settle: skip "${trade.title}" — cannot confirm fill yet`);
        continue;
      }
      const got = resolveFilledStake(trade, fills);
      filledUsd = got.filledUsd;
      fillSource = got.source;
      if (isDustFill(filledUsd)) {
        strategy.abandonTrade(marketId, { reason: `unfilled (${fillSource})` });
        log(`VOID unfilled "${trade.title}" — 0 fill (${fillSource}), not booked in PnL`);
        await notify(
          `⚪ VOID (tidak terisi) "${trade.title}"\n` +
            `Limit ${trade.side} @ ${trade.price} · $${trade.stakeUsd} tidak match. ` +
            `Bukan WIN/LOSS — PnL dan circuit breaker tidak berubah.\n` +
            strategy.statusLine(),
        );
        continue;
      }
    }

    const pnlUsd = won
      ? Number((filledUsd * (1 / trade.price - 1)).toFixed(2))
      : Number((-filledUsd).toFixed(2));

    const { halted } = strategy.settleTrade(marketId, {
      won,
      pnlUsd,
      filledUsd,
      fillSource,
    });
'''

OLD_SETTLE_START = "async function settleResolvedTrades() {\n  const open = { ...strategy.getState().openTrades };\n  for (const [marketId, trade] of Object.entries(open)) {"


def must_replace(text, old, new, label):
    if old not in text:
        raise SystemExit(f"GAGAL {label}: pola tidak ketemu. Jangan restart dulu, kirim error ini.")
    return text.replace(old, new, 1)


def main():
    if not BOT.exists():
        raise SystemExit(f"tidak ketemu {BOT}")
    FILLS.write_text(FILLS_SRC)
    print("fills.mjs: ditulis")

    t = STRAT.read_text()
    if "export function abandonTrade" not in t:
        t = must_replace(t, "export function settleTrade(marketId, { won, pnlUsd }) {", ABANDON, "strategy settleTrade")
        needle = "const settled = { ...trade, settledAt: new Date().toISOString(), won, pnlUsd };"
        extra = needle + "\n  if (Number.isFinite(filledUsd)) settled.filledUsd = Number(filledUsd);\n  if (fillSource) settled.fillSource = fillSource;"
        t = must_replace(t, needle, extra, "strategy settled fields")
        STRAT.write_text(t)
        print("strategy.mjs: gepatch")
    else:
        print("strategy.mjs: sudah OK")

    t = BOT.read_text()
    if 'from "./predictfun/fills.mjs"' not in t:
        t = must_replace(
            t,
            'import { mlFeatures, modelsReady, readMeta, resolvePython, scoreFeatures } from "./predictfun/ml.mjs";',
            'import { mlFeatures, modelsReady, readMeta, resolvePython, scoreFeatures } from "./predictfun/ml.mjs";\nimport { isDustFill, resolveFilledStake } from "./predictfun/fills.mjs";',
            "bot import",
        )
    if "VOID unfilled" not in t:
        # Replace from function start through settleTrade call header
        idx = t.find(OLD_SETTLE_START)
        if idx < 0:
            raise SystemExit("GAGAL bot: settleResolvedTrades lama tidak ketemu")
        marker = "const { halted } = strategy.settleTrade(marketId, { won, pnlUsd });"
        end = t.find(marker, idx)
        if end < 0:
            raise SystemExit("GAGAL bot: settleTrade call tidak ketemu")
        end += len(marker)
        t = t[:idx] + LOAD_FILL + t[end:]
        t = t.replace(
            '`${LIVE ? "🎯 ORDER PLACED" : "🧪 SIMULATED ENTRY"}',
            '`${LIVE ? "🎯 ORDER PLACED (limit di buku, belum tentu terisi)" : "🧪 SIMULATED ENTRY"}',
            1,
        )
        BOT.write_text(t)
        print("predict-fun-bot.mjs: gepatch")
    else:
        print("predict-fun-bot.mjs: sudah OK")

    for f in (FILLS, BOT):
        r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr)
            raise SystemExit(f"syntax error {f}")
        print(f"syntax OK {f.name}")
    print("INSTALL VOID SELESAI")


if __name__ == "__main__":
    main()
