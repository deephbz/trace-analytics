// Compaction report as a text table. Input: analyzeCompaction's result. The page
// (page.html) holds the narrative; this is the summary for a terminal.

const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
const n0 = (x) => (x == null ? "-" : Math.round(x).toLocaleString("en-US"));
const s0 = (x) => (x == null ? "-" : `${Math.round(x)} s`);
const usd = (x) => (x == null ? "-" : `$${x.toFixed(2)}`);

export function compactionText({ stats: S, rows }) {
  const L = [`compaction  ${S.meta.since.slice(0, 16)} -> ${S.meta.until.slice(0, 16)} UTC  ${rows.length} compactions`, ""];
  L.push(`${"population".padEnd(26)}${"compactions".padStart(12)}${"calls/compaction".padStart(18)}${"input".padStart(8)}${"output".padStart(8)}${"cost".padStart(8)}${"+handoff".padStart(10)}${"time".padStart(8)}${"+handoff".padStart(10)}`);
  for (const [name, s] of Object.entries(S.shares)) {
    if (!s.compactions) continue;
    L.push(`${name.padEnd(26)}${String(s.compactions).padStart(12)}${n0(s.per_1000_calls ? 1000 / s.per_1000_calls : null).padStart(18)}${pct(s.input_share).padStart(8)}${pct(s.output_share).padStart(8)}${pct(s.cost_share).padStart(8)}${pct(s.cost_share_with_handoff).padStart(10)}${pct(s.time_share).padStart(8)}${pct(s.time_share_with_handoff).padStart(10)}`);
  }
  L.push("", `${"method".padEnd(26)}${"n".padStart(5)}${"ctx before".padStart(12)}${"out".padStart(8)}${"wall p50".padStart(10)}${"wall p90".padStart(10)}${"cost p50".padStart(10)}${"ctx after".padStart(11)}`);
  for (const [g, x] of Object.entries(S.groups)) {
    L.push(`${g.padEnd(26)}${String(x.n).padStart(5)}${n0(x.ctx_pre_p50).padStart(12)}${n0(x.out_p50).padStart(8)}${s0(x.wall_p50).padStart(10)}${s0(x.wall_p90).padStart(10)}${usd(x.cost_p50).padStart(10)}${n0(x.ctx_next_p50).padStart(11)}`);
  }
  const U = S.factors.unified;
  if (U) L.push("", `wall ≈ ${U.a.toFixed(0)} s + ${U.b.toFixed(2)} × output / ordinary decode speed: R² ${U.r2.toFixed(2)} over ${U.n} compactions (input alone: R² ${U.r2_input_only.toFixed(3)})`);
  L.push("", `Left out: ${Object.entries(S.dropped).map(([k, v]) => `${k} ${v}`).join("; ") || "none"}`);
  return L.join("\n");
}
