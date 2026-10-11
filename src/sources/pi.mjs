// Pi adapter: pi session JSONL -> CALL and COMPACTION records (src/record.mjs).
//
// A session file is a tree: each entry names its parentId. lineage.mjs resolves each
// call's prev call, the compaction or branch summary between them, and its cause.
//
// - Call: an assistant message with usage. `message.timestamp` is request start; the
//   entry's `timestamp` is when pi appended the finished message (the response end).
//   An assistant message with zero tokens never reached a model and is skipped.
// - Stream timing: the pi-tps extension writes one `custom/tps` entry after each turn.
//   A pi turn holds one assistant message, so the entry times the nearest call above it.
//   It arrives as a patch. pi-tps measures TTFT from turn start, so it includes pi's own
//   request setup; it keeps no per-update times.
// - Usage: pi logs input, cacheRead, cacheWrite, cacheWrite1h, output, reasoning, cost.
//   Some routes fold cache writes into input and log cacheWrite 0 (openai-codex).
// - `usage` entries: calls outside the conversation (extensions), purpose "side".
// - Compaction: a `compaction` entry. Native: pi's summarizer ran one or two requests and
//   logged their summed usage on the entry, cache writes folded into input; the entry
//   names no model. Blackmagic (details.state "remote_applied"): a remote Codex
//   compaction; details carry its usage without a cache split, latencyMs, and the model.
// - hc-auto-compact: an `auto-compact.handoff` custom message asks the agent for a
//   handoff turn before compaction. Calls after it, up to the compaction, are its handoff.
//   A user message cancels it.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { callKey } from "../record.mjs";
import { at, initPaths, place } from "./lineage.mjs";

export const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const TYPE = /^\{"type":"(\w+)"/;
const HEAD_IDS = /^\{"type":"\w+","id":"([^"]+)","parentId":(?:"([^"]+)"|null)/;
const TAIL_IDS = /"id":"([^"]+)","parentId":(?:"([^"]+)"|null)/;
const ROLE = /"message":\{"role":"(\w+)"/;
const CUSTOM = /"customType":"([^"]+)"/;
const TS = /"timestamp":"([^"]+)"/;
const INPUT_ROLES = { user: "user", bashExecution: "user", toolResult: "tool" };

export const pi = {
  name: "pi",
  source: import.meta.url,
  uses: [new URL("./lineage.mjs", import.meta.url).href, new URL("../record.mjs", import.meta.url).href],

  async list(dir = SESSIONS_DIR) {
    const out = [];
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      for (const f of await readdir(join(dir, d.name)).catch(() => [])) if (f.endsWith(".jsonl")) out.push(join(dir, d.name, f));
    }
    return out;
  },

  init(path) {
    return {
      session: basename(path, ".jsonl").replace(/^.*?Z_/, ""),
      paths: initPaths(),
      routes: [], // [call id, route] of the last calls, for the tps model check
      lastT: null,
      handoff: null, // { start, calls }
      skipped: { noTokens: 0, timingNoCall: 0, timingModelMismatch: 0, timingInvalid: 0 },
    };
  },

  line(st, buf, start, end, emit) {
    const head = buf.toString("utf8", start, Math.min(end, start + 300));
    const type = TYPE.exec(head)?.[1];
    if (!type || type === "session") return;
    let ids = HEAD_IDS.exec(head);
    const tail = ids ? null : buf.toString("utf8", Math.max(start, end - 300), end);
    if (!ids) ids = TAIL_IDS.exec(tail);
    const id = ids?.[1] ?? null;
    const parent = ids?.[2] ?? null;
    const prevT = st.lastT;
    const tsm = TS.exec(head) ?? TS.exec(tail ?? buf.toString("utf8", Math.max(start, end - 300), end));
    const t = tsm ? Date.parse(tsm[1]) : null;
    if (t != null) st.lastT = t;

    if (type === "message") {
      const role = ROLE.exec(head)?.[1];
      if (role === "assistant") return assistant(st, id, parent, JSON.parse(buf.toString("utf8", start, end)), emit);
      if (role === "user") st.handoff = null;
      if (role in INPUT_ROLES) return void place(st.paths, id, parent, "input", INPUT_ROLES[role]);
      return void place(st.paths, id, parent, role === "system" ? null : "input", "other");
    }
    if (type === "custom_message") {
      if (CUSTOM.exec(head)?.[1] === "auto-compact.handoff") st.handoff = { start: t, calls: [] };
      return void place(st.paths, id, parent, "input", "other");
    }
    if (type === "compaction") return compaction(st, id, parent, t, prevT, JSON.parse(buf.toString("utf8", start, end)), emit);
    if (type === "branch_summary") return void place(st.paths, id, parent, "branch");
    if (type === "custom" && CUSTOM.exec(head)?.[1] === "tps") return tps(st, id, parent, JSON.parse(buf.toString("utf8", start, end)), emit);
    if (type === "usage") return side(st, JSON.parse(buf.toString("utf8", start, end)), emit);
    place(st.paths, id, parent, null);
  },
};

