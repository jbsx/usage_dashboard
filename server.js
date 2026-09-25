import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAutoArmer } from "./lib/autoarm.js";
import { createResetScheduler } from "./lib/reset-scheduler.js";
import { createUsageCache } from "./lib/usage-cache.js";
import { createUsageHistory } from "./lib/usage-history.js";
import { createUsageSampler } from "./lib/usage-sampler.js";
import { createWindowVerifier } from "./lib/window-verify.js";
import { codexPing } from "./lib/codex-ping.js";
import { parseCodexUsageResponse, tokenNeedsRefresh } from "./lib/codex-usage.js";
import { glmPing, GLM_PING_MODEL } from "./lib/glm-ping.js";
import {
  getGrok,
  pollGrokDeviceToken,
  readXaiOAuth,
  startGrokDeviceAuth,
  writeXaiAuth,
} from "./lib/grok.js";
import {
  buildClaudeAuthorizeUrl,
  claudeHeaders,
  claudePing,
  CLAUDE_MANUAL_REDIRECT_URL,
  CLAUDE_PING_MODEL,
  CLAUDE_PROFILE_URL,
  codeChallengeS256,
  defaultClaudeCliCredentialsPath,
  ensureClaudeToken,
  exchangePastedClaudeCode,
  generateCodeVerifier,
  getClaude,
  parseClaudeProfile,
  readEffectiveClaudeOauth,
  writeClaudeOauth,
} from "./lib/claude.js";
import {
  defaultAuthStorePath,
  defaultDataDir,
  defaultSettingsPath,
  readAutoArmSettings,
  readAuthEntry,
  writeAuthEntry,
  writeAutoArmSetting,
} from "./lib/dash-auth.js";
import { attachLiveAuth } from "./lib/attach-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;
const HOST = "0.0.0.0";

// ---------- tiny .env loader ----------
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const ZAI_API_KEY = process.env.ZAI_API_KEY || "";
const GROK_ENABLED = (process.env.GROK_ENABLED || "").trim().toLowerCase() !== "false";
const CLAUDE_ENABLED = (process.env.CLAUDE_ENABLED || "").trim().toLowerCase() !== "false";
const AUTH_STORE_PATH = process.env.AUTH_STORE_PATH || defaultAuthStorePath();
const CLAUDE_CREDENTIALS_PATH = defaultClaudeCliCredentialsPath();
const SETTINGS_PATH = process.env.SETTINGS_PATH || defaultSettingsPath();
const HISTORY_PATH = process.env.HISTORY_PATH || path.join(defaultDataDir(), "history.json");
const GROK_AUTH_PATH = AUTH_STORE_PATH; // xai entry lives in the shared store

const ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// ---------- helpers ----------
function decodeJwt(tok) {
  try {
    const p = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8"));
  } catch {
    return {};
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}
// ---------- GLM (z.ai coding plan) ----------
async function getGLM() {
  if (!ZAI_API_KEY) return { name: "GLM", connected: false, plan: null, error: "no ZAI_API_KEY in .env", windows: [], extras: [] };
  const { status, json } = await getJson("https://api.z.ai/api/monitor/usage/quota/limit", {
    headers: { Authorization: `Bearer ${ZAI_API_KEY}`, Accept: "application/json" },
  });
  if (!json || json.code !== 200) return { name: "GLM", connected: true, plan: null, error: `HTTP ${status}`, windows: [], extras: [] };
  const data = json.data || {};
  const out = { name: "GLM", connected: true, plan: data.level || null, error: null, windows: [], extras: [] };
  for (const l of data.limits || []) {
    if (l.type === "TOKENS_LIMIT" && l.unit === 3) {
      const total = l.total || 0, pct = l.percentage || 0;
      out.windows.push({ key: "5h", label: "5-Hour", unit: "tokens", usedPct: pct, used: Math.round(total * pct / 100), limit: total, remaining: Math.round(total * (100 - pct) / 100), resetAt: l.nextResetTime || null });
    } else if (l.type === "TOKENS_LIMIT" && l.unit === 6) {
      const total = l.total || 0, pct = l.percentage || 0;
      out.windows.push({ key: "7d", label: "7-Day", unit: "tokens", usedPct: pct, used: Math.round(total * pct / 100), limit: total, remaining: Math.round(total * (100 - pct) / 100), resetAt: l.nextResetTime || null });
    } else if (l.type === "TIME_LIMIT" && l.unit === 5) {
      const used = l.currentValue || 0, limit = l.usage || 0, pct = l.percentage || 0;
      out.windows.push({ key: "monthly", label: "Monthly (tool calls)", unit: "calls", usedPct: pct, used, limit, remaining: Math.max(0, limit - used), resetAt: l.nextResetTime || null });
    }
  }
  return out;
}

// ---------- Codex (OAuth) ----------
let codexLogin = null; // { device_auth_id, user_code, verification_url, interval }
let codexAuthRejected = false;

function readCodexAuth() {
  return readAuthEntry("codex", AUTH_STORE_PATH);
}
function writeCodexAuth(obj) {
  writeAuthEntry("codex", obj, AUTH_STORE_PATH);
}
async function refreshCodexToken(auth) {
  const { status, json } = await getJson(`${ISSUER}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token }),
  });
  if (status < 200 || status >= 300 || !json?.access_token) {
    throw new Error(json?.error?.code || json?.error || `HTTP ${status}`);
  }
  auth.tokens = { ...auth.tokens, ...json };
  auth.last_refresh = new Date().toISOString();
  writeCodexAuth(auth);
  codexAuthRejected = false;
  return auth;
}
function codexAccountId(auth) {
  return auth.account_id || decodeJwt(auth.tokens.id_token)?.chatgpt_account_id || null;
}
async function ensureCodexToken() {
  if (codexAuthRejected) return null;
  let auth = readCodexAuth();
  if (!auth?.tokens?.access_token) return null;
  if (tokenNeedsRefresh(auth)) auth = await refreshCodexToken(auth);
  return auth;
}
async function getCodex() {
  let auth;
  try {
    auth = await ensureCodexToken();
  } catch {
    codexAuthRejected = true;
    return parseCodexUsageResponse(401, null, codexLogin);
  }
  if (!auth || !auth.tokens?.access_token) {
    const pending = codexLogin ? { user_code: codexLogin.user_code, verification_url: codexLogin.verification_url, error: codexLogin.error || null } : null;
    const provider = parseCodexUsageResponse(401, null, pending);
    if (!codexAuthRejected) provider.error = "not connected";
    return provider;
  }
  const { status, json } = await getJson("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${auth.tokens.access_token}`, "ChatGPT-Account-Id": codexAccountId(auth), Accept: "application/json" },
  });
  if (status === 401) codexAuthRejected = true;
  return parseCodexUsageResponse(status, json, codexLogin);
}

