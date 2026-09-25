#!/usr/bin/env node
/**
 * Predict Telegram Bot
 * --------------------
 * Telegram bot that reports live data from the PancakeSwap Prediction V2
 * contract on BNB Chain (BSC) mainnet: current round, BNB/USD oracle price,
 * pool sizes, and payout multipliers. Read-only — it never places bets.
 *
 * Usage:
 *   node bot/predict-telegram-bot.mjs --check   Run diagnostics (env, RPC, contracts, Telegram)
 *   node bot/predict-telegram-bot.mjs           Start the bot (long polling)
 *
 * Environment variables (see .env.example):
 *   TELEGRAM_BOT_TOKEN  Bot token from @BotFather. Optional for --check.
 *   BSC_RPC_URL         BSC mainnet RPC endpoint. Defaults to a public node.
 */

import { ethers } from "ethers";
import process from "node:process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_RPC_URLS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://rpc.ankr.com/bsc",
  "https://binance.llamarpc.com",
];

const BSC_CHAIN_ID = 56n;

// PancakeSwap Prediction V2 (BNB/USD) on BSC mainnet
const PREDICTION_ADDRESS = "0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA";
// Chainlink BNB/USD price feed on BSC mainnet
const ORACLE_ADDRESS = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";

const PREDICTION_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function paused() view returns (bool)",
  "function minBetAmount() view returns (uint256)",
  "function intervalSeconds() view returns (uint256)",
  "function treasuryFee() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)",
];

const ORACLE_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  rpcUrls: process.env.BSC_RPC_URL
    ? [process.env.BSC_RPC_URL, ...DEFAULT_RPC_URLS]
    : DEFAULT_RPC_URLS,
};

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

async function connectProvider() {
  const errors = [];
  for (const url of config.rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, {
        staticNetwork: ethers.Network.from(Number(BSC_CHAIN_ID)),
      });
      const network = await provider.getNetwork();
      if (network.chainId !== BSC_CHAIN_ID) {
        throw new Error(`unexpected chainId ${network.chainId}`);
      }
      return { provider, url };
    } catch (err) {
      errors.push(`${url}: ${err.message ?? err}`);
    }
  }
  throw new Error(`No BSC RPC endpoint reachable:\n  ${errors.join("\n  ")}`);
}

function formatBnb(wei) {
  return `${Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 })} BNB`;
}

function formatUsd(answer, decimals) {
  const value = Number(answer) / 10 ** Number(decimals);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function payoutMultiplier(total, side) {
  if (side === 0n) return "—";
  return `${(Number(total) / Number(side)).toFixed(2)}x`;
}

function secondsUntil(tsSeconds) {
  return Number(tsSeconds) - Math.floor(Date.now() / 1000);
}

async function fetchRoundSummary(provider) {
  const prediction = new ethers.Contract(PREDICTION_ADDRESS, PREDICTION_ABI, provider);
  const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, provider);

  const [epoch, paused, minBet, interval, oracleData, oracleDecimals] = await Promise.all([
    prediction.currentEpoch(),
    prediction.paused(),
    prediction.minBetAmount(),
    prediction.intervalSeconds(),
    oracle.latestRoundData(),
    oracle.decimals(),
  ]);

  const round = await prediction.rounds(epoch);
  return { epoch, paused, minBet, interval, round, oracleData, oracleDecimals };
}

