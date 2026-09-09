import { defaultAuthStorePath, readAuthEntry, writeAuthEntry } from "./dash-auth.js";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const GROK_SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const REFRESH_SKEW_MS = 120000;
const PLAN_BY_TIER = {
  SUBSCRIPTION_TIER_SUPER_GROK_HEAVY: "Heavy",
  SUBSCRIPTION_TIER_SUPER_GROK_LITE: "Lite",
  SUBSCRIPTION_TIER_SUPER_GROK: "SuperGrok",
  SUBSCRIPTION_TIER_SUPER_GROK_PRO: "SuperGrok",
  SUBSCRIPTION_TIER_GROK_PRO: "Grok Pro",
};

// Tokens live in the dashboard's own credential store (one file, per-provider
// keys) — the same store Claude and Codex use.
export function defaultAuthPath() {
  return defaultAuthStorePath();
}

export function grokHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "usage-dashboard/1.0",
    "x-grok-client-surface": "grok-build",
    "x-grok-client-version": "1.0.0",
  };
}

function isRecord(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function jwtExpMs(tok) {
  try {
    const p = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = p + "=".repeat((4 - (p.length % 4)) % 4);
    const exp = JSON.parse(Buffer.from(pad, "base64").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function writeXaiAuth(xai, authPath = defaultAuthPath()) {
  writeAuthEntry("xai", xai, authPath);
}

export function readXaiOAuth(authPath = defaultAuthPath()) {
  const entry = readAuthEntry("xai", authPath);
  if (!entry || entry.type !== "oauth") return null;
  const access = typeof entry.access === "string" ? entry.access.trim() : "";
  const refresh = typeof entry.refresh === "string" ? entry.refresh.trim() : "";
  if (!access) return null;
  return {
    type: "oauth",
    access,
    refresh,
    expires: typeof entry.expires === "number" ? entry.expires : 0,
  };
}

export function tokenNeedsRefresh(auth, now = Date.now()) {
  if (!auth?.access) return true;
  if (auth.expires && auth.expires - now <= REFRESH_SKEW_MS) return true;
  const jwtExp = jwtExpMs(auth.access);
  return jwtExp > 0 && jwtExp - now <= REFRESH_SKEW_MS;
}

export async function refreshXaiToken(auth, { fetchFn = fetch } = {}) {
  if (!auth?.refresh) throw new Error("no refresh token");
  const res = await fetchFn(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "usage-dashboard/1.0",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: XAI_CLIENT_ID,
    }).toString(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.access_token) {
    throw new Error(`xAI token refresh failed (${res.status})`);
  }
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token || auth.refresh,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function ensureXaiToken({
  authPath = defaultAuthPath(),
  fetchFn = fetch,
  now = Date.now,
} = {}) {
  let auth = readXaiOAuth(authPath);
  if (!auth) return null;
  if (!tokenNeedsRefresh(auth, now())) return auth;
  auth = await refreshXaiToken(auth, { fetchFn });
  writeXaiAuth(auth, authPath);
  return auth;
}

export function periodKind(type) {
  const raw = String(type || "").toUpperCase();
  if (raw.includes("WEEK")) return { key: "7d", label: "Weekly" };
  if (raw.includes("MONTH")) return { key: "monthly", label: "Monthly" };
  if (raw.includes("DAY")) return { key: "daily", label: "Daily" };
  return { key: "period", label: "Period" };
}

export function parseCredits(payload) {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  const hasUsage = Object.hasOwn(config, "creditUsagePercent");
  const hasPeriod = Boolean(period?.type || period?.start || period?.end);
  if (!hasPeriod && !hasUsage) return null;
  if (hasUsage && (typeof config.creditUsagePercent !== "number" || !Number.isFinite(config.creditUsagePercent))) {
    throw new Error("invalid creditUsagePercent");
  }
  const usedPct = hasUsage ? config.creditUsagePercent : 0;
  const end = period?.end || config.billingPeriodEnd || null;
  const resetAt = end ? Date.parse(end) || null : null;
  const { key, label } = periodKind(period?.type);
  return {
    key,
    label,
    unit: "percent",
    usedPct,
    used: null,
    limit: null,
    remaining: null,
    resetAt,
  };
}

export function parsePlan(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.subscriptions)) return null;
  const active = payload.subscriptions.find((s) => isRecord(s) && s.status === "SUBSCRIPTION_STATUS_ACTIVE");
  if (!isRecord(active)) return null;
  const offerId = isRecord(active.activeOffer) ? String(active.activeOffer.providerOfferId || "") : "";
  if (/^heavy-p\d+m-\d{1,2}-[a-z]{3}\d{4}$/i.test(offerId)) return "Heavy";
  return PLAN_BY_TIER[active.tier] || null;
}

async function getJson(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

// Error responses may carry retry-after as delay-seconds or an HTTP-date.
function retryAfterMs(headers, nowMs = Date.now()) {
  const v = headers?.get?.("retry-after");
  if (typeof v !== "string" || !v.trim()) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

export async function startGrokDeviceAuth({ fetchFn = fetch } = {}) {
  const res = await fetchFn(XAI_DEVICE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "usage-dashboard/1.0",
    },
    body: new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPE,
      referrer: "opencode",
    }).toString(),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.device_code || !json?.user_code || !json?.verification_uri) {
    throw new Error("xAI device code request failed");
  }
  return json;
}

export async function pollGrokDeviceToken(device, { fetchFn = fetch } = {}) {
  const res = await fetchFn(XAI_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "usage-dashboard/1.0",
    },
    body: new URLSearchParams({
      grant_type: XAI_DEVICE_GRANT,
      client_id: XAI_CLIENT_ID,
      device_code: device.device_code,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok && json.access_token) {
    return {
      type: "success",
      auth: {
        type: "oauth",
        access: json.access_token,
        refresh: json.refresh_token || "",
        expires: Date.now() + (json.expires_in ?? 3600) * 1000,
      },
    };
  }
  return { type: "pending", error: json.error || null, status: res.status };
}

export async function getGrok({
  authPath = defaultAuthPath(),
  fetchFn = fetch,
  now = Date.now,
  pending = null,
} = {}) {
  const disconnected = (error) => ({
    name: "Grok",
    connected: false,
    plan: null,
    error: error || "not connected",
    windows: [],
    extras: [],
    auth: { slug: "grok", pending },
  });
  let auth;
  try {
    auth = await ensureXaiToken({ authPath, fetchFn, now });
  } catch (e) {
    return disconnected(e.message);
  }
  if (!auth?.access) return disconnected();
  const headers = grokHeaders(auth.access);
  const { status, json, headers: respHeaders } = await getJson(fetchFn, GROK_CREDITS_URL, headers);
  if (!json) return { name: "Grok", connected: true, plan: null, error: `HTTP ${status}`, retryAfterMs: retryAfterMs(respHeaders), windows: [], extras: [] };
  let window;
  try {
    window = parseCredits(json);
  } catch (e) {
    return { name: "Grok", connected: true, plan: null, error: e.message, windows: [], extras: [] };
  }
  if (!window) return { name: "Grok", connected: true, plan: null, error: "no quota data", windows: [], extras: [] };
  let plan = null;
  try {
    const sub = await getJson(fetchFn, GROK_SUBSCRIPTIONS_URL, headers);
    if (sub.json) plan = parsePlan(sub.json);
  } catch {}
  return { name: "Grok", connected: true, plan, error: null, windows: [window], extras: [] };
}