// ---------- Codex login flow ----------
async function startCodexLogin() {
  try {
    const existing = await ensureCodexToken();
    if (existing?.tokens?.access_token) return { connected: true };
  } catch {
    codexAuthRejected = true;
  }
  codexPollCount = 0;
  const { json } = await getJson(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!json?.device_auth_id) throw new Error("device auth start failed");
  codexLogin = { device_auth_id: json.device_auth_id, user_code: json.user_code || json.usercode, verification_url: `${ISSUER}/codex/device`, interval: Number(json.interval || 5) };
  pollCodexLogin();
  return { connected: false, pending: true, user_code: codexLogin.user_code, verification_url: codexLogin.verification_url };
}
const CODEX_POLL_MAX = 60; // ~5 min at 5s
let codexPollCount = 0;
async function pollCodexLogin() {
  if (!codexLogin) return;
  try {
    const { json, status } = await getJson(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_auth_id: codexLogin.device_auth_id, user_code: codexLogin.user_code }),
    });
    if (status === 200 && json?.authorization_code) {
      const tok = await getJson(`${ISSUER}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: json.authorization_code, redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: json.code_verifier }).toString(),
      });
      if (tok.json?.access_token) {
        writeCodexAuth({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: tok.json, last_refresh: new Date().toISOString() });
        codexAuthRejected = false;
        codexLogin = null;
        usageCache = { data: null, at: 0 };
        return;
      }
      codexLogin.error = "token exchange returned no access_token";
      return;
    }
    if (status === 403 || status === 404) {
      if (++codexPollCount >= CODEX_POLL_MAX) {
        codexLogin = { ...codexLogin, error: "login timed out — approval took too long, click Retry" };
        return;
      }
      setTimeout(pollCodexLogin, (codexLogin?.interval || 5) * 1000);
      return;
    }
    codexLogin = { ...codexLogin, error: `device token error (HTTP ${status})` };
  } catch (e) {
    codexLogin = { ...codexLogin, error: "poll error: " + e.message };
    setTimeout(pollCodexLogin, (codexLogin?.interval || 5) * 1000);
  }
}

// ---------- Grok (xAI OAuth, dashboard-owned) ----------
let grokLogin = null;
const GROK_POLL_MAX = 60;
let grokPollCount = 0;

function grokLoginPending() {
  if (!grokLogin) return null;
  return {
    user_code: grokLogin.user_code,
    verification_url: grokLogin.verification_uri_complete || grokLogin.verification_uri,
    error: grokLogin.error || null,
  };
}
function grokStatus() {
  return {
    connected: !!readXaiOAuth(GROK_AUTH_PATH)?.access,
    pending: !!grokLogin,
    user_code: grokLogin?.user_code || null,
    verification_url: grokLogin?.verification_uri_complete || grokLogin?.verification_uri || null,
    error: grokLogin?.error || null,
  };
}
async function startGrokLogin() {
  if (readXaiOAuth(GROK_AUTH_PATH)?.access) return { connected: true };
  grokPollCount = 0;
  const json = await startGrokDeviceAuth();
  grokLogin = json;
  pollGrokLogin();
  return { connected: false, pending: true, user_code: json.user_code, verification_url: json.verification_uri_complete || json.verification_uri };
}
async function pollGrokLogin() {
  if (!grokLogin) return;
  try {
    const r = await pollGrokDeviceToken(grokLogin);
    if (r.type === "success") {
      writeXaiAuth(r.auth, GROK_AUTH_PATH);
      grokLogin = null;
      usageCache = { data: null, at: 0 };
      grokCache.reset();
      return;
    }
    if (r.error === "authorization_pending" || r.error === "slow_down" || r.status === 403 || r.status === 400) {
      if (++grokPollCount >= GROK_POLL_MAX) {
        grokLogin = { ...grokLogin, error: "login timed out — approval took too long, click Retry" };
        return;
      }
      const extra = r.error === "slow_down" ? 5 : 0;
      setTimeout(pollGrokLogin, ((grokLogin.interval || 5) + extra) * 1000);
      return;
    }
    if (r.error === "access_denied" || r.error === "authorization_denied") {
      grokLogin = { ...grokLogin, error: "authorization denied" };
      return;
    }
    if (r.error === "expired_token") {
      grokLogin = { ...grokLogin, error: "device code expired — click Retry" };
      return;
    }
    grokLogin = { ...grokLogin, error: `device token error (${r.error || "HTTP " + r.status})` };
  } catch (e) {
    grokLogin = { ...grokLogin, error: "poll error: " + e.message };
    setTimeout(pollGrokLogin, (grokLogin?.interval || 5) * 1000);
  }
}

// ---------- Claude (Max OAuth, dashboard-owned) ----------
let claudeLogin = null; // { codeVerifier, state, redirectUri, authorizeUrl, manualUrl, startedAt, error }
const CLAUDE_LOGIN_TTL_MS = 10 * 60 * 1000;

function claudeLoginExpired() {
  return !!claudeLogin && Date.now() - claudeLogin.startedAt > CLAUDE_LOGIN_TTL_MS;
}
function claudeLoginPending() {
  if (!claudeLogin) return null;
  if (claudeLoginExpired() && !claudeLogin.error) {
    claudeLogin = { ...claudeLogin, error: "login timed out — click Retry" };
  }
  return {
    mode: "authorize",
    verification_url: claudeLogin.authorizeUrl,
    manual_url: claudeLogin.manualUrl,
    error: claudeLogin.error || null,
  };
}
function claudeStatus() {
  return {
    connected: !!readEffectiveClaudeOauth({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH })?.access,
    pending: !!claudeLogin,
    user_code: null,
    verification_url: claudeLogin?.authorizeUrl || null,
    manual_url: claudeLogin?.manualUrl || null,
    error: claudeLoginPending()?.error || null,
  };
}
function startClaudeLogin() {
  if (readEffectiveClaudeOauth({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH })?.access) return { connected: true };
  // Reuse a live pending session: regenerating state/verifier here would
  // silently invalidate an authorize link the user already opened, so their
  // browser callback would fail the state check and the login would die.
  if (claudeLogin && !claudeLoginExpired() && !claudeLogin.error) {
    return {
      connected: false,
      pending: true,
      verification_url: claudeLogin.authorizeUrl,
      manual_url: claudeLogin.manualUrl,
    };
  }
  const codeVerifier = generateCodeVerifier();
  const state = crypto.randomUUID();
  const challenge = codeChallengeS256(codeVerifier);
  const redirectUri = `http://localhost:${PORT}/callback`;
  claudeLogin = {
    codeVerifier,
    state,
    redirectUri,
    authorizeUrl: buildClaudeAuthorizeUrl({ redirectUri, state, challenge }),
    manualUrl: buildClaudeAuthorizeUrl({ redirectUri: CLAUDE_MANUAL_REDIRECT_URL, state, challenge }),
    startedAt: Date.now(),
  };
  return {
    connected: false,
    pending: true,
    verification_url: claudeLogin.authorizeUrl,
    manual_url: claudeLogin.manualUrl,
  };
}
async function completeClaudeLogin(code, redirectUris) {
  if (!claudeLogin) throw new Error("no login in progress — click Connect first");
  if (claudeLoginExpired()) {
    claudeLogin = { ...claudeLogin, error: "login timed out — click Retry" };
    throw new Error(claudeLogin.error);
  }
  const auth = await exchangePastedClaudeCode({
    code,
    codeVerifier: claudeLogin.codeVerifier,
    redirectUris,
    state: claudeLogin.state,
  });
  try {
    const prof = await getJson(CLAUDE_PROFILE_URL, { headers: claudeHeaders(auth.access) });
    const info = parseClaudeProfile(prof.json);
    if (info) Object.assign(auth, info);
  } catch {}
  writeClaudeOauth(auth, AUTH_STORE_PATH);
  claudeLogin = null;
  usageCache = { data: null, at: 0 };
  claudeCache.reset();
}
async function handleClaudeCallback(url, res) {
  const page = (title, body) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;background:#0f0e0d;color:#fbf1c7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${title}</h2><p style="color:#bdae93">${body}</p></div></body>`);
  };
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!claudeLogin || !state || state !== claudeLogin.state) {
    // Surface the mismatch on the (newer) pending session instead of dying
    // silently — otherwise the card spins on "Waiting for approval…".
    if (claudeLogin) claudeLogin = { ...claudeLogin, error: "stale login link — click Retry" };
    page("Login session not found", "Start (or retry) the login from the usage dashboard, then reopen the authorization link.");
    return;
  }
  if (err) {
    claudeLogin = { ...claudeLogin, error: `authorization failed: ${err}` };
    page("Authorization failed", "Go back to the usage dashboard and click Retry.");
    return;
  }
  if (!code) {
    claudeLogin = { ...claudeLogin, error: "authorization returned no code — click Retry" };
    page("Missing authorization code", "Go back to the usage dashboard and click Retry.");
    return;
  }
  try {
    await completeClaudeLogin(code, [claudeLogin.redirectUri]);
    page("Claude connected", "You can close this tab — the dashboard will pick it up in a few seconds.");
  } catch (e) {
    claudeLogin = { ...(claudeLogin || {}), error: e.message };
    page("Login failed", "Go back to the usage dashboard and click Retry.");
  }
}

