import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, macd, snapshotFromKlines } from "./indicators.mjs";
import { indicatorGate, alignWithIndicators, mlEnsembleGate } from "./discipline.mjs";
import { config } from "./config.mjs";
import { currentStakes, decideEntry } from "./strategy.mjs";

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
