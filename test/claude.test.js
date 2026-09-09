import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_MESSAGES_URL,
  CLAUDE_PROFILE_URL,
  CLAUDE_SCOPE,
  CLAUDE_TOKEN_URL,
  CLAUDE_USAGE_URL,
  buildClaudeAuthorizeUrl,
  claudePing,
  claudePlanLabel,
  claudeTokenNeedsRefresh,
  codeChallengeS256,
  ensureClaudeToken,
  exchangeClaudeCode,
  exchangePastedClaudeCode,
  getClaude,
  parseClaudeProfile,
  parseClaudeUsage,
  readClaudeCliOauth,
  readClaudeOauth,
  refreshClaudeToken,
  writeClaudeOauth,
} from "../lib/claude.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-")), "auth.json");

const jsonResponse = (json, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(json),
});

// ---------- PKCE ----------

test("codeChallengeS256 matches the RFC 7636 appendix B test vector", () => {
  assert.equal(
    codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

test("buildClaudeAuthorizeUrl carries PKCE, state, scope and redirect", () => {
  const url = new URL(buildClaudeAuthorizeUrl({
    redirectUri: "http://localhost:4321/callback",
    state: "st-1",
    challenge: "ch-abc",
  }));
  assert.equal(url.origin + url.pathname, CLAUDE_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("code"), "true");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), CLAUDE_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:4321/callback");
  assert.equal(url.searchParams.get("code_challenge"), "ch-abc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st-1");
  assert.equal(
    url.searchParams.get("scope"),
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
  );
  assert.equal(url.searchParams.get("scope"), CLAUDE_SCOPE);
});

// ---------- token endpoint ----------

test("exchangeClaudeCode posts the authorization_code grant and maps the response", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return jsonResponse({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 28800,
      scope: "user:inference user:profile",
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
  };
  const auth = await exchangeClaudeCode({ code: "c-9", codeVerifier: "v-9", redirectUri: "http://localhost:4321/callback", state: "st-9", fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_TOKEN_URL);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].body.grant_type, "authorization_code");
  assert.equal(calls[0].body.code, "c-9");
  assert.equal(calls[0].body.code_verifier, "v-9");
  assert.equal(calls[0].body.redirect_uri, "http://localhost:4321/callback");
  assert.equal(calls[0].body.client_id, CLAUDE_CLIENT_ID);
  assert.equal(calls[0].body.state, "st-9");
  assert.equal(auth.access, "at-1");
  assert.equal(auth.refresh, "rt-1");
  assert.ok(auth.expires > Date.now() + 28000 * 1000);
  assert.equal(auth.scopes, "user:inference user:profile");
  assert.equal(auth.subscriptionType, "max");
  assert.equal(auth.rateLimitTier, "default_claude_max_20x");
});

test("refreshClaudeToken keeps the previous refresh token when rotation is absent", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return jsonResponse({ access_token: "at-2", expires_in: 3600 }); // no refresh_token
  };
  const auth = await refreshClaudeToken(
    { access: "at-1", refresh: "rt-1", scopes: "user:inference user:profile", subscriptionType: "max" },
    { fetchFn }
  );
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.equal(calls[0].body.refresh_token, "rt-1");
  assert.equal(calls[0].body.client_id, CLAUDE_CLIENT_ID);
  assert.equal(auth.refresh, "rt-1");
  assert.equal(auth.subscriptionType, "max"); // preserved
});

test("claudeTokenNeedsRefresh: missing access/expiry or near expiry", () => {
  const now = Date.now();
  assert.equal(claudeTokenNeedsRefresh(null, now), true);
  assert.equal(claudeTokenNeedsRefresh({ access: "a", expires: 0 }, now), true);
  assert.equal(claudeTokenNeedsRefresh({ access: "a", expires: now + 60_000 }, now), true);
  assert.equal(claudeTokenNeedsRefresh({ access: "a", expires: now + 3600_000 }, now), false);
});

// ---------- pasted-code exchange ----------

test("exchangePastedClaudeCode strips the state suffix from a manual code", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return jsonResponse({ access_token: "at-1", expires_in: 3600 });
  };
  await exchangePastedClaudeCode({
    code: "c-1#st-1",
    codeVerifier: "v-1",
    redirectUris: ["https://platform.claude.com/oauth/code/callback"],
    state: "st-1",
    fetchFn,
  });
  assert.equal(calls[0].code, "c-1");
  assert.equal(calls[0].state, "st-1");
});

test("exchangePastedClaudeCode rejects a manual code from another login", async () => {
  let requested = false;
  await assert.rejects(
    exchangePastedClaudeCode({
      code: "c-1#stale-state",
      codeVerifier: "v-1",
      redirectUris: ["https://platform.claude.com/oauth/code/callback"],
      state: "current-state",
      fetchFn: async () => { requested = true; },
    }),
    /does not match the current login/
  );
  assert.equal(requested, false);
});

