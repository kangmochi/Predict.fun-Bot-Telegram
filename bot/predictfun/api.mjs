/**
 * Thin REST client for the predict.fun API (https://dev.predict.fun).
 *
 * Mainnet requires an API key (x-api-key header); testnet does not.
 * Personal operations (orders, positions) additionally require a JWT obtained
 * by signing an auth message with the wallet.
 */

import { config } from "./config.mjs";

let jwt = null;

function headers(withAuth = false) {
  const h = { "content-type": "application/json" };
  if (config.predictApiKey) h["x-api-key"] = config.predictApiKey;
  if (withAuth) {
    if (!jwt) throw new Error("Not authenticated: call authenticate() first");
    h.authorization = `Bearer ${jwt}`;
  }
  return h;
}

async function request(method, path, { body, auth = false } = {}) {
  const res = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: headers(auth),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.message ?? text.slice(0, 300);
    const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Authenticate the wallet and store the JWT for subsequent personal calls.
 * `signMessage` is an async (message: string) => signature function so the
 * caller decides how to sign (plain EOA vs Predict smart account via SDK).
 */
export async function authenticate(signerAddress, signMessage) {
  const msgRes = await request("GET", "/v1/auth/message");
  const message = msgRes.data?.message ?? msgRes.data;
  if (typeof message !== "string") throw new Error("Unexpected /v1/auth/message response shape");

  const signature = await signMessage(message);
  const authRes = await request("POST", "/v1/auth", {
    body: { signer: signerAddress, signature, message },
  });
  jwt = authRes.data?.token ?? authRes.data?.jwt ?? authRes.data;
  if (typeof jwt !== "string") throw new Error("Unexpected /v1/auth response shape");
  return jwt;
}

export function isAuthenticated() {
  return jwt !== null;
}

/** List markets. Options map to query params (status, sort, first, after...). */
export async function getMarkets({ status = "OPEN", sort = "VOLUME_24H_DESC", first = 25, after, marketVariant } = {}) {
  const params = new URLSearchParams({ status, sort, first: String(first) });
  if (after) params.set("after", after);
  if (marketVariant && marketVariant !== "ALL") params.set("marketVariant", marketVariant);
  const res = await request("GET", `/v1/markets?${params}`);
  return res.data ?? [];
}

export async function getMarket(marketId) {
  const res = await request("GET", `/v1/markets/${marketId}`);
  return res.data;
}

export async function getOrderbook(marketId) {
  const res = await request("GET", `/v1/markets/${marketId}/orderbook`);
  return res.data;
}

/** Submit a signed order. `data` follows the CreateOrderData schema. */
export async function createOrder(data) {
  const res = await request("POST", "/v1/orders", { body: { data }, auth: true });
  return res.data;
}

export async function getMyOrders() {
  const res = await request("GET", "/v1/orders", { auth: true });
  return res.data ?? [];
}

export async function getPositions() {
  const res = await request("GET", "/v1/positions", { auth: true });
  return res.data ?? [];
}

export async function getAccount() {
  const res = await request("GET", "/v1/account", { auth: true });
  return res.data;
}

/** Reachability probe used by --check. Returns { ok, status, detail }. */
export async function probeApi() {
  try {
    const res = await fetch(`${config.apiBase}/v1/markets?first=1`, { headers: headers() });
    if (res.ok) return { ok: true, status: res.status, detail: "markets endpoint OK" };
    // 401 on mainnet without a key still proves the API is reachable.
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        detail: "API reachable but the API key is missing/invalid (HTTP 401)",
      };
    }
    return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, detail: err.message };
  }
}
