// Scope and hard-coded prompt-cache retention policies. Public API prices only.
//
// Scope: Anthropic and OpenAI model families, whatever route served them
// (direct API, openai-codex, a local proxy). The family comes from the model id.
// Other families are excluded and reported.
//
// Reconcile these numbers with the provider pages below when a provider
// changes caching terms. Base input/output/cacheRead rates are not here:
// they come per model from pi's model catalog (`pi update --models` refreshes it),
// because read multipliers differ per model (e.g. Opus 5.5 0.05x, Fable 5.1 0.025x,
// GPT-6.1 Sol 0.05x). Checked 2026-09-30.
//
// - Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   5m write 1.25x input, 1h write 2x input; hits refresh the entry at no write cost.
// - OpenAI:    https://developers.openai.com/api/docs/guides/prompt-caching
//   GPT-5.6 and later: `prompt_cache_options.ttl` supports only 30m; writes 1.25x input.
//   Their implicit breakpoint sits at the end of the latest eligible message, so the API
//   writes the whole uncached prompt. sim.mjs uses this rule to price uncached input as
//   writes on subscription routes that report no writes (see "Summary of model differences").
//   Earlier models: `prompt_cache_retention` in_memory (~5-10 min idle, up to 1h) or
//   24h; no cache-write charge. The in_memory TTL below is the conservative 5 min.

export const POLICIES = {
  anthropic: {
    "5m": { ttlSec: 300, write: 1.25 },
    "1h": { ttlSec: 3600, write: 2 },
  },
  "openai-30m": {
    "30m": { ttlSec: 1800, write: 1.25 },
  },
  "openai-legacy": {
    in_memory: { ttlSec: 300, write: 1 },
    "24h": { ttlSec: 86400, write: 1 },
  },
};

// Policy the provider applies when the client does not choose one.
export const DEFAULT_POLICY = { anthropic: "5m", "openai-30m": "30m", "openai-legacy": "24h" };

// Policy a route actually ran under, where it differs from DEFAULT_POLICY and the logs
// cannot show it. magpie serves Claude through `claude -p`, and Claude Code uses 1h for
// main-conversation requests on a subscription
// (https://code.claude.com/docs/en/prompt-caching, checked 2026-09-30). Local Claude Code
// transcripts and a live `-p` probe wrote 1h only; magpie ignores `prompt_cache_retention`.
export const ROUTE_POLICY = { magpie: { anthropic: "1h" } };

// How a user selects each policy on a route. "default" needs no setting.
// pi: PI_CACHE_RETENTION=long sends Anthropic cache_control ttl 1h (pi docs, environment-variables.md).
// magpie: its `claude -p` launch keeps CLAUDE_CODE_PROMPT_CACHE_TTL from its environment
// (magpie internal/gateway/claude_subscription.go, v0.1.455) and ignores pi's retention setting.
export const ROUTE_CONTROL = {
  anthropic: { "5m": "default", "1h": "PI_CACHE_RETENTION=long" },
  magpie: { "5m": "CLAUDE_CODE_PROMPT_CACHE_TTL=5m in magpie's environment", "1h": "default" },
};

/** Policy name the request's route actually used for its group. */
export function actualPolicy(modelKey, group) {
  return ROUTE_POLICY[modelKey.split("/")[0]]?.[group] ?? DEFAULT_POLICY[group];
}

// A scenario picks one policy per family. "default" uses DEFAULT_POLICY; "none" disables caching.
export const SCENARIOS = [
  { id: "none", label: "No cache", anthropic: "none", openai: "none" },
  { id: "a5m", label: "Anthropic 5m", anthropic: "5m", openai: "default" },
  { id: "a1h", label: "Anthropic 1h", anthropic: "1h", openai: "default" },
];

/** "provider/model" -> policy group, or null when out of scope. */
export function policyGroup(modelKey) {
  const id = modelKey.split("/").pop().toLowerCase();
  if (id.includes("claude")) return "anthropic";
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
  if (m) return Number(m[1]) * 100 + Number(m[2] ?? 0) >= 506 ? "openai-30m" : "openai-legacy";
  if (/^(o\d|codex)/.test(id)) return "openai-legacy";
  return null;
}

export const familyOf = (group) => (group === "anthropic" ? "anthropic" : group ? "openai" : null);

/** Resolve a scenario to a concrete policy for one group: { name, ttlSec, write } or null (no cache). */
export function policyFor(scenario, group, table = POLICIES) {
  let name = scenario[familyOf(group)] ?? "default";
  if (name === "none") return null;
  if (name === "default" || !table[group][name]) name = DEFAULT_POLICY[group];
  return { name, ...table[group][name] };
}
