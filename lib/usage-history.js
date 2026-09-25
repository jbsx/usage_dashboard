import fs from "node:fs";
import path from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readHistory(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeHistory(filePath, samples) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(samples), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function createUsageHistory({ filePath, now = Date.now, retentionMs = WEEK_MS } = {}) {
  if (!filePath) throw new Error("usage history filePath is required");
  let samples = readHistory(filePath);

  function compactProviders(providers) {
    return (providers || []).map((provider) => ({
      name: provider.name,
      windows: (provider.windows || [])
        .filter((window) => Number.isFinite(Number(window.usedPct)))
        .map((window) => ({
          key: String(window.key || window.label || ""),
          label: String(window.label || window.key || ""),
          usedPct: Math.max(0, Math.min(100, Number(window.usedPct))),
        })),
    })).filter((provider) => provider.name && provider.windows.length);
  }

  function prune(timestamp = now()) {
    const cutoff = timestamp - retentionMs;
    samples = samples.filter((sample) => Number.isFinite(sample?.sampledAt) && sample.sampledAt >= cutoff && sample.sampledAt <= timestamp);
  }

  function record(providers) {
    const sampledAt = now();
    prune(sampledAt);
    const compact = compactProviders(providers);

    if (compact.length) {
      const sample = { sampledAt, providers: compact };
      if (samples.at(-1)?.sampledAt === sampledAt) samples[samples.length - 1] = sample;
      else samples.push(sample);
      writeHistory(filePath, samples);
    }
    return samples;
  }

  function importSamples(imported) {
    const timestamp = now();
    const cutoff = timestamp - retentionMs;
    const merged = new Map(samples.map((sample) => [sample.sampledAt, sample]));
    for (const sample of imported || []) {
      const sampledAt = Number(sample?.sampledAt);
      if (!Number.isFinite(sampledAt) || sampledAt < cutoff || sampledAt > timestamp) continue;
      const providers = compactProviders(sample.providers);
      if (providers.length) merged.set(sampledAt, { sampledAt, providers });
    }
    samples = [...merged.values()]
      .filter((sample) => Number.isFinite(sample?.sampledAt) && sample.sampledAt >= cutoff && sample.sampledAt <= timestamp)
      .sort((a, b) => a.sampledAt - b.sampledAt);
    writeHistory(filePath, samples);
    return samples;
  }

  function get() {
    const before = samples.length;
    prune();
    if (samples.length !== before) writeHistory(filePath, samples);
    return samples;
  }

  function range(from, to) {
    return get().filter((sample) => sample.sampledAt >= from && sample.sampledAt <= to);
  }

  // Samples are kept in time order (record appends, import sorts), so the
  // first one is the oldest.
  function oldestAt() {
    return get()[0]?.sampledAt ?? null;
  }

  // Validates a caller's range, as the /api/history query strings carry it.
  // Throws on anything malformed so the route can answer 400.
  function query({ from, to } = {}) {
    const isEpoch = (value) => typeof value === "string" && /^\d+$/.test(value);
    if (!isEpoch(from) || !isEpoch(to)) throw new Error("from and to are required epoch milliseconds");
    const start = Number(from);
    const end = Math.min(Number(to), now());
    if (end < start) throw new Error("to is before from");
    if (end - start > retentionMs) throw new Error(`range is longer than ${retentionMs / 3600e3} hours of retention`);
    return { samples: range(start, end), oldestAt: oldestAt() };
  }

  return { record, importSamples, get, range, oldestAt, query };
}
