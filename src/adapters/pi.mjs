// Pi adapter: pi session JSONL -> model-call rows (see ROW in metrics.mjs).
//
// The pi-tps extension writes one `custom/tps` entry after each turn. A pi turn holds
// one assistant message, so the entry describes one model call. The entry carries
// timing; its assistant message carries usage, the request start (message.timestamp),
// and the response end (the entry's timestamp). The join walks parentId from the tps
// entry to the nearest assistant message, across tool results.
//
// Only assistant and tps lines are parsed. Every other line is read for its id and
// parentId alone. The state keeps the last RECENT entries, enough for a turn's chain.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const RECENT = 512;
const HEAD = /^\{"type":"(\w+)","id":"([^"]+)","parentId":(?:"([^"]+)"|null)/;
const TAIL_IDS = /"id":"([^"]+)","parentId":(?:"([^"]+)"|null)/;

export const pi = {
  name: "pi",
  source: import.meta.url,

  async list(dir = SESSIONS_DIR) {
    const out = [];
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      for (const f of await readdir(join(dir, d.name)).catch(() => [])) if (f.endsWith(".jsonl")) out.push(join(dir, d.name, f));
    }
    return out;
  },

  init(path) {
    // nodes: [id, parent, assistant | null], oldest first
    return { session: basename(path, ".jsonl").replace(/^.*?Z_/, ""), nodes: [], skipped: { noMessage: 0, modelMismatch: 0, noTiming: 0 } };
  },

  line(st, buf, start, end, emit) {
    const head = buf.toString("utf8", start, Math.min(end, start + 160));
    if (head.startsWith('{"type":"custom","customType":"tps"')) return tps(st, JSON.parse(buf.toString("utf8", start, end)), emit);
    let m = HEAD.exec(head);
    let assistant = null;
    if (m && m[1] === "message" && head.includes('"message":{"role":"assistant"')) {
      const o = JSON.parse(buf.toString("utf8", start, end));
      const msg = o.message;
      if (msg.usage) {
        const u = msg.usage;
        assistant = {
          provider: msg.provider, model: msg.model, stop: msg.stopReason ?? null, id: msg.responseId ?? null,
          t: typeof msg.timestamp === "number" ? msg.timestamp : null, end: Date.parse(o.timestamp),
          input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0, reasoning: u.reasoning ?? 0,
        };
      }
    }
    if (!m) {
      // Entries such as custom ones put id and parentId last.
      const t = TAIL_IDS.exec(buf.toString("utf8", Math.max(start, end - 200), end));
      if (!t) return;
      m = [null, null, t[1], t[2]];
    }
    remember(st, m[2], m[3] ?? null, assistant);
  },
};

function remember(st, id, parent, assistant) {
  st.nodes.push([id, parent, assistant]);
  if (st.nodes.length > RECENT) st.nodes.splice(0, st.nodes.length - RECENT);
}

function tps(st, o, emit) {
  remember(st, o.id, o.parentId ?? null, null);
  const byId = new Map(st.nodes.map((n) => [n[0], n]));
  let m = null;
  for (let n = byId.get(o.parentId); n; n = byId.get(n[1])) {
    if (n[2]) {
      m = n[2];
      break;
    }
  }
  const d = o.data;
  if (!m) return void st.skipped.noMessage++;
  if (m.provider !== d.model?.provider || m.model !== d.model?.modelId) return void st.skipped.modelMismatch++;
  const tm = d.timing ?? {};
  if (!(tm.ttftMs > 0) || tm.messageCount !== 1) return void st.skipped.noTiming++;
  emit({
    t: m.t ?? m.end,
    // The message's timestamp is set at request start; its entry's when pi appends the finished message.
    wall: m.t != null && m.end > m.t ? m.end - m.t : null,
    agent: "pi",
    session: st.session,
    route: `${m.provider}/${m.model}`,
    id: m.id ?? null,
    uncached: m.input + m.cacheWrite,
    cached: m.cacheRead,
    out: m.output,
    reasoning: m.reasoning,
    stop: m.stop,
    ttft: tm.ttftMs,
    stream: tm.streamMs ?? null,
    stall: tm.stallMs ?? 0,
    stalls: tm.stallCount ?? 0,
    // pi-tps's own guard: at least 5 updates, 1 ms or more between them, pauses under half the window.
    streamValid: d.isPrimaryBranch === true,
  });
}
