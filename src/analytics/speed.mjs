// Speed: how fast model calls are, as a coding agent sees them.
// This file is the authority for every speed formula and threshold.
//
// A call's wall time splits into five parts with different causes:
//
//   request ─► first token ─────────────────────────► last update ─► end
//   │◄─ TTFT floor ─►│◄─ TTFT variance ─►│◄ decoding │ stall during decoding │ … ►│◄ stall after last token ►│
//
// - TTFT floor: the part of time to first token that the context length explains. Read
//   it to see how prefill grows with context.
// - TTFT variance: TTFT above the floor. Queueing, stalls before the first token, hidden
//   reasoning, or buffered generation.
// - Decode speed: visible output over decoding time. Read it as the model's generation speed.
// - End-to-end speed: all output over wall time. Read it as what the user waits through.
// - Stalls: pauses in the stream. Read them as provider or network trouble.
//
// Population: calls in the window with a streamed first token and output. Sources that
// time whole items (codex, the gateway ledger) give no stall split: their decoding time
// shows as "decoding incl. stalls". The ledger's clock leaves out the agent's own time,
// so its calls group under gateway/<route>, apart from agent-side routes.

import { prompt, wall } from "../record.mjs";
import { quantile } from "./stats.mjs";

/** A pause between streamed updates that counts as a stall. pi-tps uses the same value. */
export const STALL_MS = 500;
/** A call is held when it decoded in under 1/HELD_SHARE of the call (Magpie's HeldShare). */
export const HELD_SHARE = 4;
/** Lower quantile that defines the TTFT floor. */
export const FLOOR_Q = 0.1;
/** A route needs this many calls for a summary line. */
export const MIN_CALLS = 30;
/** Above this share of held calls, a route's decode speed is not identifiable. */
export const MAX_HELD = 0.25;

const DAY = 86_400_000;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const q = quantile;

export const context = prompt;

/** The route a call is summarized under. */
export const routeOf = (c) => (c.source === "magpie" ? `gateway/${c.route}` : c.route);

/**
 * Span: first token to last update. pi-tps's `stream` starts at the second update, but
 * `stall` can hold the pause before it, so max(stream, stall) is the tightest lower bound.
 */
export const span = (r) => (r.stream == null ? null : Math.max(r.stream, r.stall ?? 0));

/** The source saw stalls during decoding (update-level timing). */
export const stallsSeen = (r) => r.stream != null && r.stall != null;

/** Decoding: the span less its stalls. Where stalls are not seen, the span holds both: see unsplit. */
export const decoding = (r) => (stallsSeen(r) ? span(r) - r.stall : null);

/** Decoding incl. stalls: the span of a call whose stalls the source cannot see. */
export const unsplit = (r) => (r.stream != null && r.stall == null ? span(r) : null);

/** Stall after last token: wall time after the last streamed update (the response's end, or span the bound missed). */
export const stallAfter = (r) => (wall(r) == null || r.stream == null ? 0 : Math.max(0, wall(r) - r.ttft - span(r)));

const reasoningOf = (r) => r.reasoning ?? 0;

/**
 * Stall statistics use calls without reasoning only. In reasoning calls, hidden
 * reasoning between streamed parts also shows as a stall during decoding.
 */
export const noReasoning = (r) => stallsSeen(r) && reasoningOf(r) === 0;

/**
 * End-to-end speed, tok/s: all output tokens, reasoning included, over the wall time
 * from request start to the end of the response. The headline metric: it holds every
 * wait the user sees, and needs no stream timing, so held delivery does not bias it.
 */
export const e2e = (r) => (wall(r) > 0 && r.out > 0 ? (r.out / wall(r)) * 1000 : null);

/**
 * Held delivery: the server or a proxy buffered the reply and released it in a burst,
 * so decoding looks shorter than the generation was. Generation time then sits in
 * TTFT variance, and out/decoding overstates decode speed.
 */
export const held = (r) => r.streamValid && decoding(r) * HELD_SHARE < r.ttft + span(r);

/**
 * Decode speed, tok/s: visible output over decoding time. Reasoning tokens are left
 * out, because hidden reasoning (OpenAI) is generated before the first content and
 * its time is in TTFT. null when the window is not trustworthy or held.
 */
export function decode(r) {
  if (!r.streamValid || held(r)) return null;
  const tokens = r.out - reasoningOf(r);
  return tokens > 0 ? (tokens / decoding(r)) * 1000 : null;
}

