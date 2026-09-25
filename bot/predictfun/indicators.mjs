/**
 * Mechanical crypto indicators from OHLCV + Binance book.
 * No third-party indicator API — everything is computed locally.
 */

function sma(values, period) {
  if (!period || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values, period) {
  const series = emaSeries(values, period);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Average True Range as a percent of last close. */
export function atrPct(highs, lows, closes, period = 14) {
  if (!closes.length || closes.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < closes.length; i++) {
    ranges.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  const avg = sma(ranges, Math.min(period, ranges.length));
  const close = closes[closes.length - 1];
  if (avg == null || !close) return null;
  return (avg / close) * 100;
}

/**
 * Wilder ADX (default 14). Needs ~2×period bars. Null if the series is too short.
 */
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2) return null;
  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  if (tr.length < period * 2 - 1) return null;
  let atr = 0;
  let p = 0;
  let m = 0;
  for (let i = 0; i < period; i++) {
    atr += tr[i];
    p += plusDM[i];
    m += minusDM[i];
  }
  const dxs = [];
  for (let i = period; i < tr.length; i++) {
    atr = atr - atr / period + tr[i];
    p = p - p / period + plusDM[i];
    m = m - m / period + minusDM[i];
    const plusDI = atr > 0 ? (100 * p) / atr : 0;
    const minusDI = atr > 0 ? (100 * m) / atr : 0;
    const den = plusDI + minusDI;
    dxs.push(den > 0 ? (100 * Math.abs(plusDI - minusDI)) / den : 0);
  }
  if (dxs.length < period) return null;
  let val = 0;
  for (let i = 0; i < period; i++) val += dxs[i];
  val /= period;
  for (let i = period; i < dxs.length; i++) val = (val * (period - 1) + dxs[i]) / period;
  return val;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastE[i] != null && slowE[i] != null) macdLine.push(fastE[i] - slowE[i]);
  }
  if (macdLine.length < signalPeriod) return { macd: null, signal: null, hist: null };
  const signalSeries = emaSeries(macdLine, signalPeriod);
  const last = macdLine.length - 1;
  const signal = signalSeries[last];
  if (signal == null) return { macd: null, signal: null, hist: null };
  return { macd: macdLine[last], signal, hist: macdLine[last] - signal };
}

function trueRange(h, l, prevClose) {
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function voteEma(close, emaFast, emaSlow) {
  if (emaFast == null || emaSlow == null) return "FLAT";
  if (close > emaFast && emaFast > emaSlow) return "UP";
  if (close < emaFast && emaFast < emaSlow) return "DOWN";
  return "FLAT";
}

function voteRsi(value, rsiUp, rsiDown) {
  if (value == null) return "FLAT";
  if (value >= rsiUp) return "UP";
  if (value <= rsiDown) return "DOWN";
  return "FLAT";
}

function voteMacd({ macd: line, signal, hist }) {
  if (line == null || signal == null || hist == null) return "FLAT";
  if (hist > 0 && line > signal) return "UP";
  if (hist < 0 && line < signal) return "DOWN";
  return "FLAT";
}

function voteBook(imbalance, upThresh, downThresh) {
  if (imbalance == null) return "FLAT";
  if (imbalance >= upThresh) return "UP";
  if (imbalance <= downThresh) return "DOWN";
  return "FLAT";
}

/**
 * Build a full indicator snapshot from Binance-style klines
 * `[openTime, open, high, low, close, volume, ...]` plus optional book.
 */
export function snapshotFromKlines(klines, book = {}, opts = {}) {
  const emaFastN = opts.emaFast ?? 9;
  const emaSlowN = opts.emaSlow ?? 21;
  const rsiUp = opts.rsiUp ?? 55;
  const rsiDown = opts.rsiDown ?? 45;
  const bookUp = opts.bookImbalanceUp ?? 0.55;
  const bookDown = opts.bookImbalanceDown ?? 0.45;

  const opens = klines.map((k) => Number(k[1]));
  const highs = klines.map((k) => Number(k[2]));
  const lows = klines.map((k) => Number(k[3]));
  const closes = klines.map((k) => Number(k[4]));
  const volumes = klines.map((k) => Number(k[5]));
  const close = closes[closes.length - 1];

  const emaFast = ema(closes, emaFastN);
  const emaSlow = ema(closes, emaSlowN);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const closedVols = volumes.length > 1 ? volumes.slice(0, -1) : volumes;
  const avgVol = sma(closedVols.slice(0, -1), Math.min(20, closedVols.length - 1));
  const lastClosedVol = closedVols[closedVols.length - 1];
  const volumeRatio = avgVol > 0 ? lastClosedVol / avgVol : 1;

  const ranges = [];
  for (let i = 1; i < klines.length; i++) {
    ranges.push(trueRange(highs[i], lows[i], closes[i - 1]));
  }
  const lastRange = ranges[ranges.length - 1] ?? 0;
  const medianRange = median(ranges.slice(-30));
  const atrPct = close > 0 ? (sma(ranges, Math.min(14, ranges.length)) / close) * 100 : 0;
  const lastRangePct = close > 0 ? (lastRange / close) * 100 : 0;
  const medianAtrPct = close > 0 ? (medianRange / close) * 100 : 0;

  const bid = Number(book.bid);
  const ask = Number(book.ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : close;
  const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : null;

  const bidVol = Number(book.bidVol);
  const askVol = Number(book.askVol);
  const bookDen = bidVol + askVol;
  const bookImbalance = bookDen > 0 ? bidVol / bookDen : null;

  const votes = {
    ema: voteEma(close, emaFast, emaSlow),
    rsi: voteRsi(rsiVal, rsiUp, rsiDown),
    macd: voteMacd(macdVal),
    book: voteBook(bookImbalance, bookUp, bookDown),
  };

  return {
    close,
    emaFast,
    emaSlow,
    rsi: rsiVal,
    macd: macdVal.macd,
    macdSignal: macdVal.signal,
    macdHist: macdVal.hist,
    volumeRatio,
    atrPct,
    lastRangePct,
    medianAtrPct,
    spreadBps,
    bookImbalance,
    votes,
    opens,
    highs,
    lows,
    closes,
    volumes,
  };
}

export function formatIndicatorLine(snap) {
  const v = snap.votes;
  const rsi = snap.rsi == null ? "?" : snap.rsi.toFixed(0);
  const macdH = snap.macdHist == null ? "?" : (snap.macdHist >= 0 ? "+" : "") + snap.macdHist.toFixed(4);
  const book = snap.bookImbalance == null ? "?" : `${(snap.bookImbalance * 100).toFixed(0)}%bid`;
  const spread = snap.spreadBps == null ? "?" : `${snap.spreadBps.toFixed(1)}bps`;
  return (
    `EMA ${v.ema} RSI ${v.rsi}(${rsi}) MACD ${v.macd}(${macdH}) ` +
    `BOOK ${v.book}(${book}) vol ${snap.volumeRatio.toFixed(2)}x spread ${spread}`
  );
}