// ---------- Auto-arm (GLM + Codex + Claude) ----------
// The 5h window only starts counting down after the first inference; when it
// reads 0% with no live timer, send one tiny ping so the countdown starts.
const glmAutoArm = createAutoArmer({
  ping: async () => {
    if (!ZAI_API_KEY) throw new Error("no ZAI_API_KEY");
    console.log("[auto-arm] glm 5h window unarmed — sending ping inference");
    try {
      await glmPing({ apiKey: ZAI_API_KEY, model: process.env.ZAI_PING_MODEL || GLM_PING_MODEL });
    } catch (e) {
      console.error("[auto-arm] glm ping failed:", e.message);
      throw e;
    }
  },
  refresh: getGLM,
});

const codexAutoArm = createAutoArmer({
  ping: async () => {
    const auth = await ensureCodexToken();
    if (!auth?.tokens?.access_token) throw new Error("codex not connected");
    console.log("[auto-arm] codex 5h window unarmed — sending ping inference");
    try {
      await codexPing({ auth });
    } catch (e) {
      console.error("[auto-arm] codex ping failed:", e.message);
      throw e;
    }
  },
  refresh: getCodex,
});

const claudeAutoArm = createAutoArmer({
  ping: async () => {
    const auth = await ensureClaudeToken({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH });
    if (!auth?.access) throw new Error("claude not connected");
    console.log("[auto-arm] claude 5h window unarmed — sending ping inference");
    try {
      await claudePing({ auth, model: process.env.CLAUDE_PING_MODEL || CLAUDE_PING_MODEL });
    } catch (e) {
      console.error("[auto-arm] claude ping failed:", e.message);
      throw e;
    }
  },
  refresh: () => getClaude({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH, pending: claudeLoginPending() }),
});

