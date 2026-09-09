import test from "node:test";
import assert from "node:assert/strict";
import { isUnarmed, createAutoArmer } from "../lib/autoarm.js";

const NOW = 1_700_000_000_000;

function fakeClock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function codexProvider(win) {
  return { name: "Codex", connected: true, plan: "plus", error: null, windows: [win], extras: [] };
}
const fiveHour = (over = {}) => ({
  key: "5h", label: "5-Hour", unit: "percent", usedPct: 0, used: null, limit: null, remaining: null, resetAt: null, ...over,
});

test("isUnarmed: 0% used with missing reset time means the window is not armed", () => {
  assert.equal(isUnarmed(fiveHour(), NOW), true);
});

test("isUnarmed: 0% used with a reset time in the past means the window is not armed", () => {
  assert.equal(isUnarmed(fiveHour({ resetAt: NOW - 1 }), NOW), true);
});

test("isUnarmed: 0% used with a future reset time means the timer is already counting", () => {
  assert.equal(isUnarmed(fiveHour({ resetAt: NOW + 3_600_000 }), NOW), false);
});

test("isUnarmed: usage above 0% means the window is armed even without a reset time", () => {
  assert.equal(isUnarmed(fiveHour({ usedPct: 3 }), NOW), false);
});

test("process: armed window passes through untouched and never pings", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => { throw new Error("refresh must not be called"); },
    now: clock.now,
  });
  const armed = codexProvider(fiveHour({ usedPct: 12, resetAt: NOW + 3_600_000 }));
  const out = await armer.process(armed);
  assert.equal(out, armed);
  assert.equal(pings, 0);
});

test("process: unarmed window triggers one ping, waits for the API to settle, then returns the refreshed provider", async () => {
  const clock = fakeClock();
  const events = [];
  const armed5h = fiveHour({ usedPct: 1, resetAt: clock.now() + 3_600_000 });
  const armer = createAutoArmer({
    ping: async () => { events.push(`ping@${clock.now()}`); },
    refresh: async () => { events.push(`refresh@${clock.now()}`); return codexProvider(armed5h); },
    now: clock.now,
    sleep: async (ms) => { events.push(`sleep(${ms})@${clock.now()}`); clock.advance(ms); },
    settleMs: 3000,
  });
  const out = await armer.process(codexProvider(fiveHour()));
  assert.deepEqual(events, [`ping@${NOW}`, "sleep(3000)@" + NOW, `refresh@${NOW + 3000}`]);
  assert.equal(out.windows[0], armed5h);
});

test("process: does not ping again inside the cooldown window", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => codexProvider(fiveHour()), // stays unarmed
    now: clock.now,
    sleep: async () => {},
  });
  await armer.process(codexProvider(fiveHour()));
  const afterFirst = pings;
  clock.advance(4 * 60 * 1000); // 4 min < 5 min cooldown
  await armer.process(codexProvider(fiveHour()));
  assert.equal(pings, afterFirst);
  clock.advance(2 * 60 * 1000); // now past cooldown
  await armer.process(codexProvider(fiveHour()));
  assert.equal(pings, afterFirst + 1);
});

test("process: three consecutive ineffective pings stop further pings and leave a note on the card", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => codexProvider(fiveHour()), // never arms
    now: clock.now,
    sleep: async () => {},
  });
  for (let i = 0; i < 5; i++) {
    clock.advance(10 * 60 * 1000); // always past cooldown
    var last = await armer.process(codexProvider(fiveHour()));
  }
  assert.equal(pings, 3, "stops pinging after 3 ineffective attempts");
  assert.deepEqual(last.extras, [{ label: "Auto-arm", text: "gave up after 3 ineffective pings" }]);
});