test("exchangePastedClaudeCode succeeds on the first redirect_uri without extra attempts", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.redirect_uri);
    return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
  };
  const auth = await exchangePastedClaudeCode({
    code: "c-1",
    codeVerifier: "v-1",
    redirectUris: ["https://platform.claude.com/oauth/code/callback", "http://localhost:4321/callback"],
    state: "st-1",
    fetchFn,
  });
  assert.deepEqual(calls, ["https://platform.claude.com/oauth/code/callback"]);
  assert.equal(auth.access, "at-1");
});

test("exchangePastedClaudeCode falls back to the primary redirect_uri when the manual one is rejected", async () => {
  const calls = [];
  const manual = "https://platform.claude.com/oauth/code/callback";
  const local = "http://localhost:4321/callback";
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.redirect_uri);
    if (body.redirect_uri === manual) return jsonResponse({ error: "invalid 'code' in request" }, 400);
    return jsonResponse({ access_token: "at-2", expires_in: 3600 });
  };
  const auth = await exchangePastedClaudeCode({
    code: "c-2",
    codeVerifier: "v-2",
    redirectUris: [manual, local],
    state: "st-2",
    fetchFn,
  });
  assert.deepEqual(calls, [manual, local]);
  assert.equal(auth.access, "at-2");
});

test("exchangePastedClaudeCode throws the first error when every redirect_uri is rejected", async () => {
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.redirect_uri.includes("localhost")) return jsonResponse({ error: "second failure" }, 400);
    return jsonResponse({ error: "invalid 'code' in request" }, 400);
  };
  await assert.rejects(
    exchangePastedClaudeCode({
      code: "c-3",
      codeVerifier: "v-3",
      redirectUris: ["https://platform.claude.com/oauth/code/callback", "http://localhost:4321/callback"],
      fetchFn,
    }),
    /invalid 'code' in request/
  );
});

test("exchangePastedClaudeCode refuses to run without redirect_uris", async () => {
  await assert.rejects(
    exchangePastedClaudeCode({ code: "c", codeVerifier: "v", redirectUris: [], fetchFn: async () => { throw new Error("no"); } }),
    /no redirect_uris/
  );
});

// ---------- usage parsing ----------

const usageJson = {
  five_hour: { utilization: 42.5, resets_at: "2026-09-01T18:00:00Z" },
  seven_day: { utilization: 0.15, resets_at: "2026-09-04T09:30:00.123456+00:00" },
  seven_day_opus: { utilization: 80, resets_at: "2026-09-04T09:30:00Z" },
  limits: [
    { kind: "weekly_scoped", percent: 81, resets_at: "2026-09-04T09:30:00Z", scope: { model: { display_name: "Opus" } } },
    { kind: "weekly_scoped", percent: 12, resets_at: "2026-09-04T09:30:00Z", scope: { model: { display_name: "Sonnet" } } },
  ],
  spend: { enabled: true, percent: 45, used: { amount_minor: 12345, exponent: 2, currency: "USD" } },
};

test("parseClaudeUsage maps windows, dedupes per-model weeklies, formats spend", () => {
  const parsed = parseClaudeUsage(usageJson);
  assert.deepEqual(parsed.windows.map((w) => w.key), ["5h", "7d", "7d-opus", "7d-sonnet"]);
  const [w5h, w7d, wOpus, wSonnet] = parsed.windows;
  assert.equal(w5h.label, "5-Hour");
  assert.equal(w5h.usedPct, 42.5);
  assert.equal(w5h.resetAt, Date.parse("2026-09-01T18:00:00Z"));
  assert.equal(w7d.usedPct, 15); // 0–1 fraction scaled
  assert.equal(w7d.resetAt, Date.parse("2026-09-04T09:30:00.123456+00:00"));
  assert.equal(wOpus.usedPct, 80); // limits[] duplicate of seven_day_opus dropped
  assert.equal(wOpus.label, "7-Day (Opus)");
  assert.equal(wSonnet.usedPct, 12);
  assert.deepEqual(parsed.extras, [{ label: "Spend", text: "123.45 USD (45% of cap)" }]);
});

test("parseClaudeUsage returns null when nothing recognizable", () => {
  assert.equal(parseClaudeUsage(null), null);
  assert.equal(parseClaudeUsage({}), null);
  assert.equal(parseClaudeUsage({ codename: "atlas" }), null);
});

test("parseClaudeUsage tolerates percent fields and missing resets", () => {
  const parsed = parseClaudeUsage({ seven_day: { percent: 30 } });
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0].usedPct, 30);
  assert.equal(parsed.windows[0].resetAt, null);
});

// ---------- plan label / profile ----------

