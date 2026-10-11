// Speed report as a text table. Input: the speed result (src/analytics/speed.mjs).

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const f0 = (x) => (x == null ? "-" : Math.round(x).toLocaleString("en-US"));
const s1 = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(1));
const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);

export function speedText(rep) {
  const L = [];
  L.push(`speed  ${rep.window.since.slice(0, 16)} -> ${rep.window.until.slice(0, 16)} UTC  ${rep.source.calls} calls`);
  for (const s of rep.sources) L.push(`  ${s.adapter.padEnd(6)} ${String(s.calls).padStart(6)} timed calls (${s.untimed} untimed) from ${s.inWindow} files: ${s.reused} reused, ${s.appended} appended, ${s.full} read whole, ${(s.bytes / 1e6).toFixed(1)} MB in ${s.ms} ms`);
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
  const w = rep.parts.map(([, label]) => Math.max(7, label.length));
  L.push(`${"Wall time by part".padEnd(36)} ${rep.parts.map(([, label], i) => label.padStart(w[i])).join("  ")}`);
  for (const { route, summary: { budget: b } } of rep.routes) {
    const t = sum(rep.parts.map(([k]) => b[k]));
    L.push(`${route.padEnd(36)} ${rep.parts.map(([k], i) => pct(b[k] / t).padStart(w[i])).join("  ")}`);
  }
  if (rep.source.excludedRoutes.length) {
    L.push("");
    L.push(`Excluded (< ${rep.constants.MIN_CALLS} calls): ${rep.source.excludedRoutes.map((r) => `${r.route} (${r.calls})`).join(", ")}`);
  }
  return L.join("\n");
}
