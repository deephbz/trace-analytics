// Compaction: how often agents compact their context, what it costs, and what makes it slow.
// This file is the authority for the study's derivations; research/compaction/README.md
// holds the findings. Two stages:
//
//   load() output ─► compactionRows: one row per compaction, joined to its neighbours
//                ─► compactionTotals: ordinary calls per population (the denominators)
//                ─► compactionStats: profiles, shares, fits, factors
//
// Row fields keep the study's names (ctx_pre, req_out, wall_ms, ...) so its page reads
// them as before. Costs are list prices for every call, subscription traffic included.

import { modelOf, prompt, wall } from "../record.mjs";
import { usd } from "./rates.mjs";
import { groupBy, ols, pearson, quantile, spearman, sum } from "./stats.mjs";

/** A Claude Code summary has about this many characters per token (its output is not logged). */
export const CHARS_PER_TOKEN = 3.6;
/** Claude Code writes 1-hour cache entries on subscription plans: a gap under this reads the history from cache. */
export const WARM_S = 3600;
/** A pi gap to the previous entry over this holds user idle time (manual /compact): no wall time. */
export const MAX_GAP_MS = 600_000;
/** Below this implied output speed, a wall time holds waiting (a sub-agent idle until its parent wrote). */
export const MIN_TPS = 5;
/** Ordinary calls with at least this much output give a model's ordinary decode speed. */
export const LONG_OUT = 1500;
/** A compaction that left the next request at over this share of the old context did not apply. */
export const APPLIED = 0.9;

const METHOD = { "pi-native": "pi-native-summary", "pi-blackmagic": "pi-blackmagic", "codex-remote": "codex-remote", "claude-summary": "cc-summary" };
const HARNESS = { pi: "pi", codex: "codex", claude: "claude-code" };
/** Codex's own label for a user's thread is "user"; the protocol's is "main". */
const roleOf = (r) => (r.source === "codex" ? (r.role === "main" ? "user" : r.role) : "main");
const population = (r) => (r.source === "codex" ? `codex:${roleOf(r)}` : HARNESS[r.source]);
const sKey = (r) => `${r.source}|${r.session}`;
const key3 = (source, session, id) => `${source}|${session}|${id}`;

/** price(model) -> price or null, memoized. resolve: (modelKeys) -> prices (prices.mjs resolvePrices). */
export function pricer(resolve) {
  const memo = new Map();
  return (model) => {
    if (!model) return null;
    if (!memo.has(model)) memo.set(model, resolve([model])[0]);
    return memo.get(model);
  };
}

const callCost = (price, c) => usd(price(c.route), { input: c.input, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite ?? 0, out: c.out });

