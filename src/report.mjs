// Report: rows -> per-route summaries, daily series, and chart points.
// The result object is the canonical artifact; the text table and web view render it.

import * as M from "./metrics.mjs";

const DAY = 86_400_000;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const q = (xs, p) => M.quantile(xs, p);

/** The parts of a call's wall time, in order. They add up to wall time. */
export const PARTS = [
  ["ttftFloor", "TTFT floor"],
  ["ttftVariance", "TTFT variance"],
  ["decoding", "decoding"],
  ["stallDuring", "stall during decoding"],
  // Item-level sources (codex) cannot split decoding from its stalls.
  ["unsplit", "decoding incl. stalls"],
  ["stallAfter", "stall after last token"],
];

function summarize(rows, fit) {
  const ttft = rows.map((r) => r.ttft);
  const split = rows.map((r) => M.splitTtft(fit, r));
  const plain = rows.filter((r) => r.reasoning === 0 && !M.held(r)).map((r) => M.splitTtft(fit, r).variance);
  const valid = rows.filter((r) => r.streamValid);
  const heldShare = valid.length ? valid.filter(M.held).length / valid.length : 0;
  const dec = rows.map(M.decode).filter((x) => x != null);
  const eligible = rows.filter(M.noReasoning);
  const spanMs = sum(eligible.map(M.span));
  const stalled = eligible.filter((r) => r.stalls > 0);
  const ctx = rows.map(M.context);
  const walled = rows.filter((r) => M.e2e(r) != null);
  const e2e = walled.map(M.e2e);
  return {
    calls: rows.length,
    e2e: {
      calls: walled.length,
      p25: q(e2e, 0.25),
      p50: q(e2e, 0.5),
      p75: q(e2e, 0.75),
      // All output over all wall time: long calls weigh more than in the per-call median.
      pooled: (sum(walled.map((r) => r.out)) / sum(walled.map((r) => r.wall))) * 1000,
    },
    ttft: { p50: q(ttft, 0.5), p90: q(ttft, 0.9) },
    ttftFloor: {
      baseMs: Math.exp(fit.a),
      per100k: Math.exp(fit.b * 1e5),
      atMedianCtx: M.floorAt(fit, q(ctx, 0.5)),
      medianCtx: q(ctx, 0.5),
      // Check on the fit: the share of calls under the floor should be near FLOOR_Q.
      below: rows.filter((r) => r.ttft < M.floorAt(fit, M.context(r))).length / rows.length,
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
      identifiable: heldShare <= M.MAX_HELD && dec.length >= M.MIN_CALLS,
      // Why not, when not: the source has no per-update timing, the route holds delivery, or too few calls.
      reason: !valid.length ? "no per-update timing" : heldShare > M.MAX_HELD ? "held delivery" : dec.length < M.MIN_CALLS ? "too few calls" : null,
      p25: q(dec, 0.25),
      p50: q(dec, 0.5),
      p75: q(dec, 0.75),
    },
    // Stalls during decoding, in calls without reasoning (M.noReasoning). On a route with
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
      decoding: sum(rows.map((r) => M.decoding(r) ?? 0)),
      stallDuring: sum(rows.map((r) => (M.stallsSeen(r) ? r.stall : 0))),
      unsplit: sum(rows.map((r) => M.unsplit(r) ?? 0)),
      stallAfter: sum(rows.map(M.stallAfter)),
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
    const el = rs.filter(M.noReasoning);
    const spanMs = sum(el.map(M.span));
    return {
      day,
      calls: rs.length,
      e2eP50: q(rs.map(M.e2e).filter((x) => x != null), 0.5),
      ttftP50: q(rs.map((r) => r.ttft), 0.5),
      ttftVarianceP50: q(rs.map((r) => M.splitTtft(fit, r).variance), 0.5),
      decodeP50: q(rs.map(M.decode).filter((x) => x != null), 0.5),
      stallShare: spanMs ? sum(el.map((r) => r.stall)) / spanMs : null,
    };
  });
}

