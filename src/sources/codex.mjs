// Codex adapter: Codex rollout JSONL (~/.codex/sessions, archived_sessions) -> records.
//
// A rollout times whole items, not stream updates. One model call is rebuilt as:
//
//   last input line ─► first model item starts ─► last model item ends ─► token_usage_record
//   │◄──────── ttft ────────►│◄────────── stream ──────────►│◄─ stall after ─►│
//   t                                                                        end
//
// - Input lines: tool outputs, user and developer messages, turn setup, tool items
//   completing, messages from other agents, and the previous call's token_usage_record.
//   The request goes out right after the last one before the first model item starts:
//   Codex can write an input line a little after the request left, so a later one does
//   not count. Status lines (token_count, sub-agent activity) are not inputs: they can
//   arrive while the call waits.
// - Model items: reasoning, assistant messages, tool calls. item_completed gives
//   started_at_ms and completed_at_ms; other model lines count at their timestamp.
// - Stalls inside an item are not visible, so `stall` is null and the stream window
//   is not trusted for decode speed. Codex logs no cache writes: cacheWrite is null.
// - Calls with no model item before their token_usage_record are compaction requests
//   or aborted calls. A `compacted` line claims its request by compaction_response_id
//   (or, without one, the usage record right before it). That request starts at the
//   last synchronous line before its usage record: item_completed events, other
//   agents' messages, and world state can arrive while it runs.
// - A forked thread replays its parent's compactions before its own first call; those
//   are skipped. Replayed calls keep their response ids, so load() drops the copies.
// - The session role is session_meta's thread_source ("user" is "main" here), or
//   "subagent" when the source names a parent.

import { observe } from "./session-state.mjs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { callKey } from "../record.mjs";

export const CODEX_DIRS = [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];

const HEAD = /^\{"timestamp":"([^"]+)",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const ROLE = /"role":"(\w+)"/;
const ITEM = /"item":\{"type":"(\w+)"/;
const ITEM_TIMES = /"started_at_ms":(\d+),"completed_at_ms":(\d+)\}\}$/;

const MODEL_RESPONSE_ITEMS = new Set(["reasoning", "function_call", "custom_tool_call", "web_search_call", "tool_search_call", "local_shell_call", "image_generation_call"]);
// agent_message is a message from another agent (multi-agent threads), so an input.
const INPUT_RESPONSE_ITEMS = { function_call_output: "tool", custom_tool_call_output: "tool", tool_search_output: "tool", compaction: "compaction", agent_message: "other" };
const MODEL_ITEMS = new Set(["Reasoning", "AgentMessage", "WebSearch"]);
const INPUT_ITEMS = { UserMessage: "user", CommandExecution: "tool", McpToolCall: "tool", FileChange: "tool", Extension: "tool", ImageView: "tool", CollabAgentToolCall: "tool", FunctionCallOutput: "tool", ContextCompaction: "compaction" };
const TURN_EDGES = new Set(["task_started", "task_complete", "turn_aborted"]);
// Lines that can arrive while a request runs. Every other line is synchronous.
const ASYNC = new Set(["token_usage_record", "item_completed", "agent_message", "inter_agent_communication_metadata", "world_state"]);
// A compaction whose request follows one of these started a turn; otherwise it ran mid-turn.
const TURN_START = new Set(["task_started", "user_message", "turn_context", "thread_settings_applied"]);
const RANK = { other: 0, tool: 1, compaction: 2, user: 3 };
const NO_TIMING = { ttft: null, stream: null, stall: null, stalls: null, streamValid: false };