/** One row per compaction in the window. data: load() output. price: pricer(). */
export function compactionRows({ window, calls, compactions }, price) {
  const { sinceMs, untilMs } = window;
  const cost = (model, input, cacheRead, cacheWrite, out) => usd(price(model), { input, cacheRead, cacheWrite, out });
  const byId = new Map();
  const byKey = new Map();
  const under = new Map(); // compaction or call key -> turn calls directly under it
  const add = (k, c) => (under.has(k) ? under.get(k).push(c) : under.set(k, [c]));
  for (const c of calls) {
    if (c.session != null) byId.set(key3(c.source, c.session, c.id), c);
    else byKey.set(`${c.source}:${c.id}`, c);
    if (c.purpose !== "turn") continue;
    if (c.compaction != null) add(key3(c.source, c.session, `compaction:${c.compaction}`), c);
    else if (c.prev != null) add(key3(c.source, c.session, c.prev), c);
  }
  // The next request: the first call under the compaction that started after it ended.
  // A request that started before still carried the old context; look below it.
  const nextOf = (k) => {
    let level = under.get(key3(k.source, k.session, `compaction:${k.id}`)) ?? [];
    for (let depth = 0; level.length && depth < 8; depth++) {
      const first = [...level].sort((a, b) => a.t - b.t)[0];
      if (first.t >= k.t - 1000) return first;
      level = under.get(key3(first.source, first.session, first.id)) ?? [];
    }
    return null;
  };
  const resolve = (k, key) => {
    const [source, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    return source === "magpie" ? byKey.get(key) : byId.get(key3(source, k.session, id));
  };
  // Ordinary calls since the previous compaction, per session.
  const sinceLast = new Map();
  const events = groupBy([...calls.filter((c) => c.purpose === "turn" && c.session != null), ...compactions], sKey);
  for (const evs of events.values()) {
    let n = 0;
    for (const e of evs.sort((a, b) => a.t - b.t)) {
      if (e.kind === "compaction") (sinceLast.set(e, n), (n = 0));
      else n++;
    }
  }
  const rows = [];
  const dropped = {};
  for (const k of compactions) {
    if (k.t < sinceMs || k.t >= untilMs) continue;
    const prev = k.prev != null ? byId.get(key3(k.source, k.session, k.prev)) : null;
    const prevEnd = prev ? prev.end ?? prev.t : null;
    const row = {
      harness: HARNESS[k.source], source: HARNESS[k.source], session: k.session, id: k.id, t: k.t / 1000, role: roleOf(k),
      method: METHOD[k.method], trigger: k.trigger, model: k.model, ctx_pre: k.before, calls_since_prev: sinceLast.get(k) ?? 0,
    };
    if (k.source === "pi") {
      Object.assign(row, { prev_call_gap_s: null, session_model: prev?.route ?? null });
      row.trigger ??= "pi-threshold-or-manual";
      if (k.handoffStart != null) {
        const hand = k.handoff.map((h) => resolve(k, h)).filter(Boolean);
        const last = hand.at(-1);
        Object.assign(row, {
          handoff_calls: hand.length,
          handoff_in: sum(hand.map(prompt)),
          handoff_cache_read: sum(hand.map((c) => c.cacheRead)),
          handoff_out: sum(hand.map((c) => c.out)),
          handoff_cost: sum(hand.map((c) => callCost(price, c))),
          handoff_wall_ms: last ? (last.end ?? last.t) - k.handoffStart : 0,
        });
      }
    }
    const u = k.usage;
    if (k.method === "pi-blackmagic") {
      Object.assign(row, {
        req_in_total: u?.prompt ?? null, req_out: u?.out ?? null, req_cache_read: u?.cacheRead ?? null,
        wall_ms: k.wall, wall_source: "latencyMs", tokens_source: "logged (cache split not kept)",
        retention: k.detail.retention, artifact_chars: k.detail.artifactChars,
      });
      const tin = row.req_in_total ?? 0, tout = row.req_out ?? 0;
      row.cost_lo = cost(row.model, 0, tin, 0, tout); // all of the input read from cache
      row.cost_hi = cost(row.model, tin, 0, 0, tout); // none of it
      row.cost = null;
    } else if (k.method === "pi-native") {
      let { input: unc = 0, cacheRead: cr = 0, cacheWrite: cw = 0, out = 0 } = u ?? {};
      Object.assign(row, {
        req_uncached: unc, req_cache_read: cr, req_cache_write: cw, req_in_total: unc + cr + cw, req_out: out,
        req_reasoning: u?.reasoning ?? null, tokens_source: u ? "logged" : "missing", summary_chars: k.detail.summaryChars,
      });
      const led = k.calls.map((x) => byKey.get(x)).filter(Boolean);
      if (led.length) {
        const start = Math.min(...led.map((c) => c.t));
        // The ledger has the cache split pi folds into input.
        [unc, cr, cw] = [sum(led.map((c) => c.input)), sum(led.map((c) => c.cacheRead)), sum(led.map((c) => c.cacheWrite))];
        Object.assign(row, {
          model: led[0].route, wall_ms: Math.max(...led.map((c) => c.end)) - start, ttft_ms: Math.min(...led.map((c) => c.ttft ?? 1e9)),
          wall_source: "magpie ledger", summarizer_requests: led.length,
          req_uncached: unc, req_cache_read: cr, req_cache_write: cw, req_in_total: unc + cr + cw, tokens_source: "magpie ledger",
        });
      } else {
        const gap = k.detail.gapMs;
        Object.assign(row, { model: prev?.route ?? null, wall_ms: gap && gap < MAX_GAP_MS ? gap : null, wall_source: "gap to previous entry (upper bound)" });
      }
      row.cost = u ? cost(row.model, unc, cr, cw, out) : null;
    } else if (k.method === "codex-remote") {
      row.retained_items = k.detail.retainedItems;
      if (u) {
        Object.assign(row, {
          req_in_total: u.prompt, req_uncached: u.input, req_cache_read: u.cacheRead, req_cache_write: u.cacheWrite ?? 0,
          req_out: u.out, req_reasoning: u.reasoning, tokens_source: "logged",
          wall_ms: k.wall, wall_source: "usage record minus last synchronous line", ctx_post_est: k.afterEst,
        });
        row.cost = cost(row.model, u.input, u.cacheRead, row.req_cache_write, u.out);
      } else row.tokens_source = "missing";
    } else {
      const schars = k.detail.summaryChars ?? 0;
      const gap = prevEnd != null && k.wall ? (k.t - k.wall - prevEnd) / 1000 : null;
      const warm = gap != null && gap < WARM_S;
      const pre = k.before;
      const outEst = Math.round(schars / CHARS_PER_TOKEN);
      Object.assign(row, {
        model: prev ? modelOf(prev.route) : null, ctx_post_est: k.afterEst, wall_ms: k.wall, wall_source: "compactMetadata.durationMs",
        prev_call_gap_s: gap != null ? round1(gap) : null, summary_chars: schars, req_in_total: pre, req_out: outEst,
        req_cache_read: warm ? pre : 0, req_uncached: warm ? 0 : pre, tokens_source: `estimated (summary chars/${CHARS_PER_TOKEN}; cache by gap)`,
      });
      row.cost = cost(row.model, row.req_uncached ?? 0, row.req_cache_read ?? 0, 0, outEst);
    }
    if (k.source === "pi" && prevEnd != null && row.wall_ms) row.prev_call_gap_s = round1((k.t - row.wall_ms - prevEnd) / 1000);
    const n = nextOf(k);
    if (n) {
      Object.assign(row, { ctx_next: prompt(n), next_cache_read: n.cacheRead, next_uncached: n.input });
      if (k.source !== "codex") Object.assign(row, { next_cache_write: n.cacheWrite ?? 0, next_gap_s: round1((n.t - k.t) / 1000) });
    }
    if (row.wall_ms && row.req_out && row.req_out / (row.wall_ms / 1000) < MIN_TPS && row.wall_source !== "compactMetadata.durationMs") {
      Object.assign(row, { wall_ms: null, wall_dropped: `implied output rate < ${MIN_TPS} tok/s` });
      bump(dropped, `${row.harness}: wall time dropped (idle in gap)`);
    }
    row.iso = new Date(k.t).toISOString().slice(0, 19) + "Z";
    row.applied = row.ctx_next && row.ctx_pre ? row.ctx_next < APPLIED * row.ctx_pre : null;
    rows.push(row);
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, dropped };
}

const round1 = (x) => Math.round(x * 10) / 10;
const bump = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);

