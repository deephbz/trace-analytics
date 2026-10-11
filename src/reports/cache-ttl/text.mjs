// Cache TTL report: the text table and the web payload. Input: analyzeCacheTtl's result.

import { POLICIES, SCENARIOS } from "../../analytics/cache-ttl/policies.mjs";

/** Payload for the web view. The browser reruns sim.mjs so prices and policies stay editable. */
export function cacheTtlPayload(bt, { catalogSource } = {}) {
  const t = bt.table;
  return {
    sinceMs: t.sinceMs,
    untilMs: t.untilMs,
    stats: { sessions: t.sessions, requests: t.rows.length, warm: t.warm.length, linked: bt.prep.linked },
    models: t.models,
    prices: bt.prices,
    catalogSource,
    scenarios: SCENARIOS,
    policies: POLICIES,
    rows: t.rows,
    warm: t.warm,
  };
}

const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const mtok = (n) => `${(n / 1e6).toFixed(1)}M`;
const share = (a, b) => `${((b ? a / b : 0) * 100).toFixed(1)}%`;

export function cacheTtlText(bt) {
  const t = bt.table;
  const base = bt.repriced.cost;
  const cov = bt.coverage;
  const fam = (x, f) => usd(x.byFamily[f] ?? 0).padStart(11);
  const lines = [
    `cache-ttl  ${new Date(t.sinceMs).toISOString().slice(0, 16)} -> ${new Date(t.untilMs).toISOString().slice(0, 16)} UTC  ${t.rows.length} requests · ${t.sessions} sessions · ${bt.prep.linked} with a predecessor`,
    `Scope: Anthropic + OpenAI models at API prices. Excluded ${mtok(cov.excluded)} tokens (${share(cov.excluded, cov.total)}): ${Object.keys(cov.excludedModels).join(", ") || "none"}`,
    "",
    `${"scenario".padEnd(24)}${"cost".padStart(11)}${"vs actual".padStart(11)}${"anthropic".padStart(11)}${"openai".padStart(11)}${"hit".padStart(9)}${"write".padStart(9)}`,
    `${"actual (logged)".padEnd(24)}${usd(bt.logged.cost).padStart(11)}${"".padStart(11)}${fam(bt.logged, "anthropic")}${fam(bt.logged, "openai")}`,
    `${"actual (API repriced)".padEnd(24)}${usd(base).padStart(11)}${"".padStart(11)}${fam(bt.repriced, "anthropic")}${fam(bt.repriced, "openai")}${mtok(bt.repriced.hit).padStart(9)}${mtok(bt.repriced.write).padStart(9)}`,
  ];
  for (const r of bt.results) {
    const d = base ? (r.cost - base) / base : 0;
    lines.push(`${r.scenario.label.padEnd(24)}${usd(r.cost).padStart(11)}${pct(d).padStart(11)}${fam(r, "anthropic")}${fam(r, "openai")}${mtok(r.hit).padStart(9)}${mtok(r.write).padStart(9)}`);
  }
  const est = t.models.filter((_, m) => bt.prep.group[m] && !bt.prep.reported[m]);
  if (est.length) lines.push("", `Estimated writes (route logs no cacheWrite; uncached input priced as writes): ${mtok(bt.repriced.estWrite)} tokens on ${est.join(", ")}`);
  if (cov.unpriced) lines.push(`Unpriced in-scope models (excluded): ${Object.keys(cov.unpricedModels).join(", ")}`);
  return lines.join("\n");
}
