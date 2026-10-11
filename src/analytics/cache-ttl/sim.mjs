// Pure prompt-cache TTL replay. Runs in Node and in the browser.
//
// Evidence (local audit, 30 days, see README "Ground truth"):
// - Every assistant request logs input, output, cacheRead; `message.timestamp` is request start.
// - Direct Anthropic logs cacheWrite and cacheWrite1h. On every in-TTL hit,
//   cacheRead == predecessor cacheRead + cacheWrite, so the reusable prefix is exact.
// - openai-codex and the magpie proxy never log cacheWrite; writes are folded into input.
//   Their hits read ~99.7% of the predecessor's prompt.
//
// Replay model:
// - A request's predecessor is its prev call on the same model with no compaction or
//   branch summary between (see table.mjs).
// - Reusable prefix R: the lineage prefix (predecessor cacheRead + cacheWrite on routes
//   that log writes, predecessor prompt otherwise), except where the observation decides:
//   - observed cacheRead covers >= 90% of it: R = cacheRead (observed hit);
//   - gap within the TTL the request actually ran under and a short read: R = cacheRead
//     (observed prefix change or eviction, not expiry). Only expiry-explained misses
//     are imputed. Actual TTL: 1h when the request logged 1h writes, else the route policy
//     (policies.mjs actualPolicy: magpie Claude 1h, otherwise the group default).
// - Under a policy with TTL T, the request hits R when (start - predecessor start) <= T.
//   All other prompt tokens are written at the policy write multiplier × input.
// - Rates follow pi's calculateCost tier rule on the request prompt.

import { tierRates } from "../rates.mjs";
import { actualPolicy, familyOf, POLICIES, policyFor, policyGroup } from "./policies.mjs";

// Compact request row as produced by table.mjs.
export const COL = { t: 0, chain: 1, model: 2, input: 3, cr: 4, cw: 5, cw1h: 6, out: 7, cost: 8, predT: 9, predP: 10, predCached: 11 };
const OBSERVED_SHARE = 0.9;


/** Derive scenario-independent facts per request. */
export function prepare(rows, models) {
  const group = models.map(policyGroup);
  const provider = models.map((k) => k.split("/")[0]);
  const writing = new Set();
  for (const r of rows) if (r[COL.cw] > 0) writing.add(provider[r[COL.model]]);
  const reported = models.map((_, m) => writing.has(provider[m]));
  const actual = models.map((k, m) => (group[m] ? actualPolicy(k, group[m]) : null));
  const n = rows.length;
  const gap = new Float64Array(n);
  const reuse = new Float64Array(n);
  const prompt = new Float64Array(n);
  let linked = 0;
  let observedMiss = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const P = r[COL.input] + r[COL.cr] + r[COL.cw];
    prompt[i] = P;
    if (r[COL.predT] < 0) {
      gap[i] = Infinity;
      continue;
    }
    linked++;
    gap[i] = (r[COL.t] - r[COL.predT]) / 1000;
    const m = r[COL.model];
    const base = reported[m] ? r[COL.predCached] : r[COL.predP];
    const g = group[m];
    const actualTtl = !g ? 0 : r[COL.cw1h] > 0 ? POLICIES.anthropic["1h"].ttlSec : POLICIES[g][actual[m]].ttlSec;
    const observed = r[COL.cr] >= OBSERVED_SHARE * base || gap[i] <= actualTtl;
    if (observed && r[COL.cr] < OBSERVED_SHARE * base) observedMiss++;
    reuse[i] = Math.min(P, observed ? r[COL.cr] : base);
  }
  return { rows, models, group, route: provider, reported, actual, gap, reuse, prompt, linked, observedMiss };
}