/**
 * Ordinary model calls per population (pi, codex:<role>, claude-code) in the window:
 * the denominators of the shares. A user turn is a call that answers a user input.
 */
export function compactionTotals({ window, calls, compactions }, price) {
  const { sinceMs, untilMs } = window;
  const totals = {};
  const sessions = {};
  const tot = (p) => (totals[p] ??= { sessions: 0, user_turns: 0, calls: 0, uncached: 0, cache_read: 0, cache_write: 0, out: 0, cost: 0, wall_ms: 0, timed_calls: 0, unpriced_calls: 0 });
  const dec = {};
  for (const c of calls) {
    if (c.source === "magpie" || c.purpose !== "turn" || c.t < sinceMs || c.t >= untilMs) continue;
    const p = population(c);
    const t = tot(p);
    (sessions[p] ??= new Set()).add(c.session);
    t.calls++;
    if (c.cause === "user") t.user_turns++;
    t.uncached += c.input;
    t.cache_read += c.cacheRead;
    t.cache_write += c.cacheWrite ?? 0;
    t.out += c.out;
    const usdC = callCost(price, c);
    if (usdC == null) t.unpriced_calls++;
    else t.cost += usdC;
    const w = wall(c);
    if (w != null && w > 0) (t.wall_ms += w), t.timed_calls++;
    // Ordinary decode speed of long outputs, per harness and model.
    if (c.source !== "claude" && w != null && c.ttft != null && c.out >= LONG_OUT && w > c.ttft) (dec[`${c.source}|${modelOf(c.route)}`] ??= []).push(c.out / ((w - c.ttft) / 1000));
  }
  for (const k of compactions) {
    if (k.t < sinceMs || k.t >= untilMs) continue;
    (sessions[population(k)] ??= new Set()).add(k.session);
    if (k.source === "codex" && k.usage) bump(tot(population(k)), "compaction_requests_in_records");
  }
  for (const [p, s] of Object.entries(sessions)) tot(p).sessions = s.size;
  const ordinaryDecode = Object.fromEntries(Object.entries(dec).map(([k, v]) => (v.sort((a, b) => a - b), [k, { n: v.length, p50: v[v.length >> 1] }])));
  return { totals, ordinaryDecode };
}

