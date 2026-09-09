import test from "node:test";
import assert from "node:assert/strict";
import { createUsageCache } from "../lib/usage-cache.js";

const good = {
  name: "Claude",
  connected: true,
  plan: "Max 20x",
  error: null,
  windows: [{ key: "5h", label: "5-Hour", unit: "percent", usedPct: 10, used: null, limit: null, remaining: null, resetAt: 1e15 }],
  extras: [{ label: "Spend", text: "1.00 USD (1% of cap)" }],
};
const err429 = (retryAfterMs = null) => ({
  name: "Claude",
  connected: true,
  plan: "Max 20x",
  error: "HTTP 429",
  retryAfterMs,
  windows: [],
  extras: [],
});

// Deterministic clock; results may be a provider or a () => provider thunk
// (thunks are evaluated at fetch time, after the clock has advanced).
function setup(results, opts = {}) {
  let t = 1_000_000;
  const calls = [];
  const cache = createUsageCache({
    fetchProvider: async () => {
      calls.push(t);
      const r = results.shift();
      return typeof r === "function" ? r() : r;
    },
    now: () => t,
    ...opts,
  });
  return { cache, calls, tick: (ms) => { t += ms; } };
}

const notes = (p) => (p.extras || []).filter((x) => x.label === "Refresh").map((x) => x.text);

test("fresh success is served for the ttl without refetching", async () => {
  const { cache, calls, tick } = setup([good, good]);
  const p1 = await cache.get();
  tick(5 * 60 * 1000 - 1);
  const p2 = await cache.get();
  assert.equal(calls.length, 1);
  assert.equal(p2, p1);
  tick(1);
  await cache.get();
  assert.equal(calls.length, 2);
});

test("transient failure keeps last good data with a single stale note", async () => {
  const { cache, tick } = setup([good, err429(), err429()]);
  await cache.get();
  tick(5 * 60 * 1000);
  const stale1 = await cache.get(); // 429 -> stale serving
  assert.equal(stale1.connected, true);
  assert.deepEqual(stale1.windows, good.windows);
  assert.deepEqual(notes(stale1), ["stale — HTTP 429"]);
  assert.deepEqual(stale1.extras.filter((x) => x.label !== "Refresh"), good.extras);
  tick(60 * 1000);
  const stale2 = await cache.get(); // second 429 -> note must not duplicate
  assert.deepEqual(notes(stale2), ["stale — HTTP 429"]);
});

test("consecutive 429s back off exponentially instead of retrying every 60s", async () => {
  const { cache, calls, tick } = setup([good, err429(), err429(), err429(), err429()]);
  await cache.get();               // t0: good (call 1)
  tick(5 * 60 * 1000);             // ttl expired
  await cache.get();               // call 2: 1st 429; retry due +60s
  tick(60 * 1000);
  await cache.get();               // call 3: 2nd 429; retry due +60s*2
  tick(60 * 1000);
  await cache.get();               // still held — no refetch 60s after the 2nd 429
  assert.equal(calls.length, 3);   // RED: fixed 60s delay refetches here
  tick(60 * 1000);                 // 2nd failure + 120s
  await cache.get();               // call 4: 3rd 429; retry due +60s*4
  tick(3 * 60 * 1000);             // < 3rd failure + 240s
  await cache.get();
  assert.equal(calls.length, 4);
  tick(60 * 1000);                 // = +240s
  await cache.get();
  assert.equal(calls.length, 5);
});

test("backoff is capped and resets after a successful refresh", async () => {
  const { cache, calls, tick } = setup([good, err429(), err429(), err429(), err429(), err429(), err429(), good, err429()]);
  await cache.get();
  tick(5 * 60 * 1000);
  for (let i = 0; i < 6; i++) {
    await cache.get();
    tick(10 * 60 * 1000); // past any capped delay (cap 10m)
  }
  assert.equal(calls.length, 7);
  await cache.get(); // success clears the note and backoff state
  const p = await cache.get();
  assert.deepEqual(notes(p), []);
  tick(5 * 60 * 1000);
  await cache.get(); // fresh 429 after success: delay starts at 60s again
  tick(60 * 1000 - 1);
  await cache.get();
  assert.equal(calls.length, 9); // only the success + this 429 refetched
});

