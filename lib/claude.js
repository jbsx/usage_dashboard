// Claude (claude.ai Max subscription) via the OAuth app scheme Claude Code
// itself uses. Endpoints and protocol verified against claude-cli 2.1.252:
//   authorize : https://platform.claude.com/oauth/authorize (PKCE S256)
//   token     : https://platform.claude.com/v1/oauth/token
//   usage     : https://api.anthropic.com/api/oauth/usage  (the /usage source)
//   profile   : https://api.anthropic.com/api/oauth/profile
// The usage endpoint is undocumented and its schema evolves; parsing is
// tolerant of missing/renamed fields.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultAuthStorePath, readAuthEntry, writeAuthEntry } from "./dash-auth.js";

export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const CLAUDE_USER_AGENT = "claude-cli (external, cli)";
export const CLAUDE_SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const CLAUDE_PING_MODEL = "claude-haiku-4-5"; // cheapest current haiku
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const PING_TIMEOUT_MS = 30000;

// ---------- PKCE ----------

export function generateCodeVerifier(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function codeChallengeS256(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function buildClaudeAuthorizeUrl({ redirectUri, state, challenge, scope = CLAUDE_SCOPE }) {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

// ---------- stored auth ----------

export function readClaudeOauth(authPath = defaultAuthStorePath()) {
  return readAuthEntry("claude", authPath);
}

export function writeClaudeOauth(auth, authPath = defaultAuthStorePath()) {
  writeAuthEntry("claude", auth, authPath);
}

export function defaultClaudeCliCredentialsPath() {
  return process.env.CLAUDE_CREDENTIALS_PATH || path.join(os.homedir(), ".claude", ".credentials.json");
}

export function readClaudeCliOauth(credentialsPath = defaultClaudeCliCredentialsPath()) {
  try {
    const auth = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    return {
      type: "oauth",
      access: auth.accessToken,
      refresh: auth.refreshToken || "",
      expires: auth.expiresAt || 0,
      scopes: Array.isArray(auth.scopes) ? auth.scopes.join(" ") : auth.scopes || CLAUDE_SCOPE,
      subscriptionType: auth.subscriptionType ?? null,
      rateLimitTier: auth.rateLimitTier ?? null,
      credentialSource: "claude-cli",
    };
  } catch {
    return null;
  }
}

function writeClaudeCliOauth(auth, credentialsPath) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(credentialsPath, "utf8")); } catch {}
  if (!all || typeof all !== "object" || Array.isArray(all)) all = {};
  const previous = all.claudeAiOauth && typeof all.claudeAiOauth === "object" ? all.claudeAiOauth : {};
  const scopes = typeof auth.scopes === "string" ? auth.scopes.split(/\s+/).filter(Boolean) : auth.scopes;
  all.claudeAiOauth = {
    ...previous,
    accessToken: auth.access,
    refreshToken: auth.refresh || previous.refreshToken || "",
    expiresAt: auth.expires,
    scopes: Array.isArray(previous.scopes) ? scopes : auth.scopes,
    subscriptionType: auth.subscriptionType ?? previous.subscriptionType ?? null,
    rateLimitTier: auth.rateLimitTier ?? previous.rateLimitTier ?? null,
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  const tmp = credentialsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credentialsPath);
}

export function readEffectiveClaudeOauth({ authPath = defaultAuthStorePath(), cliCredentialsPath = null } = {}) {
  return (cliCredentialsPath && readClaudeCliOauth(cliCredentialsPath)) || readClaudeOauth(authPath);
}

function persistClaudeOauth(auth, authPath, cliCredentialsPath) {
  if (auth?.credentialSource === "claude-cli" && cliCredentialsPath) {
    writeClaudeCliOauth(auth, cliCredentialsPath);
  } else {
    writeClaudeOauth(auth, authPath);
  }
}

// ---------- token endpoint ----------

function tokenRequest(body, fetchFn) {
  return fetchFn(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": CLAUDE_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}

// The token endpoint reports errors as either strings or
// { type, message } objects; normalize to readable text.
function errorMessage(json, fallback) {
  const e = json?.error_description || json?.error || json?.error_message;
  if (typeof e === "string" && e) return e;
  if (e && typeof e === "object") return e.message || e.type || JSON.stringify(e);
  return fallback;
}

function mapTokenResponse(json, prev = null) {
  if (!json?.access_token) {
    throw new Error(errorMessage(json, "token endpoint returned no access_token"));
  }
  const scopes = Array.isArray(json.scopes)
    ? json.scopes.join(" ")
    : (typeof json.scope === "string" && json.scope) || prev?.scopes || CLAUDE_SCOPE;
  return {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token || prev?.refresh || "",
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    scopes,
    subscriptionType: typeof json.subscriptionType === "string" ? json.subscriptionType : prev?.subscriptionType ?? null,
    rateLimitTier: typeof json.rateLimitTier === "string" ? json.rateLimitTier : prev?.rateLimitTier ?? null,
    ...(prev?.credentialSource ? { credentialSource: prev.credentialSource } : {}),
  };
}

export async function exchangeClaudeCode({ code, codeVerifier, redirectUri, state, fetchFn = fetch }) {
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }, fetchFn);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    throw new Error(errorMessage(json, `HTTP ${res.status}`));
  }
  return mapTokenResponse(json);
}

