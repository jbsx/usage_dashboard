import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageHistory } from "../lib/usage-history.js";

test("records compact usage samples and retains only the last 24 hours", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "history.json");
  let now = 25 * 3600e3;
  const history = createUsageHistory({ filePath, now: () => now });
  const provider = { name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 42, resetAt: 123 }] };

  history.record(provider ? [provider] : []);
  now += 24 * 3600e3 + 1;
  provider.windows[0].usedPct = 55;
  const samples = history.record([provider]);

  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], {
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
