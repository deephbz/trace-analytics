// Codex adapter: Codex rollout JSONL (~/.codex/sessions, archived_sessions) -> rows.
//
// A rollout times whole items, not stream updates. One model call is rebuilt as:
//
//   last input line ─► first model item starts ─► last model item ends ─► token_usage_record
//   │◄──────── ttft ────────►│◄────────── stream ──────────►│◄─ stall after ─►│
//   t                                                                        t + wall
//
// - Input lines: tool outputs, user and developer messages, turn setup, tool items
//   completing, messages from other agents, and the previous call's token_usage_record. The request goes out
//   right after the last one before the first model item starts: Codex can write
//   an input line a little after the request left, so a later one does not count.
//   Status lines (token_count, sub-agent activity) are not inputs: they can arrive
//   while the call waits.
// - Model items: reasoning, assistant messages, tool calls. item_completed gives
//   started_at_ms and completed_at_ms; other model lines count at their timestamp.
// - Stalls inside an item are not visible, so `stall` is null and the stream window
//   is not trusted for decode speed.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CODEX_DIRS = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];

const HEAD = /^\{"timestamp":"([^"]+)",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const ROLE = /"role":"(\w+)"/;
const ITEM = /"item":\{"type":"(\w+)"/;
const ITEM_TIMES = /"started_at_ms":(\d+),"completed_at_ms":(\d+)\}\}$/;

const MODEL_RESPONSE_ITEMS = new Set(["reasoning", "function_call", "custom_tool_call", "web_search_call", "tool_search_call", "local_shell_call", "image_generation_call"]);
// agent_message is a message from another agent (multi-agent threads), so an input.
const INPUT_RESPONSE_ITEMS = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output", "compaction", "agent_message"]);
const MODEL_ITEMS = new Set(["Reasoning", "AgentMessage", "WebSearch"]);
const INPUT_ITEMS = new Set(["UserMessage", "CommandExecution", "McpToolCall", "FileChange", "Extension", "ImageView", "CollabAgentToolCall", "FunctionCallOutput", "ContextCompaction"]);
const TURN_EDGES = new Set(["task_started", "task_complete", "turn_aborted"]);

export const codex = {
  name: "codex",
  source: import.meta.url,

  async list(dirs = CODEX_DIRS) {
    const out = [];
    for (const dir of dirs) {
      for (const f of await readdir(dir, { recursive: true }).catch(() => [])) {
        if (/(^|\/)rollout-[^/]*\.jsonl$/.test(f)) out.push(join(dir, f));
      }
    }
    return out;
  },

  init(path) {
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path));
    // inputs: input-line times since the last call ended
    return { session: id ? id[1] : basename(path), model: null, inputs: [], first: null, last: null, skipped: { noModel: 0, noOutput: 0, badOrder: 0 } };
  },

  line(st, buf, start, end, emit) {
    const head = buf.toString("utf8", start, Math.min(end, start + 300));
    const m = HEAD.exec(head);
    if (!m) return;
    const [, iso, type, sub] = m;
    const ts = Date.parse(iso);

    if (type === "turn_context") {
      const p = JSON.parse(buf.toString("utf8", start, end)).payload;
      st.model = p.model ?? st.model;
      return;
    }
    if (type === "token_usage_record") return call(st, ts, JSON.parse(buf.toString("utf8", start, end)).payload, emit);
    if (type === "event_msg" && TURN_EDGES.has(sub)) {
      st.first = st.last = null;
      st.inputs = sub === "task_started" ? [ts] : [];
      return;
    }
    if (type === "event_msg" && sub === "item_completed") {
      const it = ITEM.exec(head)?.[1];
      if (MODEL_ITEMS.has(it)) {
        const tm = ITEM_TIMES.exec(buf.toString("latin1", Math.max(start, end - 80), end));
        return output(st, tm ? Number(tm[1]) : ts, tm ? Number(tm[2]) : ts);
      }
      if (INPUT_ITEMS.has(it)) input(st, ts);
      return;
    }
    if (type === "response_item") {
      if (MODEL_RESPONSE_ITEMS.has(sub)) return output(st, ts, ts);
      if (sub === "message") return ROLE.exec(head)?.[1] === "assistant" ? output(st, ts, ts) : input(st, ts);
      if (INPUT_RESPONSE_ITEMS.has(sub)) input(st, ts);
      return;
    }
    if (type === "compacted" || type === "world_state") input(st, ts);
  },
};

function input(st, ts) {
  st.inputs.push(ts);
}

function output(st, from, to) {
  st.first = st.first == null ? from : Math.min(st.first, from);
  st.last = st.last == null ? to : Math.max(st.last, to);
}

function call(st, end, p, emit) {
  const { first, last } = st;
  const before = first == null ? [] : st.inputs.filter((x) => x < first);
  const start = before.length ? Math.max(...before) : null;
  // The record ends this call; the next call can start from it.
  st.inputs = [end];
  st.first = st.last = null;
  if (first == null) return void st.skipped.noOutput++;
  if (!st.model) return void st.skipped.noModel++;
  if (start == null || !(last >= first && end >= last)) return void st.skipped.badOrder++;
  const u = p.usage ?? {};
  const cached = u.cached_input_tokens ?? 0;
  emit({
    t: start,
    wall: end - start,
    agent: "codex",
    session: st.session,
    route: `codex/${st.model}`,
    uncached: Math.max(0, (u.input_tokens ?? 0) - cached),
    cached,
    out: u.output_tokens ?? 0,
    reasoning: u.reasoning_output_tokens ?? 0,
    stop: null,
    ttft: first - start,
    stream: last - first,
    stall: null,
    stalls: null,
    streamValid: false,
  });
}