test("process: strike count resets once the window arms again", async () => {
  const clock = fakeClock();
  let pings = 0;
  let armsOnRefresh = 1; // refresh #1 (after ping #1) still unarmed; refresh #2 arms
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => codexProvider(fiveHour(
      armsOnRefresh-- > 0 ? {} : { usedPct: 1, resetAt: clock.now() + 3_600_000 }
    )),
    now: clock.now,
    sleep: async () => {},
  });
  await armer.process(codexProvider(fiveHour()));   // ping 1, ineffective (strike 1)
  clock.advance(10 * 60 * 1000);
  await armer.process(codexProvider(fiveHour()));   // ping 2, refresh arms it
  assert.equal(pings, 2);
  clock.advance(10 * 60 * 1000);
  const out = await armer.process(codexProvider(fiveHour({ usedPct: 1, resetAt: clock.now() + 3_600_000 })));
  assert.equal(pings, 2, "armed windows never ping");
  assert.equal(out.extras.length, 0);
});

test("process: a ping that throws is counted as ineffective and surfaces a note instead of crashing", async () => {
  const armer = createAutoArmer({
    ping: async () => { throw new Error("HTTP 401"); },
    refresh: async () => { throw new Error("refresh must not be called"); },
    now: () => NOW,
    sleep: async () => {},
  });
  const out = await armer.process(codexProvider(fiveHour()));
  assert.deepEqual(out.extras, [{ label: "Auto-arm", text: "ping failed: HTTP 401" }]);
});

test("process: providers without a connected 5h window pass through untouched", async () => {
  const armer = createAutoArmer({
    ping: async () => { throw new Error("must not ping"); },
    refresh: async () => { throw new Error("must not refresh"); },
    now: () => NOW,
  });
  const disconnected = { name: "Codex", connected: false, plan: null, error: "not connected", windows: [], extras: [] };
  assert.equal(await armer.process(disconnected), disconnected);
  const glm = { name: "GLM", connected: true, plan: "lite", error: null, windows: [
    { key: "7d", label: "7-Day", unit: "tokens", usedPct: 0, resetAt: null },
  ], extras: [] };
  assert.equal(await armer.process(glm), glm);
});

// ---- floating reset time (Codex reports reset_at = now + 5h while unarmed) ----

test("process: 0% window whose future reset time drifts forward between polls is unarmed and gets pinged", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => codexProvider(fiveHour({ usedPct: 1, resetAt: clock.now() + 3_600_000 })),
    now: clock.now,
    sleep: async () => {},
  });
  // poll 1: first sighting of a full-length window — decision deferred
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 0);
  // poll 2: reset time drifted forward with wall clock → floating → ping
  clock.advance(60 * 1000);
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 1);
});

test("process: 0% window whose future reset time is anchored between polls is already armed", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => { throw new Error("refresh must not be called"); },
    now: clock.now,
    sleep: async () => {},
  });
  const anchored = clock.now() + 295 * 60 * 1000;
  const out1 = await armer.process(codexProvider(fiveHour({ resetAt: anchored })));
  clock.advance(60 * 1000);
  const out2 = await armer.process(codexProvider(fiveHour({ resetAt: anchored })));
  assert.equal(pings, 0);
  assert.equal(out1.windows[0].resetAt, anchored);
  assert.equal(out2.windows[0].resetAt, anchored);
  assert.equal(out2.extras.length, 0);
});

test("check: ambiguous timers get a short probe, then anchored timers schedule at reset", async () => {
  const clock = fakeClock();
  const resetAt = NOW + 300 * 60 * 1000;
  const armer = createAutoArmer({
    ping: async () => { throw new Error("must not ping"); },
    refresh: async () => { throw new Error("must not refresh"); },
    now: clock.now,
    probeMs: 60_000,
    graceMs: 2000,
  });
  const provider = codexProvider(fiveHour({ resetAt }));

  const first = await armer.check(provider);
  assert.equal(first.nextCheckAt, NOW + 60_000);
  clock.advance(60_000);
  const second = await armer.check(provider);
  assert.equal(second.nextCheckAt, resetAt + 2000);
});

