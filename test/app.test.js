import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// options.phone: pretend the (max-width: 600px) media query matches, which
// swaps the card to its headline-row layout and the chart to 12 hours.
function loadCardRenderer(storedPrefsJson, storedChartPrefsJson, sharedStorage = new Map(), fetchImpl, options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: id === "settings-overlay",
        innerHTML: "",
        textContent: "",
        addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const context = {
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => sharedStorage.get(key) ?? (key === "usage-dashboard-chart-prefs" ? storedChartPrefsJson ?? null : storedPrefsJson ?? null),
      setItem: (key, value) => sharedStorage.set(key, value),
      removeItem: (key) => sharedStorage.delete(key),
    },
    fetch: fetchImpl || (async () => ({ json: async () => ({ updatedAt: 0, providers: [] }) })),
    window: { addEventListener() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
    alert() {},
    confirm: () => true,
  };
  if (options.phone) context.matchMedia = () => ({ matches: true, addEventListener() {} });
  const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  vm.runInNewContext(
    source + "\nglobalThis.__api = { cardHtml, renderGrid, renderChart, renderSettings, shortCountdown, setData: (d) => { lastData = d; }, gridEl: grid, chartLegend, chartPlot, chartSubtitle, settingsBody, stepChart, jumpChart, panChartBy, chartKey, chartBack: document.getElementById('chart-back'), chartForward: document.getElementById('chart-forward'), chartNow: document.getElementById('chart-now'), chartLive: document.getElementById('chart-live') };",
    context,
  );
  return context.__api;
}

test("Claude reconnect card displays why the stored login was rejected", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Claude",
    connected: false,
    error: "permissions changed — reconnect",
    auth: { slug: "claude", pending: null },
    windows: [],
    extras: [],
  });

  assert.match(html, /permissions changed — reconnect/);
});

test("rate-limited card shows the requested wait instead of advising Refresh", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Claude",
    connected: true,
    error: "Rate limited. Please try again later.",
    retryAfterMs: 3550 * 1000,
    windows: [],
    extras: [],
  });

  assert.match(html, /60-minute wait/);
  assert.doesNotMatch(html, /hit .*Refresh/i);
});

const litDots = (html) => (html.match(/<circle class="dot on"/g) || []).length;
const windowFixture = (name, pct, over = {}, card = {}) => ({
  name,
  connected: true,
  windows: [{ key: "5h", label: "5-Hour", unit: "percent", usedPct: pct, ...over }],
  extras: [],
  ...card,
});

test("usage window renders an 8x8 polka-dot grid of 64 dots", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Claude",
    connected: true,
    windows: [{ key: "5h", label: "5h", unit: "percent", usedPct: 0, resetAt: Date.now() + 3e6 }],
    extras: [],
  });

  const dots = (html.match(/<circle class="dot/g) || []).length;
  assert.equal(dots, 64);
  assert.match(html, /class="dots-wrap"/);
  assert.match(html, /aria-label="5h 0% used"/);
  assert.match(html, /class="gauge-meta"><b>5h<\/b>/);
  // The gauge countdown reads bare ("5h · 3h 15m"), like the secondary rows.
  assert.match(html, /<span data-reset="\d+">/);
  assert.doesNotMatch(html, /resets in/);
});

test("lit dots follow ceil(pct) clamped to 0-100, number shows rounded pct", () => {
  const { cardHtml } = loadCardRenderer();
  // Unknown-duration windows ("period") fall back to usage-based fill.
  const render = (pct) => cardHtml(windowFixture("Claude", pct, { key: "period", resetAt: 1 }));

  assert.equal(litDots(render(37.2)), 24);
  assert.equal(litDots(render(0.4)), 1);
  assert.equal(litDots(render(-5)), 0);
  assert.equal(litDots(render(100)), 64);
  assert.match(render(37.2), />37</);
});

test("overage clamps dots at 100 but shows the true percentage in red", () => {
  const { cardHtml } = loadCardRenderer();
  const now = Date.now();
  const html = cardHtml(windowFixture("Claude", 127.4, { resetAt: now + 1 }), false, now);

  assert.equal(litDots(html), 64);
  assert.match(html, /class="dots-pct over">127</);
  assert.match(html, /aria-label="5h 127% used"/);
});

test("grid fill reflects elapsed window time: full duration left means empty grid", () => {
  const { cardHtml } = loadCardRenderer();
  const now = Date.now();
  const quarterLeft = cardHtml(windowFixture("Claude", 80, { resetAt: now + 0.25 * 5 * 3600e3 }), false, now);

  assert.equal(litDots(quarterLeft), 48);
  assert.match(quarterLeft, />80</);

  const freshlyArmed = cardHtml(windowFixture("Claude", 80, { resetAt: now + 5 * 3600e3 - 1 }), false, now);
  assert.equal(litDots(freshlyArmed), 0);
});