test("claudePlanLabel: Max tiers and plain subscription types", () => {
  assert.equal(claudePlanLabel({ rateLimitTier: "default_claude_max_20x" }), "Max 20x");
  assert.equal(claudePlanLabel({ rateLimitTier: "default_claude_max_5x" }), "Max 5x");
  assert.equal(claudePlanLabel({ subscriptionType: "max" }), "Max");
  assert.equal(claudePlanLabel({ subscriptionType: "pro" }), "Pro");
  assert.equal(claudePlanLabel({}), null);
});

test("parseClaudeProfile picks plan metadata across spellings", () => {
  assert.deepEqual(
    parseClaudeProfile({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }),
    { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }
  );
  assert.deepEqual(parseClaudeProfile({ subscription: { type: "pro" } }), { subscriptionType: "pro" });
  assert.equal(parseClaudeProfile({ email: "a@b.c" }), null);
});

// ---------- provider ----------

test("getClaude: disconnected card with claude slug when the store has no entry", async () => {
  const file = tmp();
  const p = await getClaude({ authPath: file, fetchFn: async () => { throw new Error("should not fetch"); } });
  assert.equal(p.name, "Claude");
  assert.equal(p.connected, false);
  assert.equal(p.error, "not connected");
  assert.equal(p.auth.slug, "claude");
  assert.deepEqual(p.windows, []);
});

test("getClaude: happy path backfills plan metadata from the profile and persists it", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000, scopes: "user:inference user:profile" }, file);
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url === CLAUDE_USAGE_URL) return jsonResponse(usageJson);
    if (url === CLAUDE_PROFILE_URL) {
      return jsonResponse({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" });
    }
    throw new Error("unexpected " + url);
  };
  const p = await getClaude({ authPath: file, fetchFn });
  assert.equal(p.connected, true);
  assert.equal(p.error, null);
  assert.equal(p.plan, "Max 20x");
  assert.equal(p.windows.length, 4);
  const stored = readClaudeOauth(file);
  assert.equal(stored.rateLimitTier, "default_claude_max_20x");
  // Second call: plan already known, no profile fetch.
  urls.length = 0;
  await getClaude({ authPath: file, fetchFn });
  assert.deepEqual(urls, [CLAUDE_USAGE_URL]);
});

test("getClaude: expired token refreshes, writes back, then reports usage", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-old", refresh: "rt-1", expires: Date.now() - 1000, scopes: "user:inference user:profile", rateLimitTier: "default_claude_max_20x" }, file);
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url === CLAUDE_TOKEN_URL) return jsonResponse({ access_token: "at-new", refresh_token: "rt-2", expires_in: 3600 });
    if (url === CLAUDE_USAGE_URL) return jsonResponse(usageJson);
    throw new Error("unexpected " + url);
  };
  const p = await getClaude({ authPath: file, fetchFn });
  assert.equal(calls[0].url, CLAUDE_TOKEN_URL);
  assert.equal(calls[0].body.grant_type, "refresh_token");
  assert.equal(calls[1].url, CLAUDE_USAGE_URL);
  assert.equal(p.connected, true);
  assert.equal(p.plan, "Max 20x");
  const stored = readClaudeOauth(file);
  assert.equal(stored.access, "at-new");
  assert.equal(stored.refresh, "rt-2");
});

test("getClaude: 401 on usage becomes session-expired reconnect card", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000 }, file);
  const p = await getClaude({ authPath: file, fetchFn: async () => ({ ok: false, status: 401, text: async () => "no" }) });
  assert.equal(p.connected, false);
  assert.equal(p.error, "session expired — reconnect");
  assert.equal(p.auth.slug, "claude");
});

test("getClaude: 403 on usage surfaces Anthropic's permission reason", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000 }, file);
  const p = await getClaude({
    authPath: file,
    fetchFn: async () => jsonResponse({
      type: "error",
      error: { type: "permission_error", message: "OAuth authentication is currently not allowed for this organization." },
    }, 403),
  });
  assert.equal(p.connected, true);
  assert.equal(p.error, "OAuth authentication is currently not allowed for this organization.");
});

