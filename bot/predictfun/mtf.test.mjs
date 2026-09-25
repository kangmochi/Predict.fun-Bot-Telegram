import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adx } from "./indicators.mjs";
import { sheetGate, tfBias } from "./mtf.mjs";

function trendKlines({ n = 80, start = 100, step = 0.8, vol = 1000 } = {}) {
  const rows = [];
  let t = Date.UTC(2026, 0, 1);
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p += step;
    rows.push([t, open, p + 0.3, open - 0.05, p, vol + i * 5]);
    t += 60_000;
  }
  return rows;
}

function chopKlines({ n = 80, start = 100 } = {}) {
  const rows = [];
  let t = Date.UTC(2026, 0, 1);
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p += i % 2 === 0 ? 0.15 : -0.15;
    rows.push([t, open, Math.max(open, p) + 0.05, Math.min(open, p) - 0.05, p, 800]);
    t += 60_000;
  }
  return rows;
}

describe("adx", () => {
  it("is high on a strong trend and lower on chop", () => {
    const up = trendKlines({ step: 1.2 });
    const chop = chopKlines();
    const highs = (k) => k.map((r) => r[2]);
    const lows = (k) => k.map((r) => r[3]);
    const closes = (k) => k.map((r) => r[4]);
    const adxUp = adx(highs(up), lows(up), closes(up), 14);
    const adxChop = adx(highs(chop), lows(chop), closes(chop), 14);
    assert.ok(adxUp != null && adxUp > 25, `trend ADX ${adxUp}`);
    assert.ok(adxChop != null && adxChop < adxUp, `chop ${adxChop} vs trend ${adxUp}`);
  });
});

describe("tfBias / sheetGate", () => {
  it("votes UP on a rising 5m series", () => {
    const b = tfBias(trendKlines({ step: 0.6 }), { emaPeriod: 9 });
    assert.equal(b.side, "UP", JSON.stringify(b.votes));
  });

  it("requires 5m=15m=60m and ADX≥20", () => {
    const up = trendKlines({ step: 1.0, n: 80 });
    const out = sheetGate({
      frames: { "5m": up, "15m": up, "60m": up },
      startPrice: 90,
      currentPrice: 170,
      upAsk: 0.48,
      downAsk: 0.52,
      symbol: "BTCUSDT",
    });
    assert.equal(out.skip, null, out.skip);
    assert.equal(out.favored, "UP");
    assert.match(out.line, /MTF 5m UP/);
  });

  it("blocks a fade vs the strike", () => {
    const up = trendKlines({ step: 1.0 });
    const out = sheetGate({
      frames: { "5m": up, "15m": up, "60m": up },
      startPrice: 200,
      currentPrice: 170,
      upAsk: 0.48,
      downAsk: 0.52,
      symbol: "BTCUSDT",
    });
    assert.match(String(out.skip), /not fading/);
  });

  it("blocks mixed timeframes", () => {
    const up = trendKlines({ step: 1.0 });
    const down = trendKlines({ start: 180, step: -0.8 });
    const out = sheetGate({
      frames: { "5m": up, "15m": down, "60m": up },
      startPrice: 90,
      currentPrice: 170,
      upAsk: 0.48,
      downAsk: 0.52,
      symbol: "BTCUSDT",
    });
    assert.match(String(out.skip), /mtf_aligned/);
  });
});
