function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function tokenNeedsRefresh(auth, now = Date.now(), skewMs = 5 * 60 * 1000) {
  const accessExp = decodeJwt(auth?.tokens?.access_token || "").exp;
  const idExp = decodeJwt(auth?.tokens?.id_token || "").exp;
  const expMs = (accessExp || idExp || 0) * 1000;
  return !!expMs && expMs < now + skewMs;
}

// Window keys and labels are derived from each window's duration, not from
// its slot in the response: plans change which limits the API reports — a
// plan with no 5-hour limit reports its 7-day limit as primary_window — so
// either slot can carry either window.
const WINDOW_KINDS = [
  { maxSeconds: 3600, key: "1h", label: "Hourly" },
  { maxSeconds: 21600, key: "5h", label: "5-Hour" },
  { maxSeconds: 90000, key: "1d", label: "Daily" },
  { maxSeconds: 691200, key: "7d", label: "7-Day" },
  { maxSeconds: 3024000, key: "1mo", label: "Monthly" },
  { maxSeconds: Infinity, key: "1y", label: "Yearly" },
];

function windowKind(seconds) {
  if (seconds == null) return null;
  return WINDOW_KINDS.find((kind) => seconds <= kind.maxSeconds) ?? null;
}

function winLabel(seconds) {
  return windowKind(seconds)?.label ?? "";
}

export function parseCodexUsageResponse(status, json, pending = null) {
  if (status === 401) {
    return {
      name: "Codex", connected: false, plan: null,
      error: "session expired — reconnect", windows: [], extras: [],
      auth: { slug: "codex", pending },
    };
  }
  if (!json || status < 200 || status >= 300) {
    return {
      name: "Codex", connected: true, plan: null,
      error: `HTTP ${status}`, windows: [], extras: [],
    };
  }

  const rateLimit = json.rate_limit || {};
  const out = {
    name: "Codex", connected: true, plan: json.plan_type || null,
    error: null, windows: [], extras: [],
  };
  // fallbackLabel carries the limit's own name for additional limits, whose
  // duration the API may omit entirely — without it they render captionless.
  const pushWindow = (window, key, fallbackLabel = "") => {
    if (!window) return;
    const kind = windowKind(window.limit_window_seconds);
    out.windows.push({
      key,
      label: kind ? kind.label : fallbackLabel,
      unit: "percent",
      usedPct: window.used_percent || 0,
      used: null,
      limit: null,
      remaining: null,
      resetAt: window.reset_at ? window.reset_at * 1000 : null,
    });
  };
  // Slots classify by duration; named additional limits keep their name as
  // the key (only their label is derived) so they cannot collide with the
  // slot windows' keys.
  const slotKey = (window, fallbackKey) =>
    windowKind(window?.limit_window_seconds)?.key ?? fallbackKey;
  pushWindow(rateLimit.primary_window, slotKey(rateLimit.primary_window, "5h"));
  pushWindow(rateLimit.secondary_window, slotKey(rateLimit.secondary_window, "7d"));
  for (const additional of json.additional_rate_limits || []) {
    pushWindow(additional.rate_limit, additional.limit_name, additional.limit_name);
  }
  if (json.credits) {
    if (json.credits.unlimited) out.extras.push({ label: "Credits", text: "unlimited" });
    else if (json.credits.has_credits) out.extras.push({ label: "Credits", text: `${json.credits.balance ?? "?"}` });
  }
  return out;
}
