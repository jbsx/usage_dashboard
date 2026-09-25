import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageHistory } from "../lib/usage-history.js";

test("records compact usage samples and retains seven days of them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  const DAY = 24 * 3600e3;
  let now = 10 * DAY;
  const history = createUsageHistory({ filePath, now: () => now });
  const provider = { name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 42, resetAt: 123 }] };

  history.record([provider]);
  now += DAY;
  provider.windows[0].usedPct = 50;
  history.record([provider]);
  now += 6 * DAY + 1;
  provider.windows[0].usedPct = 55;
  const samples = history.record([provider]);

  // The first sample is now a week and a millisecond old; the day-old one survives.
  assert.deepEqual(samples.map((sample) => sample.sampledAt), [11 * DAY, 17 * DAY + 1]);
  assert.deepEqual(samples[1], {
    sampledAt: now,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 55 }] }],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), samples);
});

test("loads persisted samples and clamps percentages to the chart range", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  const now = 2_000_000;
  fs.writeFileSync(filePath, JSON.stringify([{ sampledAt: now - 1, providers: [] }]));

  const history = createUsageHistory({ filePath, now: () => now });
  const samples = history.record([{ name: "Codex", windows: [{ key: "5h", usedPct: 140 }] }]);

  assert.equal(samples.length, 2);
  assert.equal(samples[1].providers[0].windows[0].usedPct, 100);
});

test("imports client samples, validates them, deduplicates timestamps, and persists the merge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  const now = 25 * 3600e3;
  fs.writeFileSync(filePath, JSON.stringify([{ sampledAt: now - 1000, providers: [{ name: "Claude", windows: [{ key: "5h", usedPct: 10 }] }] }]));
  const history = createUsageHistory({ filePath, now: () => now });

  const samples = history.importSamples([
    { sampledAt: now - 2000, providers: [{ name: "Codex", windows: [{ key: "5h", usedPct: 140 }] }] },
    { sampledAt: now - 1000, providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 20 }] }] },
    { sampledAt: now + 1, providers: [{ name: "future", windows: [{ key: "5h", usedPct: 1 }] }] },
    { sampledAt: "bad", providers: [] },
  ]);

  assert.deepEqual(samples.map((sample) => sample.sampledAt), [now - 2000, now - 1000]);
  assert.equal(samples[0].providers[0].windows[0].usedPct, 100);
  assert.equal(samples[1].providers[0].windows[0].usedPct, 20);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), samples);
});

test("answers a time range with the samples inside it and reports the oldest one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  const HOUR = 3600e3;
  const now = 100 * HOUR;
  const sample = (hoursAgo) => ({ sampledAt: now - hoursAgo * HOUR, providers: [{ name: "Claude", windows: [{ key: "5h", usedPct: hoursAgo }] }] });
  fs.writeFileSync(filePath, JSON.stringify([sample(30), sample(20), sample(10), sample(0)]));
  const history = createUsageHistory({ filePath, now: () => now });

  // Both ends are inclusive.
  assert.deepEqual(history.range(now - 20 * HOUR, now - 10 * HOUR).map((s) => s.sampledAt), [now - 20 * HOUR, now - 10 * HOUR]);
  assert.deepEqual(history.range(now - 9 * HOUR, now - HOUR), []);
  assert.equal(history.oldestAt(), now - 30 * HOUR);
});

test("an empty history has no oldest sample", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const history = createUsageHistory({ filePath: path.join(dir, "history.json"), now: () => 1000 });
  assert.equal(history.oldestAt(), null);
  assert.deepEqual(history.range(0, 1000), []);
});

test("a range query takes epoch-ms strings, clamps the end to now, and rejects bad ranges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  const HOUR = 3600e3;
  const now = 500 * HOUR;
  const sample = (hoursAgo) => ({ sampledAt: now - hoursAgo * HOUR, providers: [{ name: "Claude", windows: [{ key: "5h", usedPct: 1 }] }] });
  fs.writeFileSync(filePath, JSON.stringify([sample(40), sample(2), sample(0)]));
  const history = createUsageHistory({ filePath, now: () => now });

  const answer = history.query({ from: String(now - 3 * HOUR), to: String(now + 5 * HOUR) });
  assert.deepEqual(answer.samples.map((s) => s.sampledAt), [now - 2 * HOUR, now]);
  assert.equal(answer.oldestAt, now - 40 * HOUR);

  assert.throws(() => history.query({ from: String(now - HOUR) }), /from and to/);
  assert.throws(() => history.query({ from: "yesterday", to: String(now) }), /from and to/);
  assert.throws(() => history.query({ from: String(now), to: String(now - HOUR) }), /before/);
  assert.throws(() => history.query({ from: String(now - 8 * 24 * HOUR), to: String(now) }), /longer than/);
});
