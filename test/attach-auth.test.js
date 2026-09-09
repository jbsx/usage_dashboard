import test from "node:test";
import assert from "node:assert/strict";
import { attachLiveAuth } from "../lib/attach-auth.js";

test("attachLiveAuth: cached Grok card picks up a live device-login pending", () => {
  const cached = {
    updatedAt: 1,
    providers: [
      { name: "GLM", connected: true, auth: undefined },
      { name: "Grok", connected: false, error: "not connected", auth: { slug: "grok", pending: null } },
    ],
  };
  const live = attachLiveAuth(cached, {
    grokPending: { user_code: "ABCD-EFGH", verification_url: "https://accounts.x.ai/oauth2/device", error: null },
  });
  assert.equal(cached.providers[1].auth.pending, null, "must not mutate the cache");
  assert.equal(live.providers[1].auth.pending.user_code, "ABCD-EFGH");
  assert.equal(live.providers[1].auth.slug, "grok");
});

test("attachLiveAuth: connected Grok is left alone", () => {
  const cached = { providers: [{ name: "Grok", connected: true, windows: [{ key: "7d" }] }] };
  const live = attachLiveAuth(cached, { grokPending: { user_code: "X" } });
  assert.equal(live.providers[0].connected, true);
  assert.equal(live.providers[0].auth, undefined);
  assert.equal(live.providers[0].autoArm, undefined);
});

test("attachLiveAuth: disconnected Claude card picks up the authorize pending", () => {
  const cached = {
    providers: [{ name: "Claude", connected: false, error: "not connected", windows: [], extras: [] }],
  };
  const live = attachLiveAuth(cached, {
    claudePending: {
      mode: "authorize",
      verification_url: "https://platform.claude.com/oauth/authorize?...",
      manual_url: "https://platform.claude.com/oauth/authorize?...",
      error: null,
    },
  });
  assert.equal(live.providers[0].auth.slug, "claude");
  assert.equal(live.providers[0].auth.pending.mode, "authorize");
  assert.ok(live.providers[0].auth.pending.verification_url.startsWith("https://"));
});

test("attachLiveAuth: auto-arm availability and setting attached to GLM/Codex/Claude only", () => {
  const cached = {
    providers: [
      { name: "GLM", connected: true },
      { name: "Codex", connected: true },
      { name: "Claude", connected: true },
      { name: "Grok", connected: true },
    ],
  };
  // attachLiveAuth applies the map as given (server passes the merged
  // readAutoArmSettings() output, which supplies the per-provider defaults).
  const live = attachLiveAuth(cached, { autoArm: { GLM: true, Codex: false, Claude: false } });
  assert.deepEqual(live.providers[0].autoArm, { available: true, enabled: true });
  assert.deepEqual(live.providers[1].autoArm, { available: true, enabled: false });
  assert.deepEqual(live.providers[2].autoArm, { available: true, enabled: false }); // Claude default off
  assert.equal(live.providers[3].autoArm, undefined);
});

test("attachLiveAuth: canLogout marks the OAuth providers, not GLM", () => {
  const cached = {
    providers: [
      { name: "GLM", connected: true },
      { name: "Grok", connected: true },
      { name: "Codex", connected: false },
      { name: "Claude", connected: false },
    ],
  };
  const live = attachLiveAuth(cached, {});
  assert.equal(live.providers[0].canLogout, undefined);
  assert.equal(live.providers[1].canLogout, true);
  assert.equal(live.providers[2].canLogout, true);
  assert.equal(live.providers[3].canLogout, true);
  // disconnected cards keep their connect UI alongside the flag
  assert.equal(live.providers[3].auth.slug, "claude");
});

test("attachLiveAuth: Claude CLI-backed auth cannot be logged out by the dashboard", () => {
  const cached = { providers: [{ name: "Claude", connected: true }] };
  const live = attachLiveAuth(cached, { claudeCanLogout: false });
  assert.equal(live.providers[0].canLogout, undefined);
});

test("attachLiveAuth: cached Claude card picks up a live authorize pending", () => {
  const cached = {
    providers: [{ name: "Claude", connected: false, auth: { slug: "claude", pending: null } }],
  };
  const live = attachLiveAuth(cached, {
    claudePending: { mode: "authorize", verification_url: "https://platform.claude.com/oauth/authorize", manual_url: null, error: null },
  });
  assert.equal(cached.providers[0].auth.pending, null, "must not mutate the cache");
  assert.equal(live.providers[0].auth.pending.verification_url, "https://platform.claude.com/oauth/authorize");
});
