import { AUTO_ARM_PROVIDERS } from "./dash-auth.js";

const AUTO_ARM = new Set(AUTO_ARM_PROVIDERS);
// Providers whose dashboard-owned credentials can be cleared.
const LOGOUT_PROVIDERS = new Set(["Grok", "Codex", "Claude"]);

export function attachLiveAuth(
  data,
  { grokPending = null, codexPending = null, claudePending = null, claudeCanLogout = true, autoArm = {} } = {}
) {
  if (!data?.providers) return data;
  return {
    ...data,
    providers: data.providers.map((p) => {
      let out = p;
      if (LOGOUT_PROVIDERS.has(p.name) && (p.name !== "Claude" || claudeCanLogout)) {
        out = { ...out, canLogout: true };
      }
      if (AUTO_ARM.has(p.name)) {
        out = { ...out, autoArm: { available: true, enabled: autoArm[p.name] !== false } };
      }
      if (p.connected) return out;
      if (p.name === "Grok") return { ...out, auth: { slug: "grok", pending: grokPending } };
      if (p.name === "Codex") return { ...out, auth: { ...(out.auth || {}), pending: codexPending } };
      if (p.name === "Claude") return { ...out, auth: { slug: "claude", pending: claudePending } };
      return out;
    }),
  };
}
