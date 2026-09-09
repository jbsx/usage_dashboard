// One tiny, real inference against the Codex backend. Any accepted request
// "arms" the 5-hour rate-limit window so its reset timer starts counting.
// The request shape mirrors what the Codex CLI sends (stream:true, store:false)
// because that is the known-good contract for chatgpt.com backend OAuth.

export const CODEX_PING_MODEL = "gpt-5.4-mini"; // cheapest on the plan: 21 tokens/ping vs 33 for gpt-5.5
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const PING_TIMEOUT_MS = 30000;

export async function codexPing({ fetchFn = fetch, auth, model = CODEX_PING_MODEL }) {
  const headers = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "content-type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  };
  const accountId = auth.account_id;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  // NOTE: the chatgpt.com Codex backend rejects max_output_tokens
  // ("Unsupported parameter"), so the spend ceiling here is the prompt +
  // effort "none" (measured 21 tokens), not a hard cap.
  const body = {
    model,
    instructions: "Reply with exactly: ok",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    reasoning: { effort: "none", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  };

  const res = await fetchFn(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? " " + detail : ""}`);
  }

  // The window only arms once the response actually completes, so the stream
  // must be consumed until a terminal event — cancelling early aborts
  // generation and the request never counts against the 5h window.
  const COMPLETED_EVENT = /event: response\.completed\r?\n/;
  const FAILURE_EVENT = /event: (?:response\.failed|response\.incomplete|error)\r?\n/;
  const TERMINAL_EVENT = new RegExp(`(?:${COMPLETED_EVENT.source}|${FAILURE_EVENT.source})`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no response stream");
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (TERMINAL_EVENT.test(buf)) break;
      if (buf.length > 262144) throw new Error("stream exceeded size limit");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!TERMINAL_EVENT.test(buf)) throw new Error("stream ended before completion");
  if (FAILURE_EVENT.test(buf)) {
    throw new Error(`stream error: ${buf.slice(0, 200)}`);
  }
  return true;
}