/**
 * TTFT floor: ln(ttft) = a + b * context, fitted to the FLOOR_Q quantile.
 * Method: sort calls by context into equal-count bins, take each bin's FLOOR_Q
 * quantile of ln(ttft), then a count-weighted least-squares line through the
 * (median context, quantile) points. A negative slope is clamped to 0.
 * Returns { a, b, bins } with floor(ctx) = exp(a + b * ctx) ms.
 */
export function fitFloor(rows) {
  const pts = rows.map((r) => [context(r), Math.log(r.ttft)]).sort((p, q) => p[0] - q[0]);
  const k = Math.max(4, Math.min(15, Math.floor(pts.length / 40)));
  const bins = [];
  for (let i = 0; i < k; i++) {
    const s = pts.slice(Math.floor((i * pts.length) / k), Math.floor(((i + 1) * pts.length) / k));
    if (s.length) bins.push({ x: quantile(s.map((p) => p[0]), 0.5), y: quantile(s.map((p) => p[1]), FLOOR_Q), n: s.length });
  }
  let sw = 0, sx = 0, sy = 0;
  for (const p of bins) (sw += p.n), (sx += p.n * p.x), (sy += p.n * p.y);
  const mx = sx / sw, my = sy / sw;
  let sxy = 0, sxx = 0;
  for (const p of bins) (sxy += p.n * (p.x - mx) * (p.y - my)), (sxx += p.n * (p.x - mx) ** 2);
  const b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
  return { a: my - b * mx, b, bins };
}

export const floorAt = (fit, ctx) => Math.exp(fit.a + fit.b * ctx);

/**
 * Split TTFT into the TTFT floor and the TTFT variance above it. The variance is
 * pre-first-token time the context does not explain: queueing, stalls before the
 * first token, hidden reasoning, and for held calls, buffered generation.
 */
export function splitTtft(fit, r) {
  const floor = Math.min(r.ttft, floorAt(fit, context(r)));
  return { floor, variance: r.ttft - floor };
}

/** The parts of a call's wall time, in order. They add up to wall time. */
export const PARTS = [
  ["ttftFloor", "TTFT floor"],
  ["ttftVariance", "TTFT variance"],
  ["decoding", "decoding"],
  ["stallDuring", "stall during decoding"],
  // Item-level sources (codex, the gateway ledger) cannot split decoding from its stalls.
  ["unsplit", "decoding incl. stalls"],
  ["stallAfter", "stall after last token"],
];

function summarize(rows, fit) {
  const ttft = rows.map((r) => r.ttft);
  const split = rows.map((r) => splitTtft(fit, r));
  const plain = rows.filter((r) => reasoningOf(r) === 0 && !held(r)).map((r) => splitTtft(fit, r).variance);
  const valid = rows.filter((r) => r.streamValid);
  const heldShare = valid.length ? valid.filter(held).length / valid.length : 0;
  const dec = rows.map(decode).filter((x) => x != null);
  const eligible = rows.filter(noReasoning);
  const spanMs = sum(eligible.map(span));
  const stalled = eligible.filter((r) => r.stalls > 0);
  const ctx = rows.map(context);
  const walled = rows.filter((r) => e2e(r) != null);
  const speeds = walled.map(e2e);
  return {
    calls: rows.length,
    e2e: {
      calls: walled.length,
      p25: q(speeds, 0.25),
      p50: q(speeds, 0.5),
      p75: q(speeds, 0.75),
      // All output over all wall time: long calls weigh more than in the per-call median.
      pooled: (sum(walled.map((r) => r.out)) / sum(walled.map(wall))) * 1000,
    },
    ttft: { p50: q(ttft, 0.5), p90: q(ttft, 0.9) },
    ttftFloor: {
      baseMs: Math.exp(fit.a),
      per100k: Math.exp(fit.b * 1e5),
      atMedianCtx: floorAt(fit, q(ctx, 0.5)),
      medianCtx: q(ctx, 0.5),
      // Check on the fit: the share of calls under the floor should be near FLOOR_Q.
      below: rows.filter((r) => r.ttft < floorAt(fit, context(r))).length / rows.length,
    },
    ttftVariance: {
      p50: q(split.map((s) => s.variance), 0.5),
      p90: q(split.map((s) => s.variance), 0.9),
      share: sum(split.map((s) => s.variance)) / sum(ttft),
      // Calls without reasoning and not held: variance from queueing and early stalls only.
      noReasoningP50: q(plain, 0.5),
      noReasoningCalls: plain.length,
    },
    decode: {
      calls: dec.length,
      heldShare,
      identifiable: heldShare <= MAX_HELD && dec.length >= MIN_CALLS,
      // Why not, when not: the source has no per-update timing, the route holds delivery, or too few calls.
      reason: !valid.length ? "no per-update timing" : heldShare > MAX_HELD ? "held delivery" : dec.length < MIN_CALLS ? "too few calls" : null,
      p25: q(dec, 0.25),
      p50: q(dec, 0.5),
      p75: q(dec, 0.75),
    },
    // Stalls during decoding, in calls without reasoning (noReasoning). On a route with
    // held delivery, the burst also shows as stalls; decode.identifiable says so.
    stalls: {
      calls: eligible.length,
      stalledShare: eligible.length ? stalled.length / eligible.length : null,
      perSpanMin: spanMs ? sum(eligible.map((r) => r.stalls)) / (spanMs / 60_000) : null,
      timeShare: spanMs ? sum(eligible.map((r) => r.stall)) / spanMs : null,
      p90Ms: q(stalled.map((r) => r.stall), 0.9),
    },
    // Wall time summed over all calls, split into PARTS.
    budget: {
      ttftFloor: sum(split.map((s) => s.floor)),
      ttftVariance: sum(split.map((s) => s.variance)),
      decoding: sum(rows.map((r) => decoding(r) ?? 0)),
      stallDuring: sum(rows.map((r) => (stallsSeen(r) ? r.stall : 0))),
      unsplit: sum(rows.map((r) => unsplit(r) ?? 0)),
      stallAfter: sum(rows.map(stallAfter)),
    },
  };
}

