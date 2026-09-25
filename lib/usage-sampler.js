// Takes a usage snapshot on a fixed cadence so the history keeps filling
// while no browser has the page open. Snapshots are recorded by whatever
// `sample` does (in the server it is the same getUsage() the page calls, so
// the cache TTL and in-flight dedupe keep a live tab from doubling the
// provider traffic). Ticks are chained after each sample finishes rather
// than run off setInterval, so a slow upstream can't pile up overlapping
// fetches.
export function createUsageSampler({
  sample,
  intervalMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => console.error("[history] sample failed:", error.message),
}) {
  if (typeof sample !== "function") throw new Error("usage sampler requires a sample function");
  let timer = null;
  let stopped = true;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    try {
      await sample();
    } catch (error) {
      onError(error);
    } finally {
      schedule();
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