function usageOf(u) {
  return {
    input: u.input ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    cacheWrite1h: u.cacheWrite1h ?? 0,
    out: u.output ?? 0,
    // pi omits reasoning when a call has none.
    reasoning: u.reasoning ?? 0,
    cost: u.cost?.total ?? null,
  };
}

const NO_TIMING = { ttft: null, stream: null, stall: null, stalls: null, streamValid: false };

function assistant(st, id, parent, o, emit) {
  const m = o.message;
  const u = m.usage;
  if (!u || !((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0))) {
    if (u) st.skipped.noTokens++;
    return void place(st.paths, id, parent, null);
  }
  const p = place(st.paths, id, parent, "call");
  const done = Date.parse(o.timestamp);
  const started = typeof m.timestamp === "number" ? m.timestamp : null;
  const route = `${m.provider}/${m.model}`;
  st.routes.push([id, route]);
  if (st.routes.length > 64) st.routes.shift();
  st.handoff?.calls.push(callKey("pi", id));
  emit({
    kind: "call",
    source: "pi",
    session: st.session,
    role: null,
    id,
    responseId: m.responseId ?? null,
    prev: p[0],
    reset: p[1],
    compaction: p[2],
    cause: p[3],
    purpose: "turn",
    route,
    // Without a request start, the response end stands in for it and the wall time is unknown.
    t: started ?? done,
    end: started != null ? done : null,
    ...NO_TIMING,
    ...usageOf(u),
    stop: m.stopReason ?? null,
  });
}

function tps(st, id, parent, o, emit) {
  const target = at(st.paths, o.parentId ?? parent)[0];
  place(st.paths, id, parent, null);
  const d = o.data;
  if (!target) return void st.skipped.timingNoCall++;
  if (st.routes.find((r) => r[0] === target)?.[1] !== `${d.model?.provider}/${d.model?.modelId}`) return void st.skipped.timingModelMismatch++;
  const tm = d.timing ?? {};
  if (!(tm.ttftMs > 0) || tm.messageCount !== 1) return void st.skipped.timingInvalid++;
  emit({
    kind: "patch",
    of: "call",
    id: target,
    set: {
      ttft: tm.ttftMs,
      stream: tm.streamMs ?? null,
      stall: tm.stallMs ?? 0,
      stalls: tm.stallCount ?? 0,
      // pi-tps's own guard: at least 5 updates, 1 ms or more between them, pauses under half the window.
      streamValid: d.isPrimaryBranch === true,
    },
  });
}

function side(st, o, emit) {
  const u = o.usage;
  const t = Date.parse(o.timestamp);
  if (!u || !Number.isFinite(t)) return;
  emit({
    kind: "call", source: "pi", session: st.session, role: null, id: o.id ?? `usage@${t}`, responseId: null,
    prev: null, reset: null, compaction: null, cause: null, purpose: "side",
    route: `${o.provider}/${o.model}`, t, end: null, ...NO_TIMING, ...usageOf(u), stop: null,
  });
}

function compaction(st, id, parent, t, prevT, o, emit) {
  const p = place(st.paths, id, parent, "compaction");
  const det = o.details ?? {};
  const handoff = st.handoff;
  st.handoff = null;
  const rec = {
    kind: "compaction",
    source: "pi",
    session: st.session,
    role: null,
    id,
    t,
    prev: p[0],
    trigger: handoff ? "hc-auto-compact" : null,
    before: o.tokensBefore ?? null,
    afterEst: null,
    calls: [],
    handoff: handoff?.calls ?? [],
    handoffStart: handoff?.start ?? null,
  };
  if (det.state === "remote_applied") {
    const u = det.usage ?? {};
    return emit({
      ...rec,
      method: "pi-blackmagic",
      model: det.identity?.model ?? null,
      usage: { prompt: u.input_tokens ?? null, input: null, cacheRead: u.cached_tokens ?? null, cacheWrite: null, out: u.output_tokens ?? null, reasoning: null },
      wall: det.latencyMs ?? null,
      detail: { retention: det.checkpoint?.retention ?? null, artifactChars: det.checkpoint?.length ?? null },
    });
  }
  const u = o.usage;
  emit({
    ...rec,
    method: "pi-native",
    model: null,
    usage: u
      ? { prompt: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, out: u.output ?? 0, reasoning: u.reasoning ?? null }
      : null,
    wall: null,
    detail: { summaryChars: (o.summary ?? "").length, gapMs: prevT != null && t != null ? t - prevT : null },
  });
}