// A pasted authorization code can come from either authorize link: the
// manual one (redirect_uri = CLAUDE_MANUAL_REDIRECT_URL) or the primary
// localhost one — the consent page shows a copyable code for both because
// the authorize URL carries code=true. The token endpoint requires the
// exchange redirect_uri to match the authorize request exactly, and a
// mismatched attempt is rejected without consuming the code, so trying the
// candidates in order is safe.
export async function exchangePastedClaudeCode({ code, codeVerifier, redirectUris, state, fetchFn = fetch }) {
  if (!Array.isArray(redirectUris) || !redirectUris.length) {
    throw new Error("no redirect_uris to try");
  }
  let authorizationCode = code.trim();
  const stateSeparator = authorizationCode.indexOf("#");
  if (stateSeparator !== -1) {
    const pastedState = authorizationCode.slice(stateSeparator + 1);
    authorizationCode = authorizationCode.slice(0, stateSeparator);
    if (!authorizationCode || pastedState !== state) {
      throw new Error("authorization code does not match the current login");
    }
  }
  let firstError;
  for (const redirectUri of redirectUris) {
    try {
      return await exchangeClaudeCode({ code: authorizationCode, codeVerifier, redirectUri, state, fetchFn });
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError;
}

export async function refreshClaudeToken(auth, { fetchFn = fetch } = {}) {
  if (!auth?.refresh) throw new Error("no refresh token");
  const res = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: CLAUDE_CLIENT_ID,
    scope: auth.scopes || CLAUDE_SCOPE,
  }, fetchFn);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.access_token) {
    throw new Error(errorMessage(json, `HTTP ${res.status}`));
  }
  return mapTokenResponse(json, auth);
}

export function claudeTokenNeedsRefresh(auth, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!auth?.access) return true;
  if (!auth.expires) return true; // opaque token, unknown expiry — probe once via refresh
  return auth.expires - now <= skewMs;
}

export async function ensureClaudeToken({ authPath = defaultAuthStorePath(), cliCredentialsPath = null, fetchFn = fetch, now = Date.now }) {
  let auth = readEffectiveClaudeOauth({ authPath, cliCredentialsPath });
  if (!auth?.access) return null;
  if (!claudeTokenNeedsRefresh(auth, now())) return auth;
  auth = await refreshClaudeToken(auth, { fetchFn });
  persistClaudeOauth(auth, authPath, cliCredentialsPath);
  return auth;
}

// ---------- API calls ----------

export function claudeHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": CLAUDE_USER_AGENT,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_OAUTH_BETA,
  };
}