test("getClaude prefers the Claude CLI session over a blocked dashboard OAuth session", async () => {
  const file = tmp();
  const cliFile = tmp();
  writeClaudeOauth({ type: "oauth", access: "blocked-dashboard-token", expires: Date.now() + 3600_000 }, file);
  fs.writeFileSync(cliFile, JSON.stringify({
    claudeAiOauth: {
      accessToken: "working-cli-token",
      refreshToken: "cli-refresh",
      expiresAt: Date.now() + 3600_000,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  }));
  const p = await getClaude({
    authPath: file,
    cliCredentialsPath: cliFile,
    fetchFn: async (url, opts) => {
      assert.equal(url, CLAUDE_USAGE_URL);
      assert.equal(opts.headers.Authorization, "Bearer working-cli-token");
      return jsonResponse(usageJson);
    },
  });
  assert.equal(p.connected, true);
  assert.equal(p.error, null);
  assert.equal(p.plan, "Max 20x");
});

test("refreshing a Claude CLI session preserves its credential file schema and unrelated data", async () => {
  const cliFile = tmp();
  fs.writeFileSync(cliFile, JSON.stringify({
    unrelated: { keep: true },
    claudeAiOauth: {
      accessToken: "old-cli-token",
      refreshToken: "old-cli-refresh",
      expiresAt: Date.now() - 1000,
      refreshTokenExpiresAt: Date.now() + 86400_000,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "max",
    },
  }));
  const auth = await ensureClaudeToken({
    authPath: tmp(),
    cliCredentialsPath: cliFile,
    fetchFn: async () => jsonResponse({
      access_token: "new-cli-token",
      refresh_token: "new-cli-refresh",
      expires_in: 3600,
    }),
  });
  assert.equal(auth.access, "new-cli-token");
  const stored = JSON.parse(fs.readFileSync(cliFile, "utf8"));
  assert.deepEqual(stored.unrelated, { keep: true });
  assert.equal(stored.claudeAiOauth.accessToken, "new-cli-token");
  assert.equal(stored.claudeAiOauth.refreshToken, "new-cli-refresh");
  assert.deepEqual(stored.claudeAiOauth.scopes, ["user:profile", "user:inference"]);
  assert.ok(stored.claudeAiOauth.refreshTokenExpiresAt > Date.now());
  assert.equal(readClaudeCliOauth(cliFile).access, "new-cli-token");
});

test("getClaude: incomplete scope metadata does not override a successful usage probe", async () => {
  const file = tmp();
  writeClaudeOauth({
    type: "oauth",
    access: "at-1",
    refresh: "rt-1",
    expires: Date.now() + 3600_000,
    scopes: "user:profile",
  }, file);
  const p = await getClaude({
    authPath: file,
    fetchFn: async (url) => {
      assert.equal(url, CLAUDE_USAGE_URL);
      return jsonResponse(usageJson);
    },
  });
  assert.equal(p.connected, true);
  assert.equal(p.error, null);
  assert.equal(readClaudeOauth(file).access, "at-1");
});

test("getClaude: 429 on usage surfaces the retry-after hint as retryAfterMs", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-1", refresh: "rt-1", expires: Date.now() + 3600_000 }, file);
  const res = (headers) => ({ ok: false, status: 429, headers, text: async () => "" });
  const withHint = await getClaude({
    authPath: file,
    fetchFn: async () => res({ get: (n) => (n === "retry-after" ? "30" : null) }),
  });
  assert.equal(withHint.error, "HTTP 429");
  assert.equal(withHint.retryAfterMs, 30000);
  const without = await getClaude({ authPath: file, fetchFn: async () => res(undefined) });
  assert.equal(without.error, "HTTP 429");
  assert.equal(without.retryAfterMs, null);
});

test("getClaude: dead refresh token clears the entry and reconnects", async () => {
  const file = tmp();
  writeClaudeOauth({ type: "oauth", access: "at-old", refresh: "rt-dead", expires: Date.now() - 1000 }, file);
  const fetchFn = async () => jsonResponse({ error: "invalid_grant", error_description: "refresh token is invalid" }, 400);
  const p = await getClaude({ authPath: file, fetchFn });
  assert.equal(p.connected, false);
  assert.equal(p.error, "session expired — reconnect");
  assert.equal(readClaudeOauth(file), null);
});

test("ensureClaudeToken returns null without fetching when nothing is stored", async () => {
  const file = tmp();
  assert.equal(await ensureClaudeToken({ authPath: file, fetchFn: async () => { throw new Error("no"); } }), null);
});

test("token endpoint object-shaped errors become readable messages", async () => {
  const fetchFn = async () => jsonResponse({ error: { type: "invalid_request", message: "code challenge mismatch" } }, 400);
  await assert.rejects(
    exchangeClaudeCode({ code: "c", codeVerifier: "v", redirectUri: "http://localhost:4321/callback", fetchFn }),
    /code challenge mismatch/
  );
  await assert.rejects(
    refreshClaudeToken({ access: "a", refresh: "rt" }, { fetchFn: async () => jsonResponse({ error: "rate_limited" }, 429) }),
    /rate_limited/
  );
});

// ---------- ping ----------

test("claudePing posts a one-token message with the required Anthropic headers", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return jsonResponse({ id: "msg_1", content: [{ type: "text", text: "!" }] });
  };
  await claudePing({ fetchFn, auth: { access: "at-1" }, model: "claude-haiku-4-5" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAUDE_MESSAGES_URL);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer at-1");
  assert.equal(calls[0].opts.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].opts.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(calls[0].body.model, "claude-haiku-4-5");
  assert.equal(calls[0].body.max_tokens, 1);
});
