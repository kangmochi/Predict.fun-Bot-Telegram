import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, macd, snapshotFromKlines } from "./indicators.mjs";
import { indicatorGate, alignWithIndicators, mlEnsembleGate } from "./discipline.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.mjs";
import { appendTradeLog, currentStakes, decideEntry } from "./strategy.mjs";
import { isDustFill, resolveFilledStake, shouldVoid } from "./fills.mjs";

function trendKlines({ n = 80, start = 100, step = 0.2, vol = 1000, lastVol = 1500 } = {}) {
  const rows = [];
  let t = Date.UTC(2026, 0, 1);
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p += step;
    const close = p;
    const high = Math.max(open, close) + 0.04;
    const low = Math.min(open, close) - 0.01;
    rows.push([t, open, high, low, close, i === n - 1 ? lastVol : vol]);
    t += 60_000;
  }
  return rows;
}

const tightBook = { bid: 115.9, ask: 116.0, bidVol: 800_000, askVol: 400_000 };

describe("indicator math", () => {
  it("EMA follows a rising series above a falling one", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    assert.ok(ema(up, 9) > ema(up, 21));
  });

  it("RSI is high on a straight uptrend and low on a downtrend", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 140 - i);
    assert.ok(rsi(up) > 70);
    assert.ok(rsi(down) < 30);
  });

  it("MACD histogram is positive on a late uptrend", () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i * 0.3);
    const m = macd(up);
    assert.ok(m.hist > 0);
    assert.ok(m.macd > m.signal);
  });
});

describe("indicatorGate", () => {
  it("votes UP on a strong 1m uptrend with bid-heavy book", () => {
    const klines = trendKlines();
    const snapshot = snapshotFromKlines(klines, tightBook);
    const close = snapshot.close;
    const gate = indicatorGate({
      snapshot,
      startPrice: close * 0.997,
      currentPrice: close,
      upAsk: 0.48,
      downAsk: 0.52,
    });
    assert.equal(gate.skip, null, gate.skip);
    assert.equal(gate.favored, "UP");
    assert.ok(gate.confidence >= 0.58);
  });

  it("skips a wide Binance spread even if the trend is clean", () => {
    const snapshot = snapshotFromKlines(trendKlines(), {
      bid: 100,
      ask: 100.3,
      bidVol: 800_000,
      askVol: 400_000,
    });
    const gate = indicatorGate({
      snapshot,
      startPrice: snapshot.close * 0.997,
      currentPrice: snapshot.close,
      upAsk: 0.48,
      downAsk: 0.52,
    });
    assert.ok(gate.skip);
    assert.match(gate.skip, /spread/);
  });

  it("skips when indicators fight the strike instead of fading it", () => {
    const snapshot = snapshotFromKlines(trendKlines(), tightBook);
    const gate = indicatorGate({
      snapshot,
      startPrice: snapshot.close * 1.01,
      currentPrice: snapshot.close,
      upAsk: 0.48,
      downAsk: 0.52,
    });
    assert.ok(gate.skip);
    assert.match(gate.skip, /fight the strike/);
  });

  it("skips mixed / choppy votes", () => {
    const chop = [];
    let t = Date.UTC(2026, 0, 1);
    let p = 100;
    for (let i = 0; i < 80; i++) {
      const open = p;
      p += i % 2 === 0 ? 0.4 : -0.4;
      chop.push([t, open, Math.max(open, p) + 0.1, Math.min(open, p) - 0.1, p, 1000]);
      t += 60_000;
    }
    const snapshot = snapshotFromKlines(chop, { bid: 100, ask: 100.01, bidVol: 500, askVol: 500 });
    const gate = indicatorGate({
      snapshot,
      startPrice: snapshot.close,
      currentPrice: snapshot.close,
      upAsk: 0.5,
      downAsk: 0.5,
    });
    assert.ok(gate.skip);
    assert.match(gate.skip, /mixed|fight the strike|thin/);
  });
});

describe("alignWithIndicators", () => {
  it("rejects an LLM that fades the indicator lead", () => {
    const out = alignWithIndicators(
      { probabilityUp: 0.31, confidence: 0.8, reasoning: "fade" },
      { favored: "UP", probabilityUp: 0.62, confidence: 0.7 },
    );
    assert.ok(out.skip);
    assert.match(out.skip, /faded indicators/);
  });
});