function emptyTotals() {
  return { cost: 0, hit: 0, write: 0, uncached: 0, output: 0, estWrite: 0, requests: 0, byDay: {}, byModel: {}, byFamily: {} };
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function add(tot, t, model, family, c) {
  tot.cost += c;
  tot.requests++;
  const d = dayKey(t);
  tot.byDay[d] = (tot.byDay[d] ?? 0) + c;
  tot.byModel[model] = (tot.byModel[model] ?? 0) + c;
  tot.byFamily[family] = (tot.byFamily[family] ?? 0) + c;
}

/**
 * Per-request replay of one scenario. cost is $ per request (NaN when out of scope or
 * unpriced); hit and write are prompt tokens read from and written to cache (TTL 0: write 0).
 * Consumers group these arrays by gap, route, or day.
 */
export function requestCosts(prep, prices, scenario, table = POLICIES) {
  const { rows, gap, reuse, prompt, group } = prep;
  const n = rows.length;
  const cost = new Float64Array(n).fill(NaN);
  const hit = new Float64Array(n);
  const write = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const m = r[COL.model];
    const g = group[m];
    if (!g || !prices[m]) continue;
    const rates = tierRates(prices[m], prompt[i]);
    const pol = policyFor(scenario, g, table);
    let c;
    if (!pol) c = prompt[i] * rates.input;
    else {
      hit[i] = gap[i] <= pol.ttlSec ? reuse[i] : 0;
      write[i] = prompt[i] - hit[i];
      c = hit[i] * rates.cacheRead + write[i] * pol.write * rates.input;
    }
    cost[i] = (c + r[COL.out] * rates.output) / 1e6;
  }
  return { cost, hit, write };
}

/**
 * Prompt-side cost (reads + writes; output excluded because no policy changes it)
 * of the selected requests as a function of TTL T and write multiplier w:
 *   cost(T, w) = w·Σ P·in + Σ_{gap ≤ T} reuse·(cacheRead − w·in)
 * Prefix sums over requests sorted by gap make each evaluation O(log n).
 */
export function ttlCostModel(prep, prices, select) {
  const items = [];
  let base = 0;
  for (let i = 0; i < prep.rows.length; i++) {
    const m = prep.rows[i][COL.model];
    if (!prep.group[m] || !prices[m] || !select(i)) continue;
    const rates = tierRates(prices[m], prep.prompt[i]);
    base += prep.prompt[i] * rates.input;
    if (prep.reuse[i] > 0 && Number.isFinite(prep.gap[i])) items.push([prep.gap[i], prep.reuse[i] * rates.cacheRead, prep.reuse[i] * rates.input]);
  }
  items.sort((a, b) => a[0] - b[0]);
  const gaps = new Float64Array(items.length);
  const read = new Float64Array(items.length + 1);
  const inp = new Float64Array(items.length + 1);
  items.forEach(([g, r, x], k) => ((gaps[k] = g), (read[k + 1] = read[k] + r), (inp[k + 1] = inp[k] + x)));
  const upTo = (T) => {
    let lo = 0, hi = gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid] <= T) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { base: base / 1e6, at: (T, w) => { const k = upTo(T); return (w * base + read[k] - w * inp[k]) / 1e6; } };
}

/** Replay one scenario over in-scope, priced requests. */
export function simulate(prep, prices, scenario, table = POLICIES) {
  const tot = emptyTotals();
  const { cost, hit, write } = requestCosts(prep, prices, scenario, table);
  for (let i = 0; i < prep.rows.length; i++) {
    if (Number.isNaN(cost[i])) continue;
    const r = prep.rows[i];
    const m = r[COL.model];
    if (hit[i] + write[i] === 0) tot.uncached += prep.prompt[i];
    tot.hit += hit[i];
    tot.write += write[i];
    tot.output += r[COL.out];
    add(tot, r[COL.t], m, familyOf(prep.group[m]), cost[i]);
  }
  return tot;
}

/**
 * Observed usage at API prices. Routes that log writes are priced as logged
 * (1h subset at the 1h multiplier). Routes that never log writes have their
 * uncached input priced as writes at the route policy (estimated).
 */
