#!/usr/bin/env python3
"""Upgrade VOID v1 (too aggressive) → confirm fill via hash/FILLED/positions."""
from pathlib import Path
import subprocess

ROOT = Path.home() / "labs/predict-fun-bot"
BOT = ROOT / "bot/predict-fun-bot.mjs"
API = ROOT / "bot/predictfun/api.mjs"


def must(text, old, new, label):
    if old not in text:
        raise SystemExit(f"GAGAL {label}")
    return text.replace(old, new, 1)


def main():
    t = API.read_text()
    if "getOrderByHash" not in t:
        old = '''export async function getMyOrders() {
  const res = await request("GET", "/v1/orders", { auth: true });
  return res.data ?? [];
}

export async function getPositions() {
  const res = await request("GET", "/v1/positions", { auth: true });
  return res.data ?? [];
}'''
        new = '''export async function getMyOrders({ status, first = 50 } = {}) {
  const params = new URLSearchParams({ first: String(first) });
  if (status) params.set("status", status);
  const res = await request("GET", `/v1/orders?${params}`, { auth: true });
  return res.data ?? [];
}

export async function getOrderByHash(hash) {
  if (!hash) return null;
  const res = await request("GET", `/v1/orders/${encodeURIComponent(hash)}`, { auth: true });
  return res.data ?? null;
}

export async function getPositions({ marketId, first = 50, isResolved } = {}) {
  const params = new URLSearchParams({ first: String(first) });
  if (marketId != null && marketId !== "") params.set("marketId", String(marketId));
  if (isResolved === true) params.set("isResolved", "true");
  if (isResolved === false) params.set("isResolved", "false");
  const res = await request("GET", `/v1/positions?${params}`, { auth: true });
  return res.data ?? [];
}'''
        t = must(t, old, new, "api orders/positions")
        API.write_text(t)
        print("api.mjs: OK")
    else:
        print("api.mjs: sudah v2")

    t = BOT.read_text()
    t = t.replace(
        'import { isDustFill, resolveFilledStake } from "./predictfun/fills.mjs";',
        'import { asList, fromTokenAmount, isDustFill, resolveFilledStake, shouldVoid } from "./predictfun/fills.mjs";',
        1,
    )
    if "async function withAuthRetry" not in t:
        idx = t.find("async function loadFillSnapshot")
        if idx < 0:
            raise SystemExit("GAGAL bot: loadFillSnapshot tidak ketemu")
        end = t.find("async function settleResolvedTrades", idx)
        if end < 0:
            raise SystemExit("GAGAL bot: settleResolvedTrades tidak ketemu")
        insert = r'''async function withAuthRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 401) throw err;
    const { login } = await import("./predictfun/executor.mjs");
    await login();
    return await fn();
  }
}

async function loadFillSnapshot(trade) {
  try {
    const hashed = trade?.orderHash
      ? await withAuthRetry(() => api.getOrderByHash(trade.orderHash)).catch((err) => {
          log(`settle: getOrderByHash ${String(trade.orderHash).slice(0, 10)}… ${err.message}`);
          return null;
        })
      : null;
    const [filledOrders, openOrders, positions] = await withAuthRetry(async () => {
      const [filled, open, pos] = await Promise.all([
        api.getMyOrders({ status: "FILLED", first: 50 }),
        api.getMyOrders({ status: "OPEN", first: 50 }),
        api.getPositions({ marketId: trade?.marketId, first: 50 }),
      ]);
      return [filled, open, pos];
    });
    const orders = [...asList(hashed ? [hashed] : []), ...asList(filledOrders), ...asList(openOrders)];
    return { orders, positions, ok: true };
  } catch (err) {
    log(`settle: orders/positions fetch failed (${err.message})`);
    return { orders: [], positions: [], ok: false };
  }
}

'''
        t = t[:idx] + insert + t[end:]
        print("bot: loadFillSnapshot v2")

    old_void = '''      if (isDustFill(filledUsd)) {
        strategy.abandonTrade(marketId, { reason: `unfilled (${fillSource})` });
        log(`VOID unfilled "${trade.title}" — 0 fill (${fillSource}), not booked in PnL`);'''
    new_void = '''      if (shouldVoid(got)) {
        strategy.abandonTrade(marketId, { reason: `unfilled (${fillSource}/${got.status})` });
        log(`VOID unfilled "${trade.title}" — 0 fill (${fillSource} ${got.status}), not booked in PnL`);'''
    if old_void in t:
        t = t.replace(old_void, new_void, 1)
        t = t.replace(
            '''        continue;
      }
    }

    const pnlUsd = won''',
            '''        continue;
      }
      if (!got.confirmed || isDustFill(filledUsd)) {
        log(`settle: skip "${trade.title}" — fill unconfirmed (${got.source} ${got.status || ""} filled=$${Number(filledUsd).toFixed(2)})`);
        continue;
      }
    }

    const pnlUsd = won''',
            1,
        )
        print("bot: VOID hanya jika INVALIDATED")
    elif "shouldVoid(got)" in t:
        print("bot: VOID v2 sudah ada")
    else:
        print("bot: pola VOID v1 tidak ketemu — cek manual")

    if "async function reattachFilledPositions" not in t:
        t = t.replace(
            "    strategy.loadState();\n    await settleResolvedTrades();",
            "    strategy.loadState();\n    if (LIVE && name === current) await reattachFilledPositions();\n    await settleResolvedTrades();",
            1,
        )
        fn = r'''
async function reattachFilledPositions() {
  if (!LIVE) return 0;
  let positions;
  try {
    positions = await withAuthRetry(() => api.getPositions({ first: 50 }));
  } catch (err) {
    log(`reattach: positions fetch failed (${err.message})`);
    return 0;
  }
  const s = strategy.getState();
  const histIds = new Set((s.history || []).map((row) => String(row.marketId)));
  let n = 0;
  for (const pos of asList(positions)) {
    const market = pos.market || {};
    const id = String(market.id ?? pos.marketId ?? "");
    if (!id || strategy.hasOpenTrade(id) || histIds.has(id)) continue;
    const shares = fromTokenAmount(pos.amount);
    const avg = Number(pos.averageBuyPriceUsd);
    if (!Number.isFinite(shares) || shares < 0.05 || !Number.isFinite(avg) || avg <= 0) continue;
    const name = String(pos.outcome?.name ?? "");
    const side = /up/i.test(name) ? "UP" : /down/i.test(name) ? "DOWN" : null;
    if (!side) continue;
    const stake = Number((shares * avg).toFixed(2));
    if (stake < 0.05) continue;
    strategy.recordEntry({
      marketId: id,
      title: market.title || id,
      side,
      outcomeName: name,
      tokenId: String(pos.outcome?.onChainId ?? ""),
      price: avg,
      stakeUsd: stake,
      dryRun: false,
      llmProvider: config.llmProvider,
      revived: true,
    });
    n += 1;
    log(`reattach filled position "${market.title}" ${side} ${shares.toFixed(2)} sh @ ${avg} ~$${stake}`);
  }
  return n;
}

'''
        t = t.replace("async function settleEveryLedger() {", fn + "async function settleEveryLedger() {", 1)
        print("bot: reattach posisi terisi")

    # per-trade fill snapshot
    t = t.replace(
        "  const fills = LIVE ? await loadFillSnapshot() : { orders: [], positions: [], ok: true };\n\n  for (const [marketId, trade] of Object.entries(open)) {",
        "  for (const [marketId, trade] of Object.entries(open)) {",
        1,
    )
    t = t.replace(
        """    if (LIVE && !trade.dryRun) {
      if (!fills.ok) {
        log(`settle: skip "${trade.title}" — cannot confirm fill yet`);
        continue;
      }
      const got = resolveFilledStake(trade, fills);""",
        """    if (LIVE && !trade.dryRun) {
      const fills = await loadFillSnapshot(trade);
      if (!fills.ok) {
        log(`settle: skip "${trade.title}" — cannot confirm fill yet`);
        continue;
      }
      const got = resolveFilledStake(trade, fills);""",
        1,
    )

    BOT.write_text(t)
    r = subprocess.run(["node", "--check", str(BOT)], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr)
        raise SystemExit("syntax error bot")
    print("syntax OK")
    print("INSTALL VOID v2 SELESAI")


if __name__ == "__main__":
    main()
