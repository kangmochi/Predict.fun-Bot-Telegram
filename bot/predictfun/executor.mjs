/**
 * Order execution via the official @predictdotfun/sdk.
 * Only loaded in live mode — dry-run never touches the wallet.
 */

import { JsonRpcProvider, Wallet, parseEther, formatEther } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import { config } from "./config.mjs";
import * as api from "./api.mjs";

let builder = null;
let signer = null;
let activeRpcUrl = null;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function rpcCandidates() {
  const urls = Array.isArray(config.bscRpcUrls) && config.bscRpcUrls.length ? config.bscRpcUrls : [config.bscRpcUrl];
  return urls.filter(Boolean);
}

export function walletAddress() {
  if (!config.privateKey) return null;
  return new Wallet(config.privateKey).address;
}

/** The address that acts as maker/signer on orders (smart account if set). */
export function makerAddress() {
  return config.predictAccount || walletAddress();
}

export async function initExecutor({ force = false } = {}) {
  if (builder && !force) return builder;
  if (!config.privateKey) throw new Error("PRIVY_WALLET_PRIVATE_KEY is not set");

  const urls = rpcCandidates();
  const chainId = config.network === "mainnet" ? ChainId.BnbMainnet : ChainId.BnbTestnet;
  let lastErr;
  for (const url of urls) {
    try {
      const provider = new JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
      provider.pollingInterval = 300;
      await withTimeout(provider.getBlockNumber(), 5000, `rpc ${url}`);
      signer = new Wallet(config.privateKey, provider);
      builder = await OrderBuilder.make(
        chainId,
        signer,
        config.predictAccount ? { predictAccount: config.predictAccount } : undefined,
      );
      activeRpcUrl = url;
      return builder;
    } catch (err) {
      lastErr = err;
      builder = null;
      signer = null;
      activeRpcUrl = null;
    }
  }
  throw new Error(`No BSC RPC reachable: ${lastErr?.message || "unknown"}`);
}

/** Sign the predict.fun auth message and obtain a JWT. */
export async function login() {
  await initExecutor();
  const address = makerAddress();
  await api.authenticate(address, async (message) =>
    config.predictAccount ? builder.signPredictAccountMessage(message) : signer.signMessage(message),
  );
  return address;
}

/** Ensure exchange approvals are in place (idempotent, costs gas when unset). */
export async function ensureApprovals() {
  await initExecutor();
  const result = await builder.setApprovals();
  if (!result.success) throw new Error("Failed to set protocol approvals");
}

function serializeOrder(order) {
  const out = {};
  for (const [key, value] of Object.entries(order)) {
    out[key] = typeof value === "bigint" ? value.toString() : value;
  }
  // These fields are numeric in the REST schema
  out.side = Number(order.side);
  out.signatureType = Number(order.signatureType);
  out.expiration = Number(order.expiration);
  return out;
}

/**
 * Place a LIMIT buy at the given price for `stakeUsd` worth of shares.
 * `price` is a probability (0..1); shares = stakeUsd / price.
 */
export async function placeBuyOrder({ market, outcome, price, stakeUsd }) {
  await initExecutor();

  const quantity = stakeUsd / price;
  const { pricePerShare, makerAmount, takerAmount } = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: parseEther(price.toFixed(6)),
    quantityWei: parseEther(quantity.toFixed(6)),
  });

  // With a Predict smart account the SDK sets maker/signer itself; passing
  // them only prints a harmless WARN.
  const orderFields = {
    side: Side.BUY,
    tokenId: outcome.onChainId,
    makerAmount,
    takerAmount,
    nonce: 0n,
    feeRateBps: BigInt(market.feeRateBps ?? 0),
  };
  if (!config.predictAccount) {
    const maker = makerAddress();
    orderFields.maker = maker;
    orderFields.signer = maker;
  }
  const order = builder.buildOrder("LIMIT", orderFields);

  const typedData = builder.buildTypedData(order, {
    isNegRisk: Boolean(market.isNegRisk),
    isYieldBearing: Boolean(market.isYieldBearing),
  });
  const signedOrder = await builder.signTypedDataOrder(typedData);
  const hash = builder.buildTypedDataHash(typedData);
  const payload = {
    order: { ...serializeOrder(signedOrder), hash },
    pricePerShare: pricePerShare.toString(),
    strategy: "LIMIT",
  };

  try {
    const result = await api.createOrder(payload);
    return { orderId: result.orderId, orderHash: result.orderHash };
  } catch (err) {
    // JWT is minted once at process start and expires (~hours). Refresh and
    // retry a single time so a stale session does not drop a live signal.
    if (err.status !== 401) throw err;
    await login();
    const result = await api.createOrder(payload);
    return { orderId: result.orderId, orderHash: result.orderHash };
  }
}

/** USDT balance of the trading account, in USD units. */
export async function collateralBalanceUsd() {
  await initExecutor();
  try {
    const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll");
    return Number(formatEther(wei));
  } catch (firstErr) {
    builder = null;
    signer = null;
    await initExecutor({ force: true });
    try {
      const wei = await withTimeout(builder.balanceOf(), 6000, "bankroll-retry");
      return Number(formatEther(wei));
    } catch (retryErr) {
      throw new Error(`${firstErr.message}; retry ${retryErr.message}`);
    }
  }
}

/** BNB gas balance of the Privy signing wallet. */
export async function gasBalanceBnb() {
  await initExecutor();
  const wei = await signer.provider.getBalance(signer.address);
  return Number(formatEther(wei));
}