async function getJson(fetchFn, url, headers) {
  const res = await fetchFn(url, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

// 429/5xx responses may carry retry-after as delay-seconds or an HTTP-date;
// either way return the wait in ms so the caller can back off accordingly.
function retryAfterMs(headers, nowMs = Date.now()) {
  const v = headers?.get?.("retry-after");
  if (typeof v !== "string" || !v.trim()) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

// ---------- usage parsing ----------

function isRecord(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function parseIsoMs(s) {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// The endpoint reports utilization as a percentage; some builds return a
// 0–1 fraction instead. Values strictly between 0 and 1 are treated as
// fractions (a real 0.5% reading is far rarer than a 0.5 fraction).
function toPct(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, pct));
}

function windowFrom(key, label, w) {
  if (!isRecord(w)) return null;
  const pct = toPct(w.utilization ?? w.percent);
  if (pct == null) return null;
  return {
    key,
    label,
    unit: "percent",
    usedPct: pct,
    used: null,
    limit: null,
    remaining: null,
    resetAt: parseIsoMs(w.resets_at),
  };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scoped";
}

export function parseClaudeUsage(json) {
  if (!isRecord(json)) return null;
  const windows = [];
  const seen = new Set();
  const push = (w) => {
    if (!w || seen.has(w.key)) return;
    seen.add(w.key);
    windows.push(w);
  };
  push(windowFrom("5h", "5-Hour", json.five_hour));
  push(windowFrom("7d", "7-Day", json.seven_day));
  push(windowFrom("7d-opus", "7-Day (Opus)", json.seven_day_opus));
  push(windowFrom("7d-sonnet", "7-Day (Sonnet)", json.seven_day_sonnet));
  for (const lim of Array.isArray(json.limits) ? json.limits : []) {
    if (!isRecord(lim) || lim.kind !== "weekly_scoped") continue;
    const model = isRecord(lim.scope) && isRecord(lim.scope.model) ? lim.scope.model.display_name : null;
    const label = model ? `7-Day (${model})` : "7-Day (scoped)";
    push(windowFrom("7d-" + slug(model), label, lim));
  }
  const extras = [];
  const spend = json.spend;
  if (isRecord(spend) && spend.enabled && isRecord(spend.used)) {
    const amount = spend.used.amount_minor;
    if (typeof amount === "number" && Number.isFinite(amount)) {
      const exp = typeof spend.used.exponent === "number" ? spend.used.exponent : 2;
      const cur = spend.used.currency || "USD";
      extras.push({
        label: "Spend",
        text: `${(amount / 10 ** exp).toFixed(2)} ${cur} (${spend.percent ?? 0}% of cap)`,
      });
    }
  }
  if (!windows.length && !extras.length) return null;
  return { windows, extras };
}

export function parseClaudeProfile(json) {
  if (!isRecord(json)) return null;
  const sub = isRecord(json.subscription) ? json.subscription : {};
  const out = {};
  const subscriptionType = json.subscriptionType ?? json.subscription_type ?? sub.type;
  if (typeof subscriptionType === "string" && subscriptionType) out.subscriptionType = subscriptionType;
  const rateLimitTier = json.rateLimitTier ?? json.rate_limit_tier ?? sub.rateLimitTier;
  if (typeof rateLimitTier === "string" && rateLimitTier) out.rateLimitTier = rateLimitTier;
  return Object.keys(out).length ? out : null;
}

export function claudePlanLabel(auth) {
  const tier = String(auth?.rateLimitTier || "");
  const m = /claude_max_(\d+)x/i.exec(tier);
  if (m) return `Max ${m[1]}x`;
  const sub = String(auth?.subscriptionType || "");
  if (sub) return sub[0].toUpperCase() + sub.slice(1);
  return null;
}

// ---------- provider ----------

export async function getClaude({
  authPath = defaultAuthStorePath(),
  cliCredentialsPath = null,
  fetchFn = fetch,
  now = Date.now,
  pending = null,
} = {}) {
  const disconnected = (error) => ({
    name: "Claude",
    connected: false,
    plan: null,
    error: error || "not connected",
    windows: [],
    extras: [],
    auth: { slug: "claude", pending },
  });

  let auth;
  try {
    auth = await ensureClaudeToken({ authPath, cliCredentialsPath, fetchFn, now });
  } catch (e) {
    // A dead refresh token means reconnect; anything else (network etc.)
    // keeps the stored entry and surfaces as a transient error.
    if (/invalid|revoked|expired/i.test(e.message)) {
      const stored = readEffectiveClaudeOauth({ authPath, cliCredentialsPath });
      if (stored?.credentialSource !== "claude-cli") writeClaudeOauth(null, authPath);
      return disconnected("session expired — reconnect");
    }
    const stored = readEffectiveClaudeOauth({ authPath, cliCredentialsPath });
    return {
      name: "Claude",
      connected: true,
      plan: claudePlanLabel(stored),
      error: `token refresh failed: ${e.message}`,
      windows: [],
      extras: [],
    };
  }
  if (!auth?.access) return disconnected();

  const { status, json, headers } = await getJson(fetchFn, CLAUDE_USAGE_URL, claudeHeaders(auth.access));
  if (status === 401) {
    return {
      name: "Claude",
      connected: false,
      plan: claudePlanLabel(auth),
      error: "session expired — reconnect",
      windows: [],
      extras: [],
      auth: { slug: "claude", pending },
    };
  }
  if (!json || status < 200 || status >= 300) {
    return { name: "Claude", connected: true, plan: claudePlanLabel(auth), error: errorMessage(json, `HTTP ${status}`), retryAfterMs: retryAfterMs(headers), windows: [], extras: [] };
  }
  const parsed = parseClaudeUsage(json);
  if (!parsed) {
    return { name: "Claude", connected: true, plan: claudePlanLabel(auth), error: "no quota data", windows: [], extras: [] };
  }

  // Plan metadata (subscriptionType / rateLimitTier) rides on token/profile
  // responses, not usage; backfill it once when missing.
  let plan = claudePlanLabel(auth);
  if (!plan) {
    try {
      const prof = await getJson(fetchFn, CLAUDE_PROFILE_URL, claudeHeaders(auth.access));
      const info = parseClaudeProfile(prof.json);
      if (info) {
        auth = { ...auth, ...info };
        persistClaudeOauth(auth, authPath, cliCredentialsPath);
        plan = claudePlanLabel(auth);
      }
    } catch {}
  }
  return { name: "Claude", connected: true, plan, error: null, windows: parsed.windows, extras: parsed.extras };
}

// One tiny, real inference so the 5-hour window starts counting. Only used
// when auto-arm is enabled for the Claude card.
export async function claudePing({ fetchFn = fetch, auth, model = CLAUDE_PING_MODEL }) {
  const res = await fetchFn(CLAUDE_MESSAGES_URL, {
    method: "POST",
    headers: claudeHeaders(auth.access),
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return true;
}
