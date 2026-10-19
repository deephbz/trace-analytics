// Live transcript of one Pi Session file: incremental TranscriptEntry stream (src/record.mjs).
//
//   refresh() ─► same ino, head intact, size >= offset ─► parse appended complete lines only
//            └► first call, shrank, replaced, new head ──► reparse the whole file, reset
//
// Entry kinds and Session fields come from session-state.mjs observe(), the same code the
// catalog reader runs, so ENTRY records and TranscriptEntry agree. The active branch is
// lineage.mjs activeBranch() from the last appended entry: an entry whose parent is the
// current tip extends it; any other entry moves the tip, and refresh() reports a reset.
//
// The Host is configured (option, TRACE_ANALYTICS_HOST, or "local"), never derived from the
// path, so a byte-for-byte copy of a Session yields the same refs. Image bytes are dropped.
import { open } from 'node:fs/promises';
import { READER_VERSION } from '../record.mjs';
import { activeBranch } from './lineage.mjs';
import { feed } from './scan.mjs';
import { checkHost, entryRef, observe, sessionRecord, sessionState, textOf } from './session-state.mjs';

const HEAD_BYTES = 64;

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b?.type === 'text') out.push({ type: 'text', text: b.text ?? '' });
    else if (b?.type === 'thinking') out.push({ type: 'thinking', text: b.thinking ?? b.text ?? '' });
    else if (b?.type === 'toolCall') out.push({ type: 'toolCall', id: b.id ?? null, name: b.name ?? null, args: b.arguments ?? b.args ?? null });
    else if (b?.type === 'image') out.push({ type: 'image', mimeType: b.mimeType ?? null });
  }
  return out;
}

const usageOf = (u) => ({ input: u.input ?? null, output: u.output ?? null, cacheRead: u.cacheRead ?? null,
  cacheWrite: u.cacheWrite ?? null, cost: u.cost?.total ?? (typeof u.cost === 'number' ? u.cost : null) });

/** TranscriptEntry of a native Pi line o and its ENTRY observation r. */
export function transcriptEntry(o, r, host) {
  const e = { ref: entryRef(host, r.session, r.id), id: r.id, parent: r.parent, t: r.t, kind: r.entryKind, name: r.name };
  if (o.type === 'message') {
    const m = o.message ?? {};
    e.role = m.role ?? null;
    if (m.role === 'assistant') {
      if (m.model) e.model = m.model;
      if (m.provider) e.provider = m.provider;
      if (m.usage) e.usage = usageOf(m.usage);
      // How the turn ended (stop, toolUse, length, error, aborted), and the provider's error text when it failed.
      if (typeof m.stopReason === 'string') e.stop = m.stopReason;
      if (typeof m.errorMessage === 'string' && m.errorMessage) e.error = m.errorMessage;
    }
    if (m.role === 'toolResult') e.result = { callId: m.toolCallId ?? null, isError: m.isError === true, text: textOf(m.content) };
    else e.blocks = blocksOf(m.content);
  } else if (o.type === 'custom_message' || o.type === 'custom') {
    e.customType = o.customType ?? null;
    if (o.type === 'custom_message') e.text = textOf(o.content);
    else if (typeof o.data?.text === 'string') e.text = o.data.text;
  } else if (o.type === 'compaction' || o.type === 'branch_summary') e.summary = o.summary ?? null;
  return e;
}

/** Open a Pi Session file for incremental reading. Nothing is read until refresh(). */
export function openPiSession(path, { host } = {}) {
  host = checkHost(host);
  let file = null; // { ino, size, mtimeMs, offset, head }
  let st, nodes, byId, branch, status;
  const reinit = () => {
    st = { reader: sessionState('pi', path, 'full') };
    nodes = new Map(); // id -> ENTRY observation (tree for activeBranch)
    byId = new Map(); // id -> TranscriptEntry
    branch = []; // active-branch observations, root first
    status = 'complete';
  };
  reinit();

  async function read() {
    const fh = await open(path, 'r');
    try {
      const s = await fh.stat();
      if (file && file.ino === s.ino && file.size === s.size && file.mtimeMs === s.mtimeMs) return { reset: false, added: [] };
      const head = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
      const now = head.subarray(0, bytesRead);
      let reset = !file || file.ino !== s.ino || s.size < file.offset || !now.subarray(0, file.head.length).equals(file.head);
      if (reset) { reinit(); file = { offset: 0 }; }
      const pushed = [];
      file.offset = await feed(fh, file.offset, s.size, (buf, a, b) => {
        let o;
        try { o = JSON.parse(buf.toString('utf8', a, b)); } catch { return; }
        const tip = st.reader.tip;
        let r = null;
        observe(st, o, (x) => { r = x; });
        if (!r) return;
        const seen = nodes.has(r.id);
        nodes.set(r.id, r);
        byId.set(r.id, transcriptEntry(o, r, host));
        if (reset) return;
        if (!seen && (r.parent === tip || branch.length === 0) && (branch.length ? branch.at(-1).id === tip : tip == null)) {
          if (!branch.length && r.parent != null) status = 'partial';
          branch.push(r); pushed.push(r);
        } else reset = true; // the tip moved to another branch
      });
      if (reset) ({ entries: branch, branch: status } = activeBranch([...nodes.values()], st.reader.tip));
      Object.assign(file, { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, head: Buffer.from(now) });
      return { reset, added: (reset ? branch : pushed).map(r => byId.get(r.id)) };
    } finally { await fh.close(); }
  }

  let queue = Promise.resolve();
  return {
    path, host,
    /** Read appended bytes. reset: true means `added` is the whole active branch; replace any held view. */
    refresh() { const p = queue.then(read); queue = p.catch(() => {}); return p; },
    /** SESSION record (src/record.mjs) with host and ref, or null before the Session header is read. */
    session() {
      const s = st.reader;
      if (s.started === null || s.native === null) return null;
      return sessionRecord('pi', s, { entries: branch, branch: status }, { version: READER_VERSION, host, path, text: true }).record;
    },
    /** Active-branch TranscriptEntries, root first. */
    entries() { return branch.map(r => byId.get(r.id)); },
  };
}
