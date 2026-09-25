import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assemblePriceContext,
  cacheSetForTests,
  fetchJson,
  getPriceContext,
  resetPricefeedForTests,
} from "./pricefeed.mjs";

const originalFetch = globalThis.fetch;

function klines(n = 80, start = 100) {
  const rows = [];
  let t = Date.UTC(2026, 8, 22, 12, 0, 0);
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p += 0.15;
    rows.push([t, open, p + 0.05, open - 0.02, p, 1200, t + 59_999]);
    t += 60_000;
  }
  return rows;
}

function jsonRes(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

afterEach(() => {
  resetPricefeedForTests();
  globalThis.fetch = originalFetch;
});

describe("assemblePriceContext", () => {
  it("builds indicators from klines even without a book", () => {
    const ctx = assemblePriceContext("BTCUSDT", klines(), null, null);
    assert.equal(ctx.symbol, "BTCUSDT");
    assert.ok(ctx.currentPrice > 100);
    assert.ok(ctx.snapshot.rsi != null);
    assert.equal(ctx.snapshot.spreadBps, null);
    assert.equal(ctx.snapshot.votes.book, "FLAT");
  });
});

describe("fetchJson", () => {
  it("maps AbortError to timeout", async () => {
    globalThis.fetch = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await assert.rejects(() => fetchJson("https://example.test/x"), /timeout/);
  });
});

describe("getPriceContext", () => {
  it("still returns a snapshot when depth is down", async () => {
    const rows = klines();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/depth")) throw new Error("depth down");
      if (u.includes("/klines")) return jsonRes(rows);
      if (u.includes("/bookTicker")) return jsonRes({ bidPrice: "111.9", askPrice: "112.0" });
      throw new Error(`unexpected ${u}`);
    };
    const ctx = await getPriceContext("BTCUSDT");
    assert.equal(ctx.venue, "binance");
    assert.equal(ctx.fromCache, false);
    assert.ok(ctx.snapshot.spreadBps != null);
    assert.ok(ctx.snapshot.spreadBps < 20);
  });

  it("reuses a warm cache when every host fails", async () => {
    const warm = assemblePriceContext("ETHUSDT", klines(80, 2000), { bidPrice: "2000", askPrice: "2000.2" }, null);
    cacheSetForTests("ETHUSDT", warm, Date.now() - 12_000);
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };
    const ctx = await getPriceContext("ETHUSDT");
    assert.equal(ctx.fromCache, true);
    assert.ok(ctx.cacheAgeSec >= 10);
    assert.equal(ctx.currentPrice, warm.currentPrice);
  });

  it("falls back to Bybit when Binance is down and cache is empty", async () => {
    const rows = klines(80, 400).reverse().map((k) => [k[0], k[1], k[2], k[3], k[4], k[5], "0"]);
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("binance")) throw new Error("fetch failed");
      if (u.includes("bybit.com") && u.includes("/kline")) {
        return jsonRes({ result: { list: rows } });
      }
      if (u.includes("bybit.com") && u.includes("/tickers")) {
        return jsonRes({ result: { list: [{ bid1Price: "411", ask1Price: "411.2" }] } });
      }
      if (u.includes("bybit.com") && u.includes("/orderbook")) {
        return jsonRes({ result: { b: [["411", "2"]], a: [["411.2", "1"]] } });
      }
      throw new Error(`unexpected ${u}`);
    };
    const ctx = await getPriceContext("BNBUSDT");
    assert.equal(ctx.venue, "bybit");
    assert.equal(ctx.fromCache, false);
    assert.ok(ctx.currentPrice > 400);
  });

  it("throws when live, cache, and Bybit all fail", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(() => getPriceContext("BTCUSDT"), /All Binance hosts failed/);
  });
});
