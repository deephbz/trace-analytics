#!/usr/bin/env node
// agent-speed [since] [until] [--out dir] [--no-open]
//   Writes <out>/report.json (the artifact) and <out>/report.html (a rendering of it).
// agent-speed [since] --serve [--port n] [--no-open]
//   Live view: the page polls a fresh report; `until` is always now.
// since, until: 14d, 12h, 2026-09-26, or ISO time. Defaults: 14d, now.
// A relative `since` rolls with the clock in the live view.

import { execFile, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "../src/ingest.mjs";
import { renderPage } from "../src/page.mjs";
import { buildReport, textReport } from "../src/report.mjs";
import { serve } from "../src/server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseTime(s, now) {
  const rel = /^(\d+(?:\.\d+)?)([hd])$/.exec(s);
  if (rel) return now - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(t)) throw new Error(`bad time: ${s}`);
  return t;
}

function codeVersion() {
  try {
    const rev = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "src", "bin", "web"], { encoding: "utf8" }).trim();
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "unversioned";
  }
}

const open = (url) => process.platform === "darwin" && execFile("open", [url], () => {});
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const pos = argv.filter((a, i) => !a.startsWith("--") && !["--out", "--port"].includes(argv[i - 1]));
const sinceArg = pos[0] ?? "14d";
const version = codeVersion();

async function build(untilArg) {
  const now = Date.now();
  const sinceMs = parseTime(sinceArg, now);
  const untilMs = untilArg ? parseTime(untilArg, now) : now;
  return buildReport(await ingest({ sinceMs, untilMs }), { sinceMs, untilMs, codeVersion: version });
}

if (argv.includes("--serve")) {
  const { url } = await serve(() => build(), { port: Number(opt("--port") ?? 0) });
  console.log(`Live view: ${url}  (window ${sinceArg} to now; Ctrl-C to stop)`);
  if (!argv.includes("--no-open")) open(url);
} else {
  const rep = await build(pos[1]);
  const day = (iso) => iso.slice(0, 10);
  const out = resolve(opt("--out") ?? join(ROOT, "out", `${day(rep.window.since)}_${day(rep.window.until)}`));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(rep));
  await writeFile(join(out, "report.html"), await renderPage(rep));
  console.log(textReport(rep));
  console.log(`\n${join(out, "report.json")}\n${join(out, "report.html")}`);
  if (!argv.includes("--no-open")) open(join(out, "report.html"));
}
