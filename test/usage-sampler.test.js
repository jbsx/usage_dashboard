import test from "node:test";
import assert from "node:assert/strict";
import { createUsageSampler } from "../lib/usage-sampler.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("sampler takes a snapshot on start and again after each interval", async () => {
  let samples = 0;
  let scheduled;
  const sampler = createUsageSampler({
    sample: async () => { samples++; },
    intervalMs: 60_000,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  sampler.start();
  await flush();
  assert.equal(samples, 1);
  assert.equal(scheduled.delay, 60_000);

  scheduled.fn();
  await flush();
  assert.equal(samples, 2);
  sampler.stop();
});

test("sampler keeps its cadence after a failed snapshot", async () => {
  let scheduled;
  const errors = [];
  const sampler = createUsageSampler({
    sample: async () => { throw new Error("offline"); },
    intervalMs: 5_000,
    onError: (e) => errors.push(e.message),
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  sampler.start();
  await flush();
  assert.deepEqual(errors, ["offline"]);
  assert.equal(scheduled.delay, 5_000);
  sampler.stop();
});

test("sampler does not overlap ticks while a snapshot is still in flight", async () => {
  let release;
  let inFlight = 0;
  let maxInFlight = 0;
  let scheduled = null;
  const sampler = createUsageSampler({
    sample: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => { release = resolve; });
      inFlight--;
    },
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  sampler.start();
  await flush();
  // Nothing is scheduled until the first sample resolves.
  assert.equal(scheduled, null);
  release();
  await flush();
  assert.ok(scheduled);
  assert.equal(maxInFlight, 1);
  sampler.stop();
});

test("stop cancels the pending tick and start is idempotent", async () => {
  let cleared = 0;
  let samples = 0;
  const sampler = createUsageSampler({
    sample: async () => { samples++; },
    setTimer: () => 7,
    clearTimer: (id) => { if (id === 7) cleared++; },
  });

  sampler.start();
  sampler.start();
  await flush();
  assert.equal(samples, 1);
  sampler.stop();
  assert.equal(cleared, 1);
});