test("unarmed windows render a fully gray grid; expired ones fill completely", () => {
  const { cardHtml } = loadCardRenderer();
  const now = Date.now();

  const unarmed = cardHtml(windowFixture("Claude", 62), false, now);
  assert.equal(litDots(unarmed), 0);
  assert.match(unarmed, />62</);

  const expired = cardHtml(windowFixture("Claude", 62, { resetAt: now - 1000 }), false, now);
  assert.equal(litDots(expired), 64);
});

test("percentage overlay drops the % sign and keeps one size across digit counts", () => {
  const { cardHtml } = loadCardRenderer();
  const render = (pct) => cardHtml(windowFixture("Claude", pct));

  assert.match(render(5), /class="dots-pct">5</);
  assert.match(render(37), /class="dots-pct">37</);
  assert.match(render(100), /class="dots-pct">100</);
  assert.match(render(1274), /class="dots-pct over widest">1274</);
});

test("dots use provider brand colors with accent fallback", () => {
  const { cardHtml } = loadCardRenderer();
  const render = (name) => cardHtml(windowFixture(name, 40));

  assert.match(render("Claude"), /style="color:#fd3a5e"/);
  assert.match(render("Codex"), /style="color:#bffd3a"/);
  assert.match(render("Grok"), /style="color:#3afdda"/);
  assert.match(render("GLM"), /style="color:#783afd"/);
  assert.match(render("Mistral"), /style="color:var\(--accent\)"/);
});

test("stagger animation applies to the first render only", () => {
  const { renderGrid, setData, gridEl } = loadCardRenderer();
  setData({ updatedAt: 0, providers: [windowFixture("Claude", 40, { resetAt: Date.now() + 0.1 * 5 * 3600e3 })] });

  renderGrid();
  assert.match(gridEl.innerHTML, /dots-wrap stagger/);
  assert.match(gridEl.innerHTML, /animation-delay:/);

  renderGrid();
  assert.doesNotMatch(gridEl.innerHTML, /stagger/);
  assert.doesNotMatch(gridEl.innerHTML, /animation-delay:/);
});