// ---- stats

export const ORDER = ["pi native summary", "pi blackmagic", "codex (user thread)", "codex (sub-agent)", "codex (guardian_review)", "claude code"];

/** Groups: harness x method; Codex split by role because sub-agents dominate its count. */
export function group(r) {
  if (r.harness === "codex") return `codex (${r.role === "user" ? "user thread" : r.role === "subagent" ? "sub-agent" : r.role})`;
  return { "pi-native-summary": "pi native summary", "pi-blackmagic": "pi blackmagic", "cc-summary": "claude code" }[r.method];
}

const POP = {
  pi: ["pi", (r) => r.harness === "pi"],
  "codex (user thread)": ["codex:user", (r) => r.harness === "codex" && r.role === "user"],
  "codex (sub-agent)": ["codex:subagent", (r) => r.harness === "codex" && r.role === "subagent"],
  "codex (guardian_review)": ["codex:guardian_review", (r) => r.harness === "codex" && r.role === "guardian_review"],
  "claude code": ["claude-code", (r) => r.harness === "claude-code"],
};

/** Percentile p in [0, 100] of the non-null values (NumPy's default). */
const q = (xs, p) => quantile(xs.filter((x) => x != null), p / 100);
const median = (xs) => q(xs, 50);
const costMid = (r) => (r.cost != null ? r.cost : r.cost_lo != null ? (r.cost_lo + r.cost_hi) / 2 : null);
/** Compaction output speed: output over wall time less TTFT where TTFT is known. */
const tps = (r) => (r.wall_ms && r.req_out ? r.req_out / ((r.wall_ms - (r.ttft_ms ?? 0)) / 1000) : null);
const vendor = (r) => (String(r.model).includes("claude") ? "Anthropic" : "OpenAI");
const bm = (m) => String(m).split("/").pop();
const uniq = (xs) => [...new Set(xs)].sort();