export function actualRepriced(prep, prices, warm = [], table = POLICIES) {
  const tot = emptyTotals();
  for (const r of [...prep.rows, ...warm]) {
    const m = r[COL.model];
    const g = prep.group[m];
    if (!g || !prices[m]) continue;
    const P = r[COL.input] + r[COL.cr] + r[COL.cw];
    const rates = tierRates(prices[m], P);
    // Logged writes: split by the logged 1h subset. Estimated writes: the route's actual policy.
    const short = prep.reported[m] ? table[g]["5m"]?.write ?? table[g][prep.actual[m]].write : table[g][prep.actual[m]].write;
    let c = r[COL.cr] * rates.cacheRead + r[COL.out] * rates.output;
    if (prep.reported[m]) {
      const long = table.anthropic["1h"].write;
      c += r[COL.input] * rates.input + (r[COL.cw] - r[COL.cw1h]) * short * rates.input + r[COL.cw1h] * long * rates.input;
      tot.write += r[COL.cw];
      tot.uncached += r[COL.input];
    } else {
      c += r[COL.input] * short * rates.input;
      tot.write += r[COL.input];
      tot.estWrite += r[COL.input];
    }
    tot.hit += r[COL.cr];
    tot.output += r[COL.out];
    add(tot, r[COL.t], m, familyOf(g), c / 1e6);
  }
  return tot;
}

/** Cost pi logged at request time, in-scope models only. Proxies and subscriptions can log 0. */
export function actualLogged(prep, warm = []) {
  const tot = emptyTotals();
  for (const r of [...prep.rows, ...warm]) {
    const g = prep.group[r[COL.model]];
    if (g) add(tot, r[COL.t], r[COL.model], familyOf(g), r[COL.cost]);
  }
  return tot;
}

/** Requests and tokens outside the Anthropic/OpenAI scope, and unpriced in-scope models. */
export function coverage(prep, prices) {
  const tok = (r) => r[COL.input] + r[COL.cr] + r[COL.cw] + r[COL.out];
  const c = { total: 0, excluded: 0, unpriced: 0, excludedModels: {}, unpricedModels: {} };
  for (const r of prep.rows) {
    const m = r[COL.model];
    const t = tok(r);
    c.total += t;
    if (!prep.group[m]) (c.excluded += t), (c.excludedModels[prep.models[m]] = (c.excludedModels[prep.models[m]] ?? 0) + t);
    else if (!prices[m]) (c.unpriced += t), (c.unpricedModels[prep.models[m]] = (c.unpricedModels[prep.models[m]] ?? 0) + t);
  }
  return c;
}

export const GAP_BINS = [
  { label: "<1m", max: 60 },
  { label: "1–5m", max: 300 },
  { label: "5–15m", max: 900 },
  { label: "15–30m", max: 1800 },
  { label: "30–60m", max: 3600 },
  { label: "1–2h", max: 7200 },
  { label: "2–6h", max: 21600 },
  { label: ">6h", max: Infinity },
];

const inFamily = (prep, i, family) => {
  const f = familyOf(prep.group[prep.rows[i][COL.model]]);
  return f && (!family || f === family);
};

/** Reusable tokens grouped by idle gap: the tokens a TTL at least that long can serve. */
export function gapHistogram(prep, family) {
  const bins = GAP_BINS.map((b) => ({ ...b, tokens: 0, requests: 0 }));
  for (let i = 0; i < prep.gap.length; i++) {
    if (prep.reuse[i] <= 0 || !inFamily(prep, i, family)) continue;
    const b = bins.find((x) => prep.gap[i] <= x.max);
    b.tokens += prep.reuse[i];
    b.requests++;
  }
  return bins;
}

/** Share of reusable tokens served for each TTL (price-independent). */
export function hitCurve(prep, ttls, family) {
  let total = 0;
  for (let i = 0; i < prep.reuse.length; i++) if (inFamily(prep, i, family)) total += prep.reuse[i];
  return ttls.map((ttl) => {
    let hit = 0;
    for (let i = 0; i < prep.reuse.length; i++) if (prep.gap[i] <= ttl && inFamily(prep, i, family)) hit += prep.reuse[i];
    return { ttl, share: total ? hit / total : 0 };
  });
}

export function parseDuration(v) {
  const m = /^([\d.]+)\s*(s|m|h|d)?$/.exec(String(v).trim());
  if (!m) throw new Error(`Bad duration: ${v}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"];
}
