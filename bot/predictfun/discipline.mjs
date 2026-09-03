/**
 * Indicator gates that replace the old sigma / probability-shrink filters.
 * Direction comes from EMA, RSI, MACD, and order-book imbalance. Spread and
 * volatility spikes are hard vetoes so a wide book cannot look like a signal.
 */

import { config } from "./config.mjs";
import { formatIndicatorLine } from "./indicators.mjs";

function countSide(votes, side) {
  return Object.values(votes).filter((v) => v === side).length;
}

/**
 * @returns {{ skip: string, snapshot?: object } | { skip: null, favored: "UP"|"DOWN", confidence: number, probabilityUp: number, line: string, snapshot: object }}
 */
export function indicatorGate({ snapshot, startPrice, currentPrice, upAsk, downAsk }) {
  const S = config.strategy;
  const line = formatIndicatorLine(snapshot);

  if (snapshot.spreadBps != null && snapshot.spreadBps > S.maxSpreadBps) {
    return {
      skip: `spread ${snapshot.spreadBps.toFixed(1)}bps > ${S.maxSpreadBps}bps (wide Binance book — last price is not trustworthy)`,
      snapshot,
      line,
    };
  }

  const marketSpread = upAsk != null && downAsk != null ? upAsk + downAsk - 1 : 0;
  if (marketSpread > S.maxMarketSpread) {
    return {
      skip: `predict.fun spread ${(marketSpread * 100).toFixed(1)}c > ${(S.maxMarketSpread * 100).toFixed(1)}c`,
      snapshot,
      line,
    };
  }

  if (snapshot.volumeRatio < S.minVolumeRatio) {
    return {
      skip: `volume ${snapshot.volumeRatio.toFixed(2)}x < ${S.minVolumeRatio}x (thin tape)`,
      snapshot,
      line,
    };
  }

  if (snapshot.medianAtrPct > 0 && snapshot.lastRangePct > S.maxAtrMult * snapshot.medianAtrPct) {
    return {
      skip: `range spike ${snapshot.lastRangePct.toFixed(3)}% > ${S.maxAtrMult}× median ${snapshot.medianAtrPct.toFixed(3)}%`,
      snapshot,
      line,
    };
  }

  const upVotes = countSide(snapshot.votes, "UP");
  const downVotes = countSide(snapshot.votes, "DOWN");
  if (upVotes < S.minIndicatorAgree && downVotes < S.minIndicatorAgree) {
    return {
      skip: `indicators mixed (UP ${upVotes} / DOWN ${downVotes}, need ${S.minIndicatorAgree} of EMA/RSI/MACD/BOOK)`,
      snapshot,
      line,
    };
  }

  const favored = upVotes >= downVotes ? "UP" : "DOWN";
  const agree = favored === "UP" ? upVotes : downVotes;
  const strikeSide = currentPrice >= startPrice ? "UP" : "DOWN";
  if (favored !== strikeSide) {
    return {
      skip: `indicators ${favored} fight the strike (${strikeSide} — price vs start); not fading`,
      snapshot,
      line,
      favored,
    };
  }

  const rsiExtreme =
    (favored === "UP" && snapshot.rsi != null && snapshot.rsi >= 65) ||
    (favored === "DOWN" && snapshot.rsi != null && snapshot.rsi <= 35);
  const strongBook =
    snapshot.bookImbalance != null &&
    ((favored === "UP" && snapshot.bookImbalance >= 0.62) ||
      (favored === "DOWN" && snapshot.bookImbalance <= 0.38));

  let confidence = 0.58 + 0.06 * (agree - 3);
  if (rsiExtreme) confidence += 0.06;
  if (strongBook) confidence += 0.06;
  confidence = Math.min(0.82, confidence);

  const extras = (rsiExtreme ? 1 : 0) + (strongBook ? 1 : 0);
  const strength = (agree + extras) / 6;
  const pFavored = 0.5 + 0.18 * strength;
  const probabilityUp = favored === "UP" ? pFavored : 1 - pFavored;

  return {
    skip: null,
    favored,
    confidence,
    probabilityUp,
    agree,
    line,
    snapshot,
  };
}

