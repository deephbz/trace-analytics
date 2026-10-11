// Claude Code adapter: ~/.claude/projects/<project>/<session>.jsonl -> records.
//
// - Entries form a tree through uuid and parentUuid; lineage.mjs resolves paths.
// - Call: one assistant message. Claude Code writes one entry per content block, all
//   with the message id; each repeats the usage, and the last one holds the final
//   output count. The first entry emits the call; later ones patch its end and usage.
//   Request start is the last `user` entry (prompt or tool result) before the message,
//   in file order. There is no stream timing: ttft is null.
// - Usage: input_tokens, cache_read_input_tokens, cache_creation_input_tokens, and its
//   1-hour part. No reasoning count, no cost. The model is not prefixed by a provider.
// - Compaction: a `compact_boundary` system entry with compactMetadata (trigger,
//   preTokens, postTokens, durationMs). The summarizer request's usage is not logged.
//   The summary arrives within the next entries as a user entry with isCompactSummary.
// - A resumed session copies earlier entries into its new file; load() drops the copies.
// - Magpie's Claude subscription bridge drives Claude Code as transport for other agents'
//   calls (`*magpie-c*` project dirs). Those files are left out: the gateway ledger has
//   the calls. Subagent transcripts (<session>/subagents/) are not read yet.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { initPaths, place } from "./lineage.mjs";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const NO_TIMING = { ttft: null, stream: null, stall: null, stalls: null, streamValid: false };

export const claude = {
  name: "claude",
  source: import.meta.url,
  uses: [new URL("./lineage.mjs", import.meta.url).href],

  async list(dir = PROJECTS_DIR) {
    const out = [];
    let bridge = 0;
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      for (const f of await readdir(join(dir, d.name)).catch(() => [])) {
        if (!f.endsWith(".jsonl")) continue;
        if (d.name.includes("magpie-c")) bridge++;
        else out.push(join(dir, d.name, f));
      }
    }
    out.excluded = { magpieBridge: bridge };
    return out;
  },

  init(path) {
    return { session: basename(path, ".jsonl"), paths: initPaths(), lastInput: null, lastCall: null, open: null, after: null, skipped: { synthetic: 0 } };
  },

  line(st, buf, start, end, emit) {
    let o;
    try {
      o = JSON.parse(buf.toString("utf8", start, end));
    } catch {
      return;
    }
    const t = o.timestamp ? Date.parse(o.timestamp) : null;
    if (st.after && o.isCompactSummary) {
      emit({ kind: "patch", of: "compaction", id: st.after[0], set: { detail: { summaryChars: textLength(o.message?.content) } } });
      st.after = null;
    } else if (st.after && --st.after[1] <= 0) st.after = null;

    if (o.type === "user") {
      st.lastInput = t;
      st.open = null;
      return void place(st.paths, o.uuid, o.parentUuid, "input", causeOf(o));
    }
    if (o.type === "assistant") return assistant(st, o, t, emit);
    if (o.type === "system" && o.subtype === "compact_boundary") return boundary(st, o, t, emit);
    if (o.uuid) place(st.paths, o.uuid, o.parentUuid, null);
  },
};

function causeOf(o) {
  if (o.isCompactSummary) return "compaction";
  if (o.isMeta) return "other";
  const c = o.message?.content;
  if (typeof c === "string" || (Array.isArray(c) && c.some((x) => x.type === "text"))) return "user";
  if (Array.isArray(c) && c.some((x) => x.type === "tool_result")) return "tool";
  return "other";
}

function textLength(c) {
  if (typeof c === "string") return c.length;
  return Array.isArray(c) ? c.reduce((n, x) => n + (x.type === "text" ? x.text.length : 0), 0) : 0;
}

function usageOf(u = {}) {
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? null,
    out: u.output_tokens ?? 0,
  };
}

function assistant(st, o, t, emit) {
  const m = o.message ?? {};
  if (!m.id || m.model === "<synthetic>") {
    if (m.model === "<synthetic>") st.skipped.synthetic++;
    return void place(st.paths, o.uuid, o.parentUuid, null);
  }
  const p = place(st.paths, o.uuid, o.parentUuid, "call", m.id);
  if (st.open === m.id) return emit({ kind: "patch", of: "call", id: m.id, set: { end: t, ...usageOf(m.usage), stop: m.stop_reason ?? null } });
  st.open = m.id;
  st.lastCall = m.id;
  emit({
    kind: "call",
    source: "claude",
    session: st.session,
    role: o.isSidechain ? "subagent" : "main",
    id: m.id,
    responseId: m.id,
    prev: p[0],
    reset: p[1],
    compaction: p[2],
    cause: p[3],
    purpose: "turn",
    route: `claude/${m.model}`,
    t: st.lastInput ?? t,
    end: t,
    ...NO_TIMING,
    ...usageOf(m.usage),
    reasoning: null,
    stop: m.stop_reason ?? null,
    cost: null,
  });
}

function boundary(st, o, t, emit) {
  const p = place(st.paths, o.uuid, o.logicalParentUuid ?? o.parentUuid, "compaction");
  st.open = null;
  const cm = o.compactMetadata ?? {};
  st.after = [o.uuid, 5];
  emit({
    kind: "compaction",
    source: "claude",
    session: st.session,
    role: o.isSidechain ? "subagent" : "main",
    id: o.uuid,
    t,
    prev: p[0] ?? st.lastCall,
    method: "claude-summary",
    trigger: cm.trigger ?? null,
    model: null,
    before: cm.preTokens ?? null,
    afterEst: cm.postTokens ?? null,
    usage: null,
    wall: cm.durationMs ?? null,
    calls: [],
    handoff: [],
    handoffStart: null,
    detail: { summaryChars: null },
  });
}

