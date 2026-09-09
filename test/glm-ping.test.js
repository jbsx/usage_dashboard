import test from "node:test";
import assert from "node:assert/strict";
import { glmPing, GLM_PING_MODEL } from "../lib/glm-ping.js";

function jsonFetch(status, json) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { fetchFn, calls };
}
const ok = () => jsonFetch(200, { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 5 } });

test("glmPing: sends one minimal coding-plan chat completion with the API key", async () => {
  const rec = ok();
  await glmPing({ fetchFn: rec.fetchFn, apiKey: "zai-key" });

  assert.equal(rec.calls.length, 1);
  const { url, opts } = rec.calls[0];
  assert.equal(url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers.Authorization, "Bearer zai-key");
  assert.equal(opts.headers["content-type"], "application/json");

  const body = JSON.parse(opts.body);
  assert.equal(body.model, GLM_PING_MODEL);
  assert.equal(body.max_tokens, 1, "hard cap on ping output spend");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("glmPing: throws on a non-2xx response", async () => {
  const rec = jsonFetch(401, { error: { message: "bad key" } });
  await assert.rejects(glmPing({ fetchFn: rec.fetchFn, apiKey: "zai-key" }), /HTTP 401/);
});

test("glmPing: throws when the response has no choices (quota/refusal wrapper shapes)", async () => {
  const rec = jsonFetch(200, { code: 429, msg: "rate limited" });
  await assert.rejects(glmPing({ fetchFn: rec.fetchFn, apiKey: "zai-key" }), /HTTP 200/);
});
