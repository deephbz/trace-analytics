// Durable source: one pi-durable conversation, read only through its node (D10, K5.I1).
// Contract and rationale: HyperCarrier apps/ampi/docs/durable/reader-design.md.
//
//   node.open ──► fence probe (entries desc, 1) ──► entries asc (lastId..fence, cursor pages)
//        └► watch frames: active-context ids, revision ──► dirty ──► next refresh catches up
//
// History is the conversation's fork-aware `entries()` sequence. Entry IDs are store-wide and
// ascending in history order, so the last absorbed ID is the incremental checkpoint. A catch-up
// scan starts at that ID inclusively: its first item must be the boundary entry, otherwise the
// held prefix is unverified and the reader resets. The watch only invalidates; it never carries
// history, and nothing is replayed after a reconnect.
//
// The node client is injected; this file never opens a store and never imports pi-durable.
// The Host is configured, never derived from the transport (K5.I3). The index is in memory.
import { READER_VERSION } from '../record.mjs';
import { checkHost, entryRef, injected, isScratch, sessionRef, textOf } from './session-state.mjs';

export const HARNESS = 'pi-durable';
const LEADER = new Set(['team_create', 'ensure_worker', 'worker_ensure', 'spawn_teammate', 'task_graph_apply']);
const MAX_LIMIT = 400;
const MAX_ROUNDS = 8;

