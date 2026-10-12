// Session and entry semantics shared by the source adapters. Enabled only for the
// reader scan; analytics retain their smaller state. Text never enters a plain index.
import { basename } from 'node:path';

export const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c)
  ? c.filter(x => ['text', 'input_text', 'output_text'].includes(x.type)).map(x => x.text ?? '').join('\n') : '';
// Known harness wrappers only. A human can start a turn with an XML or HTML tag.
export const injected = (s) => !s.trim() || /^(<(?:environment_context|system-reminder|system_reminder|turn_aborted|permissions instructions|user_instructions)(?:\s|>)|# AGENTS\.md|\[PiTeams|Caveat:)/.test(s.trimStart());
const LEADER = new Set(['team_create', 'ensure_worker', 'worker_ensure', 'spawn_teammate', 'task_graph_apply']);
const time = (s) => { const t = typeof s === 'number' ? s : Date.parse(s); return Number.isFinite(t) ? t : null; };

export function sessionState(harness, path, text) {
  return { harness, path, text, native: harness === 'claude' ? basename(path, '.jsonl') : null, cwd: null, parent: null,
    started: null, updated: null, origin: null, title: null, leader: false, worker: false,
    automated: false, archived: harness === 'codex' ? path.includes('/archived_sessions/') : false,
    sequence: 0, tip: null };
}

export function observe(st, o, emit) {
  const s = st.reader;
  if (!s) return;
  const h = s.harness;
  const t = time(o.timestamp);
  if (t !== null) { s.started ??= t; s.updated = Math.max(s.updated ?? t, t); }
  let id, parent = null, kind = 'other', name = null, text = '';
  if (h === 'pi') {
    if (o.type === 'session') {
      s.native = o.id ?? s.native; s.cwd = o.cwd ?? null;
      s.parent = o.parentSession ?? null; s.started = t; return;
    }
    if (o.type === 'session_info' && s.text && o.name) { s.title = o.name.replace(/^\d{8}-/, ''); s.titleTime = t; s.titleEntry = o.id ?? null; }
    id = o.id; parent = o.parentId ?? null;
    if (o.type === 'message') {
      const m = o.message ?? {}; text = textOf(m.content);
      kind = m.role === 'user' ? (injected(text) ? 'injected' : 'human')
        : m.role === 'assistant' ? 'assistant' : m.role === 'toolResult' ? 'tool' : 'other';
      name = m.toolName ?? null;
      if (m.role === 'assistant' && Array.isArray(m.content))
        s.leader ||= m.content.some(x => x.type === 'toolCall' && LEADER.has(x.name));
    } else if (o.type === 'custom_message') {
      kind = 'injected'; text = textOf(o.content);
      s.worker ||= (o.customType ?? '').includes('task-change');
    } else if (o.type === 'compaction') { kind = 'compaction'; text = o.summary ?? ''; }
    else if (o.type === 'branch_summary') { kind = 'branch-summary'; text = o.summary ?? ''; }
  } else if (h === 'claude') {
    s.cwd = o.cwd ?? s.cwd; s.origin = o.entrypoint ?? s.origin;
    s.worker ||= s.path.includes('/subagents/') || o.isSidechain === true;
    s.automated ||= (s.cwd ?? '').includes('magpie') || (s.origin ?? '').startsWith('sdk');
    if (o.type === 'ai-title' && s.text && o.aiTitle) { s.title = o.aiTitle; s.titleTime = t; s.titleEntry = o.uuid ?? null; }
    if (o.agentId) { s.native = o.agentId; s.parent = o.sessionId ?? null; }
    else if (o.sessionId) s.native = o.sessionId;
    id = o.uuid; parent = o.parentUuid ?? null;
    text = textOf(o.message?.content);
    const blocks = o.message?.content;
    const tool = Array.isArray(blocks) ? blocks.find(x => x.type === 'tool_result') : null;
    kind = o.isCompactSummary || o.subtype === 'compact_boundary' ? 'compaction'
      : tool ? 'tool' : o.type === 'user' ? (o.isMeta || injected(text) ? 'injected' : 'human')
      : o.type === 'assistant' ? 'assistant' : 'other';
    name = tool?.name ?? null;
  } else if (h === 'codex') {
    const p = o.payload ?? {};
    if (o.type === 'session_meta') {
      if (s.meta) return;
      s.meta = true; s.native = p.id ?? s.native; s.cwd = p.cwd ?? null;
      s.origin = p.thread_source ?? (typeof p.source === 'object' ? 'subagent' : p.source ?? null);
      const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subagent;
      s.parent = spawn?.parent_thread_id ?? p.parent_thread_id ?? null;
      s.worker = typeof p.source === 'object' || s.origin === 'subagent';
      s.automated = p.source === 'exec' || ['automation', 'agent_created_thread'].includes(s.origin) || p.originator === 'bb';
      s.started = time(p.timestamp) ?? t; return;
    }
    id = p.id ?? p.call_id ?? `line:${s.sequence++}`;
    if (o.type === 'response_item') {
      text = textOf(p.content);
      kind = p.type === 'message' ? (p.role === 'user' ? (injected(text) ? 'injected' : 'human')
        : p.role === 'assistant' ? 'assistant' : 'injected')
        : /_output$/.test(p.type ?? '') ? 'tool' : 'other';
      name = p.name ?? null;
      if (p.role === 'user' && !s.firstUser) {
        s.firstUser = true;
        s.worker ||= /^\s*(You are Worker|Controlled BB plugin test)/.test(text);
        s.automated ||= text.startsWith('Write a concise human re-entry summary');
      }
    } else if (o.type === 'compacted') { kind = 'compaction'; text = p.message ?? ''; }
    // event_msg user_message repeats response_item and must not create a second human turn.
  }
  if (id == null || s.native == null) return;
  s.tip = id;
  const r = { kind: 'entry', session: `${h}:${s.native}`, id, parent, t, entryKind: kind, name };
  if (s.text) r.text = kind === 'tool' && s.text !== 'full' ? '' : text;
  emit(r);
}