test("one dot grid per card: 5h wins, other windows become bars", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Claude",
    connected: true,
    windows: [
      { key: "7d", label: "7-Day", unit: "percent", usedPct: 43, resetAt: 1 },
      { key: "5h", label: "5-Hour", unit: "percent", usedPct: 62, resetAt: 2 },
      { key: "monthly", label: "Monthly", unit: "percent", usedPct: 20, resetAt: 3 },
    ],
    extras: [],
  });

  assert.equal((html.match(/class="dots-wrap/g) || []).length, 1);
  assert.match(html, /aria-label="5h 62% used"/);
  assert.equal((html.match(/class="minibar"/g) || []).length, 2);
  assert.match(html, /class="mb-cap" title="7-Day">7d</);
  assert.match(html, /class="mb-cap" title="Monthly">mo</);
});

test("7d window is primary when no 5h window exists", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Grok",
    connected: true,
    windows: [
      { key: "monthly", label: "Monthly", unit: "percent", usedPct: 20 },
      { key: "7d", label: "Weekly", unit: "percent", usedPct: 50 },
    ],
    extras: [],
  });

  assert.equal((html.match(/class="dots-wrap/g) || []).length, 1);
  assert.match(html, /aria-label="7d 50% used"/);
  assert.equal((html.match(/class="minibar"/g) || []).length, 1);
});

test("chosen primary metric takes the gauge and demotes the default", () => {
  const storage = new Map([["usage-dashboard-primary-prefs", JSON.stringify({ Claude: "monthly" })]]);
  const { cardHtml } = loadCardRenderer(null, null, storage);
  const html = cardHtml({
    name: "Claude",
    connected: true,
    windows: [
      { key: "5h", label: "5-Hour", unit: "percent", usedPct: 62, resetAt: 1 },
      { key: "monthly", label: "Monthly", unit: "percent", usedPct: 20, resetAt: 2 },
    ],
    extras: [],
  });

  assert.equal((html.match(/class="dots-wrap/g) || []).length, 1);
  assert.match(html, /aria-label="mo 20% used"/);
  assert.equal((html.match(/class="minibar"/g) || []).length, 1);
  assert.match(html, /class="mb-cap" title="5-Hour">5h</);
});

test("hidden chosen primary falls back to the default gauge", () => {
  const storage = new Map([
    ["usage-dashboard-primary-prefs", JSON.stringify({ Claude: "monthly" })],
    ["usage-dashboard-metric-prefs", JSON.stringify({ Claude: { monthly: false } })],
  ]);
  const { cardHtml } = loadCardRenderer(null, null, storage);
  const html = cardHtml({
    name: "Claude",
    connected: true,
    windows: [
      { key: "5h", label: "5-Hour", unit: "percent", usedPct: 62, resetAt: 1 },
      { key: "monthly", label: "Monthly", unit: "percent", usedPct: 20, resetAt: 2 },
    ],
    extras: [],
  });

  assert.match(html, /aria-label="5h 62% used"/);
  assert.equal((html.match(/class="minibar"/g) || []).length, 0);
});

test("single window renders no secondary rows", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml(windowFixture("Grok", 30));

  assert.equal((html.match(/class="dots-wrap/g) || []).length, 1);
  assert.equal((html.match(/class="minibar"/g) || []).length, 0);
  assert.doesNotMatch(html, /class="minibars"/);
});

test("secondary rows fill with provider color, clamp overage, keep resets", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml({
    name: "Claude",
    connected: true,
    windows: [
      { key: "5h", label: "5-Hour", unit: "percent", usedPct: 10 },
      { key: "7d", label: "7-Day", unit: "percent", usedPct: 43, resetAt: 12345 },
      { key: "monthly", label: "Monthly", unit: "percent", usedPct: 127, resetAt: 6789 },
    ],
    extras: [],
  });

  assert.match(html, /class="mb-fill" style="width:43%;background:#fd3a5e"/);
  assert.match(html, /class="mb-pct">43%</);
  assert.match(html, /width:100%;background:#fd3a5e"/);
  assert.match(html, /class="mb-pct over">127%</);
  assert.match(html, /class="mb-reset" data-reset="6789"/);
});

test("the plan sits inline in the card head rather than on its own row", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml(windowFixture("Grok", 30, {}, { plan: "Grok Pro" }));

  assert.match(html, /<h2>Grok<span class="plan-inline">Grok Pro<\/span><\/h2>/);
  assert.doesNotMatch(html, /class="plan"/);
});

test("countdowns show seconds only when the reset is under ten minutes away", () => {
  const { shortCountdown } = loadCardRenderer();

  // Far-off resets would otherwise repaint every second for no actionable gain.
  assert.doesNotMatch(shortCountdown(Date.now() + 14 * 86400e3), /\ds$/);
  assert.doesNotMatch(shortCountdown(Date.now() + 3 * 3600e3), /\ds$/);
  assert.doesNotMatch(shortCountdown(Date.now() + 10 * 60e3 + 5000), /\ds$/);

  // Imminent resets are exactly when the seconds are worth watching.
  assert.match(shortCountdown(Date.now() + 9 * 60e3), /\ds$/);
  assert.match(shortCountdown(Date.now() + 30e3), /\ds$/);

  // A window with no reset has not started counting, which "unarmed" says and
  // a bare dash does not.
  assert.equal(shortCountdown(null), "unarmed");
});

const codexSparkCard = (sparkLabel) => ({
  name: "Codex", connected: true, plan: "prolite", error: null,
  windows: [
    { key: "7d", label: "7-Day", usedPct: 25, resetAt: Date.now() + 5 * 86400e3 },
    { key: "GPT-5.3-Codex-Spark", label: sparkLabel, usedPct: 0, resetAt: null },
  ],
  extras: [],
});

test("a named per-model limit captions by its model, not a truncated key", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml(codexSparkCard("GPT-5.3-Codex-Spark"), false);

  const caption = html.match(/class="mb-cap"[^>]*>([^<]*)</)[1];
  assert.equal(caption, "Spark");
  assert.doesNotMatch(caption, /gpt-5\./i);
  // The caption drops the rest of the name, so the tooltip has to keep it.
  assert.match(html, /class="mb-cap" title="GPT-5\.3-Codex-Spark"/);
});

test("a per-model limit captions by its model even when the API reports a duration", () => {
  const { cardHtml } = loadCardRenderer();
  // The label is the duration in this case, so a caption read off the label
  // would say "Day" and collide with the real 7-day window.
  const html = cardHtml(codexSparkCard("7-Day"), false);

  assert.match(html, /class="mb-cap"[^>]*>Spark</);
  assert.doesNotMatch(html, /class="mb-cap"[^>]*>Day</);
});

test("a window with no scheduled reset renders as unarmed rather than a dash", () => {
  const { cardHtml } = loadCardRenderer();
  const html = cardHtml(codexSparkCard("GPT-5.3-Codex-Spark"), false);

  // Dimmed, and carrying an empty data-reset so the ticker leaves it alone.
  assert.match(html, /<span class="mb-reset na" data-reset=""[^>]*>unarmed<\/span>/);
  assert.doesNotMatch(html, />—</);
  // The armed 7d window is this card's gauge, and keeps a real countdown.
  assert.match(html, /<span data-reset="\d+">\d+d /);
  assert.doesNotMatch(html, /<span class="na"/);
});

test("card is not rendered when every metric is disabled, but partially-hidden cards stay", () => {
  const prefs = JSON.stringify({ Claude: { "5h": false, "7d": false, "extra:Spend": false } });
  const allOff = loadCardRenderer(prefs);
  const provider = {
    name: "Claude",
    connected: true,
    windows: [
      { key: "5h", label: "5-Hour", unit: "percent", usedPct: 62 },
      { key: "7d", label: "7-Day", unit: "percent", usedPct: 43 },
    ],
    extras: [{ label: "Spend", text: "$12" }],
  };

  assert.equal(allOff.cardHtml(provider), "");

  const someOn = loadCardRenderer(JSON.stringify({ Claude: { "5h": false } }));
  const html = someOn.cardHtml(provider);
  assert.match(html, /aria-label="7d 43% used"/);
  assert.match(html, /Spend/);
});

test("erroring provider with no data still renders its card", () => {
  const { cardHtml } = loadCardRenderer(JSON.stringify({ Claude: {} }));
  const html = cardHtml({
    name: "Claude",
    connected: true,
    error: "HTTP 429",
    windows: [],
    extras: [],
  });

  assert.match(html, /<section class="card"/);
});

const claudePhoneCard = {
  name: "Claude", connected: true, plan: "Max 20x", canLogout: true,
  windows: [
    { key: "5h", label: "5-Hour", usedPct: 60, resetAt: Date.now() + 4.35 * 3600e3 },
    { key: "7d", label: "7-Day", usedPct: 46, resetAt: Date.now() + 5 * 86400e3 },
    { key: "7d-fable", label: "7-Day (Fable)", usedPct: 22, resetAt: Date.now() + 5 * 86400e3 },
  ],
  extras: [{ label: "Spend", text: "18.40 GBP" }],
};

test("phone card shows the primary window as one bar row and folds the rest", () => {
  const { cardHtml } = loadCardRenderer(undefined, undefined, new Map(), undefined, { phone: true });
  const html = cardHtml(claudePhoneCard, false);

  assert.doesNotMatch(html, /dots-wrap/);
  assert.match(html, /<div class="minibars headline">\s*<div class="minibar">\s*<span class="mb-cap" title="5-Hour">5h</);
  // Two secondary windows plus one extra are folded, and the fold starts closed.
  assert.match(html, /<button class="more-btn" data-more="Claude" aria-expanded="false">3 more<\/button>/);
  assert.match(html, /<div class="fold" hidden>/);
  assert.match(html, /Spend/);
  // The elapsed-time tick replaces the dot grid's signal; 13% of the 5h window is gone.
  assert.match(html, /class="mb-tick" style="left:13%"/);
  // The desktop card keeps its gauge and grows no toggle.
  const desktop = loadCardRenderer().cardHtml(claudePhoneCard, false);
  assert.match(desktop, /dots-wrap/);
  assert.doesNotMatch(desktop, /more-btn|mb-tick/);
});

test("phone fold stays open across re-renders once expanded", () => {
  const storage = new Map([["usage-dashboard-expanded-prefs", JSON.stringify({ Claude: true })]]);
  const { cardHtml } = loadCardRenderer(undefined, undefined, storage, undefined, { phone: true });
  const html = cardHtml(claudePhoneCard, false);

  assert.match(html, /aria-expanded="true">3 more</);
  assert.match(html, /<div class="fold">/);
  assert.doesNotMatch(html, /class="fold" hidden/);
});

test("a phone card with a single window has nothing to fold", () => {
  const { cardHtml } = loadCardRenderer(undefined, undefined, new Map(), undefined, { phone: true });
  const html = cardHtml(windowFixture("Grok", 30, { resetAt: Date.now() + 86400e3 }), false);

  assert.match(html, /class="minibars headline"/);
  assert.doesNotMatch(html, /more-btn|class="fold"/);
});

test("phone countdowns keep two units; desktop keeps all of them", () => {
  const far = Date.now() + 10 * 86400e3 + 23 * 3600e3 + 59 * 60e3 + 30e3;
  assert.match(loadCardRenderer(undefined, undefined, new Map(), undefined, { phone: true }).shortCountdown(far), /^10d 23h$/);
  assert.match(loadCardRenderer().shortCountdown(far), /^10d 23h 59m$/);
});

test("the chart shows the last 12 hours on desktop and phone alike", () => {
  for (const phone of [false, true]) {
    const api = loadCardRenderer(undefined, undefined, new Map(), undefined, { phone });
    const now = 48 * 3600e3;
    const provider = (usedPct) => [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }];
    api.setData({ updatedAt: now, providers: provider(35), history: [{ sampledAt: now - 20 * 3600e3, providers: provider(20) }] });
    api.renderChart();

    // The 20-hour-old sample falls outside the range, so the axis spans the default 12 hours.
    assert.match(api.chartPlot.innerHTML, /aria-label="Provider usage percentages over the last 12 hours"/);
    assert.match(api.chartPlot.innerHTML, /−12h/);
    assert.doesNotMatch(api.chartPlot.innerHTML, /−24h|−20h/);
    assert.equal(api.chartSubtitle.textContent, "Rolling history, up to 12 hours · percentage used");
  }
});

test("settings panel carries plan and Log out so the phone card can drop them", () => {
  const { renderSettings, setData, settingsBody } = loadCardRenderer();
  setData({ updatedAt: 0, providers: [claudePhoneCard, windowFixture("GLM", 10, {}, { plan: "lite" })] });
  renderSettings();

  assert.match(settingsBody.innerHTML, /<strong>Claude<span class="plan-inline">Max 20x<\/span><\/strong>/);
  assert.match(settingsBody.innerHTML, /class="link-btn logout-link" data-logout="claude" data-name="Claude"/);
  // GLM is keyed, not OAuth: nothing to log out of.
  assert.doesNotMatch(settingsBody.innerHTML, /data-logout="glm"/);
});

test("history chart defaults to 5h series and scales the axis to the visible peak", () => {
  const { renderChart, setData, chartLegend, chartPlot } = loadCardRenderer();
  const sampledAt = 24 * 3600e3;
  setData({
    updatedAt: sampledAt,
    providers: [{
      name: "Claude",
      windows: [
        { key: "5h", label: "5-Hour", usedPct: 40 },
        { key: "7d", label: "7-Day", usedPct: 70 },
      ],
    }],
    history: [{
      sampledAt,
      providers: [{ name: "Claude", windows: [
        { key: "5h", label: "5-Hour", usedPct: 40 },
        { key: "7d", label: "7-Day", usedPct: 70 },
      ] }],
    }],
  });

  renderChart();

  assert.match(chartLegend.innerHTML, /data-series="Claude:5h" checked/);
  assert.doesNotMatch(chartLegend.innerHTML, /data-series="Claude:7d" checked/);
  assert.equal((chartPlot.innerHTML.match(/class="usage-line"/g) || []).length, 1);
  // Only the 5h series is visible at 40%, so the axis tops out at 50, not 100.
  assert.match(chartPlot.innerHTML, />50<\/text>/);
  assert.match(chartPlot.innerHTML, />0<\/text>/);
  assert.doesNotMatch(chartPlot.innerHTML, />100<\/text>/);
  assert.match(chartPlot.innerHTML, /−12h/);
});

test("axis coarsens to 25-point steps once the visible peak passes 50", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const sampledAt = 24 * 3600e3;
  const windows = [{ key: "5h", label: "5-Hour", usedPct: 88 }];
  setData({
    updatedAt: sampledAt,
    providers: [{ name: "Claude", windows }],
    history: [{ sampledAt, providers: [{ name: "Claude", windows }] }],
  });

  renderChart();

  assert.match(chartPlot.innerHTML, />100<\/text>/);
  assert.match(chartPlot.innerHTML, />75<\/text>/);
  assert.match(chartPlot.innerHTML, />25<\/text>/);
  assert.doesNotMatch(chartPlot.innerHTML, />10<\/text>/);
});

test("an all-zero chart still renders a usable axis instead of dividing by zero", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const sampledAt = 24 * 3600e3;
  const windows = [{ key: "5h", label: "5-Hour", usedPct: 0 }];
  setData({
    updatedAt: sampledAt,
    providers: [{ name: "Claude", windows }],
    history: [{ sampledAt, providers: [{ name: "Claude", windows }] }],
  });

  renderChart();

  assert.match(chartPlot.innerHTML, />10<\/text>/);
  assert.doesNotMatch(chartPlot.innerHTML, /NaN/);
});

test("toggling a series does not change other lines' dash patterns", () => {
  const mkData = () => ({
    updatedAt: 24 * 3600e3,
    providers: [{
      name: "Claude",
      windows: [
        { key: "5h", label: "5-Hour", usedPct: 40 },
        { key: "7d", label: "7-Day", usedPct: 70 },
        { key: "1mo", label: "Monthly", usedPct: 55 },
      ],
    }],
    history: [],
  });
  const dashFor = (html, label) => {
    const chunk = html.split("<path").find((part) => part.includes(`<title>Claude ${label}`));
    const m = chunk && chunk.match(/stroke-dasharray="([^"]*)"/);
    return m ? m[1] : null;
  };

  const allOn = loadCardRenderer(undefined, JSON.stringify({ "Claude:5h": true, "Claude:7d": true, "Claude:1mo": true }));
  allOn.setData(mkData());
  allOn.renderChart();
  assert.equal(dashFor(allOn.chartPlot.innerHTML, "7-Day"), "3 5");
  assert.equal(dashFor(allOn.chartPlot.innerHTML, "Monthly"), "9 5");

  const without7d = loadCardRenderer(undefined, JSON.stringify({ "Claude:5h": true, "Claude:7d": false, "Claude:1mo": true }));
  without7d.setData(mkData());
  without7d.renderChart();
  assert.equal(dashFor(without7d.chartPlot.innerHTML, "7-Day"), null);
  assert.equal(dashFor(without7d.chartPlot.innerHTML, "Monthly"), "9 5");
});

