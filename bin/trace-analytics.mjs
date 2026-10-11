#!/usr/bin/env node
// trace-analytics <study> [since] [until] [--out dir] [--no-open] [--prices file] [--no-cache]
//   Prints the study's text report and writes its files to <out>.
// trace-analytics <study> [since] --serve [--port n] [--no-open] [--prices file]
//   Live view: the page reads a result rebuilt on request; `until` is always now.
//
// study: speed | cache-ttl | compaction
// since, until: 14d, 12h, 2026-09-26 (UTC midnight), or ISO time. Defaults: the study's, now.
// --prices: price overrides { "<provider/model>|<model>": { input, output, cacheRead, cacheWrite } }.
// Prices come from the pi extension's catalog snapshot, else ~/.pi/agent/models-store.json + models.json.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_DIR, catalogFromDisk } from "../src/analytics/prices.mjs";
import { run, STUDIES } from "../src/pipeline.mjs";
import { openUrl, serve } from "../src/reports/serve.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function parseTime(s, now) {
  const rel = /^(\d+(?:\.\d+)?)([hd])$/.exec(s);
  if (rel) return now - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) throw new Error(`bad time: ${s}`);
  return t;
}

function codeVersion() {
  try {
    const rev = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "src", "bin"], { encoding: "utf8" }).trim();
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "unversioned";
  }
}

const argv = process.argv.slice(2);
const VALUED = ["--out", "--port", "--prices"];
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const pos = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
const name = pos[0];
if (!STUDIES[name]) {
  console.error(`usage: trace-analytics <${Object.keys(STUDIES).join("|")}> [since] [until] [--out dir] [--serve] [--port n] [--no-open] [--prices file] [--no-cache]`);
  for (const [k, s] of Object.entries(STUDIES)) console.error(`  ${k.padEnd(11)} ${s.title} (default since ${s.defaultSince})`);
  process.exit(2);
}
const study = STUDIES[name];
const sinceArg = pos[1] ?? study.defaultSince;
const ctx = {
  codeVersion: codeVersion(),
  catalog: await catalogFromDisk(CATALOG_DIR),
  overrides: opt("--prices") ? JSON.parse(await readFile(opt("--prices"), "utf8")) : {},
};
const useCache = !argv.includes("--no-cache");

function windowAt(now, untilArg) {
  return { sinceMs: parseTime(sinceArg, now), untilMs: untilArg ? parseTime(untilArg, now) : now };
}
const build = async (window) => (await run(name, window, ctx, { useCache })).result;

if (argv.includes("--serve")) {
  // A relative `since` rolls with the clock.
  const { url } = await serve(() => build(windowAt(Date.now())), study.routes, { port: Number(opt("--port") ?? 0) });
  console.log(`Live view: ${url}  (${name}, window ${sinceArg} to now; Ctrl-C to stop)`);
  if (!argv.includes("--no-open")) openUrl(url);
} else {
  const window = windowAt(Date.now(), pos[2]);
  const result = await build(window);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const out = resolve(opt("--out") ?? join(ROOT, "out", name, `${day(window.sinceMs)}_${day(window.untilMs)}`));
  await mkdir(out, { recursive: true });
  const files = await study.files(result, ctx);
  for (const [f, body] of Object.entries(files)) await writeFile(join(out, f), body);
  console.log(study.text(result, ctx));
  console.log(`\n${Object.keys(files).map((f) => join(out, f)).join("\n")}`);
  if (files["report.html"] && !argv.includes("--no-open")) openUrl(join(out, "report.html"));
}
