// Checks for the compaction study's joins, on synthetic records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionRows, compactionTotals, pricer } from "../src/analytics/compaction.mjs";

const T0 = Date.parse("2026-10-10T05:00:00.000Z");
const PRICE = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const price = pricer((keys) => keys.map((k) => (k.includes("claude") ? PRICE : null)));
const call = (id, at, extra) => ({
  kind: "call", source: "pi", session: "s", role: null, id, responseId: null, prev: null, reset: null, compaction: null, cause: null, purpose: "turn",
  route: "p/claude-x", t: T0 + at, end: T0 + at + 1000, ttft: null, stream: null, stall: null, stalls: null, streamValid: false,
  input: 10, cacheRead: 1000, cacheWrite: 0, cacheWrite1h: 0, out: 100, reasoning: 0, stop: null, cost: null, ...extra,
});
const window = { sinceMs: T0, untilMs: T0 + 3_600_000 };

// Fails if the next request is one that started before the compaction ended (it still
// carried the old context), or if the ledger's cache split and timing are not used.
test("pi native: next request below a stale one; summarizer timing and tokens from the ledger", () => {
  const data = {
    window,
    calls: [
      call("a1", 0, { cause: "user" }),
      call("x1", 50_000, { source: "magpie", session: null, purpose: "compaction", route: "claude/claude-x", end: T0 + 90_000, ttft: 2000, input: 100, cacheRead: 0, cacheWrite: 800, out: 300 }),
      call("a2", 80_000, { prev: "a1", reset: "compaction", compaction: "k1", cause: "compaction" }), // started before k1 ended
      call("a3", 120_000, { prev: "a2", input: 5, cacheRead: 20_000, cacheWrite: 1000, cause: "tool" }),
    ],
    compactions: [{
      kind: "compaction", source: "pi", session: "s", role: null, id: "k1", t: T0 + 100_000, prev: "a1", method: "pi-native", trigger: null, model: null,
      before: 90_000, afterEst: null, usage: { prompt: 900, input: 900, cacheRead: 0, cacheWrite: 0, out: 300, reasoning: null }, wall: null,
      calls: ["magpie:x1"], handoff: [], handoffStart: null, detail: { summaryChars: 1200, gapMs: 5000 },
    }],
    coverage: [],
  };
  const { rows: [r] } = compactionRows(data, price);
  assert.deepEqual([r.ctx_next, r.next_gap_s], [21_005, 20]);
  assert.deepEqual([r.wall_ms, r.ttft_ms, r.req_uncached, r.req_cache_write, r.tokens_source, r.model], [40_000, 2000, 100, 800, "magpie ledger", "claude/claude-x"]);
  assert.ok(Math.abs(r.cost - (100 * 5 + 800 * 6.25 + 300 * 25) / 1e6) < 1e-12);
  assert.equal(r.trigger, "pi-threshold-or-manual");
  // The ledger's summarizer request is not an ordinary call.
  const { totals } = compactionTotals(data, price);
  assert.deepEqual([totals.pi.calls, totals.pi.user_turns, totals.pi.sessions], [3, 1, 1]);
});