test("history chart plots the current live snapshot when history is empty", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  setData({
    updatedAt: 24 * 3600e3,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 42 }] }],
    history: [],
  });

  renderChart();

  assert.match(chartPlot.innerHTML, /class="usage-line"/);
  assert.doesNotMatch(chartPlot.innerHTML, /class="usage-point"/);
  assert.match(chartPlot.innerHTML, /Claude 5-Hour: 42%/);
});

test("history chart connects snapshots returned by the server", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const provider = (usedPct) => [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }];

  setData({
    updatedAt: 3600e3 + 60e3,
    providers: provider(35),
    history: [{ sampledAt: 3600e3, providers: provider(20) }],
  });
  renderChart();

  assert.match(chartPlot.innerHTML, /class="usage-line" d="M[^\"]+ C[^\"]+"/);
  assert.match(chartPlot.innerHTML, /class="usage-line" d="M36\.0,.+ 988\.0,/);
});

test("existing client history is uploaded once and removed after success", async () => {
  const storage = new Map();
  const samples = [{ sampledAt: 3600e3, providers: [] }];
  storage.set("usage-dashboard-live-history", JSON.stringify(samples));
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === "/api/history/import") return { ok: true, json: async () => ({ count: 1 }) };
    return { ok: true, json: async () => ({ updatedAt: 0, providers: [], history: [] }) };
  };

  loadCardRenderer(undefined, undefined, storage, fetchImpl);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(requests[0].options.body), { samples });
  assert.equal(storage.has("usage-dashboard-live-history"), false);
  assert.equal(requests[1].url, "/api/usage");
});