function renderRoundMessage(s) {
  const lockIn = secondsUntil(s.round.lockTimestamp);
  const lines = [
    `🔮 PancakeSwap Prediction — round #${s.epoch}`,
    ``,
    `BNB/USD: ${formatUsd(s.oracleData.answer, s.oracleDecimals)} (Chainlink)`,
    `Status: ${s.paused ? "⏸ paused" : "▶️ live"} · lock ${lockIn > 0 ? `in ${lockIn}s` : `${-lockIn}s ago`}`,
    ``,
    `Pool: ${formatBnb(s.round.totalAmount)}`,
    `  ⬆️ UP   ${formatBnb(s.round.bullAmount)} (payout ${payoutMultiplier(s.round.totalAmount, s.round.bullAmount)})`,
    `  ⬇️ DOWN ${formatBnb(s.round.bearAmount)} (payout ${payoutMultiplier(s.round.totalAmount, s.round.bearAmount)})`,
    ``,
    `Min bet: ${formatBnb(s.minBet)} · round length: ${Number(s.interval) / 60} min`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Telegram (raw Bot API over fetch — no extra dependency)
// ---------------------------------------------------------------------------

async function tg(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

const HELP_TEXT = [
  "Available commands:",
  "/round — current prediction round (pool, payouts, lock time)",
  "/price — latest BNB/USD price from Chainlink",
  "/help — this message",
].join("\n");

async function handleCommand(provider, text) {
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase();
  switch (cmd) {
    case "/start":
      return `Hi! I report live PancakeSwap Prediction data from BNB Chain mainnet.\n\n${HELP_TEXT}`;
    case "/help":
      return HELP_TEXT;
    case "/round": {
      const summary = await fetchRoundSummary(provider);
      return renderRoundMessage(summary);
    }
    case "/price": {
      const oracle = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, provider);
      const [data, decimals] = await Promise.all([oracle.latestRoundData(), oracle.decimals()]);
      const age = Math.floor(Date.now() / 1000) - Number(data.updatedAt);
      return `BNB/USD: ${formatUsd(data.answer, decimals)} (updated ${age}s ago)`;
    }
    default:
      return null;
  }
}

async function runBot() {
  if (!config.telegramToken) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set. Get a token from @BotFather and export it,\n" +
        "or run with --check to test everything except Telegram delivery.",
    );
    process.exit(1);
  }

  const me = await tg("getMe");
  const { provider, url } = await connectProvider();
  console.log(`Connected to BSC mainnet via ${url}`);
  console.log(`Bot @${me.username} is polling for messages. Press Ctrl+C to stop.`);

  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", { offset, timeout: 30 });
    } catch (err) {
      console.error(`getUpdates error, retrying in 5s: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text) continue;
      try {
        const reply = await handleCommand(provider, msg.text);
        if (reply) await tg("sendMessage", { chat_id: msg.chat.id, text: reply });
      } catch (err) {
        console.error(`Failed to handle "${msg.text}": ${err.message}`);
        await tg("sendMessage", {
          chat_id: msg.chat.id,
          text: "Sorry, something went wrong fetching on-chain data. Try again shortly.",
        }).catch(() => {});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// --check mode: diagnostics
// ---------------------------------------------------------------------------

const PASS = "✅";
const WARN = "⚠️";
const FAIL = "❌";

async function runCheck() {
  console.log("predict-telegram-bot — diagnostics (--check)\n");
  let failed = false;

  // 1. Runtime
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) {
    console.log(`${PASS} Node.js ${process.version} (>= 18 required)`);
  } else {
    console.log(`${FAIL} Node.js ${process.version} — version 18+ required`);
    failed = true;
  }

  // 2. Environment
  if (config.telegramToken) {
    console.log(`${PASS} TELEGRAM_BOT_TOKEN is set`);
  } else {
    console.log(`${WARN} TELEGRAM_BOT_TOKEN not set — bot cannot go live, chain checks still run`);
  }
  console.log(
    process.env.BSC_RPC_URL
      ? `${PASS} BSC_RPC_URL set: ${process.env.BSC_RPC_URL}`
      : `${WARN} BSC_RPC_URL not set — falling back to public BSC endpoints`,
  );

  // 3. Mainnet RPC
  let provider = null;
  try {
    const conn = await connectProvider();
    provider = conn.provider;
    const [network, block] = await Promise.all([conn.provider.getNetwork(), conn.provider.getBlockNumber()]);
    console.log(`${PASS} BSC mainnet RPC reachable via ${conn.url} (chainId ${network.chainId}, block ${block})`);
  } catch (err) {
    console.log(`${FAIL} Cannot reach BSC mainnet: ${err.message}`);
    failed = true;
  }

  // 4. On-chain contracts
  if (provider) {
    try {
      const s = await fetchRoundSummary(provider);
      console.log(
        `${PASS} Prediction contract OK — round #${s.epoch}, ${s.paused ? "paused" : "live"}, ` +
          `pool ${formatBnb(s.round.totalAmount)}, min bet ${formatBnb(s.minBet)}`,
      );
      const age = Math.floor(Date.now() / 1000) - Number(s.oracleData.updatedAt);
      console.log(
        `${PASS} Chainlink oracle OK — BNB/USD ${formatUsd(s.oracleData.answer, s.oracleDecimals)} (updated ${age}s ago)`,
      );
    } catch (err) {
      console.log(`${FAIL} Contract read failed: ${err.message}`);
      failed = true;
    }
  }

  // 5. Telegram API
  if (config.telegramToken) {
    try {
      const me = await tg("getMe");
      console.log(`${PASS} Telegram token valid — bot @${me.username}`);
    } catch (err) {
      console.log(`${FAIL} Telegram check failed: ${err.message}`);
      failed = true;
    }
  } else {
    console.log(`${WARN} Telegram check skipped (no token)`);
  }

  console.log(failed ? "\nResult: FAIL — fix the items marked ❌ above." : "\nResult: OK — all critical checks passed.");
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  runCheck().catch((err) => {
    console.error(`${FAIL} Unexpected error: ${err.message}`);
    process.exit(1);
  });
} else {
  runBot().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
