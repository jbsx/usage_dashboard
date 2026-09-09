// Daily window verification. Window keys/labels are derived from each
// window's duration at parse time, so a plan change reclassifies windows on
// the next successful parse — but the stale-serving caches (lib/usage-cache.js)
// can keep a previous window set alive across transient errors indefinitely.
// Once a day this forces a fresh, side-effect-free fetch of every provider
// and reports whose window set changed so callers can invalidate snapshots.
//
// Fetching directly (not through the auto-arm schedulers) keeps the pass
// free of ping side effects. Providers that return no windows (transient
// errors, disconnects) keep their last known classification instead of
// registering a spurious change.

export const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function windowSignature(provider) {
  return (provider?.windows || [])
    .map((w) => `${w?.key ?? ""}:${w?.label ?? ""}`)
    .sort()
    .join("|");
}

export function createWindowVerifier({
  providers,
  intervalMs = VERIFY_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onVerify,
  onError = (e) => {},
}) {
  let timer = null;
  let stopped = true;
  const lastByProvider = new Map();

  async function verify() {
    const changes = [];
    for (const { fetch } of providers || []) {
      let provider;
      try {
        provider = await fetch(true);
      } catch (e) {
        onError(e); // one provider failing must not stop the pass
        continue;
      }
      if (!provider?.name || !(provider.windows || []).length) continue;
      const signature = windowSignature(provider);
      const previous = lastByProvider.get(provider.name);
      lastByProvider.set(provider.name, signature);
      if (previous != null && previous !== signature) {
        changes.push({ name: provider.name, from: previous, to: signature });
      }
    }
    onVerify?.(changes);
    return changes;
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void verify().catch(onError).finally(schedule);
    }, intervalMs);
  };

  return {
    verify,
    // Boot fetches belong to the reset schedulers; the first verification
    // comes one interval out.
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
