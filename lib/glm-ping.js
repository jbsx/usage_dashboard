// One tiny, real inference against the z.ai coding-plan API. Any accepted
// request arms the 5-hour token window so its reset timer starts counting.

export const GLM_PING_MODEL = "glm-4.5-air"; // cheapest on the plan: 7 tokens/ping vs 14 for flash
export const GLM_CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const PING_TIMEOUT_MS = 30000;

export async function glmPing({ fetchFn = fetch, apiKey, model = GLM_PING_MODEL }) {
  const res = await fetchFn(GLM_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  // OpenAI-compatible success carries choices; quota/refusal wrappers do not.
  if (!res.ok || !json?.choices?.length) {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return true;
}