test("a long gap between samples never draws the line backwards in time", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const now = 24 * 3600e3;
  const sample = (sampledAt, usedPct) => ({
    sampledAt,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }],
  });
  // A minute-by-minute run, then an eight-hour outage, then another run: the
  // spacing either side of the gap is 480x tighter than the gap itself.
  const history = [];
  for (let i = 0; i < 20; i++) history.push(sample(now - 16 * 3600e3 + i * 60e3, 10 + i));
  for (let i = 0; i < 20; i++) history.push(sample(now - 5 * 60e3 + i * 15e3, 40 + i));
  setData({
    updatedAt: now,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 60 }] }],
    history,
  });

  renderChart();

  const d = chartPlot.innerHTML.match(/ d="([^"]+)"/)[1];
  const xs = [...d.matchAll(/[MC]?(-?[\d.]+),(-?[\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(xs.length > 2);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] >= xs[i - 1] - 0.05, `x went backwards at ${i}: ${xs[i - 1]} -> ${xs[i]}`);
  }
});

test("an outage breaks the line instead of interpolating across it", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const now = 24 * 3600e3;
  const sample = (sampledAt, usedPct) => ({
    sampledAt,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }],
  });
  const history = [];
  for (let i = 0; i < 20; i++) history.push(sample(now - 9 * 3600e3 + i * 60e3, 10));
  for (let i = 0; i < 20; i++) history.push(sample(now - 5 * 60e3 + i * 15e3, 40));
  setData({
    updatedAt: now,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 40 }] }],
    history,
  });

  renderChart();

  const d = chartPlot.innerHTML.match(/ d="([^"]+)"/)[1];
  // One moveto per side of the eight-hour hole, and no curve spanning it.
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((chartPlot.innerHTML.match(/class="usage-line"/g) || []).length, 1);

  // A run of missed refreshes short enough to be noise stays a single line.
  const dense = [];
  for (let i = 0; i < 40; i++) dense.push(sample(now - 40 * 60e3 + i * 60e3, 10));
  dense.splice(20, 2); // a two-minute hiccup
  setData({
    updatedAt: now,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 10 }] }],
    history: dense,
  });
  renderChart();
  assert.equal((chartPlot.innerHTML.match(/ d="([^"]+)"/)[1].match(/M/g) || []).length, 1);
});

