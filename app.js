const REFRESH_MS = 60000;
const grid = document.getElementById("grid");
const updatedEl = document.getElementById("updated");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsBody = document.getElementById("settings-body");
const chartLegend = document.getElementById("chart-legend");
const chartPlot = document.getElementById("chart-plot");
const chartSubtitle = document.getElementById("chart-subtitle");
let pendingPoll = null;
let lastData = null;

// On a phone the card trades its dot gauge for one headline bar row and folds
// the other windows under a "N more" toggle. The breakpoint matches style.css.
// Tests run without matchMedia and get the desktop layout.
const PHONE_QUERY = "(max-width: 600px)";
const phoneMedia = typeof matchMedia === "function" ? matchMedia(PHONE_QUERY) : null;
const isPhone = () => Boolean(phoneMedia && phoneMedia.matches);
phoneMedia?.addEventListener?.("change", () => { renderGrid(); renderChart(); });

const PREFS_KEY = "usage-dashboard-metric-prefs";
const CHART_PREFS_KEY = "usage-dashboard-chart-prefs";
const PRIMARY_PREFS_KEY = "usage-dashboard-primary-prefs";
const EXPANDED_PREFS_KEY = "usage-dashboard-expanded-prefs";
const LIVE_HISTORY_KEY = "usage-dashboard-live-history";
const CHART_SPAN_KEY = "usage-dashboard-chart-span";
let prefs = loadPrefs();
let chartPrefs = loadChartPrefs();
let primaryPrefs = loadPrimaryPrefs();
let expandedPrefs = loadExpandedPrefs();
let firstRender = true;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}
function loadChartPrefs() {
  try { return JSON.parse(localStorage.getItem(CHART_PREFS_KEY)) || {}; } catch { return {}; }
}
function saveChartPrefs() {
  try { localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(chartPrefs)); } catch {}
}
function loadPrimaryPrefs() {
  try { return JSON.parse(localStorage.getItem(PRIMARY_PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrimaryPrefs() {
  try { localStorage.setItem(PRIMARY_PREFS_KEY, JSON.stringify(primaryPrefs)); } catch {}
}
function loadExpandedPrefs() {
  try { return JSON.parse(localStorage.getItem(EXPANDED_PREFS_KEY)) || {}; } catch { return {}; }
}
// Which phone cards are unfolded; the poll re-renders every card, so the
// choice has to outlive the markup.
function isExpanded(provider) {
  return expandedPrefs[provider] === true;
}
function setExpanded(provider, on) {
  if (on) expandedPrefs[provider] = true; else delete expandedPrefs[provider];
  try { localStorage.setItem(EXPANDED_PREFS_KEY, JSON.stringify(expandedPrefs)); } catch {}
}
const winId = (w) => String(w.key || w.label || "");
const extraId = (x) => "extra:" + (x.label || "");
function isEnabled(provider, id) {
  return ((prefs[provider] || {})[id]) !== false;
}
function setEnabled(provider, id, on) {
  const p = prefs[provider] || (prefs[provider] = {});
  if (on) delete p[id]; else p[id] = false;
  if (!Object.keys(p).length) delete prefs[provider];
  savePrefs();
}

// Which window a provider's card shows as the big dot gauge; every other
// enabled window drops to a mini bar. Unset means "whatever pickPrimaryWindow
// picks", so a provider the user never touched keeps the 5h-then-7d default.
function setPrimaryMetric(provider, id) {
  if (id) primaryPrefs[provider] = id; else delete primaryPrefs[provider];
  savePrimaryPrefs();
}

const DOTS = 64;
const DOT_COLS = 8;
const STAGGER_MS = 11;
const PROVIDER_COLORS = {
  GLM: "#783afd",
  Codex: "#bffd3a",
  Grok: "#3afdda",
  Claude: "#fd3a5e",
};
const providerColor = (name) => PROVIDER_COLORS[name] || "var(--accent)";

function windowDurationMs(w) {
  const k = String(w.key || w.label || "").toLowerCase();
  if (k.startsWith("5h")) return 5 * 3600e3;
  if (k.startsWith("1h")) return 3600e3;
  if (k.startsWith("7d")) return 7 * 86400e3;
  if (k.startsWith("1d") || k.startsWith("day")) return 86400e3;
  if (k.startsWith("month") || k.startsWith("1mo")) {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() * 86400e3;
  }
  return null;
}
// How full the dot grid is: the share of the window's duration already elapsed,
// rounded so a freshly armed window is empty and reset-imminent is full.
// 0 = unarmed / full duration remaining (all gray); null = duration unknown,
// fall back to usage.
function gridFillPct(w, now) {
  if (!w.resetAt) return 0;
  const dur = windowDurationMs(w);
  if (!dur) return null;
  return Math.max(0, Math.min(100, Math.round(100 - ((w.resetAt - now) / dur) * 100)));
}
function dotGridHtml(pct, caption, color, stagger, fillPct) {
  const raw = Math.max(0, pct || 0);
  const fill = fillPct == null ? raw : fillPct;
  const lit = Math.ceil((Math.min(100, Math.max(0, fill)) * DOTS) / 100);
  const shown = Math.round(raw);
  const over = raw > 100;
  const digits = String(shown).length;
  const sizeClass = digits >= 4 ? " widest" : "";
  let dots = "";
  for (let i = 0; i < DOTS; i++) {
    const cx = 13.75 + (i % DOT_COLS) * 27.5;
    const cy = 13.75 + Math.floor(i / DOT_COLS) * 27.5;
    const on = i < lit;
    const delay = stagger && on ? ` style="animation-delay:${i * STAGGER_MS}ms"` : "";
    dots += `<circle class="dot${on ? " on" : ""}" cx="${cx}" cy="${cy}" r="9.2"${delay}/>`;
  }
  return `<div class="dots-wrap${stagger ? " stagger" : ""}" style="color:${color}">
    <svg class="dots" viewBox="0 0 220 220" role="img" aria-label="${caption} ${shown}% used">
      ${dots}
    </svg>
    <div class="dots-pct${over ? " over" : ""}${sizeClass}">${shown}</div>
  </div>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SECONDS_BELOW_MS = 10 * 60e3;
// A phone row has room for two units ("10d 23h", "3h 15m"); the third never
// changes a decision and costs the column its width.
const PHONE_COUNTDOWN_UNITS = 2;
function remaining(resetAt, maxUnits = Infinity) {
  const left = Math.max(0, resetAt - Date.now());
  let s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h || d) parts.push(h + "h");
  parts.push(m + "m");
  if (left < SECONDS_BELOW_MS) parts.push(s + "s");
  return parts.slice(0, maxUnits).join(" ");
}
// Countdowns render bare next to their window caption ("5h · 3h 15m"); the
// caption and column position carry the meaning a "resets in" prefix would.
// No resetAt means the window has not started counting down — the same
// "unarmed" state gridFillPct reads as an empty grid — so say that rather
// than render a bare dash that reads as missing data.
const UNARMED_TEXT = "unarmed";
const UNARMED_TITLE = "No reset scheduled — this window starts counting at its first use";
function shortCountdown(resetAt) {
  return resetAt ? remaining(resetAt, isPhone() ? PHONE_COUNTDOWN_UNITS : Infinity) : UNARMED_TEXT;
}
function countdownHtml(resetAt, className = "") {
  const cls = [className, resetAt ? "" : "na"].filter(Boolean).join(" ");
  const title = resetAt ? "" : ` title="${esc(UNARMED_TITLE)}"`;
  return `<span${cls ? ` class="${cls}"` : ""} data-reset="${esc(resetAt || "")}"${title}>${shortCountdown(resetAt)}</span>`;
}
function updateCountdowns() {
  document.querySelectorAll("[data-reset]").forEach((el) => {
    const v = el.getAttribute("data-reset");
    const resetAt = v ? Number(v) : null;
    el.textContent = shortCountdown(resetAt);
    if (el.classList) el.classList.toggle("na", !resetAt);
  });
}

// Duration windows caption by their key ("5h", "7d"). A named limit — an
// extra per-model cap such as "GPT-5.3-Codex-Spark" — has a name where the
// key would be, and slicing that to six characters yields "gpt-5.", so caption
// it by the trailing segment that actually distinguishes it ("Spark"). The
// full name stays in the title attribute.
const DURATION_KEY = /^(\d+(h|d|mo|y)|month|day|week)/;
function captionFor(w) {
  const k = String(w.key || w.label || "").toLowerCase();
  if (k.startsWith("month")) return "mo";
  if (DURATION_KEY.test(k)) return k.slice(0, 6);
  // The key is the limit's name here; the label may have been overwritten with
  // a duration ("7-Day") when the API reported one, so read the key first.
  const name = String(w.key || w.label || "");
  return name.split(/[-\u2013 ]/).filter(Boolean).pop() || k.slice(0, 6);
}
// What the caption abbreviates, for a tooltip: the parts of a window's
// identity the six-character caption had to drop, or "" when it dropped none.
function captionTitle(w) {
  const key = String(w.key || "");
  const label = String(w.label || "");
  const parts = [];
  if (key && !DURATION_KEY.test(key.toLowerCase())) parts.push(key);
  if (label && label !== key) parts.push(label);
  const full = parts.join(" \u00b7 ");
  return full.toLowerCase() === captionFor(w).toLowerCase() ? "" : full;
}
function pickPrimaryWindow(wins, provider) {
  if (!wins.length) return null;
  // A chosen window that is hidden or gone from the payload falls through to
  // the default rather than leaving the card without a gauge.
  const chosen = provider && primaryPrefs[provider];
  if (chosen) {
    const match = wins.find((w) => winId(w) === chosen);
    if (match) return match;
  }
  const id = (w) => String(w.key || w.label || "").toLowerCase();
  return wins.find((w) => id(w).startsWith("5h")) || wins.find((w) => id(w).startsWith("7d")) || wins[0];
}
// tickAt: when given, a marker on the track shows how far through the window's
// duration we are — the same signal the dot grid carries on desktop, which a
// phone card has no gauge to show. Omitted (desktop bars), the row is plain.
function miniBarHtml(w, color, tickAt) {
  const raw = Math.max(0, w.usedPct || 0);
  const clamped = Math.min(100, raw);
  const title = captionTitle(w);
  const fill = tickAt == null ? null : gridFillPct(w, tickAt);
  // Clamped short of 100 so a reset-imminent tick stays inside the clipped track.
  const tick = fill ? `<i class="mb-tick" style="left:${Math.min(fill, 99)}%"></i>` : "";
  return `<div class="minibar">
    <span class="mb-cap"${title ? ` title="${esc(title)}"` : ""}>${esc(captionFor(w))}</span>
    <span class="mb-track"><i class="mb-fill" style="width:${Math.round(clamped)}%;background:${color}"></i>${tick}</span>
    <span class="mb-pct${raw > 100 ? " over" : ""}">${Math.round(raw)}%</span>
    ${countdownHtml(w.resetAt, "mb-reset")}
  </div>`;
}
function gaugeHtml(w, color, stagger, now = Date.now()) {
  const caption = esc(captionFor(w));
  const title = captionTitle(w);
  return `<div class="gauge-wrap">${dotGridHtml(w.usedPct || 0, caption, color, stagger, gridFillPct(w, now))}</div>
    <div class="gauge-meta"><b${title ? ` title="${esc(title)}"` : ""}>${caption}</b>${countdownHtml(w.resetAt)}</div>`;
}
function extrasHtml(extras) {
  if (!extras || !extras.length) return "";
  return `<div class="extras">${extras.map((e) => `<div class="extra"><span>${esc(e.label)}</span><span>${esc(e.text)}</span></div>`).join("")}</div>`;
}
function oauthSlug(p) {
  return (p.auth && p.auth.slug) || p.name.toLowerCase();
}
function oauthConnectHtml(p) {
  if (p.connected) return "";
  const slug = oauthSlug(p);
  const a = p.auth && p.auth.pending;
  if (a && (a.verification_url || a.error)) {
    const err = a.error ? `<p class="error">${esc(a.error)}</p>` : "";
    const retry = a.error ? `<button class="btn" data-connect="${esc(slug)}">Retry</button>` : `<p class="spinner">Waiting for approval…</p>`;
    const url = typeof a.verification_url === "string" && a.verification_url.startsWith("https://") ? a.verification_url : "";
    const urlHtml = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : "";
    const code = a.user_code ? `<p>and enter code</p><code>${esc(a.user_code)}</code>` : "";
    const manualUrl = typeof a.manual_url === "string" && a.manual_url.startsWith("https://") ? a.manual_url : "";
    const manual = manualUrl ? `
      <p class="hint">Redirect not working? <a href="${esc(manualUrl)}" target="_blank" rel="noopener">authorize manually</a>, then paste the code:</p>
      <div class="paste-row">
        <input type="text" placeholder="Paste code" autocomplete="off" spellcheck="false" data-paste-input="${esc(slug)}" />
        <button class="btn ghost" data-paste="${esc(slug)}">Submit</button>
      </div>` : "";
    return `<div class="connect">
      ${urlHtml ? `<p>Open ${urlHtml}</p>` : ""}
      ${code}
      ${err}
      ${retry}
      ${manual}
    </div>`;
  }
  const reason = p.error && p.error !== "not connected"
    ? `<p class="error">${esc(p.error)}</p>`
    : "";
  return `<div class="connect">
    <p class="spinner">${esc(p.name)} uses OAuth. Connect once to start tracking.</p>
    ${reason}
    <button class="btn" data-connect="${esc(slug)}">Connect ${esc(p.name)}</button>
  </div>`;
}
function logoutSlug(p) {
  if (!p.canLogout) return null;
  return (p.auth && p.auth.slug) || p.name.toLowerCase();
}
function providerErrorText(p) {
  const wait = Number(p.retryAfterMs);
  if (Number.isFinite(wait) && wait > 0) {
    const minutes = Math.max(1, Math.ceil(wait / 60000));
    return `${p.error} — Anthropic requested a ${minutes}-minute wait; Refresh will not bypass it.`;
  }
  if (/^HTTP (429|5\d\d)\b|rate limit|network|fetch failed/i.test(p.error || "")) {
    return `${p.error} — retrying with backoff.`;
  }
  return p.error;
}
function cardHtml(p, stagger, now = Date.now()) {
  let body;
  let moreBtn = "";
  if (!p.connected && p.auth) {
    body = oauthConnectHtml(p);
  } else if (p.error && !p.connected) {
    body = `<p class="error">${esc(p.error)}</p>`;
  } else {
    const color = providerColor(p.name);
    const wins = (p.windows || []).filter((w) => isEnabled(p.name, winId(w)));
    const extras = (p.extras || []).filter((x) => isEnabled(p.name, extraId(x)));
    const hasMetrics = (p.windows || []).length + (p.extras || []).length > 0;
    if (hasMetrics && !wins.length && !extras.length) return "";
    const primary = pickPrimaryWindow(wins, p.name);
    const rest = primary ? wins.filter((w) => w !== primary) : [];
    if (isPhone()) {
      // The primary window is the headline row; everything else folds.
      const folded = rest.length + extras.length;
      const open = isExpanded(p.name);
      moreBtn = folded
        ? `<button class="more-btn" data-more="${esc(p.name)}" aria-expanded="${open}">${folded} more</button>`
        : "";
      const headline = primary ? `<div class="minibars headline">${miniBarHtml(primary, color, now)}</div>` : "";
      const restHtml = rest.length ? `<div class="minibars">${rest.map((w) => miniBarHtml(w, color, now)).join("")}</div>` : "";
      const fold = folded ? `<div class="fold"${open ? "" : " hidden"}>${restHtml}${extrasHtml(extras)}</div>` : "";
      body = headline + fold;
    } else {
      const restHtml = rest.length
        ? `<div class="minibars">${rest.map((w) => miniBarHtml(w, color)).join("")}</div>`
        : "";
      body = (primary ? gaugeHtml(primary, color, stagger, now) : "") + restHtml + extrasHtml(extras);
    }
    if (!wins.length && !extras.length) {
      // A connected card with no data and an error (e.g. usage endpoint
      // 429ing before any good data was cached) must not render blank.
      body += p.error
        ? `<p class="error">${esc(providerErrorText(p))}</p>`
        : `<p class="all-hidden">All metrics hidden — enable some in ⚙ Metrics.</p>`;
    }
  }
  const slug = p.connected ? logoutSlug(p) : null;
  const logoutBtn = slug
    ? `<button class="logout-btn" data-logout="${esc(slug)}" data-name="${esc(p.name)}" title="Forget this dashboard's stored credentials">Log out</button>`
    : "";
  return `<section class="card">
    <div class="card-head">
      <h2>${esc(p.name)}${p.plan ? `<span class="plan-inline">${esc(p.plan)}</span>` : ""}${p.connected ? "" : '<span class="plan-inline">· not connected</span>'}</h2>
      ${moreBtn}${logoutBtn}
    </div>
    ${body}
  </section>`;
}
function renderGrid() {
  if (!lastData) return;
  const stagger = firstRender;
  firstRender = false;
  // The pending-auth poll re-renders periodically; keep typed paste codes.
  const pasted = {};
  document.querySelectorAll("[data-paste-input]").forEach((el) => { pasted[el.dataset.pasteInput] = el.value; });
  grid.innerHTML = lastData.providers.map((p) => cardHtml(p, stagger)).join("");
  document.querySelectorAll("[data-paste-input]").forEach((el) => {
    if (pasted[el.dataset.pasteInput]) el.value = pasted[el.dataset.pasteInput];
  });
}

// ---------- history chart ----------
// The server keeps seven days; the chart shows twelve hours of it at a time
// by default, on every layout, and pans back through the rest. Twelve hours
// keeps each 5h sawtooth legible even on a phone-width plot. Shift+wheel and
// +/- zoom between an hour and the whole week.
const CHART_HOURS = 12;
const DEFAULT_CHART_MS = CHART_HOURS * 3600e3;
const MIN_CHART_MS = 3600e3;
const MAX_CHART_MS = 7 * 24 * 3600e3;
const clampSpan = (ms) => Math.max(MIN_CHART_MS, Math.min(MAX_CHART_MS, ms));
function loadChartSpan() {
  let ms;
  try { ms = Number(JSON.parse(localStorage.getItem(CHART_SPAN_KEY))); } catch { return DEFAULT_CHART_MS; }
  return Number.isFinite(ms) && ms > 0 ? clampSpan(ms) : DEFAULT_CHART_MS;
}
// The server only samples while it is running, so history has holes. A few
// missed samples still read as one line; a longer silence is drawn as a break
// rather than a stroke implying usage we never observed.
const CHART_GAP_MS = 5 * REFRESH_MS;
// Last drawn layout, so a drag or wheel can turn pixels into time and a zoom
// knows what span is on screen.
const chartGeometry = { width: 0, padLeft: 0, plotW: 0, rangeMs: 0 };
async function migrateClientHistory() {
  let samples;
  try { samples = JSON.parse(localStorage.getItem(LIVE_HISTORY_KEY)); } catch { return; }
  if (!Array.isArray(samples) || !samples.length) return;
  try {
    const response = await fetch("/api/history/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples }),
    });
    if (response.ok) localStorage.removeItem(LIVE_HISTORY_KEY);
  } catch {}
}
const seriesId = (provider, window) => `${provider}:${String(window.key || window.label || "")}`;
const isFiveHour = (window) => String(window.key || window.label || "").toLowerCase().startsWith("5h");
const chartEnabled = (id, window) => id in chartPrefs ? chartPrefs[id] : isFiveHour(window);
const compactHistoryProviders = (providers) => (providers || []).map((provider) => ({
  name: provider.name,
  windows: (provider.windows || []).filter((window) => Number.isFinite(Number(window.usedPct))).map((window) => ({
    key: window.key,
    label: window.label,
    usedPct: Number(window.usedPct),
  })),
})).filter((provider) => provider.name && provider.windows.length);

function chartSeries(data) {
  const definitions = new Map();
  for (const provider of data.providers || []) {
    for (const window of provider.windows || []) {
      const id = seriesId(provider.name, window);
      definitions.set(id, { id, provider: provider.name, key: window.key, label: window.label || window.key, points: [] });
    }
  }
  const samplesByTime = new Map(olderSamples);
  for (const sample of data.history || []) samplesByTime.set(sample.sampledAt, sample);
  const liveAt = Number(data.updatedAt);
  if (Number.isFinite(liveAt)) samplesByTime.set(liveAt, { sampledAt: liveAt, providers: compactHistoryProviders(data.providers) });
  const samples = [...samplesByTime.values()].sort((a, b) => a.sampledAt - b.sampledAt);
  for (const sample of samples) {
    for (const provider of sample.providers || []) {
      for (const window of provider.windows || []) {
        const id = seriesId(provider.name, window);
        if (!definitions.has(id)) definitions.set(id, { id, provider: provider.name, key: window.key, label: window.label || window.key, points: [] });
        definitions.get(id).points.push([sample.sampledAt, Math.max(0, Math.min(100, Number(window.usedPct) || 0))]);
      }
    }
  }
  return [...definitions.values()];
}

// Split a series wherever the dashboard stopped sampling, so neither the
// smoothing below nor the curve tangents reach across a hole in the history.
function contiguousRuns(points) {
  const runs = [];
  for (const point of points) {
    const run = runs.at(-1);
    if (run && point[0] - run.at(-1)[0] <= CHART_GAP_MS) run.push(point);
    else runs.push([point]);
  }
  return runs;
}

function runPath(run, x, y) {
  const sm = run.map(([, pct]) => pct);
  for (let pass = 0; pass < 3; pass++) {
    const next = sm.slice();
    for (let i = 1; i < sm.length - 1; i++) next[i] = sm[i - 1] * 0.25 + sm[i] * 0.5 + sm[i + 1] * 0.25;
    sm.splice(0, sm.length, ...next);
  }
  const pts = run.map(([time], i) => [x(time), y(sm[i])]);
  const head = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  // A run of one has no segment to stroke; the round linecap turns an explicit
  // zero-length line into a dot so an isolated sample stays visible.
  if (pts.length === 1) return `${head}L${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  // Tangents are slopes scaled by each segment, not fixed fractions of the
  // neighbour span: samples are unevenly spaced, and a uniform Catmull-Rom
  // throws control points outside a short segment next to a long one, which
  // draws the line looping backwards in time.
  const slope = pts.map((point, i) => {
    const prev = pts[i - 1] || point;
    const next = pts[i + 1] || point;
    const span = next[0] - prev[0];
    return span > 0 ? (next[1] - prev[1]) / span : 0;
  });
  let d = head;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const dx = (p2[0] - p1[0]) / 3;
    d += ` C${(p1[0] + dx).toFixed(1)},${(p1[1] + slope[i] * dx).toFixed(1)} ${(p2[0] - dx).toFixed(1)},${(p2[1] - slope[i + 1] * dx).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// More samples than pixel columns: keep each column's lowest and highest
// point, in time order, so a week-wide view keeps the 5h peaks instead of
// stroking ten thousand points or averaging them away. The run's own first
// and last points stay too, so a line still stops where sampling stopped.
function thinRun(run, x) {
  const out = [];
  let column = null;
  let bucket = [];
  const flush = () => {
    if (bucket.length <= 2) {
      out.push(...bucket);
    } else {
      let lo = bucket[0];
      let hi = bucket[0];
      for (const point of bucket) {
        if (point[1] < lo[1]) lo = point;
        if (point[1] > hi[1]) hi = point;
      }
      if (lo === hi) out.push(lo);
      else out.push(...(lo[0] < hi[0] ? [lo, hi] : [hi, lo]));
    }
    bucket = [];
  };
  for (const point of run) {
    const at = Math.floor(x(point[0]));
    if (at !== column) { flush(); column = at; }
    bucket.push(point);
  }
  flush();
  if (out[0] !== run[0]) out.unshift(run[0]);
  if (out.at(-1) !== run.at(-1)) out.push(run.at(-1));
  return out;
}

// ---------- browsing back through history ----------
// null while the chart follows live; otherwise the absolute right edge the
// user panned to, which new samples never move.
let chartEnd = null;
// How much time the plot spans; kept across reloads, which still open live.
let chartSpanMs = loadChartSpan();
const chartBack = document.getElementById("chart-back");
const chartForward = document.getElementById("chart-forward");
const chartNow = document.getElementById("chart-now");
const chartLive = document.getElementById("chart-live");

const liveEdge = () => Number(lastData?.updatedAt) || Date.now();
// The furthest back the right edge may go: one window past the oldest stored
// sample, so the left edge stops on data rather than paging into a blank.
function earliestEnd() {
  const oldest = lastData?.historyOldestAt;
  const now = liveEdge();
  return oldest == null || !Number.isFinite(Number(oldest)) ? now : Math.min(now, Number(oldest) + chartSpanMs);
}
// Landing on the live edge re-attaches to live, however it got there.
function resolveChartEnd(end) {
  const now = liveEdge();
  const clamped = Math.max(earliestEnd(), Math.min(now, end));
  return clamped >= now ? null : clamped;
}
function setChartEnd(end) {
  historyFailed = false;
  chartEnd = resolveChartEnd(end);
  renderChart();
}
const viewEnd = () => chartEnd ?? liveEdge();
function stepChart(direction) { setChartEnd(viewEnd() + direction * chartSpanMs / 2); }
function jumpChart(where) { setChartEnd(where === "oldest" ? -Infinity : Infinity); }
// Positive moves forward in time.
function panChartBy(ms) { setChartEnd(viewEnd() + ms); }

// fraction: where across the plot the zoom centres, 0 the left edge and 1
// the right. A live view keeps its right edge on now whatever the fraction,
// so zooming never drops out of live.
function setChartSpan(ms, fraction = 0.5) {
  const onScreenMs = chartGeometry.rangeMs || chartSpanMs;
  const anchor = viewEnd() - (1 - fraction) * onScreenMs;
  chartSpanMs = clampSpan(ms);
  try { localStorage.setItem(CHART_SPAN_KEY, JSON.stringify(chartSpanMs)); } catch {}
  setChartEnd(chartEnd === null ? Infinity : anchor + (1 - fraction) * chartSpanMs);
}
// Below one, zooms in. A short history stretched across the plot shows less
// than the span, so zooming in starts from what is on screen; zooming out
// starts from the span, or the stretch would hold it in place.
function zoomChart(factor, fraction) {
  const onScreenMs = chartGeometry.rangeMs || chartSpanMs;
  setChartSpan((factor < 1 ? Math.min(chartSpanMs, onScreenMs) : chartSpanMs) * factor, fraction);
}
const KEY_ZOOM_FACTOR = 1.5;
const CHART_KEYS = {
  ArrowLeft: () => stepChart(-1),
  ArrowRight: () => stepChart(1),
  Home: () => jumpChart("oldest"),
  End: () => jumpChart("now"),
  "+": () => zoomChart(1 / KEY_ZOOM_FACTOR),
  "=": () => zoomChart(1 / KEY_ZOOM_FACTOR),
  "-": () => zoomChart(KEY_ZOOM_FACTOR),
  "0": () => setChartSpan(DEFAULT_CHART_MS),
};
function chartKey(key) {
  if (!CHART_KEYS[key]) return false;
  CHART_KEYS[key]();
  return true;
}

// Older samples the page fetched, and the spans of time those fetches
// covered. The snapshot itself carries everything since historySince, so
// only a browsed view, or a live one zoomed out past the snapshot, fetches.
// Kept for the life of the tab.
const olderSamples = new Map();
let fetchedSpans = [];
let historyFetch = null;
let historyFailed = false;
// An hour either side of the view, so the smoothing and gap detection have
// neighbours at the edges.
const CHART_FETCH_MARGIN_MS = 3600e3;
// The part of [from, to] that neither the snapshot nor an earlier fetch
// holds, trimmed from both ends; null when all of it is held.
function unheldPart(from, to) {
  const since = Number(lastData?.historySince);
  const spans = Number.isFinite(since) ? [...fetchedSpans, [since, Infinity]] : fetchedSpans;
  const ascending = spans.slice().sort((p, q) => p[0] - q[0]);
  let lo = from;
  for (const [a, b] of ascending) if (a <= lo && b > lo) lo = b;
  let hi = to;
  for (const [a, b] of ascending.reverse()) if (a < hi && b >= hi) hi = a;
  return lo < hi ? [lo, hi] : null;
}
function addFetchedSpan(from, to) {
  const merged = [];
  for (const span of [...fetchedSpans, [from, to]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  fetchedSpans = merged;
}
// Returns true when this view's range failed to load. A failure is not
// retried until the user pans or zooms again, so a down server isn't
// hammered by every 60s re-render; a live view's range slides with each
// poll, so the failure can't be keyed to the range it was for.
function ensureHistory(start, end) {
  const unheld = unheldPart(Math.floor(start - CHART_FETCH_MARGIN_MS), Math.ceil(Math.min(end + CHART_FETCH_MARGIN_MS, liveEdge())));
  if (!unheld) return false;
  if (historyFailed) return true;
  if (historyFetch) return false;
  const [from, to] = unheld;
  historyFetch = fetch(`/api/history?from=${from}&to=${to}`)
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((body) => {
      for (const sample of body.samples || []) olderSamples.set(sample.sampledAt, sample);
      addFetchedSpan(from, to);
    })
    .catch(() => { historyFailed = true; })
    .finally(() => {
      historyFetch = null;
      renderChart();
    });
  return false;
}

const clockLabel = (time) => new Date(time).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
function agoWords(ms) {
  if (ms < 3600e3) {
    const minutes = Math.max(1, Math.round(ms / 60e3));
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.round(ms / 3600e3);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(ms / 86400e3)} days ago`;
}
// Zoom is smooth, so hour and day counts keep one decimal below ten, and a
// count a hair under a whole number reads whole ("3", not "3.0").
const roundCount = (count) => (count >= 10 ? Math.round(count) : Number(count.toFixed(1)));
// A span in words: "30 minutes", "4.5 hours", "3 days".
function spanWords(ms) {
  const unit = ms < 3600e3 ? [60e3, "minute"] : ms < 48 * 3600e3 ? [3600e3, "hour"] : [86400e3, "day"];
  const count = unit[1] === "minute" ? Math.round(ms / unit[0]) : roundCount(ms / unit[0]);
  return `${count} ${unit[1]}${count === 1 ? "" : "s"}`;
}

function renderChartNav(browsing) {
  if (chartNow) chartNow.hidden = !browsing;
  if (chartForward) chartForward.disabled = !browsing;
  if (chartBack) chartBack.disabled = viewEnd() <= earliestEnd();
  const step = spanWords(chartSpanMs / 2);
  for (const [button, label] of [[chartBack, `Back ${step}`], [chartForward, `Forward ${step}`]]) {
    if (!button) continue;
    button.title = label;
    button.setAttribute?.("aria-label", label);
  }
  if (chartLive) {
    chartLive.className = browsing ? "live-mark browsing" : "live-mark";
    chartLive.innerHTML = browsing ? "<i></i> browsing" : "<i></i> live";
  }
}

function renderChart() {
  if (!lastData || !chartLegend || !chartPlot) return;
  // Pruning can move the oldest sample past a view the user left open.
  if (chartEnd !== null) chartEnd = resolveChartEnd(chartEnd);
  const browsing = chartEnd !== null;
  renderChartNav(browsing);
  const allSeries = chartSeries(lastData);
  chartLegend.innerHTML = allSeries.map((series) => {
    const window = { key: series.key, label: series.label };
    const checked = chartEnabled(series.id, window) ? " checked" : "";
    return `<label class="series-toggle" style="--series:${providerColor(series.provider)}">
      <input type="checkbox" data-series="${esc(series.id)}"${checked} />
      <i></i><span>${esc(series.provider)} · ${esc(captionFor(window))}</span>
    </label>`;
  }).join("");
  if (!allSeries.length) {
    chartPlot.innerHTML = `<p class="chart-empty">Usage history will appear after the first successful refresh.</p>`;
    return;
  }

  const width = Math.max(320, chartPlot.clientWidth || 1000);
  const height = Math.max(150, chartPlot.clientHeight || 300);
  const pad = { left: 36, right: 12, top: 12, bottom: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  chartGeometry.plotW = plotW;
  const now = liveEdge();
  const end = browsing ? chartEnd : now;
  const visibleSeries = allSeries.filter((series) => chartEnabled(series.id, series));
  const visibleTimes = [...new Set(visibleSeries.flatMap((series) => series.points.map(([time]) => time)))]
    .filter((time) => time >= end - chartSpanMs && time <= end)
    .sort((a, b) => a - b);
  // A history shorter than the window stretches to fill the plot. Once there
  // is older history to pan into, the window is always exactly the span,
  // so a drag from live tracks the cursor at the same scale it will pan at.
  // The fetch covers the whole span even while stretched: a live view zoomed
  // out past the snapshot has only the snapshot's samples until it lands.
  const unloaded = ensureHistory(end - chartSpanMs, end) ? " · couldn't load this range" : "";
  const stretch = !browsing && earliestEnd() >= now && visibleTimes.length > 1;
  const start = stretch ? visibleTimes[0] : end - chartSpanMs;
  const rangeMs = end - start;
  Object.assign(chartGeometry, { width, padLeft: pad.left, rangeMs });
  if (chartSubtitle) {
    chartSubtitle.textContent = browsing
      ? `${clockLabel(start)} – ${clockLabel(end)} · ${agoWords(now - end)}${unloaded} · percentage used`
      : `Rolling history, up to ${spanWords(chartSpanMs)}${unloaded} · percentage used`;
  }
  const x = (time) => pad.left + ((time - start) / rangeMs) * plotW;
  const peak = Math.max(0, ...visibleSeries.flatMap((series) =>
    series.points.filter(([time]) => time >= start && time <= end).map(([, pct]) => pct)));
  const step = peak > 50 ? 25 : peak > 20 ? 10 : 5;
  const axisTop = Math.min(100, Math.max(step * 2, Math.ceil((peak * 1.15) / step) * step));
  const ticks = [];
  for (let pct = 0; pct <= axisTop + 0.001; pct += step) ticks.push(pct);
  const y = (pct) => pad.top + (1 - pct / axisTop) * plotH;
  const grid = ticks.map((pct) => `<g><line x1="${pad.left}" y1="${y(pct)}" x2="${width - pad.right}" y2="${y(pct)}"/><text x="${pad.left - 10}" y="${y(pct) + 4}" text-anchor="end">${pct}</text></g>`).join("");
  // Past two days, hour counts get long ("−168h"), so every label reads in days.
  const inDays = rangeMs > 48 * 3600e3;
  const agoLabel = (ms) => {
    if (!ms) return "now";
    if (inDays) {
      return `−${roundCount(ms / 86400e3)}d`;
    }
    if (ms >= 3600e3) {
      return `−${roundCount(ms / 3600e3)}h`;
    }
    if (ms >= 60000) return `−${Math.round(ms / 60000)}m`;
    return `−${Math.max(1, Math.round(ms / 1000))}s`;
  };
  // Live labels count back from now; once the right edge is in the past a
  // relative label would be ambiguous, so browsed labels are clock times.
  const times = [4, 3, 2, 1, 0].map((steps, index) => {
    const xx = pad.left + (index / 4) * plotW;
    const label = browsing ? clockLabel(end - rangeMs * steps / 4) : agoLabel(rangeMs * steps / 4);
    return `<text x="${xx}" y="${height - 9}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}">${esc(label)}</text>`;
  }).join("");
  // Lines reach one gap's width past each edge and are clipped to the plot,
  // so a panned view shows the line entering and leaving rather than
  // starting and stopping at the frame.
  const paths = allSeries.map((series, index) => {
    if (!chartEnabled(series.id, series)) return "";
    const points = series.points.filter(([time]) => time >= start - CHART_GAP_MS && time <= end + CHART_GAP_MS).sort((a, b) => a[0] - b[0]);
    const inView = points.filter(([time]) => time >= start && time <= end);
    if (!inView.length) return "";
    const d = contiguousRuns(points).map((run) => runPath(thinRun(run, x), x, y)).join(" ");
    const last = inView.at(-1);
    const dash = String(series.key).toLowerCase().startsWith("5h") ? "" : ` stroke-dasharray="${index % 2 ? "3 5" : "9 5"}"`;
    return `<path class="usage-line" d="${d}" stroke="${providerColor(series.provider)}"${dash} clip-path="url(#chart-clip)"><title>${esc(series.provider)} ${esc(series.label)}: ${Math.round(last[1])}%</title></path>`;
  }).join("");
  const label = browsing
    ? `Provider usage percentages from ${clockLabel(start)} to ${clockLabel(end)}`
    : `Provider usage percentages over the last ${spanWords(chartSpanMs)}`;
  // The clip leaves room above and below for the stroke's width and round caps.
  const clip = `<clipPath id="chart-clip"><rect x="${pad.left}" y="0" width="${plotW}" height="${height}"/></clipPath>`;
  chartPlot.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><defs>${clip}</defs><g class="chart-grid">${grid}${times}</g>${paths}</svg>`;
}

let chartResizeFrame = null;
window.addEventListener("resize", () => {
  if (chartResizeFrame) cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => { chartResizeFrame = null; renderChart(); });
});

chartBack?.addEventListener("click", () => stepChart(-1));
chartForward?.addEventListener("click", () => stepChart(1));
chartNow?.addEventListener("click", () => jumpChart("now"));
chartPlot?.addEventListener("keydown", (event) => {
  // Alt+Left is the browser's Back; only bare keys belong to the chart,
  // except the shift most layouts need to type "+".
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.shiftKey && event.key !== "+") return;
  if (chartKey(event.key)) event.preventDefault();
});

// Drag and horizontal wheel pan pixel for pixel. Pointer events come faster
// than frames, so the target edge is coalesced into one render per frame.
let panFrame = null;
let panTarget = null;
function panToOnNextFrame(end) {
  panTarget = end;
  if (panFrame) return;
  panFrame = requestAnimationFrame(() => {
    panFrame = null;
    setChartEnd(panTarget);
  });
}
const msPerPixel = () => (chartGeometry.plotW ? chartSpanMs / chartGeometry.plotW : 0);
let chartDrag = null;
chartPlot?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !msPerPixel()) return;
  chartDrag = { id: event.pointerId, x: event.clientX, end: viewEnd(), msPerPx: msPerPixel() };
  chartPlot.setPointerCapture?.(event.pointerId);
  chartPlot.classList.add("dragging");
});
chartPlot?.addEventListener("pointermove", (event) => {
  if (!chartDrag || event.pointerId !== chartDrag.id) return;
  // Dragging the line rightward pulls older history into view.
  panToOnNextFrame(chartDrag.end - (event.clientX - chartDrag.x) * chartDrag.msPerPx);
});
const endChartDrag = (event) => {
  if (!chartDrag || event.pointerId !== chartDrag.id) return;
  chartDrag = null;
  chartPlot.classList.remove("dragging");
};
chartPlot?.addEventListener("pointerup", endChartDrag);
chartPlot?.addEventListener("pointercancel", endChartDrag);
const wheelPixels = (event, delta) => delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chartGeometry.plotW : 1);
// A 100px wheel notch zooms by about a fifth. Scrolling up (a negative delta)
// zooms in. Chrome and Safari report shift+wheel on the horizontal axis, so
// the zoom reads whichever axis moved.
const ZOOM_PER_PIXEL = 0.002;
function wheelZoomFactor(event) {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  return Math.exp(wheelPixels(event, delta) * ZOOM_PER_PIXEL);
}
// Where across the plot a pointer sits, 0 to 1; the SVG scales to the box.
function plotFraction(clientX) {
  const rect = chartPlot.getBoundingClientRect?.();
  if (!rect || !rect.width || !chartGeometry.plotW) return 0.5;
  const svgX = (clientX - rect.left) * (chartGeometry.width / rect.width);
  return Math.max(0, Math.min(1, (svgX - chartGeometry.padLeft) / chartGeometry.plotW));
}
// Wheel events come faster than frames too; their factors multiply into one
// zoom per frame, centred where the pointer last was.
let zoomFrame = null;
let zoomFactor = 1;
let zoomAt = 0.5;
// Shift+wheel zooms. Ctrl, which a trackpad pinch also sets, stays the
// browser's page zoom even with shift held. Otherwise only a
// mostly-horizontal wheel pans; a vertical one scrolls the page.
chartPlot?.addEventListener("wheel", (event) => {
  if (event.ctrlKey) return;
  if (event.shiftKey) {
    event.preventDefault();
    zoomFactor *= wheelZoomFactor(event);
    zoomAt = plotFraction(event.clientX);
    if (!zoomFrame) {
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = null;
        const factor = zoomFactor;
        zoomFactor = 1;
        zoomChart(factor, zoomAt);
      });
    }
    return;
  }
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !msPerPixel()) return;
  // Already at now with nowhere further to go: leave the gesture to the
  // browser, whose trackpad swipe may mean Back.
  if (event.deltaX > 0 && chartEnd === null && !panFrame) return;
  event.preventDefault();
  panToOnNextFrame((panFrame ? panTarget : viewEnd()) + wheelPixels(event, event.deltaX) * msPerPixel());
}, { passive: false });

chartLegend?.addEventListener("change", (event) => {
  const input = event.target;
  if (!input.matches("[data-series]")) return;
  chartPrefs[input.dataset.series] = input.checked;
  saveChartPrefs();
  renderChart();
});

// ---------- settings panel ----------
function metricRows(p) {
  const rows = [
    ...(p.windows || []).map((w) => ({ id: winId(w), label: w.label || w.key, hint: w.unit || "", kind: "window" })),
    ...(p.extras || []).map((x) => ({ id: extraId(x), label: x.label, hint: "info", kind: "extra" })),
  ];
  const seen = new Set();
  return rows.filter((r) => r.id && !seen.has(r.id) && seen.add(r.id));
}
function renderSettings() {
  const providers = (lastData && lastData.providers) || [];
  if (!providers.length) {
    settingsBody.innerHTML = `<p class="spinner">Waiting for data…</p>`;
    return;
  }
  settingsBody.innerHTML = providers.map((p) => {
    const rows = metricRows(p);
    const armRow = p.autoArm ? `
      <label class="set-row" title="Send a tiny paid inference when the 5h window is unarmed so its reset timer starts counting">
        <input type="checkbox" data-autoarm="${esc(p.name)}" ${p.autoArm.enabled ? "checked" : ""} />
        <span class="set-label">Auto-arm 5h window</span>
        <span class="hint">${p.autoArm.enabled ? "pings when unarmed" : "display only"}</span>
      </label>
      <div class="set-sep"></div>` : "";
    if (!rows.length) {
      // Empty because the provider is erroring, not because metrics are off.
      const msg = p.error ? `${esc(p.error)} — no metrics until it recovers` : "No metrics available.";
      return `<section class="set-card"><div class="set-head"><strong>${esc(p.name)}</strong></div>${armRow}<p class="set-empty">${msg}</p></section>`;
    }
    // The radio marks the window the card actually gauges, defaults included,
    // so an untouched provider shows where its gauge came from.
    const shownWins = (p.windows || []).filter((w) => isEnabled(p.name, winId(w)));
    const primary = pickPrimaryWindow(shownWins, p.name);
    const primaryId = primary ? winId(primary) : "";
    // The phone card hides its plan and Log out to stay one row tall; the
    // panel carries them at every width so nothing depends on the breakpoint.
    const logoutSlugFor = p.connected ? logoutSlug(p) : null;
    const logoutLink = logoutSlugFor
      ? `<button class="link-btn logout-link" data-logout="${esc(logoutSlugFor)}" data-name="${esc(p.name)}" title="Forget this dashboard's stored credentials">log out</button>`
      : "";
    return `<section class="set-card" data-provider="${esc(p.name)}">
      <div class="set-head">
        <strong>${esc(p.name)}${p.plan ? `<span class="plan-inline">${esc(p.plan)}</span>` : ""}</strong>
        <span class="set-actions">
          ${logoutLink}
          <button class="link-btn" data-bulk="${esc(p.name)}" data-on="1">all</button>
          <button class="link-btn" data-bulk="${esc(p.name)}" data-on="0">none</button>
          <span class="set-col-label" title="Which metric fills the big dot gauge; the rest become bars">gauge</span>
        </span>
      </div>
      ${armRow}
      ${rows.map((r) => `
        <div class="set-row">
          <label class="set-pick">
            <input type="checkbox" data-provider="${esc(p.name)}" data-metric="${esc(r.id)}" ${isEnabled(p.name, r.id) ? "checked" : ""} />
            <span class="set-label">${esc(r.label)}</span>
            <span class="hint">${esc(r.hint)}</span>
          </label>
          ${r.kind === "window"
            ? `<label class="set-primary" title="Make this the primary gauge">
                <input type="radio" name="primary-${esc(p.name)}" data-primary-provider="${esc(p.name)}" data-primary-metric="${esc(r.id)}" ${r.id === primaryId ? "checked" : ""} />
              </label>`
            : `<span class="set-primary"></span>`}
        </div>`).join("")}
    </section>`;
  }).join("");
}
function openSettings() {
  renderSettings();
  settingsOverlay.hidden = false;
}
function closeSettings() {
  settingsOverlay.hidden = true;
}
document.getElementById("settings-btn").onclick = openSettings;
document.getElementById("settings-close").onclick = closeSettings;
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !settingsOverlay.hidden) closeSettings(); });
settingsBody.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches("input[type=checkbox][data-autoarm]")) {
    toggleAutoArm(t.dataset.autoarm, t.checked, t);
    return;
  }
  if (t.matches("input[type=radio][data-primary-metric]")) {
    const provider = t.dataset.primaryProvider;
    const id = t.dataset.primaryMetric;
    setPrimaryMetric(provider, id);
    // Gauging a metric implies showing it.
    if (!isEnabled(provider, id)) setEnabled(provider, id, true);
    renderGrid();
    renderSettings();
    return;
  }
  if (t.matches("input[type=checkbox][data-metric]")) {
    const provider = t.dataset.provider;
    const id = t.dataset.metric;
    setEnabled(provider, id, t.checked);
    // Hiding the gauged window hands the gauge back to the default pick.
    if (!t.checked && primaryPrefs[provider] === id) setPrimaryMetric(provider, null);
    renderGrid();
    renderSettings();
  }
});

async function toggleAutoArm(provider, enabled, input) {
  input.disabled = true;
  try {
    const r = await fetch("/api/autoarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, enabled }),
    });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
    for (const p of lastData?.providers || []) {
      if (p.name === provider && p.autoArm) p.autoArm.enabled = enabled;
    }
    renderGrid();
  } catch (e) {
    if (input) input.checked = !enabled;
    alert("Could not save auto-arm setting: " + e.message);
  } finally {
    if (input) input.disabled = false;
  }
}
settingsBody.addEventListener("click", (e) => {
  if (handleLogoutClick(e)) return;
  const btn = e.target.closest(".link-btn[data-bulk]");
  if (!btn) return;
  const provider = btn.dataset.bulk;
  for (const p of (lastData?.providers || [])) {
    if (p.name !== provider) continue;
    for (const r of metricRows(p)) setEnabled(provider, r.id, btn.dataset.on === "1");
    if (btn.dataset.on !== "1") setPrimaryMetric(provider, null);
  }
  savePrefs();
  renderGrid();
  renderSettings();
});

async function load(force = false) {
  try {
    // force: manual click — makes the server retry Claude past its backoff.
    const r = await fetch("/api/usage" + (force ? "?refresh" : ""));
    const data = await r.json();
    lastData = data;
    updatedEl.textContent = "Updated " + new Date(data.updatedAt).toLocaleTimeString();
    renderGrid();
    renderChart();
    if (!settingsOverlay.hidden) renderSettings();
    const pending = (data.providers || []).some((p) => p.auth?.pending);
    if (pending) startStatusPoll();
    else stopStatusPoll();
  } catch (e) {
    updatedEl.textContent = "error: " + e;
  }
}

function patchOAuth(slug, s) {
  if (!lastData) return;
  lastData = {
    ...lastData,
    providers: lastData.providers.map((p) => {
      if (oauthSlug(p) !== slug) return p;
      if (s.connected) return { ...p, connected: true, error: null, auth: undefined };
      return {
        ...p,
        connected: false,
        auth: {
          slug,
          pending: {
            user_code: s.user_code || "",
            verification_url: s.verification_url || "",
            manual_url: s.manual_url || "",
            error: s.error || null,
          },
        },
      };
    }),
  };
  renderGrid();
}

async function startOAuthLogin(slug) {
  try {
    const r = await fetch(`/api/${slug}/login`, { method: "POST" });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
    patchOAuth(slug, s);
    if (s.connected) load();
    else startStatusPoll();
  } catch (e) {
    patchOAuth(slug, { pending: true, error: String(e.message || e), user_code: "", verification_url: "" });
  }
}
function startStatusPoll() {
  if (pendingPoll) return;
  pendingPoll = setInterval(async () => {
    try {
      const slugs = [...new Set((lastData?.providers || []).filter((p) => p.auth && !p.connected).map(oauthSlug))];
      for (const slug of slugs) {
        const r = await fetch(`/api/${slug}/status`);
        const s = await r.json();
        if (s.connected) { stopStatusPoll(); load(); return; }
        if (s.pending || s.error) {
          const next = {
            user_code: s.user_code || "",
            verification_url: s.verification_url || "",
            manual_url: s.manual_url || "",
            error: s.error || null,
          };
          const cur = ((lastData?.providers || []).find((p) => oauthSlug(p) === slug)?.auth) || {};
          const unchanged = cur.pending && Object.keys(next).every((k) => (cur.pending[k] || "") === next[k]);
          if (!unchanged) patchOAuth(slug, s);
        } else {
          // Login session vanished server-side (restart / completed elsewhere):
          // fall back to the Connect button instead of spinning forever.
          const cur = (lastData?.providers || []).find((p) => oauthSlug(p) === slug)?.auth;
          if (cur?.pending) patchOAuth(slug, {});
        }
      }
    } catch {}
  }, 3000);
}
function stopStatusPoll() {
  if (pendingPoll) { clearInterval(pendingPoll); pendingPoll = null; }
}

document.getElementById("refresh").onclick = () => load(true);
async function submitPasteCode(slug, code) {
  try {
    const r = await fetch(`/api/${slug}/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
    if (s.connected) { stopStatusPoll(); load(); }
  } catch (e) {
    const prev = ((lastData?.providers || []).find((p) => oauthSlug(p) === slug)?.auth) || {};
    const pending = prev.pending || {};
    patchOAuth(slug, {
      pending: true,
      error: String(e.message || e),
      user_code: pending.user_code || "",
      verification_url: pending.verification_url || "",
      manual_url: pending.manual_url || "",
    });
  }
}
async function logoutOfService(slug, name) {
  try {
    const r = await fetch(`/api/${slug}/logout`, { method: "POST" });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
    stopStatusPoll();
    await load();
  } catch (e) {
    alert("Log out failed: " + e.message);
  }
}
// Log out lives in the card head on desktop and in the ⚙ panel everywhere;
// both surfaces share one confirm-and-forget path.
function handleLogoutClick(e) {
  const out = e.target && e.target.closest && e.target.closest("[data-logout]");
  if (!out) return false;
  const name = out.dataset.name || out.dataset.logout;
  if (!confirm(`Log out of ${name}?\nThe dashboard will forget its stored credentials for this service.`)) return true;
  out.disabled = true;
  logoutOfService(out.dataset.logout, name).finally(() => { out.disabled = false; });
  return true;
}
grid.addEventListener("click", (e) => {
  if (handleLogoutClick(e)) return;
  const more = e.target && e.target.closest && e.target.closest("[data-more]");
  if (more) {
    const provider = more.dataset.more;
    setExpanded(provider, !isExpanded(provider));
    renderGrid();
    return;
  }
  const btn = e.target && e.target.closest && e.target.closest("[data-connect]");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    startOAuthLogin(btn.dataset.connect);
    return;
  }
  const paste = e.target && e.target.closest && e.target.closest("[data-paste]");
  if (paste) {
    const input = document.querySelector(`[data-paste-input="${paste.dataset.paste}"]`);
    const code = (input && input.value || "").trim();
    if (!code) { if (input) input.focus(); return; }
    paste.disabled = true;
    paste.textContent = "Submitting…";
    submitPasteCode(paste.dataset.paste, code).finally(() => {
      paste.disabled = false;
      paste.textContent = "Submit";
    });
  }
});
setInterval(updateCountdowns, 1000);
migrateClientHistory().finally(load);
setInterval(() => load(), REFRESH_MS);
