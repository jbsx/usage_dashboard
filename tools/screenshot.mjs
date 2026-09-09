// Regenerates docs/screenshot.png for the README.
//
// Serves the real index.html/app.js/style.css against a demo payload, seeds the
// chart and metric preferences the shot is meant to show, and captures the page
// with headless Chrome. No dependency beyond a local Chrome; the live
// dashboard, its credentials and its stored history are never touched.
//
//   node tools/screenshot.mjs [--out docs/screenshot.png] [--width 1400]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { demoSnapshot } from "./demo-data.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const out = path.resolve(root, arg("out", "docs/screenshot.png"));
const width = Number(arg("width", 1400));
const height = Number(arg("height", 1015));

// The series worth showing at a glance: every provider's headline window, plus
// Claude's 7-day so one card demonstrates two lines at once.
const CHART_PRESETS = {
  "GLM:5h": true,
  "GLM:monthly": true,
  "Codex:7d": true,
  "Grok:7d": true,
  "Claude:5h": true,
  "Claude:7d": true,
  "Claude:7d-fable": false,
  "Codex:GPT-5.3-Codex-Spark": false,
};

const seed = `<script>
  try {
    localStorage.setItem("usage-dashboard-chart-prefs", ${JSON.stringify(JSON.stringify(CHART_PRESETS))});
    localStorage.removeItem("usage-dashboard-metric-prefs");
    localStorage.removeItem("usage-dashboard-primary-prefs");
    localStorage.removeItem("usage-dashboard-live-history");
  } catch {}
</script>`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/usage") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(demoSnapshot(Date.now())));
  }
  if (url.pathname === "/api/history/import" || url.pathname === "/api/autoarm") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(root, file);
  if (!full.startsWith(root) || !fs.existsSync(full)) {
    res.writeHead(404);
    return res.end("not found");
  }
  let body = fs.readFileSync(full);
  if (file === "index.html") body = String(body).replace('<script src="app.js">', seed + '\n  <script src="app.js">');
  res.writeHead(200, { "content-type": TYPES[path.extname(full)] || "application/octet-stream" });
  res.end(body);
});

const chrome = (() => {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
})();
if (!chrome) {
  console.error("no Chrome or Chromium found on PATH");
  process.exit(1);
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--screenshot=${out}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=2",
    // Let the fade-in, the dot stagger and the first fetch all settle.
    "--virtual-time-budget=6000",
    `http://127.0.0.1:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("exit", (code) => {
    server.close();
    if (code !== 0 || !fs.existsSync(out)) {
      console.error(err.trim() || `chrome exited ${code}`);
      process.exit(1);
    }
    console.log(`${path.relative(root, out)} — ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  });
});