function daily(rows, fit) {
  const days = new Map();
  for (const r of rows) {
    const d = Math.floor(r.t / DAY) * DAY;
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  return [...days].sort((a, b) => a[0] - b[0]).map(([day, rs]) => {
    const el = rs.filter(noReasoning);
    const spanMs = sum(el.map(span));
    return {
      day,
      calls: rs.length,
      e2eP50: q(rs.map(e2e).filter((x) => x != null), 0.5),
      ttftP50: q(rs.map((r) => r.ttft), 0.5),
      ttftVarianceP50: q(rs.map((r) => splitTtft(fit, r).variance), 0.5),
      decodeP50: q(rs.map(decode).filter((x) => x != null), 0.5),
      stallShare: spanMs ? sum(el.map((r) => r.stall)) / spanMs : null,
    };
  });
}

/** The calls this study measures. */
export const timed = (c) => c.ttft > 0 && c.out > 0;

/**
 * Speed result: per-route summaries, daily series, and per-call chart points.
 * data: load() output. The result is the canonical artifact; reports render it.
 */
export function analyzeSpeed({ window, calls, coverage }, { codeVersion } = {}) {
  const { sinceMs, untilMs } = window;
  const rows = calls.filter((c) => c.t >= sinceMs && c.t < untilMs && timed(c));
  const byRoute = new Map();
  for (const r of rows) {
    const k = routeOf(r);
    if (!byRoute.has(k)) byRoute.set(k, []);
    byRoute.get(k).push(r);
  }
  const routes = [];
  const points = [];
  for (const [route, rs] of [...byRoute].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < MIN_CALLS) continue;
    const fit = fitFloor(rs);
    const i = routes.length;
    routes.push({ route, fit, summary: summarize(rs, fit), daily: daily(rs, fit) });
    // [t, route, context, ttft, ttftFloor, decode|null, span|null, stall, stalls, held, reasoning>0, out, e2e|null]
    for (const r of rs) {
      points.push([r.t, i, context(r), r.ttft, splitTtft(fit, r).floor, decode(r), span(r), r.stall, r.stalls, held(r) ? 1 : 0, reasoningOf(r) > 0 ? 1 : 0, r.out, e2e(r)]);
    }
  }
  const perSource = (name) => rows.filter((r) => r.source === name).length;
  return {
    kind: "trace-analytics/speed",
    generatedAt: new Date().toISOString(),
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    codeVersion,
    parts: PARTS,
    constants: { STALL_MS, HELD_SHARE, FLOOR_Q, MIN_CALLS, MAX_HELD },
    // Per source: the calls measured, and the source's scan and coverage counts.
    sources: coverage.map((c) => ({ adapter: c.source, ...c, calls: perSource(c.source), untimed: c.calls - perSource(c.source) })),
    source: { calls: rows.length, excludedRoutes: [...byRoute].filter(([, rs]) => rs.length < MIN_CALLS).map(([route, rs]) => ({ route, calls: rs.length })) },
    routes,
    points,
  };
}
