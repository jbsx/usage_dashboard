import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_AUTO_ARM,
  defaultAuthStorePath,
  readAuthEntry,
  readAutoArmSettings,
  writeAuthEntry,
  writeAutoArmSetting,
} from "../lib/dash-auth.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dash-auth-")), "auth.json");

test("writeAuthEntry creates nested dirs with 0600 and preserves sibling keys", () => {
  const file = tmp();
  writeAuthEntry("xai", { access: "a" }, file);
  writeAuthEntry("claude", { access: "b" }, file);
  assert.equal(readAuthEntry("xai", file).access, "a");
  assert.equal(readAuthEntry("claude", file).access, "b");
  assert.equal(readAuthEntry("codex", file), null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeAuthEntry(null) removes an entry but keeps others", () => {
  const file = tmp();
  writeAuthEntry("xai", { access: "a" }, file);
  writeAuthEntry("claude", { access: "b" }, file);
  writeAuthEntry("claude", null, file);
  assert.equal(readAuthEntry("claude", file), null);
  assert.equal(readAuthEntry("xai", file).access, "a");
});

test("auto-arm defaults: GLM and Codex on, Claude off", () => {
  const file = tmp();
  assert.deepEqual(readAutoArmSettings(file), DEFAULT_AUTO_ARM);
  assert.deepEqual(DEFAULT_AUTO_ARM, { GLM: true, Codex: true, Claude: false });
});

test("writeAutoArmSetting persists, keeps other providers, rejects unknown providers", () => {
  const file = tmp();
  const settings = writeAutoArmSetting("Claude", true, file);
  assert.equal(settings.Claude, true);
  assert.equal(readAutoArmSettings(file).GLM, true);
  writeAutoArmSetting("GLM", false, file);
  assert.deepEqual(readAutoArmSettings(file), { GLM: false, Codex: true, Claude: true });
  assert.throws(() => writeAutoArmSetting("Grok", true, file), /not available/);
});

test("defaultAuthStorePath honors AUTH_STORE_PATH then XDG_DATA_HOME", () => {
  const prevAuth = process.env.AUTH_STORE_PATH;
  const prevXdg = process.env.XDG_DATA_HOME;
  try {
    process.env.AUTH_STORE_PATH = "/custom/auth.json";
    assert.equal(defaultAuthStorePath(), "/custom/auth.json");
    process.env.AUTH_STORE_PATH = "";
    process.env.XDG_DATA_HOME = "/xdg-data";
    assert.equal(defaultAuthStorePath(), path.join("/xdg-data", "usage-dashboard", "auth.json"));
  } finally {
    if (prevAuth === undefined) delete process.env.AUTH_STORE_PATH; else process.env.AUTH_STORE_PATH = prevAuth;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
  }
});
