import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GROK_CREDITS_URL,
  GROK_SUBSCRIPTIONS_URL,
  XAI_CLIENT_ID,
  XAI_TOKEN_URL,
  getGrok,
  parseCredits,
  parsePlan,
  refreshXaiToken,
  tokenNeedsRefresh,
  writeXaiAuth,
} from "../lib/grok.js";
import { writeAuthEntry } from "../lib/dash-auth.js";

const creditsPayload = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-22T14:49:19.617849+00:00",
      end: "2026-08-29T14:49:19.617849+00:00",
    },
    creditUsagePercent: 21,
    billingPeriodEnd: "2026-08-29T14:49:19.617849+00:00",
  },
};

test("parseCredits: weekly used percent and reset time", () => {
  const w = parseCredits(creditsPayload);
  assert.equal(w.key, "7d");
  assert.equal(w.label, "Weekly");
  assert.equal(w.usedPct, 21);
  assert.equal(w.resetAt, Date.parse("2026-08-29T14:49:19.617849+00:00"));
});

test("parseCredits: omitted creditUsagePercent is 0% used", () => {
  const w = parseCredits({
    config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-29T00:00:00Z" } },
  });
  assert.equal(w.usedPct, 0);
  assert.equal(w.key, "7d");
});

test("parsePlan: active Grok Pro subscription", () => {
  assert.equal(parsePlan({
    subscriptions: [
      { tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_INACTIVE" },
      { tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_ACTIVE" },
    ],
  }), "Grok Pro");
});

test("tokenNeedsRefresh: expired expires timestamp", () => {
  assert.equal(tokenNeedsRefresh({ access: "x", refresh: "y", expires: 1 }, 100000), true);
  assert.equal(tokenNeedsRefresh({ access: "x", refresh: "y", expires: Date.now() + 3600000 }), false);
});

test("refreshXaiToken: posts refresh_token grant and maps the response", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    };
  };
  const next = await refreshXaiToken({ access: "old", refresh: "rt-1" }, { fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, XAI_TOKEN_URL);
  assert.equal(calls[0].opts.method, "POST");
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "rt-1");
  assert.equal(body.get("client_id"), XAI_CLIENT_ID);
  assert.equal(next.access, "new-at");
  assert.equal(next.refresh, "new-rt");
  assert.ok(next.expires > Date.now());
});

test("getGrok: disconnected when the dashboard store has no xai oauth", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-"));
  const authPath = path.join(dir, "auth.json");
  writeAuthEntry("openai", { type: "oauth", access: "x" }, authPath);
  const p = await getGrok({ authPath, fetchFn: async () => { throw new Error("should not fetch"); } });
  assert.equal(p.name, "Grok");
  assert.equal(p.connected, false);
  assert.equal(p.auth.slug, "grok");
});

test("getGrok: maps credits + plan from the stored xai oauth", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-"));
  const authPath = path.join(dir, "auth.json");
  writeXaiAuth({
    type: "oauth",
    access: "at-live",
    refresh: "rt",
    expires: Date.now() + 3600000,
  }, authPath);
  const fetchFn = async (url) => {
    if (url === GROK_CREDITS_URL) {
      return { status: 200, text: async () => JSON.stringify(creditsPayload) };
    }
    if (url === GROK_SUBSCRIPTIONS_URL) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          subscriptions: [{ tier: "SUBSCRIPTION_TIER_GROK_PRO", status: "SUBSCRIPTION_STATUS_ACTIVE" }],
        }),
      };
    }
    throw new Error("unexpected " + url);
  };
  const p = await getGrok({ authPath, fetchFn });
  assert.equal(p.connected, true);
  assert.equal(p.plan, "Grok Pro");
  assert.equal(p.windows.length, 1);
  assert.equal(p.windows[0].usedPct, 21);
  assert.equal(p.windows[0].label, "Weekly");
});

test("getGrok: non-JSON credits response surfaces the status and retry-after hint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auth-"));
  const authPath = path.join(dir, "auth.json");
  writeXaiAuth({ type: "oauth", access: "at-live", refresh: "rt", expires: Date.now() + 3600000 }, authPath);
  const res = (headers) => ({ status: 500, headers, text: async () => "<html>Internal Server Error</html>" });
  const withHint = await getGrok({
    authPath,
    fetchFn: async () => res({ get: (n) => (n === "retry-after" ? "120" : null) }),
  });
  assert.equal(withHint.connected, true);
  assert.equal(withHint.error, "HTTP 500");
  assert.equal(withHint.retryAfterMs, 120000);
  const without = await getGrok({ authPath, fetchFn: async () => res(undefined) });
  assert.equal(without.error, "HTTP 500");
  assert.equal(without.retryAfterMs, null);
});