/** `<storeId>.<conversationId>`, the node's thread key. */
export function parseThread(threadId) {
  const dot = typeof threadId === 'string' ? threadId.lastIndexOf('.') : -1;
  if (dot <= 0 || dot === threadId.length - 1 || /[\s/#]/.test(threadId)) throw new Error(`Invalid durable thread id: ${JSON.stringify(threadId)}`);
  return { storeId: threadId.slice(0, dot), conversationId: threadId.slice(dot + 1) };
}
export const sessionIdOf = (threadId) => `${HARNESS}:${threadId}`;

function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
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
const num = (x) => typeof x === 'number' && Number.isFinite(x) ? x : null;
const usageOf = (u) => ({ input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead),
  cacheWrite: num(u.cacheWrite), cost: num(u.cost?.total) ?? num(u.cost) });
const messagesText = (messages) => messages.map((m) => textOf(m?.content)).filter(Boolean).join('\n');

/**
 * Normalize one native EntryRecord into a ReaderItem: { entry, source, semantics }.
 * entry is a TranscriptEntry (src/record.mjs); source keeps durable structure; semantics holds
 * published projections only. `extractors` maps a custom kind to its published text extractor.
 */
export function durableItem(record, { host, threadId, parent = null, extractors = {} }) {
  const { storeId } = parseThread(threadId);
  const session = sessionIdOf(threadId);
  const id = String(record.id);
  const messages = Array.isArray(record.model) ? record.model : [];
  const m = messages[0] ?? {};
  const e = { ref: entryRef(host, session, id), id, parent, t: num(m.timestamp), kind: 'other', name: null };
  const source = { kind: record.kind, entryId: record.id, conversationId: record.conversationId,
    originRef: entryRef(host, sessionIdOf(`${storeId}.${record.conversationId}`), id) };
  for (const key of ['head', 'edits', 'byTaskId']) if (record[key] !== undefined) source[key] = record[key];
  const semantics = {};
  switch (record.kind) {
    case 'pi.user': {
      e.role = 'user'; e.blocks = blocksOf(m.content);
      e.kind = injected(textOf(m.content)) ? 'injected' : 'human';
      break;
    }
    case 'pi.assistant': {
      e.kind = 'assistant'; e.role = 'assistant';
      if (m.model) e.model = m.model;
      if (m.provider) e.provider = m.provider;
      if (m.usage) e.usage = usageOf(m.usage);
      if (typeof m.stopReason === 'string') e.stop = m.stopReason;
      if (typeof m.errorMessage === 'string' && m.errorMessage) e.error = m.errorMessage;
      e.blocks = blocksOf(m.content);
      break;
    }
    case 'pi.tool-result': {
      e.kind = 'tool'; e.role = 'toolResult'; e.name = m.toolName ?? null;
      e.result = { callId: m.toolCallId ?? null, isError: m.isError === true, text: textOf(m.content) };
      if (Array.isArray(record.data?.diagnostics)) semantics.toolDiagnostics = record.data.diagnostics;
      break;
    }
    case 'pi.compaction': {
      e.kind = 'compaction'; e.summary = textOf(m.content);
      semantics.contextBoundary = { type: 'compaction', head: record.head == null ? null : String(record.head), reason: record.data?.reason ?? null };
      break;
    }
    case 'pi.reset': {
      if (messages.length) { e.role = 'user'; e.text = messagesText(messages); }
      semantics.contextBoundary = { type: 'reset', head: id, handoff: messages.length ? e.text : null };
      break;
    }
    case 'pi.system': {
      e.role = 'system';
      const names = (xs) => (Array.isArray(xs) ? xs : []).map((x) => typeof x === 'string' ? x : x?.name ?? null);
      semantics.systemAudit = { toolsAdded: names(m.toolsAdded), toolsRemoved: names(m.toolsRemoved),
        sections: m.sections ?? null, prompt: typeof m.content === 'string' && m.content ? m.content : null };
      break;
    }
    default: {
      if (record.kind.startsWith('pi.')) { source.unknown = true; break; }
      e.customType = record.kind;
      if (record.data !== undefined) source.data = record.data;
      const extract = extractors[record.kind];
      if (messages.length) {
        // An input placed with a custom kind still reaches the model as a message; it is never human input.
        e.kind = 'injected'; e.role = m.role ?? null; e.text = messagesText(messages);
      }
      if (extract) { const text = extract(record); if (typeof text === 'string') e.text = text; }
    }
  }
  return { entry: e, source, semantics };
}

/** Error from the node or the transport. `code` follows the node protocol. */
const codeOf = (error) => error?.code ?? 'unavailable';

/**
 * Open one durable conversation for incremental reading through `node`:
 *   open({threadId}) → {handle, epoch, conversation, activeEntryIds, watchRevision}
 *   entries({handle, order, minEntryId?, maxEntryId?, limit, cursor?}) → {items, next?}
 *   watch({handle}, onFrame, onEnd) → {stop()}; frames {epoch, watchRevision, conversation, activeEntryIds}
 *   close({handle})
 * Nothing is read until refresh(). `onChange` hears watch invalidations.
 */
export function openDurableSession({ node, threadId, host, pageLimit = 100, extractors = {}, onChange } = {}) {
  host = checkHost(host);
  parseThread(threadId);
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_LIMIT) throw new Error(`Page limit must be 1..${MAX_LIMIT}`);
  const session = sessionIdOf(threadId);
  let items, byId, lineage, lastId;
  const reinit = () => { items = []; byId = new Map(); lineage = undefined; lastId = null; };
  reinit();
  let attachment = null; // { handle, epoch, watch }
  let revision = 0, scanned = -1; // watch revision seen, and the one the last scan absorbed
  let active = [], conversation = null, docs = {};
  let status = 'stale', error = null, closed = false;
  const stats = { received: 0, normalized: 0, scans: 0, resets: 0 };

  const sameLineage = (c) => JSON.stringify({ parent: c?.parent ?? null, owner: c?.owner ?? null }) === lineage;
  function observe(frame) {
    if (frame.conversation) conversation = frame.conversation;
    if (Array.isArray(frame.activeEntryIds)) active = frame.activeEntryIds.map(String);
    if (frame.docs) docs = frame.docs;
    revision++;
  }
  function detach() {
    const a = attachment; attachment = null;
    if (!a) return;
    try { a.watch?.stop(); } catch {}
    Promise.resolve().then(() => node.close({ handle: a.handle })).catch(() => {});
  }
  async function attach() {
    const opened = await node.open({ threadId });
    const a = { handle: opened.handle, epoch: opened.epoch, watch: null };
    attachment = a;
    observe(opened);
    a.watch = await node.watch({ handle: a.handle }, (frame) => {
      if (attachment !== a) return;
      observe(frame);
      if (status === 'ready') status = 'stale';
      onChange?.();
    }, () => { if (attachment === a) { attachment = null; if (status === 'ready') status = 'stale'; onChange?.(); } });
  }
  async function scan(query) {
    const out = [];
    let cursor;
    do {
      const page = await node.entries({ handle: attachment.handle, limit: pageLimit, ...query, ...(cursor ? { cursor } : {}) });
      stats.received += page.items.length;
      out.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return out;
  }
  function absorb(records) {
    const added = [];
    for (const r of records) {
      if (lastId !== null && r.id <= lastId) continue;
      const parent = items.length ? items.at(-1).entry.id : null;
      const item = durableItem(r, { host, threadId, parent, extractors });
      stats.normalized++;
      items.push(item); byId.set(item.entry.id, item); lastId = r.id; added.push(item.entry);
    }
    return added;
  }

  async function read() {
    if (closed) throw new Error('Reader is closed');
    let reset = false;
    const added = [];
    try {
      if (!attachment) await attach();
      if (lineage !== undefined && !sameLineage(conversation)) { reinit(); reset = true; stats.resets++; }
      for (let round = 0; ; round++) {
        const seen = revision;
        const newest = await node.entries({ handle: attachment.handle, order: 'descending', limit: 1 });
        const fence = newest.items[0]?.id ?? null;
        if (fence !== null && fence !== lastId) {
          if (lastId !== null && fence < lastId) { reinit(); reset = true; stats.resets++; }
          const records = await scan({ order: 'ascending', maxEntryId: fence, ...(lastId === null ? {} : { minEntryId: lastId }) });
          if (lastId !== null && records[0]?.id !== lastId) {
            // The boundary entry is gone: the held prefix cannot be verified against this history.
            reinit(); reset = true; stats.resets++;
            records.splice(0, records.length, ...await scan({ order: 'ascending', maxEntryId: fence }));
          }
          added.push(...absorb(records));
        } else if (fence === null && lastId !== null) { reinit(); reset = true; stats.resets++; }
        lineage ??= JSON.stringify({ parent: conversation?.parent ?? null, owner: conversation?.owner ?? null });
        stats.scans++;
        scanned = seen;
        if (revision === seen || round + 1 >= MAX_ROUNDS) break;
      }
      status = revision === scanned && attachment ? 'ready' : 'stale';
      error = null;
    } catch (e) {
      detach();
      status = codeOf(e) === 'not_found' ? 'not_found' : 'unavailable';
      error = { code: codeOf(e), message: e?.message ?? String(e) };
    }
    return { reset, added: reset ? items.map((i) => i.entry) : added, status, ...(error ? { error } : {}) };
  }

  let queue = Promise.resolve();
  const position = (id) => {
    const i = items.findIndex((x) => x.entry.id === String(id));
    if (i < 0) throw new Error('Entry is not in this Session history');
    return i;
  };
  return {
    host, threadId, ref: sessionRef(host, session),
    /** Catch up to the node's current history. Never throws for node failure: see status and error. */
    refresh() { const p = queue.then(read); queue = p.catch(() => {}); return p; },
    /** ready: absorbed the newest observed revision; stale: behind or detached; unavailable / not_found: node failed. */
    status() { return { status, ...(error ? { error } : {}) }; },
    info() {
      return { version: lastId === null ? null : `${READER_VERSION}:${HARNESS}:${host}:${threadId}:${lastId}`,
        count: items.length, branch: 'complete', status, lastId, epoch: attachment?.epoch ?? null, stats: { ...stats } };
    },
    /** SESSION record (src/record.mjs). Role is a provisional inference (K5.I4). */
    session() {
      if (!conversation) return null;
      const { storeId } = parseThread(threadId);
      const humans = items.filter((i) => i.entry.kind === 'human');
      const replies = items.filter((i) => i.entry.kind === 'assistant' && i.entry.blocks.some((b) => b.type === 'text' && b.text.trim()));
      const leader = items.some((i) => i.entry.blocks?.some((b) => b.type === 'toolCall' && LEADER.has(b.name)));
      const times = items.map((i) => i.entry.t).filter((t) => t !== null);
      const cwd = docs['pi.agent']?.cwd ?? null;
      const parent = conversation.parent ? sessionIdOf(`${storeId}.${conversation.parent.conversationId}`) : null;
      const prose = (i) => i?.entry.blocks?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? null;
      return { reader: READER_VERSION, id: session, host, ref: sessionRef(host, session), harness: HARNESS, session: threadId,
        role: leader ? 'leader' : conversation.owner ? 'worker' : 'solo', parent,
        forkAt: conversation.parent ? entryRef(host, parent, String(conversation.parent.at)) : null,
        owner: conversation.owner ? { session: sessionIdOf(`${storeId}.${conversation.owner.conversationId}`), task: conversation.owner.taskId } : null,
        cwd, scratch: isScratch(cwd), path: null, started: times.length ? Math.min(...times) : null,
        updated: times.length ? Math.max(...times) : null, archived: false, branch: 'complete', humanTurns: humans.length,
        resume: null, title: null, firstAsk: prose(humans[0]), lastAsk: prose(humans.at(-1)), lastReply: prose(replies.at(-1)) };
    },
    /** History TranscriptEntries, oldest first. */
    entries() { return items.map((i) => i.entry); },
    /** Entry IDs of the model's active context at the last watch frame. */
    activeContext() { return [...active]; },
    page({ before, limit = MAX_LIMIT } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`Page limit must be 1..${MAX_LIMIT}`);
      const end = before == null ? items.length : position(before);
      const start = Math.max(0, end - limit);
      return { entries: items.slice(start, end).map((i) => i.entry), more: start > 0, version: this.info().version, branch: 'complete' };
    },
    entry(id) { return byId.get(String(id))?.entry; },
    item(id) { return byId.get(String(id)); },
    /** Visit ReaderItems in history order, after `after` when given. */
    visit(visitor, { after } = {}) {
      for (let i = after == null ? 0 : position(after) + 1; i < items.length; i++) visitor(items[i], i);
    },
    close() { if (!closed) { closed = true; detach(); } },
  };
}