test("a 429's retry-after hint lengthens the hold", async () => {
  const { cache, calls, tick } = setup([good, err429(5 * 60 * 1000), good]);
  await cache.get();
  tick(5 * 60 * 1000);
  await cache.get(); // 429 asking to wait 5 minutes
  tick(60 * 1000);
  await cache.get();
  assert.equal(calls.length, 2); // RED: fixed 60s ignores retry-after
  tick(4 * 60 * 1000);
  await cache.get();
  assert.equal(calls.length, 3);
});

test("first-ever fetch failing 429 is served as-is (no stale note, no fake data)", async () => {
  const { cache } = setup([err429()]);
  const p = await cache.get();
  assert.equal(p.error, "HTTP 429");
  assert.deepEqual(p.windows, []);
  assert.deepEqual(notes(p), []);
});

test("a bare transient error retries at its retry-after hint, not after the good-data ttl", async () => {
  // Restart case: no prior good data, endpoint 429s with a 90s hint. The
  // error must not be parked as "fresh" for the full 5-minute ttl while
  // the hint says the account may recover far sooner.
  const { cache, calls, tick } = setup([err429(90 * 1000), good]);
  await cache.get();
  tick(60 * 1000);
  await cache.get();
  assert.equal(calls.length, 1); // still inside the hint
  tick(30 * 1000);               // = hint
  await cache.get();
  assert.equal(calls.length, 2); // RED today: hint is ignored, ttl parks it
});

test("a large retry-after hint is honored in full, not clamped to the backoff cap", async () => {
  const { cache, calls, tick } = setup([good, err429(30 * 60 * 1000), good]);
  await cache.get();
  tick(5 * 60 * 1000);
  await cache.get(); // 429 demanding a 30-minute wait
  tick(10 * 60 * 1000); // past the 10-minute backoff cap
  await cache.get();
  assert.equal(calls.length, 2); // RED today: retries here and re-trips the window
  tick(20 * 60 * 1000);          // = hint
  await cache.get();
  assert.equal(calls.length, 3);
});

test("retry-after hints are capped at hintMaxMs", async () => {
  const { cache, calls, tick } = setup([good, err429(5 * 60 * 60 * 1000), good]);
  await cache.get();
  tick(5 * 60 * 1000);
  await cache.get(); // 5-hour hint -> clamped to 1 hour
  tick(60 * 60 * 1000 - 1);
  await cache.get();
  assert.equal(calls.length, 2);
  tick(1);
  await cache.get();
  assert.equal(calls.length, 3);
});

test("force=true bypasses fresh cache and stale holds", async () => {
  const { cache, calls, tick } = setup([good, good, good]);
  await cache.get();
  await cache.get(true);
  assert.equal(calls.length, 2);
  tick(5 * 60 * 1000 - 1); // still fresh
  await cache.get(true);
  assert.equal(calls.length, 3);
});

test("force=true does not bypass an explicit retry-after hold", async () => {
  const { cache, calls, tick } = setup([err429(5 * 60 * 1000), good]);
  await cache.get();
  await cache.get(true);
  assert.equal(calls.length, 1);
  tick(5 * 60 * 1000);
  await cache.get(true);
  assert.equal(calls.length, 2);
});

test("concurrent gets share one upstream fetch", async () => {
  let t = 1;
  let resolveFetch;
  const seen = [];
  const cache = createUsageCache({
    fetchProvider: () => new Promise((res) => { seen.push(t); resolveFetch = res; }),
    now: () => t,
  });
  const a = cache.get();
  const b = cache.get(true);
  resolveFetch(good);
  assert.equal(await a, await b);
  assert.equal(seen.length, 1);
});

test("a fetch crossing a generation bump (logout) is not cached", async () => {
  let gen = 0;
  let resolveFetch;
  const calls = [];
  const cache = createUsageCache({
    fetchProvider: () => { calls.push(1); return new Promise((res) => { resolveFetch = res; }); },
    now: () => 1,
    generation: () => gen,
  });
  const p = cache.get();
  gen++; // logout while in flight
  resolveFetch(good);
  await p;
  cache.reset();
  const p2 = cache.get(); // must refetch: pre-logout result was not cached
  resolveFetch(good);
  await p2;
  assert.equal(calls.length, 2);
});

test("reset() drops cached data so the next get refetches", async () => {
  const { cache, calls } = setup([good, good]);
  await cache.get();
  cache.reset();
  await cache.get();
  assert.equal(calls.length, 2);
});