describe("currentStakes compounds off live USDT", () => {
  const S = config.strategy;
  const snapshot = {
    bankrollLive: S.bankrollLive,
    liveBankrollUsd: S.liveBankrollUsd,
    bankrollUsd: S.bankrollUsd,
    baseStakeUsd: S.baseStakeUsd,
    baseStakePct: S.baseStakePct,
    highConfStakePct: S.highConfStakePct,
    maxStakeUsd: S.maxStakeUsd,
  };

  function restore() {
    Object.assign(S, snapshot);
  }

  it("sizes 4% / 5% of a ~$40 wallet and respects the $5 cap", () => {
    try {
      S.bankrollLive = true;
      S.liveBankrollUsd = 40.65;
      S.baseStakeUsd = 1.5;
      S.baseStakePct = 4;
      S.highConfStakePct = 5;
      S.maxStakeUsd = 5;
      const stakes = currentStakes();
      assert.equal(stakes.live, true);
      assert.equal(stakes.bankroll, 40.65);
      assert.ok(Math.abs(stakes.base - 1.626) < 0.001, `base ${stakes.base}`);
      assert.ok(Math.abs(stakes.high - 2.0325) < 0.001, `high ${stakes.high}`);
    } finally {
      restore();
    }
  });

  it("grows the ticket after the wallet grows (compounding)", () => {
    try {
      S.bankrollLive = true;
      S.baseStakeUsd = 1.5;
      S.baseStakePct = 4;
      S.highConfStakePct = 5;
      S.maxStakeUsd = 5;
      S.liveBankrollUsd = 40.65;
      const before = currentStakes();
      S.liveBankrollUsd = 50;
      const after = currentStakes();
      assert.ok(after.base > before.base, `base ${before.base} → ${after.base}`);
      assert.ok(after.high > before.high, `high ${before.high} → ${after.high}`);
    } finally {
      restore();
    }
  });

  it("does not stake more than 90% of a tiny live wallet", () => {
    try {
      S.bankrollLive = true;
      S.liveBankrollUsd = 1.2;
      S.baseStakeUsd = 1.5;
      S.baseStakePct = 4;
      S.highConfStakePct = 5;
      S.maxStakeUsd = 5;
      const stakes = currentStakes();
      assert.ok(stakes.base <= 1.2 * 0.9 + 1e-9, `base ${stakes.base}`);
      assert.ok(stakes.high <= 1.2 * 0.9 + 1e-9, `high ${stakes.high}`);
    } finally {
      restore();
    }
  });

  it("falls back to BANKROLL_USD when live has not been fetched yet", () => {
    try {
      S.bankrollLive = true;
      S.liveBankrollUsd = null;
      S.bankrollUsd = 34;
      S.baseStakeUsd = 1.5;
      S.maxStakeUsd = 5;
      const stakes = currentStakes();
      assert.equal(stakes.live, false);
      assert.equal(stakes.bankroll, 34);
      assert.equal(stakes.base, 1.5);
    } finally {
      restore();
    }
  });
});

describe("decideEntry never fades the crypto leader", () => {
  it("refuses a 5¢ UP ticket when price is already below the strike", () => {
    const decision = decideEntry(
      { probabilityYes: 0.37, confidence: 0.72, favored: "DOWN" },
      { yesAsk: 0.07, noAsk: 0.93 },
    );
    assert.ok(decision.skip, `expected skip, got ${JSON.stringify(decision)}`);
    assert.match(decision.skip, /will not fade/);
  });

  it("buys the leader when it is still reasonably priced", () => {
    const decision = decideEntry(
      { probabilityYes: 0.62, confidence: 0.68, favored: "UP" },
      { yesAsk: 0.5, noAsk: 0.5 },
    );
    assert.equal(decision.skip, undefined);
    assert.equal(decision.side, "YES");
    assert.ok(decision.edge >= 0.08);
    assert.notEqual(decision.tier, "cheap");
  });
});