export function buildReport({ rows, sources }, { sinceMs, untilMs, codeVersion }) {
  const byRoute = new Map();
  for (const r of rows) {
    if (!byRoute.has(r.route)) byRoute.set(r.route, []);
    byRoute.get(r.route).push(r);
  }
  const routes = [];
  const points = [];
  for (const [route, rs] of [...byRoute].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < M.MIN_CALLS) continue;
    const fit = M.fitFloor(rs);
    const i = routes.length;
    routes.push({ route, fit, summary: summarize(rs, fit), daily: daily(rs, fit) });
    // [t, route, context, ttft, ttftFloor, decode|null, span|null, stall, stalls, held, reasoning>0, out, e2e|null]
    for (const r of rs) {
      points.push([r.t, i, M.context(r), r.ttft, M.splitTtft(fit, r).floor, M.decode(r), M.span(r), r.stall, r.stalls, M.held(r) ? 1 : 0, r.reasoning > 0 ? 1 : 0, r.out, M.e2e(r)]);
    }
  }
  return {
    kind: "agent-speed/report",
    generatedAt: new Date().toISOString(),
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    codeVersion,
    parts: PARTS,
    constants: { STALL_MS: M.STALL_MS, HELD_SHARE: M.HELD_SHARE, FLOOR_Q: M.FLOOR_Q, MIN_CALLS: M.MIN_CALLS, MAX_HELD: M.MAX_HELD },
    sources,
    source: { calls: rows.length, excludedRoutes: [...byRoute].filter(([, rs]) => rs.length < M.MIN_CALLS).map(([route, rs]) => ({ route, calls: rs.length })) },
    routes,
    points,
  };
}

const f0 = (x) => (x == null ? "-" : Math.round(x).toLocaleString("en-US"));
const s1 = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(1));
const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);

export function textReport(rep) {
  const L = [];
  L.push(`agent-speed  ${rep.window.since.slice(0, 16)} -> ${rep.window.until.slice(0, 16)} UTC  ${rep.source.calls} calls`);
  for (const s of rep.sources) L.push(`  ${s.adapter.padEnd(6)} ${String(s.calls).padStart(6)} calls from ${s.inWindow} files: ${s.reused} reused, ${s.appended} appended, ${s.full} read whole, ${(s.bytes / 1e6).toFixed(1)} MB in ${s.ms} ms`);
  L.push("");
  L.push("End-to-end (output tok/s, request -> end)  calls    p25    p50    p75  pooled");
  for (const { route, summary: { e2e: e } } of rep.routes) {
    L.push(`${route.padEnd(36)} ${String(e.calls).padStart(11)} ${[e.p25, e.p50, e.p75, e.pooled].map((x) => f0(x).padStart(6)).join(" ")}`);
  }
  L.push("");
  L.push("TTFT (s)                              calls    p50    p90  floor@p50ctx  ×/100k ctx  below  variance p50  variance share  no-reasoning variance p50");
  for (const { route, summary: s } of rep.routes) {
    L.push(`${route.padEnd(36)} ${String(s.calls).padStart(6)} ${s1(s.ttft.p50).padStart(6)} ${s1(s.ttft.p90).padStart(6)} ${s1(s.ttftFloor.atMedianCtx).padStart(13)} ${s.ttftFloor.per100k.toFixed(2).padStart(11)} ${pct(s.ttftFloor.below).padStart(6)} ${s1(s.ttftVariance.p50).padStart(13)} ${pct(s.ttftVariance.share).padStart(15)} ${s1(s.ttftVariance.noReasoningP50).padStart(26)}`);
  }
  L.push("");
  L.push("Decode (visible tok/s)                calls   held    p25    p50    p75");
  for (const { route, summary: { decode: d } } of rep.routes) {
    const v = d.identifiable ? [d.p25, d.p50, d.p75].map((x) => f0(x).padStart(6)).join(" ") : `  not identifiable: ${d.reason}`;
    L.push(`${route.padEnd(36)} ${String(d.calls).padStart(6)} ${pct(d.heldShare).padStart(6)} ${v}`);
  }
  L.push("");
  L.push("Stall during decoding (no-reasoning calls)  calls  stalled  per span-min  time share  p90 stall/call (s)");
  for (const { route, summary: { stalls: st, decode: d } } of rep.routes) {
    const flag = d.heldShare > rep.constants.MAX_HELD ? "  held delivery" : "";
    L.push(`${route.padEnd(36)} ${String(st.calls).padStart(13)} ${pct(st.stalledShare).padStart(8)} ${(st.perSpanMin?.toFixed(2) ?? "-").padStart(13)} ${pct(st.timeShare).padStart(11)} ${s1(st.p90Ms).padStart(19)}${flag}`);
  }
  L.push("");
  const w = PARTS.map(([, label]) => Math.max(7, label.length));
  L.push(`${"Wall time by part".padEnd(36)} ${PARTS.map(([, label], i) => label.padStart(w[i])).join("  ")}`);
  for (const { route, summary: { budget: b } } of rep.routes) {
    const t = sum(PARTS.map(([k]) => b[k]));
    L.push(`${route.padEnd(36)} ${PARTS.map(([k], i) => pct(b[k] / t).padStart(w[i])).join("  ")}`);
  }
  if (rep.source.excludedRoutes.length) {
    L.push("");
    L.push(`Excluded (< ${rep.constants.MIN_CALLS} calls): ${rep.source.excludedRoutes.map((r) => `${r.route} (${r.calls})`).join(", ")}`);
  }
  return L.join("\n");
}
