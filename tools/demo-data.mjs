// Demo payload for the README screenshot: the real /api/usage shape, filled
// with representative numbers and an unbroken seven days of samples. Nothing
// here reads or writes the live dashboard's own history.
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const SPAN = 7 * DAY;
// Mirrors the server: the snapshot embeds the last 13 hours, the rest is
// served by /api/history.
const EMBED_MS = 13 * HOUR;
const SAMPLE_MS = 2 * 60e3;
const FIVE_H = 5 * HOUR;

// Samples are keyed by age ("how long ago"), so elapsed runs the other way;
// every curve below is written in terms of elapsed so it climbs toward now.
const elapsed = (age) => SPAN - age;
// Deterministic pseudo-random in [0,1), so a regenerated shot is identical.
const rand = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const wobble = (t, seed) => Math.sin(t * 37 + seed) * 0.4 + Math.sin(t * 11.3 + seed * 2) * 0.55;

// Nobody codes around the clock: each day opens busy, goes quiet overnight,
// then picks up again. Every series is shaped by this so the chart reads like
// days of work rather than a signal generator.
const activity = (u) => {
  const h = (u % DAY) / HOUR;
  if (h < 4.5) return 1.15;
  if (h < 6) return 0.5;
  if (h < 11.5) return 0.04;
  if (h < 13) return 0.6;
  return 1.25;
};
// Share of the day's work done by time u — the integral of activity, normalised.
const workDone = (() => {
  const steps = 7 * 480;
  const cum = [0];
  for (let i = 1; i <= steps; i++) cum.push(cum[i - 1] + activity((i / steps) * SPAN));
  const total = cum[steps];
  return (u) => {
    const i = Math.max(0, Math.min(steps, Math.round((u / SPAN) * steps)));
    return cum[i] / total;
  };
})();

// A 5-hour window sawtooths: it climbs while you work, drops to nothing when it
// resets, and barely moves at all while you are asleep.
const sawtooth = (age, peak, phase, seed) => {
  const u = elapsed(age);
  const pos = (u + phase) / FIVE_H;
  const cycle = Math.floor(pos);
  const t = pos - cycle;
  // Each window gets its own intensity, and a slow start before real work lands.
  const intensity = 0.45 + 0.55 * rand(cycle + seed * 13);
  const shape = Math.max(0, Math.min(1, (t - 0.1) / 0.72));
  const value = peak * intensity * shape * Math.min(1.15, activity(u)) / 1.15;
  return Math.max(0, Math.round((value + wobble(t, seed) * shape) * 10) / 10);
};
// Long windows only ever climb, and only while there is work being done.
const ramp = (age, from, to, seed) => {
  const u = elapsed(age);
  const value = from + (to - from) * workDone(u);
  return Math.max(0, Math.round((value + wobble(u / SPAN, seed) * 0.35) * 10) / 10);
};

function demo(now) {
  const byProvider = (age) => ({
    GLM: [
      { key: "monthly", label: "Monthly (tool calls)", usedPct: ramp(age, 27, 34, 1) },
      { key: "5h", label: "5-Hour", usedPct: sawtooth(age, 58, 4.3 * HOUR, 2) },
    ],
    Codex: [
      { key: "7d", label: "7-Day", usedPct: ramp(age, 22, 41, 3) },
      { key: "GPT-5.3-Codex-Spark", label: "GPT-5.3-Codex-Spark", usedPct: ramp(age, 4, 18, 4) },
    ],
    Grok: [
      { key: "7d", label: "Weekly", usedPct: ramp(age, 9, 27, 5) },
    ],
    Claude: [
      { key: "5h", label: "5-Hour", usedPct: sawtooth(age, 64, 0.65 * HOUR, 6) },
      { key: "7d", label: "7-Day", usedPct: ramp(age, 19, 46, 7) },
      { key: "7d-fable", label: "7-Day (Fable)", usedPct: ramp(age, 6, 22, 8) },
    ],
  });
  const at = (age) => {
    const w = byProvider(age);
    return Object.keys(w).map((name) => ({ name, windows: w[name] }));
  };

  const history = [];
  for (let age = SPAN; age >= 0; age -= SAMPLE_MS) history.push({ sampledAt: now - age, providers: at(age) });

  const plans = { GLM: "lite", Codex: "prolite", Grok: "Grok Pro", Claude: "Max 20x" };
  const resets = {
    "GLM:monthly": now + 11 * 24 * HOUR,
    "GLM:5h": now + 0.7 * HOUR,
    "Codex:7d": now + 3.2 * 24 * HOUR,
    "Grok:7d": now + 4.4 * 24 * HOUR,
    "Claude:5h": now + 4.35 * HOUR,
    "Claude:7d": now + 5.1 * 24 * HOUR,
    "Claude:7d-fable": now + 5.1 * 24 * HOUR,
  };
  // Mirrors lib/attach-auth.js: only the OAuth providers can be logged out,
  // and only GLM/Codex/Claude expose an auto-arm toggle.
  const canLogout = new Set(["Grok", "Codex", "Claude"]);
  const canAutoArm = new Set(["GLM", "Codex", "Claude"]);
  const providers = at(0).map((p) => ({
    name: p.name,
    connected: true,
    plan: plans[p.name],
    error: null,
    ...(canLogout.has(p.name) ? { canLogout: true } : {}),
    ...(canAutoArm.has(p.name) ? { autoArm: { available: true, enabled: true } } : {}),
    windows: p.windows.map((w) => ({ ...w, resetAt: resets[`${p.name}:${w.key}`] ?? null })),
    extras: p.name === "Claude" ? [{ label: "Spend", text: "18.40 GBP (37% of cap)" }] : [],
  }));

  return { providers, history };
}

// The full week, for the screenshot server's /api/history.
export const demoHistory = (now) => demo(now).history;

export function demoSnapshot(now) {
  const { providers, history } = demo(now);
  return {
    updatedAt: now,
    providers,
    history: history.filter((sample) => sample.sampledAt >= now - EMBED_MS),
    historySince: now - EMBED_MS,
    historyOldestAt: history[0].sampledAt,
  };
}