/**
 * LLM may explain the setup, but it cannot reverse the indicator side
 * and it cannot restore a coin-flip as high conviction.
 */
export function alignWithIndicators(analysis, gate) {
  const rawP = analysis.probabilityUp ?? analysis.probabilityYes;
  const llmSide = rawP >= 0.5 ? "UP" : "DOWN";
  if (llmSide !== gate.favored) {
    return {
      skip: `LLM faded indicators (favored ${gate.favored}, P(Up)=${rawP.toFixed(2)})`,
      probabilityUp: rawP,
      probabilityYes: rawP,
      confidence: gate.confidence,
      rawP,
      reasoning: analysis.reasoning,
    };
  }
  const blended = Math.min(0.68, Math.max(0.32, 0.5 * gate.probabilityUp + 0.5 * rawP));
  const blendedSide = blended >= 0.5 ? "UP" : "DOWN";
  if (blendedSide !== gate.favored) {
    return {
      skip: `blended P(Up)=${blended.toFixed(2)} flipped vs indicator ${gate.favored}`,
      probabilityUp: blended,
      probabilityYes: blended,
      confidence: gate.confidence,
      rawP,
      reasoning: analysis.reasoning,
    };
  }
  if (Math.abs(blended - 0.5) < 0.08) {
    return {
      skip: `blended P(Up)=${blended.toFixed(2)} is a coin flip — no trade`,
      probabilityUp: blended,
      probabilityYes: blended,
      confidence: 0.4,
      rawP,
      reasoning: analysis.reasoning,
    };
  }
  return {
    skip: null,
    probabilityUp: blended,
    probabilityYes: blended,
    confidence: gate.confidence,
    rawP,
    reasoning: analysis.reasoning,
  };
}

/**
 * Ensemble veto from XGBoost / LightGBM / Random Forest / Logistic Regression.
 * Abstain (all FLAT or untrained) does not block. A clear fight vs the
 * indicator lead does.
 */
export function mlEnsembleGate({ votes = {}, favored, minAgree, minProba }) {
  const agreeN = minAgree ?? config.strategy.minMlAgree;
  const names = ["xgboost", "lightgbm", "random_forest", "logistic"];
  let agree = 0;
  let against = 0;
  let ready = 0;
  for (const name of names) {
    const v = votes[name];
    if (!v || !v.ready || v.side === "FLAT") continue;
    ready += 1;
    if (v.side === favored) agree += 1;
    else against += 1;
  }
  const lineBits = names.map((name) => {
    const v = votes[name];
    if (!v || !v.ready) return `${shortMl(name)} —`;
    const pct = v.p == null ? "?" : `${(v.p * 100).toFixed(0)}%`;
    return `${shortMl(name)} ${v.side}(${pct})`;
  });
  const line = `ML ${lineBits.join(" ")}`;
  if (ready === 0) {
    return { skip: null, line, agree, against, ready };
  }
  if (agree >= agreeN && agree > against) {
    return { skip: null, line, agree, against, ready };
  }
  if (against >= agreeN && against > agree) {
    return {
      skip: `ML faded indicators (lead ${favored}, agree ${agree} / against ${against}${minProba ? `, p≥${minProba}` : ""})`,
      line,
      agree,
      against,
      ready,
    };
  }
  return {
    skip: `ML mixed (lead ${favored}, agree ${agree} / against ${against}, need ${agreeN} aligned)`,
    line,
    agree,
    against,
    ready,
  };
}

function shortMl(name) {
  return { xgboost: "XGB", lightgbm: "LGB", random_forest: "RF", logistic: "LR" }[name] ?? name;
}
