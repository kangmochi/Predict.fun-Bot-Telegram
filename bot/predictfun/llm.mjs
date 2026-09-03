/**
 * LLM "brain": estimates Up/Down (or YES/NO) probability + confidence.
 *
 * Providers:
 *   - vikey  — OpenAI-compatible API at https://api.vikey.ai/v1 (DeepSeek, GLM, …)
 *   - gemini — Google Generative Language API
 */

import { config, hasLlmKey } from "./config.mjs";

const SYSTEM_PROMPT = `You are a rigorous forecasting analyst for binary prediction markets.
Given a market question, estimate the true probability of the YES outcome.
Rules:
- Base your estimate on well-established facts and base rates. You have no live news access, so widen your uncertainty for fast-moving events.
- confidence expresses how sure you are about your own probability estimate: use LOW confidence (< 0.6) when the outcome depends on information you cannot verify, and HIGH confidence (>= 0.8) only when the estimate rests on solid, stable ground.
- Never anchor on the current market price; it is provided only as context.
- Respond with JSON only.`;

const CRYPTO_SYSTEM_PROMPT = `You are a conservative short-horizon crypto trader analyzing a binary Up/Down market.
The market resolves UP if the close is above the start (strike) price, otherwise DOWN.
Mechanical filters already computed EMA, RSI, MACD, volume, spread, and order-book imbalance.
Your job is to sanity-check those readings, not to invent a new direction.
Rules:
- Follow the indicator lead. If they vote UP, probabilityUp must be >= 0.50; if DOWN, <= 0.50.
- Never fade a clear strike lead just because a cheap underdog ticket looks tempting.
- Wide spread, thin volume, or mixed EMA/RSI/MACD/book = stay near 0.50 with low confidence.
- Do not output a canned 0.74 / 0.60 pair. Stay between 0.32 and 0.68 unless several indicators agree hard.
- Respond with JSON only.`;

function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`LLM did not return JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function clamp01(value, label, raw) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`LLM returned non-numeric ${label}: ${String(raw).slice(0, 200)}`);
  return Math.min(1, Math.max(0, n));
}

async function vikeyRequest(payload) {
  const res = await fetch(`${config.vikeyBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.vikeyApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return { res, json };
}

async function completeVikey({ system, user, temperature }) {
  if (!config.vikeyApiKey) throw new Error("VIKEY_API_KEY is not set");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // Only call the active brain's model — do not silently swap GLM in during
  // a DeepSeek eval (that would contaminate the comparison).
  const attempts = [
    {
      model: config.llmModel,
      temperature,
      max_tokens: 8192,
      thinking: { type: "disabled" },
      extra_body: { thinking: { type: "disabled" } },
      response_format: { type: "json_object" },
      messages,
    },
    {
      model: config.llmModel,
      temperature: 1,
      max_tokens: 24576,
      messages,
    },
  ];

  const errors = [];
  for (const payload of attempts) {
    const { res, json } = await vikeyRequest(payload);
    if (!res.ok) {
      const detail = json.error?.message ?? JSON.stringify(json).slice(0, 180);
      errors.push(`${payload.model} HTTP ${res.status}: ${detail}`);
      continue;
    }
    const text = json.choices?.[0]?.message?.content;
    if (!text) {
      errors.push(`${payload.model}: empty content (thinking ate max_tokens)`);
      continue;
    }
    try {
      return parseJsonObject(text);
    } catch (err) {
      errors.push(`${payload.model}: ${err.message}`);
    }
  }
  throw new Error(`Vikey failed after retries: ${errors.join(" | ")}`);
}

async function completeGemini({ system, user, temperature, schema }) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${json.error?.message ?? "unknown"}`);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content (possibly safety-blocked)");
  return parseJsonObject(text);
}

async function completeJson({ system, user, temperature, schema }) {
  if (!hasLlmKey()) {
    throw new Error(
      config.llmTransport === "vikey" ? "VIKEY_API_KEY is not set" : "GEMINI_API_KEY is not set",
    );
  }
  if (config.llmTransport === "vikey") return completeVikey({ system, user, temperature });
  return completeGemini({ system, user, temperature, schema });
}

/**
 * Analyze one market. Returns { probabilityYes, confidence, reasoning }.
 */
export async function analyzeMarket(market, { yesPrice, noPrice } = {}) {
  const [outcomeA, outcomeB] = market.outcomes ?? [];
  const parts = [
    `Market title: ${market.title}`,
    `Question: ${market.question}`,
    market.description ? `Description: ${market.description.slice(0, 1500)}` : null,
    outcomeA && outcomeB
      ? `The two outcomes are: "${outcomeA.name}" (treat this as YES) and "${outcomeB.name}" (treat this as NO).`
      : null,
    yesPrice !== undefined ? `Current market price for "${outcomeA?.name ?? "YES"}": ${yesPrice}` : null,
    noPrice !== undefined ? `Current market price for "${outcomeB?.name ?? "NO"}": ${noPrice}` : null,
    `Today's date (UTC): ${new Date().toISOString().slice(0, 10)}`,
    `Return JSON: {"probabilityYes": number 0..1, "confidence": number 0..1, "reasoning": string}`,
  ].filter(Boolean);

  const parsed = await completeJson({
    system: SYSTEM_PROMPT,
    user: parts.join("\n"),
    temperature: 0.2,
    schema: {
      type: "object",
      properties: {
        probabilityYes: { type: "number" },
        confidence: { type: "number" },
        reasoning: { type: "string" },
      },
      required: ["probabilityYes", "confidence", "reasoning"],
    },
  });

  return {
    probabilityYes: clamp01(parsed.probabilityYes, "probabilityYes", JSON.stringify(parsed)),
    confidence: clamp01(parsed.confidence, "confidence", JSON.stringify(parsed)),
    reasoning: String(parsed.reasoning ?? ""),
  };
}

