/**
 * How much of a recorded LIMIT actually filled.
 *
 * Predict.fun schema (GET /v1/orders, GET /v1/orders/{hash}):
 *   { id, marketId, amount, amountFilled, status, order: { hash, tokenId } }
 *   status = OPEN | FILLED | EXPIRED | CANCELLED | INVALIDATED
 *   amount / amountFilled are USDT wei strings.
 *
 * GET /v1/orders without status defaults to OPEN, so a fill vanishes from that
 * list. Never treat "not in the OPEN list" as unfilled.
 */

const MIN_FILL_USD = 0.05;
const TERMINAL_EMPTY = new Set(["INVALIDATED", "CANCELLED", "CANCELED", "EXPIRED"]);
const FILLED_STATUSES = new Set(["FILLED", "MATCHED", "EXECUTED", "COMPLETE", "COMPLETED"]);

export function asList(data) {
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

/** Wei integer string → token units. Small numbers stay as-is (already shares/USD). */
export function fromTokenAmount(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes(".")) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (!/^-?\d+$/.test(s)) return null;
  if (s.length >= 16) return Number(s) / 1e18;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function idOf(row) {
  return String(row?.id ?? row?.orderId ?? row?.hash ?? row?.orderHash ?? row?.order?.hash ?? "");
}

export function orderStatus(order) {
  return String(order?.status ?? order?.state ?? order?.orderStatus ?? "").toUpperCase();
}

export function orderMatches(order, trade) {
  if (!order || !trade) return false;
  const oid = idOf(order);
  const nestedHash = String(order.order?.hash ?? "");
  if (trade.orderId && oid && oid === String(trade.orderId)) return true;
  if (trade.orderHash) {
    const want = String(trade.orderHash);
    if (oid === want || nestedHash === want || String(order.hash ?? "") === want) return true;
  }
  const mid = String(order.marketId ?? order.market_id ?? order.market?.id ?? "");
  const tok = String(order.tokenId ?? order.token_id ?? order.order?.tokenId ?? order.onChainId ?? "");
  if (mid && mid === String(trade.marketId)) {
    if (!trade.tokenId || !tok || tok === String(trade.tokenId)) return true;
  }
  return false;
}

/** USD filled on this order, or null if the row has no fill fields. */
export function orderFilledUsd(order, trade) {
  const st = orderStatus(order);
  const px = num(order.price, order.avgPrice, order.averageBuyPriceUsd, trade?.price) || 0;
  const stake = Number(trade?.stakeUsd) || 0;
  const filledAmt = fromTokenAmount(
    order.amountFilled ?? order.filledUsd ?? order.filledAmountUsd ?? order.filledAmount ?? order.filled,
  );
  if (filledAmt != null) {
    if (filledAmt <= 0) return 0;
    // Share count (1–40) vs USDT notional (~stake).
    if (px > 0 && filledAmt > Math.max(stake * 1.15, 4) && filledAmt <= 40) return filledAmt * px;
    return filledAmt;
  }
  const shares = fromTokenAmount(
    order.filledSize ?? order.filledQuantity ?? order.quantityFilled ?? order.sizeFilled,
  );
  if (shares != null && px > 0) return Math.max(0, shares * px);
  if (FILLED_STATUSES.has(st)) return stake;
  if (TERMINAL_EMPTY.has(st)) return 0;
  return null;
}

export function positionFilledUsd(pos, trade) {
  if (!pos || !trade) return 0;
  const mid = String(pos.marketId ?? pos.market_id ?? pos.market?.id ?? "");
  if (mid && mid !== String(trade.marketId)) return 0;
  const tok = String(
    pos.tokenId ?? pos.token_id ?? pos.onChainId ?? pos.outcomeId ?? pos.outcome?.onChainId ?? "",
  );
  if (trade.tokenId && tok && tok !== String(trade.tokenId)) return 0;
  if (!mid && !tok) return 0;
  const shares = fromTokenAmount(pos.amount ?? pos.size ?? pos.quantity ?? pos.balance ?? pos.shares);
  const avg = num(pos.averageBuyPriceUsd, pos.avgPrice, pos.price, trade.price);
  if (shares != null && shares > 0 && avg != null && avg > 0) return shares * avg;
  const usd = fromTokenAmount(pos.valueUsd);
  if (usd != null && usd > 0 && usd <= Number(trade.stakeUsd) * 3) return Number(trade.stakeUsd);
  return 0;
}

/**
 * @returns {{ filledUsd: number, source: string, confirmed: boolean, status: string }}
 */
export function resolveFilledStake(trade, { orders = [], positions = [] } = {}) {
  if (trade?.dryRun) {
    return { filledUsd: Number(trade.stakeUsd) || 0, source: "sim", confirmed: true, status: "SIM" };
  }
  const orderList = asList(orders);
  const posList = asList(positions);
  const order = orderList.find((o) => orderMatches(o, trade));
  const posUsd = posList.reduce((s, p) => s + positionFilledUsd(p, trade), 0);
  const st = order ? orderStatus(order) : "";

  if (order) {
    const fromOrder = orderFilledUsd(order, trade);
    if (fromOrder != null && fromOrder >= MIN_FILL_USD) {
      const filledUsd = Math.max(fromOrder, posUsd);
      return { filledUsd, source: fromOrder >= posUsd ? "order" : "position", confirmed: true, status: st };
    }
    if (posUsd >= MIN_FILL_USD) {
      return { filledUsd: posUsd, source: "position", confirmed: true, status: st || "POSITION" };
    }
    if (TERMINAL_EMPTY.has(st) && (fromOrder == null || fromOrder < MIN_FILL_USD)) {
      return { filledUsd: 0, source: "order-unfilled", confirmed: true, status: st };
    }
    // OPEN with 0 fill — still resting; do not VOID.
    return { filledUsd: fromOrder ?? 0, source: "order-open", confirmed: false, status: st || "OPEN" };
  }
  if (posUsd >= MIN_FILL_USD) {
    return { filledUsd: posUsd, source: "position", confirmed: true, status: "POSITION" };
  }
  return { filledUsd: 0, source: "missing", confirmed: false, status: "" };
}

export function isDustFill(filledUsd) {
  return !Number.isFinite(filledUsd) || filledUsd < MIN_FILL_USD;
}

/** Only VOID when the venue confirmed the order died with ~0 fill. */
export function shouldVoid(got) {
  if (!got || !got.confirmed) return false;
  if (!isDustFill(got.filledUsd)) return false;
  return TERMINAL_EMPTY.has(String(got.status || "").toUpperCase()) || got.source === "order-unfilled";
}

export { MIN_FILL_USD };
