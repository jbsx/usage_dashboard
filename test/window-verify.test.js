import test from "node:test";
import assert from "node:assert/strict";
import { createWindowVerifier, windowSignature } from "../lib/window-verify.js";

test("windowSignature is order-insensitive and keyed on key + label", () => {
  const a = { name: "Codex", windows: [{ key: "7d", label: "7-Day" }, { key: "5h", label: "5-Hour" }] };
  const b = { name: "Codex", windows: [{ key: "5h", label: "5-Hour" }, { key: "7d", label: "7-Day" }] };
  assert.equal(windowSignature(a), windowSignature(b));
  assert.notEqual(windowSignature(a), windowSignature({ windows: [{ key: "5h", label: "5-Hour" }] }));
});

test("verifier schedules the first pass one interval out; boot fetches belong to the schedulers", async () => {
  const fetches = [];
  let scheduled;
  const verifier = createWindowVerifier({
    providers: [{ fetch: async () => { fetches.push("GLM"); return { name: "GLM", windows: [{ key: "5h" }] }; } }],
    intervalMs: 86_400_000,
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  verifier.start();
  assert.equal(scheduled.delay, 86_400_000);
  assert.equal(fetches.length, 0);

  scheduled.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetches, ["GLM"]);
  verifier.stop();
});

test("verifier reports a changed window set between daily passes", async () => {
  let plan = "pro";
  const seen = [];
  const verifier = createWindowVerifier({
    providers: [{
      fetch: async () => plan === "pro"
        ? { name: "Codex", windows: [{ key: "5h", label: "5-Hour" }] }
        : { name: "Codex", windows: [{ key: "7d", label: "7-Day" }] },
    }],
    onVerify: (changes) => seen.push(changes),
  });

  assert.deepEqual(await verifier.verify(), []); // baseline, no change reported
  plan = "prolite";
  const changes = await verifier.verify();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "Codex");
  assert.equal(changes[0].from, "5h:5-Hour");
  assert.equal(changes[0].to, "7d:7-Day");
  assert.deepEqual(seen[1], changes);
});

test("verifier keeps the last known classification when a pass yields no windows", async () => {
  let healthy = true;
  const verifier = createWindowVerifier({
    providers: [{
      fetch: async () => healthy
        ? { name: "Codex", windows: [{ key: "5h", label: "5-Hour" }] }
        : { name: "Codex", connected: true, error: "HTTP 429", windows: [] },
    }],
  });

  await verifier.verify();
  healthy = false;
  assert.deepEqual(await verifier.verify(), []); // not a classification change
});

test("verifier isolates provider failures and keeps scheduling", async () => {
  const errors = [];
  let fetches = 0;
  let scheduled;
  const verifier = createWindowVerifier({
    providers: [
      { fetch: async () => { throw new Error("offline"); } },
      { fetch: async () => { fetches++; return { name: "GLM", windows: [{ key: "5h" }] }; } },
    ],
    intervalMs: 1000,
    onError: (e) => errors.push(e.message),
    setTimer: (fn, delay) => { scheduled = { fn, delay }; return 1; },
    clearTimer: () => {},
  });

  verifier.start();
  scheduled.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["offline"]);
  assert.equal(fetches, 1);
  assert.ok(scheduled, "rescheduled for the next day");
  verifier.stop();
});
