// Checks for the two estimates the speed report rests on.
import "./home.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, fitFloor, floorAt, held } from "../src/analytics/speed.mjs";

// Fails if the fit tracks the mean or median of the upward-only noise instead of the floor.
test("fitFloor recovers a known floor under upward-only noise", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const a = Math.log(800), b = 4e-6; // 0.8 s at 0 tokens, ×1.49 per 100k
  const rows = Array.from({ length: 4000 }, () => {
    const ctx = rnd() * 250_000;
    // A third of calls sit near the floor; the rest add a long TTFT variance (queueing, stalls).
    const variance = rnd() < 0.3 ? rnd() * 0.08 : -Math.log(rnd());
    return { input: ctx * 0.1, cacheRead: ctx * 0.9, cacheWrite: null, ttft: Math.exp(a + b * ctx + variance) };
  });
  const fit = fitFloor(rows);
  for (const ctx of [20_000, 120_000, 230_000]) {
    const ratio = floorAt(fit, ctx) / Math.exp(a + b * ctx);
    assert.ok(ratio > 0.97 && ratio < 1.1, `floor at ${ctx}: ${ratio.toFixed(3)}× the truth`);
  }
});

// Fails if a burst release (generation hidden in TTFT) is reported as decode speed.
test("held delivery yields no decode speed", () => {
  const base = { out: 1200, reasoning: 0, stall: 0, streamValid: true };
  const steady = { ...base, ttft: 2_000, stream: 10_000 };
  const burst = { ...base, ttft: 11_000, stream: 1_000 };
  assert.equal(held(steady), false);
  assert.equal(Math.round(decode(steady)), 120);
  assert.equal(held(burst), true);
  assert.equal(decode(burst), null);
});
