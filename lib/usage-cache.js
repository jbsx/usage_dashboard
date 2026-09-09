// Stale-serving usage cache shared by the OAuth providers whose usage
// endpoints error transiently (Claude 429s aggressively; Grok's credits
// endpoint intermittently 500s), extracted from server.js so the behavior
// is testable.
//
// Successful responses are cached for ttlMs. Transient failures (HTTP
// 429/5xx, network) keep serving the last good data with a
// "stale — <error>" note — or, with no prior good data, the bare error.
// Retries back off exponentially (failureTtlMs * 2^n, capped at
// maxFailureTtlMs): retrying every 60s forever is exactly what keeps an
// aggressive account-level rate limiter tripped, so the cadence itself
// must yield. A retry-after hint parsed off the error response is honored
// in full (up to hintMaxMs) — observed hints do not count down between
// probes, so retrying before one elapses only re-trips the window.
export function createUsageCache({
  fetchProvider,
  ttlMs = 5 * 60 * 1000,
  failureTtlMs = 60 * 1000,
  maxFailureTtlMs = 10 * 60 * 1000,
  hintMaxMs = 60 * 60 * 1000,
  now = Date.now,
  generation = () => 0,
} = {}) {
  let cache = { data: null, at: 0, stale: false };
  let inFlight = null;
  let retryNotBefore = 0;
  let explicitRetryAfter = false;
  let failures = 0;

  const isTransientError = (provider) =>
    !!provider?.error && (/^HTTP (429|5\d\d)\b/.test(provider.error) || /network|fetch failed/i.test(provider.error));

  const nextFailureDelay = (provider) => {
    const backoff = Math.min(failureTtlMs * 2 ** failures, maxFailureTtlMs);
    failures = Math.min(failures + 1, 20);
    const hint = Number(provider?.retryAfterMs);
    const hinted = Number.isFinite(hint) && hint > 0 ? Math.min(hint, hintMaxMs) : 0;
    return Math.max(backoff, hinted);
  };

  const hasRetryAfter = (provider) => {
    const hint = Number(provider?.retryAfterMs);
    return Number.isFinite(hint) && hint > 0;
  };

  const get = async (force = false) => {
    const t = now();
    const fresh = cache.data && !cache.stale && t - cache.at < ttlMs;
    const held = cache.data && cache.stale && t < retryNotBefore;
    if ((!force && (fresh || held)) || (force && held && explicitRetryAfter)) return cache.data;
    if (!inFlight) {
      const gen = generation();
      inFlight = fetchProvider()
        .then((provider) => {
          if (gen !== generation()) return provider;
          const keepStale = cache.data && isTransientError(provider) && provider.connected;
          if (keepStale) {
            // Notes can accumulate across retries — rebuild from the clean copy.
            const clean = {
              ...cache.data,
              extras: (cache.data.extras || []).filter((x) => x.label !== "Refresh"),
            };
            const note = { label: "Refresh", text: `stale — ${provider.error}` };
            const delay = nextFailureDelay(provider);
            explicitRetryAfter = hasRetryAfter(provider);
            provider = { ...clean, retryAfterMs: provider.retryAfterMs, extras: [...clean.extras, note] };
            cache = { data: provider, at: now(), stale: true };
            retryNotBefore = now() + delay;
          } else {
            // A bare transient error (no prior good data to keep) is also
            // held for the hint/backoff delay — parking it as "fresh" for
            // the full ttl would either retry too early or recover too late.
            const transient = provider.connected && isTransientError(provider);
            explicitRetryAfter = transient && hasRetryAfter(provider);
            cache = {
              data: provider,
              at: now(),
              stale: transient || (!provider.connected && !!provider.error),
            };
            retryNotBefore = cache.stale
              ? now() + (transient ? nextFailureDelay(provider) : failureTtlMs)
              : 0;
            if (!transient) {
              failures = 0;
              explicitRetryAfter = false;
            }
          }
          return provider;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  const reset = () => {
    cache = { data: null, at: 0, stale: false };
    retryNotBefore = 0;
    explicitRetryAfter = false;
    failures = 0;
  };

  return { get, reset };
}
