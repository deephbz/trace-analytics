// Pi extension: /ttl-backtest [since] [until] [--prices file] [--no-serve] [--no-open]
// Runs the cache-ttl study with the live model registry's prices, and snapshots that
// catalog so the CLI (bin/trace-analytics.mjs) prices the same way offline.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_DIR, catalogFromRegistry } from "./analytics/prices.mjs";
import { run } from "./pipeline.mjs";
import { openUrl, serve } from "./reports/serve.mjs";

function parseTime(v, now) {
  const rel = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(v);
  if (rel) return now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[rel[2]];
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw new Error(`Bad time: ${v}`);
  return t;
}

async function parseArgs(s) {
  const argv = (s.match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, ""));
  const pos = [];
  const o = { serve: true, open: true, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prices") o.overrides = JSON.parse(await readFile(argv[++i], "utf8"));
    else if (argv[i] === "--no-serve") o.serve = false;
    else if (argv[i] === "--no-open") o.open = false;
    else pos.push(argv[i]);
  }
  const now = Date.now();
  o.window = { sinceMs: parseTime(pos[0] ?? "7d", now), untilMs: pos[1] ? parseTime(pos[1], now) : now };
  return o;
}

export default function traceAnalytics(pi) {
  let active = null;
  const close = () => {
    active?.server.close();
    active = null;
  };

  pi.on("session_shutdown", close);

  pi.registerCommand("ttl-backtest", {
    description: "Backtest prompt-cache TTL strategies against local session usage",
    handler: async (args, ctx) => {
      let o;
      try {
        o = await parseArgs(args ?? "");
      } catch (e) {
        return ctx.ui.notify(String(e.message ?? e), "error");
      }
      const catalog = { models: catalogFromRegistry(ctx.modelRegistry), source: "pi model registry" };
      await mkdir(CATALOG_DIR, { recursive: true });
      await writeFile(join(CATALOG_DIR, "catalog.json"), JSON.stringify({ savedAt: new Date().toISOString(), models: catalog.models }));
      const { study, result } = await run("cache-ttl", o.window, { catalog, overrides: o.overrides });
      let text = study.text(result);
      if (o.serve) {
        close();
        active = await serve(async () => result, study.routes);
        text += `\n\nWeb view: ${active.url}`;
        if (o.open) openUrl(active.url);
      }
      ctx.ui.notify(text, "info");
    },
  });
}
