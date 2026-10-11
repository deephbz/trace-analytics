// Model-call wall time per agent from agent-speed's ingest, for compaction time shares,
// and the decode speed of ordinary long-output calls per model.
// Usage: node denoms.mjs <sinceMs> > denoms.json
import { ingest } from "../../src/ingest.mjs";

const sinceMs = Number(process.argv[2]);
const { rows } = await ingest({ sinceMs, agents: ["pi", "codex"] });
const out = {};
for (const r of rows) {
  const a = (out[r.agent] ??= { calls: 0, wallMs: 0, bySession: {} });
  if (r.wall == null) continue;
  a.calls++;
  a.wallMs += r.wall;
  const s = (a.bySession[r.session] ??= [0, 0]);
  s[0]++;
  s[1] += r.wall;
}
// Ordinary long-output calls (>= 1500 tokens): decode speed per agent and model, p50.
const dec = {};
for (const r of rows) {
  if (r.wall == null || r.out < 1500 || r.wall <= r.ttft) continue;
  (dec[`${r.agent}|${r.route.split("/").pop()}`] ??= []).push(r.out / ((r.wall - r.ttft) / 1000));
}
out.decode = Object.fromEntries(Object.entries(dec).map(([k, v]) => (v.sort((a, b) => a - b), [k, { n: v.length, p50: v[v.length >> 1] }])));
console.log(JSON.stringify(out));