// Auto-arm is toggled per card from the dashboard settings panel; read the
// persisted setting on every decision so flips apply immediately.
const autoArmEnabled = (provider) => readAutoArmSettings(SETTINGS_PATH)[provider] !== false;

const glmScheduler = createResetScheduler({
  fetchProvider: getGLM,
  autoArmer: glmAutoArm,
  shouldArm: () => autoArmEnabled("GLM"),
  onError: (e) => console.error("[auto-arm] glm scheduled check failed:", e.message),
});

const codexScheduler = createResetScheduler({
  fetchProvider: getCodex,
  autoArmer: codexAutoArm,
  shouldArm: () => autoArmEnabled("Codex"),
  onError: (e) => console.error("[auto-arm] codex scheduled check failed:", e.message),
});

const claudeScheduler = createResetScheduler({
  fetchProvider: () => getCachedClaude(),
  autoArmer: claudeAutoArm,
  shouldArm: () => autoArmEnabled("Claude"),
  onError: (e) => console.error("[auto-arm] claude scheduled check failed:", e.message),
});

// ---------- HTTP server ----------
const USAGE_TTL_MS = 55000;
const GROK_USAGE_TTL_MS = 5 * 60 * 1000;
// The Claude usage endpoint 429s aggressively when polled per-minute and
// Grok's credits endpoint intermittently 500s, so both go through the
// shared stale-serving cache (lib/usage-cache.js): long TTL, last good
// data kept across transient failures, retries backed off exponentially
// and retry-after hints honored, so the retry cadence itself doesn't keep
// the limiter tripped.
let usageCache = { data: null, at: 0 };
const usageHistory = createUsageHistory({ filePath: HISTORY_PATH });
const grokCache = createUsageCache({
  fetchProvider: () => getGrok({ authPath: GROK_AUTH_PATH, pending: grokLoginPending() }),
  ttlMs: GROK_USAGE_TTL_MS,
  generation: () => credGeneration,
});
const getCachedGrok = (force = false) => grokCache.get(force);
const claudeCache = createUsageCache({
  fetchProvider: () => getClaude({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH, pending: claudeLoginPending() }),
  generation: () => credGeneration,
});
const getCachedClaude = (force = false) => claudeCache.get(force);