test("a lone sample surrounded by outages still renders as a visible dot", () => {
  const { renderChart, setData, chartPlot } = loadCardRenderer();
  const now = 24 * 3600e3;
  const sample = (sampledAt, usedPct) => ({
    sampledAt,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }],
  });
  setData({
    updatedAt: now,
    providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct: 30 }] }],
    history: [sample(now - 12 * 3600e3, 10), sample(now, 30)],
  });

  renderChart();

  const d = chartPlot.innerHTML.match(/ d="([^"]+)"/)[1];
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.doesNotMatch(d, /C/);
  assert.match(d, /M[\d.]+,[\d.]+L[\d.]+,[\d.]+/);
});

// ---------- browsing back through history ----------
const HOUR = 3600e3;
const claudeAt = (sampledAt, usedPct) => ({ sampledAt, providers: [{ name: "Claude", windows: [{ key: "5h", label: "5-Hour", usedPct }] }] });
// Samples every ten minutes from `fromAgo` hours back to `toAgo` hours back.
function samplesBetween(now, fromAgo, toAgo, usedPct = 30) {
  const out = [];
  for (let at = now - fromAgo * HOUR; at <= now - toAgo * HOUR; at += 10 * 60e3) out.push(claudeAt(at, usedPct));
  return out;
}
// A renderer whose /api/usage poll never settles (so it can't overwrite the
// fixture) and whose /api/history answers from `older`, recording each ask.
function browsingRenderer({ now = 200 * HOUR, oldestAgo = 48, older = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    if (String(url).startsWith("/api/history?")) {
      const params = new URLSearchParams(String(url).split("?")[1]);
      const from = Number(params.get("from"));
      const to = Number(params.get("to"));
      asked.push({ from, to });
      return { ok: true, json: async () => ({ samples: older.filter((s) => s.sampledAt >= from && s.sampledAt <= to), oldestAt: now - oldestAgo * HOUR }) };
    }
    return new Promise(() => {});
  };
  const api = loadCardRenderer(undefined, undefined, new Map(), fetchImpl);
  api.setData({
    updatedAt: now,
    providers: claudeAt(now, 30).providers,
    history: samplesBetween(now, 13, 0),
    historySince: now - 13 * HOUR,
    historyOldestAt: now - oldestAgo * HOUR,
  });
  api.renderChart();
  return { ...api, asked, now };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("stepping back leaves live: absolute times, a browsing mark, and a Now button", () => {
  const view = browsingRenderer();
  assert.equal(view.chartNow.hidden, true);
  assert.match(view.chartLive.innerHTML, /live/);

  view.stepChart(-1);

  assert.equal(view.chartNow.hidden, false);
  assert.match(view.chartLive.innerHTML, /browsing/);
  assert.doesNotMatch(view.chartLive.innerHTML, /live/);
  assert.match(view.chartSubtitle.textContent, /6 hours ago/);
  assert.doesNotMatch(view.chartSubtitle.textContent, /Rolling/);
  // Relative "−6h" labels would read as hours before now, not before the right edge.
  assert.doesNotMatch(view.chartPlot.innerHTML, /−\d|>now</);
  assert.equal(view.chartForward.disabled, false);
});

test("browsing past the embedded history asks the server for that range once, then draws it", async () => {
  const now = 200 * HOUR;
  const view = browsingRenderer({ now, older: samplesBetween(now, 30, 13, 77) });

  view.stepChart(-1); // right edge 6h ago, left edge 18h ago: past the 13h the snapshot carries
  await settle();

  // The view plus an hour each side, less the 13 hours the snapshot already holds.
  assert.deepEqual(view.asked, [{ from: now - 19 * HOUR, to: now - 13 * HOUR }]);
  assert.match(view.chartPlot.innerHTML, /class="usage-line"/);
  // 77% only exists in the fetched samples; the axis scales to it.
  assert.match(view.chartPlot.innerHTML, />100<\/text>/);

  view.stepChart(1);
  view.stepChart(-1);
  await settle();
  assert.equal(view.asked.length, 1, "a range already fetched is served from memory");
});

test("the live view never asks for history beyond the snapshot", async () => {
  const view = browsingRenderer();
  view.renderChart();
  await settle();
  assert.deepEqual(view.asked, []);
});

test("a failed range says so, retries on the next pan, and never mislabels a loaded view", async () => {
  const now = 200 * HOUR;
  let failing = true;
  const asked = [];
  const fetchImpl = async (url) => {
    if (!String(url).startsWith("/api/history?")) return new Promise(() => {});
    asked.push(url);
    if (failing) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ samples: samplesBetween(now, 30, 13), oldestAt: now - 48 * HOUR }) };
  };
  const view = loadCardRenderer(undefined, undefined, new Map(), fetchImpl);
  view.setData({ updatedAt: now, providers: claudeAt(now, 30).providers, history: samplesBetween(now, 13, 0), historySince: now - 13 * HOUR, historyOldestAt: now - 48 * HOUR });

  view.stepChart(-1);
  await settle();
  assert.match(view.chartSubtitle.textContent, /couldn't load/);
  assert.equal(asked.length, 1, "the same failed range is not retried in a loop");

  // Back to a view the snapshot covers: no failure note there.
  view.stepChart(1);
  assert.doesNotMatch(view.chartSubtitle.textContent, /couldn't load/);

  failing = false;
  view.stepChart(-1);
  await settle();
  assert.equal(asked.length, 2);
  assert.doesNotMatch(view.chartSubtitle.textContent, /couldn't load/);
});

test("Home stops the left edge on the oldest sample and disables going further back", () => {
  const now = 200 * HOUR;
  const view = browsingRenderer({ now, oldestAgo: 40 });
  assert.equal(view.chartBack.disabled, false);

  assert.equal(view.chartKey("Home"), true);
  // Left edge on the sample 40h ago, so the right edge is 28h ago.
  assert.match(view.chartSubtitle.textContent, /28 hours ago/);
  assert.equal(view.chartBack.disabled, true);

  view.stepChart(-1);
  assert.match(view.chartSubtitle.textContent, /28 hours ago/, "nothing older to page into");
});

test("a history shorter than the window has nowhere to go back to", () => {
  const view = browsingRenderer({ oldestAgo: 10 });
  assert.equal(view.chartBack.disabled, true);
  view.stepChart(-1);
  assert.equal(view.chartNow.hidden, true, "still live");
});

test("stepping or dragging onto now re-attaches to live; End jumps there", () => {
  const view = browsingRenderer();
  view.stepChart(-1);
  view.stepChart(1);
  assert.equal(view.chartNow.hidden, true);
  assert.match(view.chartLive.innerHTML, /live/);

  view.stepChart(-1);
  view.panChartBy(10 * HOUR); // overshoots now and clamps to it
  assert.equal(view.chartNow.hidden, true);
  assert.equal(view.chartForward.disabled, true);

  view.chartKey("ArrowLeft");
  view.chartKey("ArrowLeft");
  assert.match(view.chartSubtitle.textContent, /12 hours ago/);
  view.chartKey("End");
  assert.match(view.chartSubtitle.textContent, /Rolling history/);
  assert.equal(view.chartKey("a"), false, "unhandled keys fall through");
});

test("a new poll slides the live view but leaves a browsed view where it is", () => {
  const now = 200 * HOUR;
  const view = browsingRenderer({ now });
  view.stepChart(-1);
  const browsed = view.chartSubtitle.textContent;
  const range = browsed.split(" · ")[0];

  view.setData({ updatedAt: now + HOUR, providers: claudeAt(now + HOUR, 30).providers, history: samplesBetween(now + HOUR, 13, 0), historySince: now - 12 * HOUR, historyOldestAt: now - 48 * HOUR });
  view.renderChart();

  assert.equal(view.chartSubtitle.textContent.split(" · ")[0], range, "same absolute range");
  assert.match(view.chartSubtitle.textContent, /7 hours ago/);
});

test("a short drag back reads in minutes, not '0 hours ago'", () => {
  const view = browsingRenderer();
  view.panChartBy(-20 * 60e3);
  assert.match(view.chartSubtitle.textContent, /20 minutes ago/);
});

test("with older history to browse, the live view is a fixed 12 hours even if the enabled lines start later", () => {
  const now = 200 * HOUR;
  const view = browsingRenderer({ now });
  // Only the last three hours carry the enabled series.
  view.setData({ updatedAt: now, providers: claudeAt(now, 30).providers, history: samplesBetween(now, 3, 0), historySince: now - 13 * HOUR, historyOldestAt: now - 48 * HOUR });
  view.renderChart();
  assert.match(view.chartPlot.innerHTML, /−12h/, "not stretched to −3h, so a drag tracks the cursor");
});

test("a fetch asks only for the part of the view not already held", async () => {
  const now = 200 * HOUR;
  const view = browsingRenderer({ now, older: samplesBetween(now, 40, 13, 50) });
  view.stepChart(-1); // needs 19h..5h ago; the snapshot holds 13h..now
  await settle();
  assert.deepEqual(view.asked.at(-1), { from: now - 19 * HOUR, to: now - 13 * HOUR });
  view.stepChart(-1); // needs 25h..11h ago; 19h onwards is held
  await settle();
  assert.deepEqual(view.asked.at(-1), { from: now - 25 * HOUR, to: now - 19 * HOUR });
});
