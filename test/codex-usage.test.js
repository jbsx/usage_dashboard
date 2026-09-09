import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexUsageResponse, tokenNeedsRefresh } from "../lib/codex-usage.js";

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;

test("parseCodexUsageResponse: expired sessions are disconnected and reconnectable", () => {
  const provider = parseCodexUsageResponse(401, {
    error: { code: "token_expired", message: "Provided authentication token is expired." },
  });

  assert.equal(provider.connected, false);
  assert.equal(provider.error, "session expired — reconnect");
  assert.deepEqual(provider.windows, []);
  assert.equal(provider.auth.slug, "codex");
});

test("parseCodexUsageResponse: valid rate-limit windows become metrics", () => {
  const provider = parseCodexUsageResponse(200, {
    plan_type: "plus",
    rate_limit: {
      primary_window: { limit_window_seconds: 18_000, used_percent: 25, reset_at: 2000 },
      secondary_window: { limit_window_seconds: 604_800, used_percent: 10, reset_at: 3000 },
    },
  });

  assert.equal(provider.connected, true);
  assert.equal(provider.windows.length, 2);
  assert.deepEqual(provider.windows[0], {
    key: "5h", label: "5-Hour", unit: "percent", usedPct: 25,
    used: null, limit: null, remaining: null, resetAt: 2_000_000,
  });
});

test("parseCodexUsageResponse: window keys come from the duration, not the slot", () => {
  // prolite reports its 7-day limit as primary_window (no 5-hour limit exists)
  const provider = parseCodexUsageResponse(200, {
    plan_type: "prolite",
    rate_limit: {
      primary_window: { limit_window_seconds: 604_800, used_percent: 18, reset_at: 2000 },
    },
    additional_rate_limits: [
      { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { limit_window_seconds: 604_800, used_percent: 0 } },
    ],
  });

  assert.equal(provider.windows[0].key, "7d");
  assert.equal(provider.windows[0].label, "7-Day");
  assert.equal(provider.windows.length, 2);
  assert.equal(provider.windows[1].key, "GPT-5.3-Codex-Spark");
  assert.equal(provider.windows[1].label, "7-Day");
});

test("parseCodexUsageResponse: a 5-hour limit in the secondary slot is keyed 5h", () => {
  const provider = parseCodexUsageResponse(200, {
    rate_limit: {
      primary_window: { limit_window_seconds: 604_800, used_percent: 1 },
      secondary_window: { limit_window_seconds: 18_000, used_percent: 2 },
    },
  });

  assert.deepEqual(provider.windows.map((w) => w.key), ["7d", "5h"]);
  assert.deepEqual(provider.windows.map((w) => w.label), ["7-Day", "5-Hour"]);
});

test("parseCodexUsageResponse: missing duration falls back to slot keys", () => {
  const provider = parseCodexUsageResponse(200, {
    rate_limit: {
      primary_window: { used_percent: 10 },
      secondary_window: { used_percent: 20 },
    },
  });

  assert.deepEqual(provider.windows.map((w) => w.key), ["5h", "7d"]);
  assert.deepEqual(provider.windows.map((w) => w.label), ["", ""]);
});

test("tokenNeedsRefresh: checks access-token expiry before ID-token expiry", () => {
  const now = 1_700_000_000_000;
  const auth = { tokens: {
    access_token: jwt({ exp: now / 1000 - 1 }),
    id_token: jwt({ exp: now / 1000 + 3600 }),
  } };

  assert.equal(tokenNeedsRefresh(auth, now), true);
});