// ---------- daily window verification ----------
// Window keys are derived from each window's duration at parse time, so a
// plan change (Codex pro -> prolite swaps a 5h window for a 7d one) is
// picked up on the next successful parse. The stale-serving Claude/Grok
// caches can keep serving the pre-switch window set across transient
// errors, though, so once a day force a fresh parse of every provider and
// drop the shared snapshot when a classification actually changed.
const windowVerifier = createWindowVerifier({
  providers: [
    { fetch: () => getGLM() },
    { fetch: () => getCodex() },
    ...(GROK_ENABLED ? [{ fetch: () => getCachedGrok(true) }] : []),
    ...(CLAUDE_ENABLED ? [{ fetch: () => getCachedClaude(true) }] : []),
  ],
  onVerify: (changes) => {
    for (const c of changes) {
      console.log(`[window-verify] ${c.name} window set changed: [${c.from}] -> [${c.to}]`);
    }
    if (changes.length) usageCache = { data: null, at: 0 };
  },
  onError: (e) => console.error("[window-verify] provider check failed:", e.message),
});

function liveUsage(data) {
  const codexPending = codexLogin
    ? { user_code: codexLogin.user_code, verification_url: codexLogin.verification_url, error: codexLogin.error || null }
    : null;
  return attachLiveAuth(data, {
    grokPending: grokLoginPending(),
    codexPending,
    claudePending: claudeLoginPending(),
    claudeCanLogout: readEffectiveClaudeOauth({ authPath: AUTH_STORE_PATH, cliCredentialsPath: CLAUDE_CREDENTIALS_PATH })?.credentialSource !== "claude-cli",
    autoArm: readAutoArmSettings(SETTINGS_PATH),
  });
}
let usageFetch = null; // in-flight snapshot fetch
let usageFetchGen = -1;

// History used to be recorded only when a browser hit /api/usage, so the
// chart went dark whenever nobody had the page open. The sampler runs the
// same getUsage() on the page's refresh cadence; it goes through the same
// 55s cache and in-flight dedupe, so an open tab adds no extra upstream
// calls beyond what one poller already makes.
const HISTORY_SAMPLE_MS = 60_000;
const historySampler = createUsageSampler({
  sample: () => getUsage(),
  intervalMs: HISTORY_SAMPLE_MS,
  onError: (e) => console.error("[history] background sample failed:", e.message),
});

// The snapshot carries only the chart's live view plus an hour of margin
// for the curve and gap detection; the page asks /api/history for anything
// older when the user scrolls back. Seven days in every 60s poll would be
// megabytes per tab per minute.
const HISTORY_EMBED_MS = 13 * 3600e3;
function recentHistory() {
  const now = Date.now();
  const since = now - HISTORY_EMBED_MS;
  return { history: usageHistory.range(since, now), historySince: since, historyOldestAt: usageHistory.oldestAt() };
}

