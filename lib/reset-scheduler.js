export function createResetScheduler({
  fetchProvider,
  autoArmer,
  shouldArm = () => true,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = 5 * 60 * 1000,
  onError = (error) => console.error("[auto-arm] scheduled check failed:", error.message),
}) {
  let timer = null;
  let inFlight = null;
  let stopped = true;

  // With arming disabled we never ping; just re-check when a window rolls
  // over so the card picks up fresh numbers.
  const idleNextCheckAt = (provider, t) => {
    const resets = (provider?.windows || [])
      .map((w) => w?.resetAt)
      .filter((r) => typeof r === "number" && r > t);
    return resets.length ? Math.min(...resets) + 2000 : t + retryMs;
  };

  const schedule = (at) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void checkNow().catch(onError);
    }, Math.max(0, at - now()));
  };

  const checkNow = async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const provider = await fetchProvider();
        const result = shouldArm(provider)
          ? await autoArmer.check(provider)
          : { provider, nextCheckAt: idleNextCheckAt(provider, now()) };
        schedule(result.nextCheckAt);
        return result.provider;
      } catch (error) {
        schedule(now() + retryMs);
        throw error;
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    checkNow,
    start() {
      if (!stopped) return;
      stopped = false;
      void checkNow().catch(onError);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
