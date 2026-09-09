// Auto-arm: when a provider's 5-hour window reads 0% used and its reset timer
// is not counting down yet, sending one tiny inference "arms" the window so
// the reset countdown starts. Guardrails: cooldown between pings, a cap on
// consecutive ineffective pings, and a note on the card when we give up.
//
// "Not counting down" has two shapes:
//  - no reset time at all (or one in the past), and
//  - the Codex phantom timer: while unarmed the API reports a floating
//    reset_at = now + 5h on every poll. Unlike a live window, whose reset_at
//    is anchored (identical between polls), a floating one drifts forward
//    with wall-clock time — that drift is what we detect.

export const FIVE_HOUR_KEY = "5h";

// A reset time that advances by more than this between polls is floating.
const DRIFT_EPSILON_MS = 1000;

export function isUnarmed(win, now = Date.now()) {
  return !!win && win.usedPct === 0 && (!win.resetAt || win.resetAt <= now);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAutoArmer({
  ping,
  refresh,
  now = Date.now,
  sleep = defaultSleep,
  cooldownMs = 5 * 60 * 1000,
  maxStrikes = 3,
  settleMs = 3000,
  probeMs = 60 * 1000,
  graceMs = 2000,
  retryMs = 5 * 60 * 1000,
}) {
  // Guardrail state is per provider: a ping for one provider must not put
  // another provider on cooldown or burn its strike budget.
  const states = new Map();
  const stateFor = (provider) => {
    const key = provider?.name || "default";
    let state = states.get(key);
    if (!state) {
      state = { lastPingAt: 0, strikes: 0, seen: false, seenResetAt: null };
      states.set(key, state);
    }
    return state;
  };

  const findWindow = (provider) =>
    (provider?.windows || []).find((w) => w.key === FIVE_HOUR_KEY);

  const note = (provider, text) => ({
    ...provider,
    extras: [...(provider.extras || []), { label: "Auto-arm", text }],
  });

  const nextFor = (provider, t) => {
    const win = findWindow(provider);
    return win?.resetAt > t ? win.resetAt + graceMs : t + retryMs;
  };

  // Classifies the window for this poll: "unarmed", "armed", or "unknown"
  // (cannot tell yet — first sighting or a state transition defers the
  // decision to the next poll).
  const classify = (win, t, state) => {
    if (win.usedPct > 0) return "armed";
    if (isUnarmed(win, t)) return "unarmed";
    if (state.seen) {
      if (state.seenResetAt === win.resetAt) return "armed";
      if (state.seenResetAt != null && win.resetAt != null &&
          win.resetAt > state.seenResetAt + DRIFT_EPSILON_MS) return "unarmed";
    }
    return "unknown";
  };

  const check = async (provider) => {
    const t = now();
    const win = findWindow(provider);
    if (!provider?.connected || !win) {
      return { provider, nextCheckAt: t + retryMs };
    }
    const state = stateFor(provider);

    const unarmed = classify(win, t, state);
    if (unarmed === "unknown") {
      state.seen = true;
      state.seenResetAt = win.resetAt;
      return { provider, nextCheckAt: t + probeMs };
    }
    if (unarmed === "armed") {
      state.strikes = 0;
      state.seen = true;
      state.seenResetAt = win.resetAt;
      return { provider, nextCheckAt: nextFor(provider, t) };
    }

    state.seen = true;
    state.seenResetAt = win.resetAt;
    if (state.strikes >= maxStrikes) {
      return {
        provider: note(provider, `gave up after ${state.strikes} ineffective pings`),
        nextCheckAt: t + retryMs,
      };
    }
    if (t - state.lastPingAt < cooldownMs) {
      return { provider, nextCheckAt: state.lastPingAt + cooldownMs };
    }
    state.strikes++;
    state.lastPingAt = t;

    try {
      await ping(provider.name);
    } catch (e) {
      return {
        provider: note(provider, `ping failed: ${e.message}`),
        nextCheckAt: t + cooldownMs,
      };
    }
    await sleep(settleMs);

    let fresh;
    try {
      fresh = await refresh(provider.name);
    } catch {
      return { provider, nextCheckAt: t + retryMs };
    }
    const freshWin = findWindow(fresh);
    state.seenResetAt = freshWin ? freshWin.resetAt ?? null : null;
    const refreshedAt = now();
    const nextCheckAt = freshWin?.usedPct === 0 && freshWin.resetAt > refreshedAt
      ? refreshedAt + probeMs
      : nextFor(fresh, refreshedAt);
    return { provider: fresh, nextCheckAt };
  };

  return {
    check,
    async process(provider) {
      return (await check(provider)).provider;
    },
  };
}