function getUsage() {
  if (usageCache.data && Date.now() - usageCache.at < USAGE_TTL_MS) return Promise.resolve(liveUsage(usageCache.data));
  if (usageFetch && usageFetchGen === credGeneration) return usageFetch;
  // A fetch started before a logout may carry pre-logout data; wait it out
  // so this request runs against the post-logout credential state.
  const staleFetch = usageFetch;
  const gen = credGeneration;
  const run = (async () => {
    if (staleFetch) await staleFetch.catch(() => {});
    const tasks = [glmScheduler.checkNow(), codexScheduler.checkNow()];
    if (GROK_ENABLED) tasks.push(getCachedGrok());
    if (CLAUDE_ENABLED) tasks.push(claudeScheduler.checkNow());
    const providers = await Promise.all(tasks);
    usageHistory.record(providers);
    const snapshot = { updatedAt: Date.now(), providers, ...recentHistory() };
    if (gen === credGeneration) usageCache = { data: snapshot, at: Date.now() };
    return liveUsage(snapshot);
  })();
  usageFetch = run;
  usageFetchGen = gen;
  run.finally(() => {
    if (usageFetch === run) { usageFetch = null; usageFetchGen = -1; }
  }).catch(() => {});
  return run;
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// ---------- logout ----------
// Drops the stored credentials and pending-login state for an OAuth
// provider. Tokens are not server-revoked (Anthropic/xAI/OpenAI expose no
// public revocation endpoint for these flows); deleting them locally is the
// same behavior as the respective CLIs' logout commands.
let credGeneration = 0; // bumped on logout; in-flight fetches check it before caching

function logoutProvider(slug) {
  if (slug === "claude") {
    writeAuthEntry("claude", null, AUTH_STORE_PATH);
    claudeLogin = null;
    claudeCache.reset();
  } else if (slug === "codex") {
    writeAuthEntry("codex", null, AUTH_STORE_PATH);
    codexLogin = null;
    codexAuthRejected = false;
  } else if (slug === "grok") {
    writeAuthEntry("xai", null, AUTH_STORE_PATH);
    grokLogin = null;
    grokCache.reset();
  } else {
    throw new Error(`logout not available for ${slug}`);
  }
  credGeneration++;
  usageCache = { data: null, at: 0 };
}
const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html" },
  "/index.html": { file: "index.html", type: "text/html" },
  "/app.js": { file: "app.js", type: "text/javascript" },
  "/style.css": { file: "style.css", type: "text/css" },
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/usage") {
      // ?refresh: manual escape hatch — force a Claude retry past its
      // backoff and rebuild the snapshot instead of waiting out the hold.
      if (url.searchParams.has("refresh")) {
        usageCache = { data: null, at: 0 };
        try { await getCachedClaude(true); } catch {}
      }
      const data = await getUsage();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === "/api/history" && req.method === "GET") {
      try {
        const answer = usageHistory.query({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/history/import" && req.method === "POST") {
      try {
        const { samples } = await readJsonBody(req, 2 * 1024 * 1024);
        if (!Array.isArray(samples)) throw new Error("samples must be an array");
        const history = usageHistory.importSamples(samples);
        if (usageCache.data) Object.assign(usageCache.data, recentHistory());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: history.length }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/api/codex/login" && req.method === "POST") {
      const r = await startCodexLogin();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    if (url.pathname === "/api/codex/status") {
      const auth = readCodexAuth();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connected: !!auth?.tokens?.access_token, pending: !!codexLogin, user_code: codexLogin?.user_code || null, verification_url: codexLogin?.verification_url || null, error: codexLogin?.error || null }));
      return;
    }
    if (url.pathname === "/api/grok/login" && req.method === "POST") {
      const r = await startGrokLogin();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    if (url.pathname === "/api/grok/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(grokStatus()));
      return;
    }
    if (url.pathname === "/api/claude/login" && req.method === "POST") {
      const r = await startClaudeLogin();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    if (url.pathname === "/api/claude/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(claudeStatus()));
      return;
    }
    if (url.pathname === "/api/claude/code" && req.method === "POST") {
      try {
        const { code } = await readJsonBody(req);
        if (!code || typeof code !== "string") throw new Error("missing code");
        // The pasted code may have been issued via either authorize link, so
        // try the manual redirect first, then the primary localhost one.
        await completeClaudeLogin(code.trim(), [CLAUDE_MANUAL_REDIRECT_URL, claudeLogin?.redirectUri].filter(Boolean));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ connected: true }));
      } catch (e) {
        // Record the failure on the pending login so /api/claude/status
        // agrees with this response; otherwise the 3s status poll reports
        // error:null and the frontend re-render wipes the message within
        // seconds of it flashing on the card.
        if (claudeLogin) claudeLogin = { ...claudeLogin, error: e.message };
        console.error("[claude] manual code exchange failed:", e.message);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url.pathname === "/callback" && req.method === "GET") {
      await handleClaudeCallback(url, res);
      return;
    }
    if (url.pathname === "/api/autoarm" && req.method === "POST") {
      try {
        const { provider, enabled } = await readJsonBody(req);
        const settings = writeAutoArmSetting(provider, !!enabled, SETTINGS_PATH);
        usageCache = { data: null, at: 0 };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ autoArm: settings }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    const logoutMatch = url.pathname.match(/^\/api\/(claude|codex|grok)\/logout$/);
    if (logoutMatch && req.method === "POST") {
      try {
        logoutProvider(logoutMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // static: explicit allowlist only
    const entry = STATIC_FILES[url.pathname];
    if (!entry) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": entry.type });
    fs.createReadStream(path.join(__dirname, entry.file)).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});
server.listen(PORT, HOST, () => {
  console.log(`AI usage dashboard running at http://${HOST}:${PORT}`);
  glmScheduler.start();
  codexScheduler.start();
  if (CLAUDE_ENABLED) claudeScheduler.start();
  windowVerifier.start();
  historySampler.start();
});
