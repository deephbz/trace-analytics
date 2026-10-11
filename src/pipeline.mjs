// The three studies, each the same pipeline:
//
//   sources/load ──► analytics/<study> ──► reports/<study>
//   (CALL, COMPACTION records)  (result)    (text, files, live routes)
//
// A study names the sources it needs, analyzes load()'s output, and renders the result.
// The CLI and the pi extension call run() and serve(); only this file knows all three layers.

import { readFile } from "node:fs/promises";
import { analyzeCacheTtl } from "./analytics/cache-ttl/index.mjs";
import { analyzeCompaction } from "./analytics/compaction.mjs";
import { resolvePrices } from "./analytics/prices.mjs";
import { analyzeSpeed } from "./analytics/speed.mjs";
import { cacheTtlPayload, cacheTtlText } from "./reports/cache-ttl/text.mjs";
import { compactionText } from "./reports/compaction/text.mjs";
import { renderPage } from "./reports/html.mjs";
import { speedText } from "./reports/speed/text.mjs";
import { load } from "./sources/load.mjs";

const page = (study) => new URL(`./reports/${study}/page.html`, import.meta.url);
const js = (rel) => ["text/javascript", () => readFile(new URL(rel, import.meta.url))];
const json = (f) => ["application/json", (r) => JSON.stringify(f(r))];
const html = (f) => ["text/html; charset=utf-8", f];

// ctx: { codeVersion, catalog: { models, source }, overrides }
export const STUDIES = {
  speed: {
    title: "Speed of model calls: TTFT, decode, stalls, end-to-end",
    defaultSince: "14d",
    // Claude Code calls have no stream timing; they are read so the ledger's copies of them drop out.
    sources: ["pi", "codex", "claude", "magpie"],
    analyze: (data, ctx) => analyzeSpeed(data, ctx),
    text: speedText,
    files: async (rep) => ({ "report.json": JSON.stringify(rep), "report.html": await renderPage(page("speed"), { REPORT: rep }) }),
    // The live page polls report.json.
    routes: { "/": html(() => renderPage(page("speed"))), "/report.json": json((r) => r) },
  },
  "cache-ttl": {
    title: "Prompt-cache TTL backtest: replay retention policies on real usage",
    defaultSince: "7d",
    // pi's session tree links each request to the prefix it can reuse.
    sources: ["pi"],
    analyze: (data, ctx) => ({ ...analyzeCacheTtl(data, ctx.catalog.models, { overrides: ctx.overrides }), catalogSource: ctx.catalog.source }),
    text: (bt) => `${cacheTtlText(bt)}\n\nPrices: ${bt.catalogSource}`,
    files: (bt) => ({ "data.json": JSON.stringify(cacheTtlPayload(bt, { catalogSource: bt.catalogSource })) }),
    // The page reruns the simulation in the browser with editable prices and policies.
    routes: {
      "/": html(() => readFile(page("cache-ttl"), "utf8")),
      "/data.json": json((bt) => cacheTtlPayload(bt, { catalogSource: bt.catalogSource })),
      "/sim.mjs": js("./analytics/cache-ttl/sim.mjs"),
      "/policies.mjs": js("./analytics/cache-ttl/policies.mjs"),
      "/rates.mjs": js("./analytics/rates.mjs"),
    },
  },
  compaction: {
    title: "Context compaction: frequency, cost, time, and what makes it slow",
    defaultSince: "28d",
    // The ledger gives pi's native summarizer requests their timing and cache split.
    sources: ["pi", "codex", "claude", "magpie"],
    analyze: (data, ctx) => analyzeCompaction(data, (keys) => resolvePrices(keys, ctx.catalog.models, ctx.overrides)),
    text: compactionText,
    files: async (res) => ({
      "compactions.jsonl": res.rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "stats.json": JSON.stringify(res.stats, null, 1),
      "totals.json": JSON.stringify({ meta: res.stats.meta, totals: res.totals, dropped: res.stats.dropped, ordinary_decode: res.ordinaryDecode }, null, 1),
      "report.html": await renderPage(page("compaction"), { DATA: { stats: res.stats, rows: res.rows } }),
    }),
    routes: { "/": html((res) => renderPage(page("compaction"), { DATA: { stats: res.stats, rows: res.rows } })) },
  },
};

/** Load, analyze, and render one study. window: { sinceMs, untilMs }. */
export async function run(name, { sinceMs, untilMs }, ctx = {}, { useCache = true } = {}) {
  const study = STUDIES[name];
  if (!study) throw new Error(`unknown study: ${name} (${Object.keys(STUDIES).join(", ")})`);
  const data = await load({ sinceMs, untilMs, use: study.sources, useCache });
  return { study, data, result: study.analyze(data, ctx) };
}
