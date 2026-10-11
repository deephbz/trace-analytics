// Load: every source's incremental scan -> one set of CALL and COMPACTION records.
//
//   scan per source ─► apply patches per file ─► drop copies ─► drop ledger calls a session
//   source has ─► link pi's native compaction requests in the ledger to their compaction
//
// The result holds every record of the files modified since sinceMs, also those before
// the window, so that lineage joins (a call's prev, a compaction's next call) resolve.
// Analytics choose their population inside `window`.

import { callKey } from "../record.mjs";
import { claude } from "./claude.mjs";
import { codex } from "./codex.mjs";
import { magpie } from "./magpie.mjs";
import { pi } from "./pi.mjs";
import { scan } from "./scan.mjs";

export const SOURCES = { pi, codex, claude, magpie };

/** Two sources' clocks for one request start differ by milliseconds; calls with equal output this close are one call. */
export const SAME_MS = 1000;

/** pi's native compaction runs one or two summarizer requests; they end this close to the compaction entry. */
const SUMMARY_BEFORE_MS = 300_000;
const SUMMARY_AFTER_MS = 10_000;

const callIdentity = (c) => `${c.source}|${c.responseId ?? `${c.id}@${c.t}`}`;
const compactionIdentity = (c) => `${c.source}|${c.id}@${c.t}`;

/** Records of one file with its patches applied. Copies, so the cached records stay as read. */
function resolve(records) {
  const out = [];
  const byId = { call: new Map(), compaction: new Map() };
  for (const r of records) {
    if (r.kind !== "patch") {
      const x = { ...r };
      byId[r.kind].set(r.id, x);
      out.push(x);
      continue;
    }
    const x = byId[r.of].get(r.id);
    if (!x) continue;
    for (const [k, v] of Object.entries(r.set)) x[k] = k === "detail" ? { ...x.detail, ...v } : v;
  }
  return out;
}

export async function load({ sinceMs, untilMs = Date.now(), sources = SOURCES, use = Object.keys(sources), useCache = true, cacheDir } = {}) {
  const window = { sinceMs, untilMs };
  const inWindow = (r) => r.t >= sinceMs && r.t < untilMs;
  const calls = [];
  const compactions = [];
  const coverage = [];
  const seen = new Set();
  const ids = new Set();
  const startsByOut = new Map();
  const near = (c) => (startsByOut.get(c.out) ?? []).some((t) => Math.abs(t - c.t) <= SAME_MS);
  // Session sources first, so their calls are known before the ledger's.
  const order = [...use].sort((a, b) => !!sources[a].fallback - !!sources[b].fallback);
  for (const name of order) {
    const adapter = sources[name];
    const { files, stats } = await scan(adapter, { sinceMs, useCache, cacheDir });
    const cov = { source: name, ...stats, skipped: {}, calls: 0, compactions: 0, copies: 0, inOtherSource: 0 };
    for (const [, e] of files) {
      for (const [k, n] of Object.entries(e.state.skipped ?? {})) cov.skipped[k] = (cov.skipped[k] ?? 0) + n;
      for (const r of resolve(e.records)) {
        const identity = r.kind === "call" ? callIdentity(r) : compactionIdentity(r);
        if (seen.has(identity)) {
          if (inWindow(r)) cov.copies++;
          continue;
        }
        seen.add(identity);
        if (r.kind === "compaction") {
          compactions.push(r);
          if (inWindow(r)) cov.compactions++;
          continue;
        }
        if (adapter.fallback && (r.responseId ? ids.has(r.responseId) : near(r))) {
          if (inWindow(r)) cov.inOtherSource++;
          continue;
        }
        if (!adapter.fallback) {
          if (r.responseId) ids.add(r.responseId);
          if (!startsByOut.has(r.out)) startsByOut.set(r.out, []);
          startsByOut.get(r.out).push(r.t);
        }
        calls.push(r);
        if (inWindow(r)) cov.calls++;
      }
    }
    coverage.push(cov);
  }
  calls.sort((a, b) => a.t - b.t);
  compactions.sort((a, b) => a.t - b.t);
  linkSummaryRequests(calls, compactions);
  return { window, calls, compactions, coverage };
}

/**
 * pi's native compaction logs the summed usage of its one or two summarizer requests.
 * Through Magpie, each request has a ledger call. Link the ledger calls whose output
 * equals the logged output, alone or as a pair, and that end just before the entry.
 */
function linkSummaryRequests(calls, compactions) {
  const ledger = calls.filter((c) => c.source === "magpie" && c.out > 0).sort((a, b) => a.end - b.end);
  const used = new Set();
  for (const k of compactions) {
    const out = k.usage?.out;
    if (k.method !== "pi-native" || !out) continue;
    const cand = ledger.filter((c) => !used.has(c) && c.end - k.t >= -SUMMARY_BEFORE_MS && c.end - k.t <= SUMMARY_AFTER_MS);
    let hit = cand.find((c) => c.out === out);
    let found = hit ? [hit] : null;
    for (let a = 0; !found && a < cand.length; a++) {
      for (let b = a + 1; b < cand.length; b++) if (cand[a].out + cand[b].out === out) (found = [cand[a], cand[b]]), (b = cand.length);
    }
    if (!found) continue;
    for (const c of found) {
      used.add(c);
      c.purpose = "compaction";
    }
    k.calls = found.map((c) => callKey(c.source, c.id));
  }
}