/**
 * Analyze a Crypto Up/Down market using live price context.
 * Returns { probabilityUp, confidence, reasoning }.
 */
export async function analyzeCryptoUpDown({ title, startPrice, minutesRemaining, priceCtx, upAsk, downAsk }) {
  const gapPct = ((priceCtx.currentPrice - startPrice) / startPrice) * 100;
  const expectedMovePct = priceCtx.vol1mPct * Math.sqrt(Math.max(minutesRemaining, 0.5));

  const prompt = [
    `Market: ${title}`,
    `Symbol: ${priceCtx.symbol}`,
    `Start (strike) price: ${startPrice}`,
    `Current price: ${priceCtx.currentPrice}  (gap: ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(4)}%)`,
    `Minutes remaining until close: ${minutesRemaining.toFixed(1)}`,
    `Realized 1-minute volatility: ${priceCtx.vol1mPct.toFixed(4)}%`,
    `Expected remaining movement (vol * sqrt(minutes)): ~${expectedMovePct.toFixed(4)}%`,
    `Recent momentum: 5m ${fmtPct(priceCtx.change5mPct)}, 15m ${fmtPct(priceCtx.change15mPct)}, 30m ${fmtPct(priceCtx.change30mPct)}`,
    priceCtx.snapshot
      ? `Indicators: EMA9=${fmtNum(priceCtx.snapshot.emaFast)} EMA21=${fmtNum(priceCtx.snapshot.emaSlow)} RSI=${fmtNum(priceCtx.snapshot.rsi, 1)} MACD hist=${fmtNum(priceCtx.snapshot.macdHist, 4)} vol=${fmtNum(priceCtx.snapshot.volumeRatio, 2)}x spread=${fmtNum(priceCtx.snapshot.spreadBps, 1)}bps book bid share=${fmtNum(priceCtx.snapshot.bookImbalance != null ? priceCtx.snapshot.bookImbalance * 100 : null, 0)}% votes EMA=${priceCtx.snapshot.votes.ema} RSI=${priceCtx.snapshot.votes.rsi} MACD=${priceCtx.snapshot.votes.macd} BOOK=${priceCtx.snapshot.votes.book}`
      : null,
    `Last 1-minute candles (UTC):`,
    ...priceCtx.candleLines,
    upAsk !== undefined ? `Market ask for UP: ${upAsk}` : null,
    downAsk !== undefined ? `Market ask for DOWN: ${downAsk}` : null,
    `Return JSON: {"probabilityUp": number 0..1, "confidence": number 0..1, "reasoning": string}`,
  ].filter(Boolean);

  const parsed = await completeJson({
    system: CRYPTO_SYSTEM_PROMPT,
    user: prompt.join("\n"),
    temperature: 0.1,
    schema: {
      type: "object",
      properties: {
        probabilityUp: { type: "number" },
        confidence: { type: "number" },
        reasoning: { type: "string" },
      },
      required: ["probabilityUp", "confidence", "reasoning"],
    },
  });

  return {
    probabilityUp: clamp01(parsed.probabilityUp, "probabilityUp", JSON.stringify(parsed)),
    confidence: clamp01(parsed.confidence, "confidence", JSON.stringify(parsed)),
    reasoning: String(parsed.reasoning ?? ""),
  };
}

function fmtPct(v) {
  return v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`;
}

function fmtNum(v, digits = 2) {
  return v == null || Number.isNaN(v) ? "n/a" : Number(v).toFixed(digits);
}

export async function probeGemini() {
  if (!config.geminiApiKey) return { ok: false, detail: "GEMINI_API_KEY not set" };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}?key=${config.geminiApiKey}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${json.error?.message ?? "unknown"}` };
    return { ok: true, detail: `model ${json.name ?? config.geminiModel} available` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function probeVikey() {
  if (!config.vikeyApiKey) return { ok: false, detail: "VIKEY_API_KEY not set" };
  try {
    const res = await fetch(`${config.vikeyBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.vikeyApiKey}` },
    });
    const json = await res.json();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${json.error?.message ?? "unknown"}` };
    const ids = (json.data ?? []).map((m) => m.id ?? m.name);
    const wanted = config.llmModel;
    const found = ids.includes(wanted);
    return {
      ok: found || ids.length > 0,
      detail: found
        ? `model ${wanted} available`
        : ids.length
          ? `connected; ${wanted} not in catalog listing (${ids.length} models) — will still try it`
          : "connected but catalog empty",
    };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export async function probeLlm() {
  if (config.llmTransport === "vikey") {
    const r = await probeVikey();
    return { ...r, provider: config.llmProvider, model: config.llmModel };
  }
  const r = await probeGemini();
  return { ...r, provider: "gemini", model: config.geminiModel };
}
