import "./home.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { policyFor, policyGroup, SCENARIOS } from "../src/analytics/cache-ttl/policies.mjs";
import { actualRepriced, coverage, hitCurve, prepare, requestCosts, simulate, ttlCostModel } from "../src/analytics/cache-ttl/sim.mjs";
import { requestTable } from "../src/analytics/cache-ttl/table.mjs";
import { resolvePrices } from "../src/analytics/prices.mjs";
import { tierRates } from "../src/analytics/rates.mjs";
import { load } from "../src/sources/load.mjs";
import { pi } from "../src/sources/pi.mjs";

const MIN = 60_000;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const claude = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
const [NONE, A5M, A1H] = SCENARIOS;
// [t, chain, model, input, cacheRead, cacheWrite, cacheWrite1h, output, loggedCost, predT, predPrompt, predCached]
const row = (t, input, cr, cw, pred = null, model = 0) => [t, 0, model, input, cr, cw, 0, 0, 0, ...(pred ? [pred[0], pred[3] + pred[4] + pred[5], pred[4] + pred[5]] : [-1, 0, 0])];

test("scope: family comes from the model id, whatever the route", () => {
  assert.equal(policyGroup("magpie/claude/claude-opus-5-5"), "anthropic");
  assert.equal(policyGroup("openai-codex/gpt-6-astra"), "openai-30m");
  assert.equal(policyGroup("openai-codex/gpt-5.6-luna"), "openai-30m");
  assert.equal(policyGroup("openai/gpt-5.5"), "openai-legacy");
  assert.equal(policyGroup("openrouter/deepseek/deepseek-v4.1-flash"), null);
});

test("scenarios change Anthropic TTL only; OpenAI GPT-5.6+ stays on 30m", () => {
  assert.deepEqual(policyFor(A1H, "anthropic"), { name: "1h", ttlSec: 3600, write: 2 });
  assert.deepEqual(policyFor(A1H, "openai-30m"), { name: "30m", ttlSec: 1800, write: 1.25 });
  assert.equal(policyFor(NONE, "openai-30m"), null);
});

test("expiry-explained miss is imputed from the lineage prefix; hit depends on TTL", () => {
  // Direct Anthropic route (logs writes). Request 2 comes 10 min later and missed under 5m.
  const r1 = row(0, 5, 0, 1000);
  const r2 = row(10 * MIN, 5, 0, 1100, r1);
  const prep = prepare([r1, r2], ["anthropic/claude-opus-5"]);
  assert.equal(prep.reuse[1], 1000);
  const five = simulate(prep, [claude], A5M);
  const hour = simulate(prep, [claude], A1H);
  assert.equal(five.hit, 0);
  assert.equal(hour.hit, 1000);
  near(hour.cost, (1000 * 1 + (1005 + 105) * 2 * 10) / 1e6);
});

test("a short read within the actual TTL is an observed prefix change, not imputed", () => {
  const r1 = row(0, 5, 0, 1000);
  const r2 = row(2 * MIN, 5, 0, 1100, r1); // miss after 2 min under 5m: prefix changed
  const prep = prepare([r1, r2], ["anthropic/claude-opus-5"]);
  assert.equal(prep.reuse[1], 0);
  assert.equal(prep.observedMiss, 1);
});

test("routes without logged writes: lineage prefix is the predecessor prompt; actual writes are estimated", () => {
  const gpt = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
  const r1 = row(0, 1000, 0, 0);
  const r2 = row(MIN, 100, 1000, 0, r1);
  const prep = prepare([r1, r2], ["openai-codex/gpt-6-astra"]);
  assert.equal(prep.reported[0], false);
  assert.equal(prep.reuse[1], 1000);
  const a = actualRepriced(prep, [gpt]);
  assert.equal(a.estWrite, 1100);
  near(a.cost, (1100 * 1.25 * 10 + 1000 * 1) / 1e6);
});

test("magpie Claude runs under 1h: estimated writes cost 2x and a 10 min miss is imputed", () => {
  const r1 = row(0, 1000, 0, 0);
  const r2 = row(10 * MIN, 1100, 0, 0, r1); // 10 min miss: 1h should have hit, so expiry cannot explain it
  const prep = prepare([r1, r2], ["magpie/claude/claude-opus-5-5"]);
  assert.equal(prep.actual[0], "1h");
  assert.equal(prep.reuse[1], 0);
  near(actualRepriced(prep, [claude]).cost, (2100 * 2 * 10) / 1e6);
});

test("replay under the actual policy reproduces actual cost on an exact route", () => {
  const r1 = row(0, 5, 0, 1000);
  const r2 = row(MIN, 5, 1000, 100, r1);
  const prep = prepare([r1, r2], ["anthropic/claude-opus-5"]);
  near(simulate(prep, [claude], A5M).cost, actualRepriced(prep, [claude]).cost + (5 + 5) * (1.25 - 1) * 10 / 1e6);
});

