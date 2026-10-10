// Ingest: every adapter's incremental scan -> rows in [sinceMs, untilMs), sorted by time.
// A fallback adapter's row is dropped when another source has a row with the same id,
// or, for a row without an id, the same output tokens with a request start within SAME_MS.

import { codex } from "./adapters/codex.mjs";
import { magpie } from "./adapters/magpie.mjs";
import { pi } from "./adapters/pi.mjs";
import { scan } from "./scan.mjs";

export const ADAPTERS = { pi, codex, magpie };

/** Two sources' clocks for one request start differ by milliseconds; calls with equal output this close are one call. */
export const SAME_MS = 1000;

export async function ingest({ sinceMs, untilMs = Date.now(), adapters = ADAPTERS, agents = Object.keys(adapters), useCache = true, cacheDir } = {}) {
  const rows = [];
  const sources = [];
  const seen = new Set();
  const startsByOut = new Map();
  const near = (r) => (startsByOut.get(r.out) ?? []).some((t) => Math.abs(t - r.t) <= SAME_MS);
  // Primary sources first, so their ids are known before a fallback's rows.
  const order = [...agents].sort((a, b) => !!adapters[a].fallback - !!adapters[b].fallback);
  for (const name of order) {
    const adapter = adapters[name];
    const { index, stats } = await scan(adapter, { sinceMs, useCache, cacheDir });
    const skipped = {};
    let calls = 0;
    for (const e of Object.values(index.files)) {
      for (const [k, n] of Object.entries(e.state.skipped ?? {})) skipped[k] = (skipped[k] ?? 0) + n;
      for (const r of e.rows) {
        if (adapter.fallback && (r.id ? seen.has(r.id) : near(r))) {
          if (r.t >= sinceMs && r.t < untilMs) skipped.inOtherSource = (skipped.inOtherSource ?? 0) + 1;
          continue;
        }
        if (!adapter.fallback) {
          if (r.id) seen.add(r.id);
          if (!startsByOut.has(r.out)) startsByOut.set(r.out, []);
          startsByOut.get(r.out).push(r.t);
        }
        if (r.t >= sinceMs && r.t < untilMs) rows.push(r), calls++;
      }
    }
    sources.push({ adapter: name, calls, skipped, ...stats });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, sources };
}
