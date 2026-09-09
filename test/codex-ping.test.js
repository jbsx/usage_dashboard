import test from "node:test";
import assert from "node:assert/strict";
import { codexPing, CODEX_PING_MODEL } from "../lib/codex-ping.js";

const auth = (over = {}) => ({
  tokens: { access_token: "at-123", id_token: "x.y.z", refresh_token: "rt" },
  account_id: "acct-9",
  ...over,
});

function sseFetch(chunks, status = 200) {
  let cancelled = false;
  let readCount = 0;
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const queue = [...chunks];
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => "",
      body: {
        getReader: () => ({
          read: async () => {
            readCount++;
            return queue.length ? { done: false, value: new TextEncoder().encode(queue.shift()) } : { done: true };
          },
          cancel: async () => { cancelled = true; },
        }),
      },
    };
  };
  return { fetchFn, calls, getCancelled: () => cancelled, getReadCount: () => readCount };
}

const COMPLETED_STREAM = [
  "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
  "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
];

test("codexPing: sends one minimal responses request with OAuth headers and CLI-compatible body", async () => {
  const rec = sseFetch(COMPLETED_STREAM);
  await codexPing({ fetchFn: rec.fetchFn, auth: auth() });

  assert.equal(rec.calls.length, 1);
  const { url, opts } = rec.calls[0];
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers.Authorization, "Bearer at-123");
  assert.equal(opts.headers["ChatGPT-Account-Id"], "acct-9");
  assert.equal(opts.headers["content-type"], "application/json");
  assert.equal(opts.headers.originator, "codex_cli_rs");
  assert.equal(opts.headers["OpenAI-Beta"], "responses=experimental");

  const body = JSON.parse(opts.body);
  assert.equal(body.model, CODEX_PING_MODEL);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "none");
  assert.ok(!("max_output_tokens" in body), "chatgpt.com backend rejects max_output_tokens");
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].role, "user");
  assert.match(JSON.stringify(body.input[0].content), /input_text/);
});

test("codexPing: omits the account-id header when the account has none", async () => {
  const rec = sseFetch(COMPLETED_STREAM);
  await codexPing({ fetchFn: rec.fetchFn, auth: auth({ account_id: null }) });
  assert.ok(!("ChatGPT-Account-Id" in rec.calls[0].opts.headers));
});

test("codexPing: throws on a non-2xx response", async () => {
  const rec = sseFetch(COMPLETED_STREAM, 400);
  await assert.rejects(
    codexPing({ fetchFn: rec.fetchFn, auth: auth() }),
    /HTTP 400/,
  );
});

test("codexPing: consumes the stream until response.completed, then cancels", async () => {
  const rec = sseFetch([
    "event: response.created\ndata: {}\n\n",
    "event: response.output_item.added\ndata: {}\n\n",
    "event: response.completed\ndata: {}\n\n",
    "event: never-read\ndata: {}\n\n",
  ]);
  assert.equal(await codexPing({ fetchFn: rec.fetchFn, auth: auth() }), true);
  assert.ok(rec.getCancelled(), "stream is cancelled after the terminal event");
});

test("codexPing: throws when the stream reports a failure event", async () => {
  const rec = sseFetch([
    "event: response.created\ndata: {}\n\n",
    "event: response.failed\ndata: {\"error\":{\"message\":\"boom\"}}\n\n",
  ]);
  await assert.rejects(
    codexPing({ fetchFn: rec.fetchFn, auth: auth() }),
    /stream error/,
  );
});

test("codexPing: throws when the stream ends without completing the response", async () => {
  const rec = sseFetch(["event: response.created\ndata: {}\n\n"]);
  await assert.rejects(
    codexPing({ fetchFn: rec.fetchFn, auth: auth() }),
    /stream ended before completion/,
  );
});