describe("decideEntry sizes up a cheap locked leader", () => {
  const S = config.strategy;
  const snapshot = {
    bankrollLive: S.bankrollLive,
    liveBankrollUsd: S.liveBankrollUsd,
    cheapEdge: S.cheapEdge,
    cheapAskMax: S.cheapAskMax,
    cheapEdgeMin: S.cheapEdgeMin,
    cheapEdgeStakePct: S.cheapEdgeStakePct,
    cheapTakeCents: S.cheapTakeCents,
    maxStakeUsd: S.maxStakeUsd,
    baseStakeUsd: S.baseStakeUsd,
    baseStakePct: S.baseStakePct,
    highConfStakePct: S.highConfStakePct,
  };

  function restore() {
    Object.assign(S, snapshot);
  }

  it("takes +1¢ and 12% size on a 12.8¢ UP gift", () => {
    try {
      S.bankrollLive = true;
      S.liveBankrollUsd = 96.62;
      S.baseStakeUsd = 5;
      S.baseStakePct = 4;
      S.highConfStakePct = 5;
      S.maxStakeUsd = 25;
      S.cheapEdge = true;
      S.cheapAskMax = 0.3;
      S.cheapEdgeMin = 0.2;
      S.cheapEdgeStakePct = 12;
      S.cheapTakeCents = 0.01;
      const decision = decideEntry(
        { probabilityYes: 0.6, confidence: 0.64, favored: "UP" },
        { yesAsk: 0.128, noAsk: 0.88 },
      );
      assert.equal(decision.skip, undefined, decision.skip);
      assert.equal(decision.side, "YES");
      assert.equal(decision.tier, "cheap");
      assert.equal(decision.ask, 0.128);
      assert.equal(decision.price, 0.138);
      assert.ok(Math.abs(decision.stakeUsd - 11.59) < 0.02, `stake ${decision.stakeUsd}`);
    } finally {
      restore();
    }
  });

  it("does not treat a 50¢ leader as cheap-edge", () => {
    try {
      S.cheapEdge = true;
      const decision = decideEntry(
        { probabilityYes: 0.62, confidence: 0.68, favored: "UP" },
        { yesAsk: 0.5, noAsk: 0.5 },
      );
      assert.equal(decision.skip, undefined, decision.skip);
      assert.notEqual(decision.tier, "cheap");
      assert.equal(decision.price, 0.5);
    } finally {
      restore();
    }
  });
});

describe("mlEnsembleGate", () => {
  const up = (p) => ({ side: "UP", p, ready: true });
  const down = (p) => ({ side: "DOWN", p, ready: true });
  const flat = (p) => ({ side: "FLAT", p, ready: true });

  it("passes when two models agree with the indicator lead", () => {
    const gate = mlEnsembleGate({
      favored: "UP",
      minAgree: 2,
      votes: { xgboost: up(0.62), lightgbm: up(0.58), random_forest: flat(0.51), logistic: flat(0.5) },
    });
    assert.equal(gate.skip, null, gate.skip);
  });

  it("skips when the ensemble fades the indicator lead", () => {
    const gate = mlEnsembleGate({
      favored: "UP",
      minAgree: 2,
      votes: { xgboost: down(0.38), lightgbm: down(0.41), random_forest: flat(0.5), logistic: flat(0.5) },
    });
    assert.ok(gate.skip);
    assert.match(gate.skip, /faded indicators/);
  });

  it("does not block when every model abstains", () => {
    const gate = mlEnsembleGate({
      favored: "DOWN",
      minAgree: 2,
      votes: { xgboost: flat(0.5), lightgbm: flat(0.52), random_forest: flat(0.49), logistic: flat(0.51) },
    });
    assert.equal(gate.skip, null, gate.skip);
  });
});

describe("trade log", () => {
  it("appends one JSON line per settled trade and keeps the entry context", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-tradelog-"));
    const file = path.join(dir, "nested", "trades.jsonl");
    const row = {
      marketId: "1",
      side: "UP",
      price: 0.48,
      won: true,
      pnlUsd: 3.79,
      entry: { asset: "BTCUSDT", horizonMin: 5, features: { gap_pct: 0.12 }, mlVotes: { xgboost: 0.61 } },
    };
    assert.equal(appendTradeLog(row, file), true);
    assert.equal(appendTradeLog({ ...row, marketId: "2", won: false, pnlUsd: -3.5 }, file), true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.entry.features.gap_pct, 0.12);
    assert.equal(first.entry.mlVotes.xgboost, 0.61);
    assert.equal(JSON.parse(lines[1]).won, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false instead of throwing when the log cannot be written", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-tradelog-"));
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    assert.equal(appendTradeLog({ marketId: "x" }, path.join(blocker, "trades.jsonl")), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled by an empty path", () => {
    assert.equal(appendTradeLog({ marketId: "x" }, ""), false);
  });
});