export function compactionStats(rows, { totals, ordinaryDecode }) {
  const G = groupBy(rows, group);
  const stats = { groups: {}, shares: {}, fits: {} };

  for (const g of ORDER) {
    const rs = G.get(g);
    if (!rs) continue;
    const w = rs.filter((r) => r.wall_ms).map((r) => r.wall_ms / 1000);
    stats.groups[g] = {
      n: rs.length, sessions: new Set(rs.map((r) => r.session)).size, models: uniq(rs.map((r) => bm(r.model))),
      ctx_pre_p50: q(rs.map((r) => r.ctx_pre), 50), ctx_pre_p10: q(rs.map((r) => r.ctx_pre), 10), ctx_pre_p90: q(rs.map((r) => r.ctx_pre), 90),
      req_in_p50: q(rs.map((r) => r.req_in_total), 50), out_p50: q(rs.map((r) => r.req_out), 50),
      ctx_next_p50: q(rs.filter((r) => r.applied).map((r) => r.ctx_next), 50), not_applied: rs.filter((r) => r.applied === false).length,
      not_applied_days: uniq(rs.filter((r) => r.applied === false).map((r) => r.iso.slice(0, 10))),
      req_in_over_ctx_p50: q(rs.filter((r) => r.req_in_total && r.ctx_pre).map((r) => r.req_in_total / r.ctx_pre), 50),
      req_cache_write_share_p50: q(rs.filter((r) => r.tokens_source === "magpie ledger").map((r) => r.req_cache_write / r.req_in_total), 50),
      ctx_next_over_pre_p50: q(rs.filter((r) => r.applied).map((r) => r.ctx_next / r.ctx_pre), 50),
      next_cache_read_share_p50: q(rs.filter((r) => r.ctx_next && r.next_cache_read != null).map((r) => r.next_cache_read / r.ctx_next), 50),
      wall_n: w.length, wall_p50: q(w, 50), wall_p90: q(w, 90), wall_max: w.length ? Math.max(...w) : null,
      ttft_p50: q(rs.filter((r) => r.ttft_ms).map((r) => r.ttft_ms / 1000), 50),
      out_tps_p50: q(rs.filter((r) => r.wall_ms && r.req_out && r.wall_ms > (r.ttft_ms ?? 0)).map(tps), 50),
      req_cache_read_share_p50: q(rs.filter((r) => r.req_cache_read != null && r.req_in_total).map((r) => r.req_cache_read / r.req_in_total), 50),
      cost_p50: q(rs.map(costMid), 50), cost_sum: sum(rs.map(costMid)), cost_lo_sum: sum(rs.map((r) => r.cost_lo)), cost_hi_sum: sum(rs.map((r) => r.cost_hi)),
      handoff_n: rs.filter((r) => r.handoff_calls != null).length,
      handoff_cost_p50: q(rs.filter((r) => r.handoff_calls != null).map((r) => r.handoff_cost), 50),
      handoff_wall_p50: q(rs.filter((r) => r.handoff_wall_ms).map((r) => r.handoff_wall_ms / 1000), 50),
      handoff_in_p50: q(rs.filter((r) => r.handoff_calls).map((r) => r.handoff_in), 50),
      handoff_cold: rs.filter((r) => r.handoff_in && r.handoff_cache_read / r.handoff_in < 0.5).length,
      calls_between_p50: q(rs.map((r) => r.calls_since_prev), 50),
      tokens_source: uniq(rs.map((r) => String(r.tokens_source))), wall_source: uniq(rs.map((r) => String(r.wall_source))),
    };
  }

  // Frequency and shares per population: compaction / (compaction + ordinary calls).
  for (const [name, [key, sel]] of Object.entries(POP)) {
    const t = { sessions: 0, user_turns: 0, calls: 0, uncached: 0, cache_read: 0, cache_write: 0, out: 0, cost: 0, wall_ms: 0, ...totals[key] };
    const rs = rows.filter(sel);
    const cIn = sum(rs.map((r) => r.req_in_total)), cOut = sum(rs.map((r) => r.req_out)), cCost = sum(rs.map(costMid));
    const cWall = sum(rs.map((r) => r.wall_ms)), hCost = sum(rs.map((r) => r.handoff_cost)), hWall = sum(rs.map((r) => r.handoff_wall_ms));
    const callsIn = t.uncached + t.cache_read + t.cache_write;
    stats.shares[name] = {
      compactions: rs.length, sessions: t.sessions, sessions_with_compaction: new Set(rs.map((r) => r.session)).size,
      agent_turns: t.user_turns, model_calls: t.calls,
      per_100_turns: t.user_turns ? (100 * rs.length) / t.user_turns : null, per_1000_calls: t.calls ? (1000 * rs.length) / t.calls : null,
      input_share: callsIn ? cIn / (callsIn + cIn) : null, output_share: t.out ? cOut / (t.out + cOut) : null,
      cost_share: t.cost ? cCost / (t.cost + cCost) : null, compaction_cost: cCost, calls_cost: t.cost,
      cost_share_with_handoff: t.cost ? (cCost + hCost) / (t.cost + cCost) : null,
      time_share: t.wall_ms ? cWall / (t.wall_ms + cWall) : null, compaction_wall_h: cWall / 3.6e6, calls_wall_h: t.wall_ms / 3.6e6,
      time_share_with_handoff: t.wall_ms ? (cWall + hWall) / (t.wall_ms + cWall) : null,
      timed_rows: rs.filter((r) => r.wall_ms).length,
    };
  }

  // Wall time vs context: OLS wall_s ~ a + b*input_k (+ c*output_k), per group.
  for (const g of ORDER) {
    const rs = (G.get(g) ?? []).filter((r) => r.wall_ms && r.req_in_total && r.req_out);
    if (rs.length < 8) continue;
    const y = rs.map((r) => r.wall_ms / 1000), xin = rs.map((r) => r.req_in_total / 1000), xout = rs.map((r) => r.req_out / 1000);
    const f1 = ols(y, [xin]), f2 = ols(y, [xin, xout]);
    stats.fits[g] = {
      n: rs.length,
      wall_vs_input: { intercept_s: f1.b[0], s_per_1k_in: f1.b[1], r2: f1.r2 },
      wall_vs_input_output: { intercept_s: f2.b[0], s_per_1k_in: f2.b[1], s_per_1k_out: f2.b[2], r2: f2.r2 },
      spearman_input: spearman(xin, y), spearman_output: spearman(xout, y), input_range_k: [Math.min(...xin), Math.max(...xin)],
    };
  }

  // Same model, two harnesses: pi native vs Claude Code on Opus 5.5.
  stats.same_model = {};
  for (const [name, sel] of [
    ["pi native, Opus 5.5", (r) => r.method === "pi-native-summary" && String(r.model).includes("opus-5-5")],
    ["claude code, Opus 5.5", (r) => r.harness === "claude-code" && String(r.model).includes("opus-5-5")],
  ]) {
    const rs = rows.filter((r) => sel(r) && r.wall_ms);
    stats.same_model[name] = {
      n: rs.length, ctx_pre_p50: q(rs.map((r) => r.ctx_pre), 50), wall_p50: q(rs.map((r) => r.wall_ms / 1000), 50),
      out_p50: q(rs.map((r) => r.req_out), 50), cost_p50: q(rs.map((r) => r.cost), 50), ctx_next_p50: q(rs.map((r) => r.ctx_next), 50),
    };
  }

  // Factors: vendor, model, ordinary decode speed, nth compaction, day.
  const ord = (harness, model) => ordinaryDecode[`${harness === "codex" ? "codex" : "pi"}|${bm(model)}`];
  const ordTps = (r) => {
    const o = ord(r.harness, r.model);
    return o && o.n >= 20 ? o.p50 : null;
  };
  const prof = (rs) => ({
    n: rs.length, wall_p50: q(rs.filter((r) => r.wall_ms).map((r) => r.wall_ms / 1000), 50), out_p50: q(rs.map((r) => r.req_out), 50),
    tps_p50: q(rs.map(tps), 50), ctx_pre_p50: q(rs.map((r) => r.ctx_pre), 50),
    ctx_next_p50: q(rs.filter((r) => r.applied).map((r) => r.ctx_next), 50), cost_p50: q(rs.map(costMid), 50),
    harnesses: uniq(rs.map((r) => r.harness)), methods: uniq(rs.map((r) => r.method)),
  });
  const fac = (stats.factors = {});
  fac.vendor = Object.fromEntries([...groupBy(rows, vendor)].map(([v, rs]) => [v, prof(rs)]));
  fac.model = [];
  for (const rs of [...groupBy(rows, (r) => `${vendor(r)}|${bm(r.model)}|${r.harness}`).values()].sort((a, b) => b.length - a.length)) {
    if (rs.length < 5) continue;
    const { harness: h, model } = rs[0];
    const o = ord(h, model);
    fac.model.push({ vendor: vendor(rs[0]), model: bm(model), harness: h, ordinary_tps: o && o.n >= 20 ? o.p50 : null, ordinary_n: o ? o.n : 0, ...prof(rs) });
  }
  // One model for all methods: wall = a + b * output / ordinary decode speed of the model.
  const pts = rows.filter((r) => r.wall_ms && r.req_out && r.harness !== "claude-code" && ordTps(r)).map((r) => [r.req_out / ordTps(r), r.wall_ms / 1000, group(r), r]);
  if (pts.length > 2) {
    const x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
    const { b: [a, b], r2 } = ols(y, [x]);
    const res = y.map((v, i) => v - (a + b * x[i]));
    fac.unified = {
      n: pts.length, a, b, r2,
      residual_p50: Object.fromEntries([...new Set(pts.map((p) => p[2]))].map((g) => [g, median(res.filter((_, i) => pts[i][2] === g))])),
      r2_input_only: pearson(pts.map((p) => p[3].req_in_total), y) ** 2,
    };
    fac.unified_points = pts.map((p) => [round1(p[0]), round1(p[1]), p[2]]);
  }
  // nth compaction in a session.
  const NTH = { "codex-remote": "codex", "pi-blackmagic": "pi blackmagic", "pi-native-summary": "pi native summary", "cc-summary": "claude code" };
  const bySession = groupBy([...rows].sort((a, b) => a.t - b.t), (r) => `${r.harness}|${r.session}`);
  const nth = {};
  for (const rs of bySession.values()) rs.forEach((r, i) => ((nth[NTH[r.method]] ??= {})[Math.min(i + 1, 4)] ??= []).push(r));
  fac.nth = Object.fromEntries(Object.entries(nth).map(([g, d]) => [g, Object.fromEntries(Object.entries(d).map(([n, rs]) => [n, {
    n: rs.length, out_p50: q(rs.map((r) => r.req_out), 50), ctx_next_p50: q(rs.filter((r) => r.applied).map((r) => r.ctx_next), 50),
  }]))]));
  fac.per_session = [...bySession.values()].map((rs) => rs.length).sort((a, b) => b - a);
  // Day-to-day speed of the most common model.
  const day = groupBy(rows.filter((r) => r.harness === "codex" && bm(r.model) === "gpt-6.1-sol" && tps(r)), (r) => r.iso.slice(0, 10));
  fac.sol_by_day = Object.fromEntries([...day].sort().filter(([, v]) => v.length >= 3).map(([d, v]) => [d, { n: v.length, tps_p50: median(v.map(tps)) }]));
  fac.out_vs_ctx_rho = {};
  for (const m of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-5.6-luna", "claude-opus-5-5"]) {
    const rs = rows.filter((r) => bm(r.model) === m && r.req_out && r.ctx_pre);
    fac.out_vs_ctx_rho[m] = { n: rs.length, rho: rs.length > 2 ? spearman(rs.map((r) => r.ctx_pre), rs.map((r) => r.req_out)) : null };
  }
  return stats;
}

/** The whole study. data: load() output; resolve: (modelKeys) -> prices. */
export function analyzeCompaction(data, resolve) {
  const price = pricer(resolve);
  const { rows, dropped } = compactionRows(data, price);
  const totals = compactionTotals(data, price);
  const stats = compactionStats(rows, totals);
  const { sinceMs, untilMs } = data.window;
  stats.meta = { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), days: Math.round((untilMs - sinceMs) / 864e5) };
  // Records left out, from the sources' coverage and the rules above.
  for (const c of data.coverage) {
    const h = HARNESS[c.source] ?? c.source;
    for (const [k, n] of Object.entries(c.excluded ?? {})) if (n) bump(dropped, `${h}: ${k} files`, n);
    if (c.copies) bump(dropped, `${h}: copies of records in another session file`, c.copies);
    if (c.skipped?.inheritedCompaction) bump(dropped, `${h}: compactions inherited by a forked thread`, c.skipped.inheritedCompaction);
  }
  stats.dropped = dropped;
  return { kind: "trace-analytics/compaction", stats, rows, totals: totals.totals, ordinaryDecode: totals.ordinaryDecode };
}
