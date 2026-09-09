import test from "node:test";
import assert from "node:assert/strict";
import { createResetScheduler } from "../lib/reset-scheduler.js";

test("scheduler checks immediately, then waits until the auto-armer's next check", async () => {
  let now = 1000;
  let fetches = 0;
  let scheduled;
  const scheduler = createResetScheduler({
    fetchProvider: async () => ({ name: "Codex", fetch: ++fetches }),
    autoArmer: {
      check: async (provider) => ({ provider, nextCheckAt: now + 5000 }),
    },
    now: () => now,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.equal(scheduled.delay, 5000);

  now += 5000;
  scheduled.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 2);
  scheduler.stop();
});

test("scheduler coalesces overlapping dashboard and scheduled checks", async () => {
  let release;
  let fetches = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = createResetScheduler({
    fetchProvider: async () => { fetches++; await pending; return { name: "GLM" }; },
    autoArmer: { check: async (provider) => ({ provider, nextCheckAt: 10_000 }) },
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
  });

  const first = scheduler.checkNow();
  const second = scheduler.checkNow();
  release();
  assert.equal(await first, await second);
  assert.equal(fetches, 1);
});

test("scheduler retries after a failed provider query", async () => {
  let scheduled;
  const scheduler = createResetScheduler({
    fetchProvider: async () => { throw new Error("offline"); },
    autoArmer: { check: async () => { throw new Error("must not run"); } },
    now: () => 2000,
    retryMs: 300_000,
    onError: () => {},
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.delay, 300_000);
  scheduler.stop();
});

test("scheduler never arms when shouldArm is false and idles until the nearest window reset", async () => {
  let now = 1000;
  let checks = 0;
  let scheduled;
  const scheduler = createResetScheduler({
    fetchProvider: async () => ({
      name: "Claude",
      windows: [
        { key: "5h", resetAt: now + 60_000 },
        { key: "7d", resetAt: now + 500_000 },
      ],
    }),
    autoArmer: { check: async () => { checks++; throw new Error("must not arm"); } },
    shouldArm: () => false,
    now: () => now,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 0);
  assert.equal(scheduled.delay, 62_000); // nearest reset + 2s grace
  scheduler.stop();
});

test("scheduler with arming disabled and no live windows falls back to the retry interval", async () => {
  let scheduled;
  const scheduler = createResetScheduler({
    fetchProvider: async () => ({ name: "Claude", windows: [{ key: "5h", resetAt: null }] }),
    autoArmer: { check: async () => { throw new Error("must not arm"); } },
    shouldArm: () => false,
    now: () => 5000,
    retryMs: 120_000,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.delay, 120_000);
  scheduler.stop();
});

test("scheduler consults shouldArm on every check so live setting flips apply", async () => {
  let now = 1000;
  let armed = false;
  let arms = 0;
  let scheduled;
  const scheduler = createResetScheduler({
    fetchProvider: async () => ({ name: "GLM", windows: [{ key: "5h", usedPct: 0, resetAt: null }] }),
    autoArmer: { check: async (provider) => { arms++; return { provider, nextCheckAt: now + 10_000 }; } },
    shouldArm: () => armed,
    now: () => now,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(arms, 0); // disabled at first check
  now += 5_000;
  scheduled.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(arms, 0); // still disabled
  armed = true;
  now += 5_000;
  scheduled.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(arms, 1); // flip picked up without restart
  scheduler.stop();
});