describe("unfilled LIMIT does not become PnL", () => {
  const trade = {
    marketId: "m1",
    orderId: "o1",
    orderHash: "h1",
    tokenId: "tok-up",
    side: "UP",
    price: 0.52,
    stakeUsd: 3.25,
  };

  it("treats 0/6.25 filled as dust", () => {
    const got = resolveFilledStake(trade, {
      orders: [{ id: "o1", marketId: "m1", status: "LIVE", filled: 0, price: 0.52 }],
    });
    assert.equal(got.filledUsd, 0);
    assert.equal(isDustFill(got.filledUsd), true);
  });

  it("books a full fill from FILLED status", () => {
    const got = resolveFilledStake(trade, {
      orders: [{ orderId: "o1", status: "FILLED", filled: 6.25, price: 0.52 }],
    });
    assert.ok(Math.abs(got.filledUsd - 3.25) < 0.01, got.filledUsd);
    assert.equal(isDustFill(got.filledUsd), false);
  });

  it("scales a partial fill", () => {
    const got = resolveFilledStake(trade, {
      orders: [{ id: "o1", filledSize: 2.5, price: 0.52 }],
    });
    assert.ok(Math.abs(got.filledUsd - 1.3) < 0.01, got.filledUsd);
  });

  it("uses a matching position when the order row is gone", () => {
    const got = resolveFilledStake(trade, {
      orders: [],
      positions: [{ marketId: "m1", tokenId: "tok-up", amount: 6.25, price: 0.52 }],
    });
    assert.ok(Math.abs(got.filledUsd - 3.25) < 0.01, got.filledUsd);
  });

  it("does not void a dry-run", () => {
    const got = resolveFilledStake({ ...trade, dryRun: true }, { orders: [], positions: [] });
    assert.equal(got.filledUsd, 3.25);
    assert.equal(got.source, "sim");
  });

  it("reads Predict FILLED amountFilled in USDT wei", () => {
    const got = resolveFilledStake(trade, {
      orders: [{
        id: "o1",
        marketId: "m1",
        status: "FILLED",
        amount: "3250000000000000000",
        amountFilled: "3270000000000000000",
        order: { hash: "h1", tokenId: "tok-up" },
      }],
    });
    assert.equal(got.confirmed, true);
    assert.equal(shouldVoid(got), false);
    assert.ok(Math.abs(got.filledUsd - 3.27) < 0.02, got.filledUsd);
  });

  it("voids only INVALIDATED/EXPIRED with ~0 fill", () => {
    const got = resolveFilledStake(trade, {
      orders: [{ id: "o1", status: "INVALIDATED", amountFilled: "0", order: { hash: "h1" } }],
    });
    assert.equal(got.confirmed, true);
    assert.equal(got.filledUsd, 0);
    assert.equal(shouldVoid(got), true);
  });

  it("does not void when the OPEN list is empty (fill lives under FILLED/hash)", () => {
    const got = resolveFilledStake(trade, { orders: [], positions: [] });
    assert.equal(got.confirmed, false);
    assert.equal(got.source, "missing");
    assert.equal(shouldVoid(got), false);
  });

  it("uses Predict position amount wei × averageBuyPriceUsd", () => {
    const got = resolveFilledStake(trade, {
      orders: [],
      positions: [{
        market: { id: "m1", title: "Bitcoin 9AM ET" },
        outcome: { name: "Up", onChainId: "tok-up" },
        amount: "6390000000000000000",
        averageBuyPriceUsd: "0.52",
        valueUsd: "6.33",
      }],
    });
    assert.equal(got.confirmed, true);
    assert.ok(Math.abs(got.filledUsd - 3.3228) < 0.02, got.filledUsd);
  });
});