test("check: a successful ping schedules from the refreshed reset time", async () => {
  const clock = fakeClock();
  const resetAt = NOW + 5 * 60 * 60 * 1000;
  const fresh = codexProvider(fiveHour({ usedPct: 1, resetAt }));
  const armer = createAutoArmer({
    ping: async () => {},
    refresh: async () => fresh,
    now: clock.now,
    sleep: async () => {},
    graceMs: 2000,
  });

  const result = await armer.check(codexProvider(fiveHour()));
  assert.equal(result.provider, fresh);
  assert.equal(result.nextCheckAt, resetAt + 2000);
});

test("check: a 0% post-ping timer is probed before treating it as anchored", async () => {
  const clock = fakeClock();
  const fresh = codexProvider(fiveHour({ resetAt: NOW + 5 * 60 * 60 * 1000 }));
  const armer = createAutoArmer({
    ping: async () => {},
    refresh: async () => fresh,
    now: clock.now,
    sleep: async () => {},
    probeMs: 60_000,
  });

  const result = await armer.check(codexProvider(fiveHour()));
  assert.equal(result.nextCheckAt, NOW + 60_000);
});

test("process: after a ping, an anchored refresh means no further pings and strikes reset", async () => {
  const clock = fakeClock();
  let pings = 0;
  let refreshCount = 0;
  const armed5h = () => fiveHour({ usedPct: 0, resetAt: NOW + 299 * 60 * 1000 }); // anchored value
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => { refreshCount++; return codexProvider(armed5h()); },
    now: clock.now,
    sleep: async () => {},
  });
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  clock.advance(60 * 1000);
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 1);
  assert.equal(refreshCount, 1);
  // subsequent polls see the anchored value → armed, never ping again
  for (let i = 0; i < 3; i++) {
    clock.advance(60 * 1000);
    await armer.process(codexProvider(armed5h()));
  }
  assert.equal(pings, 1);
});

test("process: a refresh without a reset time does not make the next floating sighting look anchored-or-unarmed by coercion", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async () => codexProvider(fiveHour()), // no resetAt at all
    now: clock.now,
    sleep: async () => {},
  });
  // prime the armer with one unarmed cycle (ping + refresh that stays unarmed, resetAt null)
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  clock.advance(60 * 1000);
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 1);
  // next poll sees a floating window again: first sighting after the transition defers
  clock.advance(10 * 60 * 1000);
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 1, "transition from null resetAt to floating defers, does not ping");
  // the poll after that confirms drift and pings (past cooldown)
  clock.advance(60 * 1000);
  await armer.process(codexProvider(fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })));
  assert.equal(pings, 2);
});

test("process: guardrails are tracked per provider, not shared", async () => {
  const clock = fakeClock();
  let pings = 0;
  const armed = () => fiveHour({ usedPct: 1, resetAt: clock.now() + 3_600_000 });
  const armer = createAutoArmer({
    ping: async () => { pings++; },
    refresh: async (name) => ({ name, connected: true, plan: "x", error: null, windows: [armed()], extras: [] }),
    now: clock.now,
    sleep: async () => {},
  });
  const floating = (name) => ({
    name, connected: true, plan: "x", error: null,
    windows: [fiveHour({ resetAt: clock.now() + 300 * 60 * 1000 })], extras: [],
  });
  const glm = () => floating("GLM");
  const codex = () => floating("Codex");

  // Codex: deferral, then drift detected → ping (cooldown now consumed for Codex)
  await armer.process(codex());
  clock.advance(60 * 1000);
  await armer.process(codex());
  assert.equal(pings, 1, "Codex pinged once");

  // GLM becomes floating one minute later — own deferral, own cooldown clock
  clock.advance(60 * 1000);
  await armer.process(glm());
  assert.equal(pings, 1, "GLM first sighting defers");
  clock.advance(60 * 1000);
  await armer.process(glm());
  assert.equal(pings, 2, "GLM pings on its own schedule despite Codex's recent ping");
});
