// Dashboard-owned credential + settings stores. Every OAuth provider this
// dashboard tracks (Claude, Codex, Grok) keeps its tokens here — we never
// read or write the credential files belonging to other CLIs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function defaultDataDir() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(data, "usage-dashboard");
}

export function defaultAuthStorePath() {
  return process.env.AUTH_STORE_PATH || path.join(defaultDataDir(), "auth.json");
}

export function defaultSettingsPath() {
  return process.env.SETTINGS_PATH || path.join(defaultDataDir(), "settings.json");
}

function readJson(filePath) {
  try {
    const v = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// ---------- credential store ----------

export function readAuthStore(authPath = defaultAuthStorePath()) {
  return readJson(authPath);
}

export function readAuthEntry(key, authPath = defaultAuthStorePath()) {
  const entry = readAuthStore(authPath)[key];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

export function writeAuthEntry(key, entry, authPath = defaultAuthStorePath()) {
  const all = readAuthStore(authPath);
  if (entry === null) delete all[key];
  else all[key] = entry;
  writeJsonAtomic(authPath, all);
}

// ---------- auto-arm settings ----------

export const AUTO_ARM_PROVIDERS = ["GLM", "Codex", "Claude"];
export const DEFAULT_AUTO_ARM = { GLM: true, Codex: true, Claude: false };

export function readAutoArmSettings(settingsPath = defaultSettingsPath()) {
  const stored = readJson(settingsPath).autoArm;
  const merged = { ...DEFAULT_AUTO_ARM };
  if (stored && typeof stored === "object") {
    for (const name of AUTO_ARM_PROVIDERS) {
      if (typeof stored[name] === "boolean") merged[name] = stored[name];
    }
  }
  return merged;
}

export function writeAutoArmSetting(provider, enabled, settingsPath = defaultSettingsPath()) {
  if (!AUTO_ARM_PROVIDERS.includes(provider)) {
    throw new Error(`auto-arm is not available for ${provider}`);
  }
  const all = readJson(settingsPath);
  const merged = readAutoArmSettings(settingsPath);
  merged[provider] = !!enabled;
  all.autoArm = merged;
  writeJsonAtomic(settingsPath, all);
  return merged;
}