export const codex = {
  name: "codex",
  source: import.meta.url,
  uses: [new URL("../record.mjs", import.meta.url).href],

  async list(dirs = CODEX_DIRS) {
    const out = [];
    for (const dir of dirs) {
      for (const f of await readdir(dir, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (/(^|\/)rollout-[^/]*\.jsonl$/.test(f)) out.push(join(dir, f));
      }
    }
    return out;
  },

  init(path) {
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(path));
    return {
      session: id ? id[1] : basename(path),
      role: null,
      model: null,
      inputs: [], // input-line times since the last call ended
      first: null,
      last: null,
      cause: null,
      userInputAt: null,
      lastCall: null,
      reset: null, // compaction id waiting for the next call
      sync: null, // [t, type, payload type] of the last synchronous line
      held: [], // output-less usage records: [id, t, sync t, sync type, sync payload type, usage]
      usageSeen: false,
      prevType: null,
      after: null, // [compaction id, lines left] waiting for Codex's estimate of the new context
      skipped: { noModel: 0, badOrder: 0, noModelItem: 0, inheritedCompaction: 0, compactionReadAsTurn: 0 },
    };
  },

  line(st, buf, start, end, emit) {
    if (st.reader) {
      let o;
      try { o = JSON.parse(buf.toString("utf8", start, end)); } catch { return; }
      return observe(st, o, emit);
    }
    const head = buf.toString("utf8", start, Math.min(end, start + 300));
    const m = HEAD.exec(head);
    if (!m) return;
    const [, iso, type, sub] = m;
    const ts = Date.parse(iso);
    const prevType = st.prevType;
    st.prevType = type;
    if (st.after && type === "event_msg" && sub === "token_count") {
      const info = JSON.parse(buf.toString("utf8", start, end)).payload.info;
      emit({ kind: "patch", of: "compaction", id: st.after[0], set: { afterEst: info?.last_token_usage?.total_tokens ?? null } });
      st.after = null;
    } else if (st.after && --st.after[1] <= 0) st.after = null;
    if (!ASYNC.has(type) && !ASYNC.has(sub)) st.sync = [ts, type, sub ?? null];

    if (type === "session_meta") {
      // A forked thread copies its parent's session_meta after its own: the first one names this thread.
      if (st.role != null) return;
      const p = JSON.parse(buf.toString("utf8", start, end)).payload ?? {};
      st.session = p.id ?? st.session;
      const role = p.thread_source ?? (p.source && typeof p.source === "object" ? "subagent" : "user");
      st.role = role === "user" ? "main" : role;
      return;
    }
    if (type === "turn_context") {
      const p = JSON.parse(buf.toString("utf8", start, end)).payload;
      st.model = p.model ?? st.model;
      return;
    }
    if (type === "token_usage_record") return usage(st, ts, JSON.parse(buf.toString("utf8", start, end)).payload, emit);
    if (type === "compacted") {
      compacted(st, ts, prevType, JSON.parse(buf.toString("utf8", start, end)).payload, emit);
      return input(st, ts, "compaction");
    }
    if (type === "event_msg" && TURN_EDGES.has(sub)) {
      st.first = st.last = null;
      st.inputs = sub === "task_started" ? [ts] : [];
      if (sub === "task_started") { st.cause = "user"; st.userInputAt = ts; }
      return;
    }
    if (type === "event_msg" && sub === "item_completed") {
      const it = ITEM.exec(head)?.[1];
      if (MODEL_ITEMS.has(it)) {
        const tm = ITEM_TIMES.exec(buf.toString("latin1", Math.max(start, end - 80), end));
        return output(st, tm ? Number(tm[1]) : ts, tm ? Number(tm[2]) : ts);
      }
      if (it in INPUT_ITEMS) {
        input(st, ts, INPUT_ITEMS[it]);
        if (INPUT_ITEMS[it] === 'tool') {
          const p = JSON.parse(buf.toString('utf8', start, end)).payload;
          const item = p.item;
          const a = p.started_at_ms, b = p.completed_at_ms;
          const timed = Number.isFinite(a) && Number.isFinite(b) && b >= a;
          const status = String(item.status ?? '').toLowerCase();
          const outcome = /timed.?out|timeout/.test(status) ? 'timeout' : /cancel|abort/.test(status) ? 'cancelled'
            : item.exit_code != null ? (item.exit_code === 0 ? 'success' : 'failure')
            : status === 'completed' ? 'success' : status === 'failed' ? 'failure' : 'unknown';
          emit({kind:'tool',source:'codex',session:st.session,id:item.id ?? `${it}@${ts}`,call:null,
            name:it === 'CommandExecution' ? 'shell' : it, t:timed?a:ts, end:timed?b:ts,
            duration:timed?b-a:null,timing:timed?'execution-events':'unknown',outcome});
        }
      }
      return;
    }
    if (type === "response_item") {
      if (MODEL_RESPONSE_ITEMS.has(sub)) return output(st, ts, ts);
      if (sub === "message") {
        const role = ROLE.exec(head)?.[1];
        return role === "assistant" ? output(st, ts, ts) : input(st, ts, role === "user" ? "user" : "other");
      }
      if (sub in INPUT_RESPONSE_ITEMS) input(st, ts, INPUT_RESPONSE_ITEMS[sub]);
      return;
    }
    if (type === "world_state") input(st, ts, "other");
  },
};

function input(st, ts, cause) {
  st.inputs.push(ts);
  if (cause === 'user') st.userInputAt = ts;
  if (st.cause == null || RANK[cause] > RANK[st.cause]) st.cause = cause;
}

function output(st, from, to) {
  st.first = st.first == null ? from : Math.min(st.first, from);
  st.last = st.last == null ? to : Math.max(st.last, to);
}