test("per-request costs sum to the scenario total and mark out-of-scope rows NaN", () => {
  const r1 = row(0, 5, 0, 1000);
  const r2 = row(10 * MIN, 5, 0, 1100, r1);
  const r3 = row(MIN, 50, 0, 0, null, 1);
  const prep = prepare([r1, r3, r2], ["anthropic/claude-opus-5", "openrouter/z-ai/glm-5.3-flash"]);
  const rc = requestCosts(prep, [claude, null], A1H);
  assert.ok(Number.isNaN(rc.cost[1]));
  near(rc.cost[0] + rc.cost[2], simulate(prep, [claude, null], A1H).cost);
  assert.equal(rc.hit[2], 1000);
});

test("TTL cost model matches the replay at each real policy", () => {
  const r1 = row(0, 5, 0, 1000);
  const r2 = row(10 * MIN, 5, 0, 1100, r1);
  const r3 = row(12 * MIN, 5, 1105, 20, r2);
  const prep = prepare([r1, r2, r3], ["anthropic/claude-opus-5"]);
  const model = ttlCostModel(prep, [claude], () => true);
  near(model.at(300, 1.25), simulate(prep, [claude], A5M).cost);
  near(model.at(3600, 2), simulate(prep, [claude], A1H).cost);
});

test("long-context tier applies per request prompt", () => {
  const p = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }] };
  assert.equal(tierRates(p, 100000).input, 2);
  assert.equal(tierRates(p, 300000).input, 4);
});

test("hit curve is monotonic in TTL", () => {
  const r1 = row(0, 0, 0, 1000);
  const r2 = row(2 * MIN, 0, 1000, 10, r1);
  const r3 = row(40 * MIN, 0, 0, 1010, r2);
  const c = hitCurve(prepare([r1, r2, r3], ["anthropic/claude-opus-5"]), [0, 300, 3600]).map((p) => p.share);
  assert.deepEqual(c, [0, 1000 / 2010, 1]);
});

test("prices: API vendor entry by normalized id; out-of-scope models are null and counted", () => {
  const catalog = [
    { provider: "openai-codex", id: "gpt-6-astra", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
    { provider: "openai", id: "gpt-6-astra", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }] } },
    { provider: "anthropic", id: "claude-opus-5-5", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  ];
  const models = ["openai-codex/gpt-6-astra", "magpie/claude/claude-opus-5-5", "openrouter/z-ai/glm-5.3-flash"];
  const [a, b, c] = resolvePrices(models, catalog);
  assert.equal(a.source, "openai/gpt-6-astra");
  assert.equal(a.tiers.length, 1);
  assert.equal(b.source, "anthropic/claude-opus-5-5");
  assert.equal(c, null);
  const prep = prepare([row(0, 10, 0, 0, null, 2)], models);
  assert.equal(coverage(prep, [a, b, c]).excluded, 10);
});

test("request table links requests by lineage and breaks at compaction and model switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ttl-"));
  const dir = join(root, "sessions", "--proj--");
  await mkdir(dir, { recursive: true });
  const t0 = Date.parse("2026-09-01T10:00:00Z");
  const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } };
  const msg = (id, parentId, dt, model = "m") => ({ type: "message", id, parentId, timestamp: new Date(t0 + dt).toISOString(), message: { role: "assistant", provider: "p", model, timestamp: t0 + dt, usage } });
  const lines = [
    { type: "session", timestamp: new Date(t0).toISOString() },
    msg("a1", null, 0),
    { type: "message", id: "u1", parentId: "a1", timestamp: new Date(t0 + 1000).toISOString(), message: { role: "user" } },
    msg("a2", "u1", 2000),
    { type: "compaction", id: "c1", parentId: "a2", timestamp: new Date(t0 + 3000).toISOString() },
    msg("a3", "c1", 4000),
    msg("a4", "a3", 5000, "other"),
    { type: "usage", kind: "cache_warm", id: "w1", parentId: "a4", timestamp: new Date(t0 + 6000).toISOString(), provider: "p", model: "m", usage },
    msg("a5", "a2", 3 * 86400_000),
  ];
  await writeFile(join(dir, "2026-09-01T10-00-00-000Z_abc.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const opts = { sinceMs: t0 + 1000, untilMs: t0 + 86400_000, sources: { pi: { ...pi, list: () => pi.list(join(root, "sessions")) } }, cacheDir: join(root, "cache") };
  const t = requestTable(await load(opts));
  // a1 is before the window but still serves as a2's predecessor.
  assert.deepEqual(t.rows.map((r) => r[9]), [t0, -1, -1]);
  assert.equal(t.warm.length, 1);
  assert.equal((await load(opts)).coverage[0].reused, 1);
});