function usage(st, end, p, emit) {
  const { first, last } = st;
  const before = first == null ? [] : st.inputs.filter((x) => x < first);
  const start = before.length ? Math.max(...before) : null;
  // The record ends this call; the next call can start from it.
  st.inputs = [end];
  st.first = st.last = null;
  st.usageSeen = true;
  const u = p.usage ?? {};
  const cached = u.cached_input_tokens ?? 0;
  const id = p.response_id ?? `usage@${end}`;
  const call = {
    kind: "call",
    source: "codex",
    session: st.session,
    role: st.role,
    id,
    responseId: p.response_id ?? null,
    route: `codex/${st.model ?? "unknown"}`,
    input: Math.max(0, (u.input_tokens ?? 0) - cached),
    cacheRead: cached,
    cacheWrite: null,
    cacheWrite1h: null,
    out: u.output_tokens ?? 0,
    reasoning: u.reasoning_output_tokens ?? 0,
    stop: null,
    cost: null,
  };
  // A `compacted` line can claim this record as its request: see compacted().
  const [syncT, syncType, syncSub] = st.sync ?? [end, null, null];
  st.held.push([id, end, syncT, syncType, syncSub, u, first == null ? null : { lastCall: st.lastCall, reset: st.reset, cause: st.cause }]);
  if (st.held.length > 4) st.held.shift();
  if (first == null) {
    // A compaction request, if a `compacted` line claims it; otherwise an aborted call.
    st.skipped.noModelItem++;
    return emit({ ...call, prev: st.lastCall, reset: null, compaction: null, cause: null, purpose: null, t: syncT, end, ...NO_TIMING });
  }
  const turn = { ...call, prev: st.lastCall, reset: st.reset ? "compaction" : null, compaction: st.reset, cause: st.cause, inputAt: st.cause === 'user' ? st.userInputAt : null, purpose: "turn" };
  st.lastCall = id;
  st.reset = null;
  st.cause = null;
  st.userInputAt = null;
  if (!st.model) st.skipped.noModel++;
  if (start == null || !(last >= first && end >= last)) {
    st.skipped.badOrder++;
    return emit({ ...turn, t: start ?? first, end, ...NO_TIMING });
  }
  emit({ ...turn, t: start, end, ttft: first - start, stream: last - first, stall: null, stalls: null, streamValid: false });
}

function compacted(st, ts, prevType, p, emit) {
  // A forked thread replays its parent's compactions before its own first call.
  if (!st.usageSeen) return void st.skipped.inheritedCompaction++;
  const rid = p.compaction_response_id ?? null;
  // By response id, any held record; else the record just before, if it streamed no model item.
  let h = rid ? st.held.find((x) => x[0] === rid) : null;
  if (!h && prevType === "token_usage_record" && st.held.at(-1)?.[6] === null) h = st.held.at(-1);
  const id = rid ?? p.window_id ?? createHash("sha1").update(JSON.stringify(p.replacement_history ?? null)).digest("hex");
  // A compaction request that streamed a reasoning item was read as a turn: undo that.
  const turn = h?.[6];
  if (turn) {
    st.skipped.compactionReadAsTurn++;
    ({ lastCall: st.lastCall, reset: st.reset, cause: st.cause } = turn);
  }
  const rec = {
    kind: "compaction",
    source: "codex",
    session: st.session,
    role: st.role,
    id,
    t: ts,
    prev: st.lastCall,
    method: "codex-remote",
    model: p.resume_metadata?.previous_turn_settings?.model ?? st.model,
    afterEst: null,
    handoff: [],
    handoffStart: null,
    detail: { retainedItems: (p.replacement_history ?? []).length },
  };
  st.reset = id;
  st.after = [id, 7];
  if (!h) return emit({ ...rec, trigger: null, before: null, usage: null, wall: null, calls: [] });
  const [cid, end, syncT, syncType, syncSub, u] = h;
  st.held = st.held.filter((x) => x !== h);
  emit({ kind: "patch", of: "call", id: cid, set: { purpose: "compaction", ...(turn && { prev: turn.lastCall, reset: null, compaction: null, cause: null }) } });
  const tin = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  emit({
    ...rec,
    trigger: TURN_START.has(syncSub) || syncType === "session_meta" ? "turn-start" : "mid-turn",
    before: tin,
    usage: { prompt: tin, input: tin - cached, cacheRead: cached, cacheWrite: u.cache_write_input_tokens ?? null, out: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0 },
    wall: end - syncT,
    calls: [callKey("codex", cid)],
  });
}
