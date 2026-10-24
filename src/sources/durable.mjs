// Durable source: one pi-durable conversation, read only through its node (D10, K5.I1).
// Contract and rationale: HyperCarrier apps/ampi/docs/durable/reader-design.md.
//
//   node.open ──► fence (newest ID) ──► entries asc (lastId..fence, budgeted pages; oversized → raw chunks)
//        └► watch frames: active-context ranges, bounded docs, revision ──► dirty ──► next refresh
//
// History is the conversation's fork-aware `entries()` sequence. Entry IDs are store-wide and
// ascending in history order, so the last absorbed ID is the incremental checkpoint. A catch-up
// scan starts at that ID inclusively: its first record must be the boundary entry with the same
// bytes (sha256), otherwise the held prefix is shorter or divergent and the reader resets with
// that reason. A restored snapshot passes the same check before it is trusted. The watch only
// invalidates; it never carries history, and nothing is replayed after a reconnect.
//
// The node client is injected; this file never opens a store and never imports pi-durable.
// The Host is configured, never derived from the transport (K5.I3). The index is in memory;
// snapshot() is the caller's persistence seam.
import { createHash } from 'node:crypto';
import { READER_VERSION } from '../record.mjs';
import { expandRanges } from './durable-wire.mjs';
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
  // A stub for an entry past the reader's maxEntryBytes: the body stays on the node.
  if (record.oversized) e.oversized = { bytes: record.oversized.bytes, sha256: record.oversized.sha256, kind: record.kind };
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
      e.kind = 'reset';
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

const iso = (t) => typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : null;
/**
 * The Pi JSONL shape of one durable record, for published readers that take native Pi entries
 * (Rarebit's selector, Find's text mirror). Compatibility only: durableItem stays the semantic
 * mapper, and kinds without a Pi analog become `{ type: 'durable' }`, which those readers skip.
 */
export function piShaped(record) {
  const id = String(record.id);
  const messages = Array.isArray(record.model) ? record.model : [];
  const m = messages[0] ?? {};
  const timestamp = iso(m.timestamp);
  if (record.oversized) return { type: 'durable', id, kind: record.kind, timestamp, oversized: record.oversized };
  switch (record.kind) {
    case 'pi.user': case 'pi.assistant': case 'pi.tool-result':
      return { type: 'message', id, parentId: null, timestamp, message: m };
    case 'pi.compaction':
      return { type: 'compaction', id, parentId: null, timestamp, summary: textOf(m.content) };
    default:
      if (record.kind.startsWith('pi.')) return { type: 'durable', id, kind: record.kind, timestamp };
      if (messages.length) return { type: 'custom_message', id, parentId: null, timestamp, customType: record.kind, content: messagesText(messages), display: true };
      return { type: 'custom', id, parentId: null, timestamp, customType: record.kind, data: record.data ?? null };
  }
}

/** An empty running summary of a durable history; foldSession adds one entry at a time. */
export const emptySessionFold = () => ({ entries: 0, lastId: null, started: null, updated: null, humanTurns: 0, firstAsk: null, lastAsk: null,
  lastReply: null, leader: false, inheritedUntil: null });
const proseOf = (e) => e.blocks?.filter((b) => b.type === 'text').map((b) => b.text).join('\n') ?? null;
/** Adds one ReaderItem to a running summary. `own` is the conversation ID; entries of other conversations are inherited fork history. */
export function foldSession(fold, { entry: e, source }, own) {
  fold.entries++; fold.lastId = e.id;
  if (e.t !== null) { fold.started = fold.started === null ? e.t : Math.min(fold.started, e.t); fold.updated = fold.updated === null ? e.t : Math.max(fold.updated, e.t); }
  if (e.kind === 'human') { fold.humanTurns++; fold.firstAsk ??= proseOf(e); fold.lastAsk = proseOf(e); }
  if (e.kind === 'assistant' && e.blocks.some((b) => b.type === 'text' && b.text.trim())) fold.lastReply = proseOf(e);
  if (e.blocks?.some((b) => b.type === 'toolCall' && LEADER.has(b.name))) fold.leader = true;
  if (own !== undefined && source?.conversationId !== undefined && String(source.conversationId) !== String(own) && e.t !== null)
    fold.inheritedUntil = Math.max(fold.inheritedUntil ?? e.t, e.t);
  return fold;
}

/** SESSION record (src/record.mjs) for a durable conversation, from its history summary, conversation and docs. Role is a provisional inference (K5.I4). */
export function durableSessionRecord({ host, threadId, fold, conversation, docs = {} }) {
  if (!conversation) return null;
  const { storeId } = parseThread(threadId);
  const session = sessionIdOf(threadId);
  const cwd = docs['pi.agent']?.cwd ?? null;
  const parent = conversation.parent ? sessionIdOf(`${storeId}.${conversation.parent.conversationId}`) : null;
  return { reader: READER_VERSION, id: session, host, ref: sessionRef(host, session), harness: HARNESS, session: threadId,
    role: fold.leader ? 'leader' : conversation.owner ? 'worker' : 'solo', parent,
    forkAt: conversation.parent ? entryRef(host, parent, String(conversation.parent.at)) : null,
    owner: conversation.owner ? { session: sessionIdOf(`${storeId}.${conversation.owner.conversationId}`), task: conversation.owner.taskId } : null,
    cwd, scratch: isScratch(cwd), path: null, started: fold.started, updated: fold.updated, archived: false, branch: 'complete',
    humanTurns: fold.humanTurns, resume: null, title: null, firstAsk: fold.firstAsk, lastAsk: fold.lastAsk, lastReply: fold.lastReply };
}

/** A digest of the conversation and docs fields durableSessionRecord reads; a change re-derives the Session. */
export const sessionHeadOf = ({ conversation, docs = {} }) =>
  createHash('sha256').update(JSON.stringify([conversation ?? null, docs?.['pi.agent']?.cwd ?? null])).digest('hex').slice(0, 16);

/** Error from the node or the transport. `code` follows the node protocol. */
const codeOf = (error) => error?.code ?? 'unavailable';
const digest = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
export const SNAPSHOT_FORMAT = 'durable-reader/1';

/**
 * The `write` for exportDurableRecords over an HTTP response: it waits for `drain` when the response
 * buffers, and throws once the client has closed. A response that closed before the write never emits
 * `close` again, so the write checks `destroyed` before and after it starts waiting. `write.signal`
 * aborts when the client closes before the response ends: pass it as the export's `signal`, so an
 * outstanding node read does not hold the export either.
 */
export function responseWriter(res) {
  const gone = () => new Error('The client closed the raw export');
  const abort = new AbortController();
  if (res.destroyed) abort.abort();
  else res.once('close', () => { if (!res.writableFinished) abort.abort(); });
  return Object.assign((chunk) => {
    if (res.destroyed) throw gone();
    if (res.write(chunk)) return undefined;
    return new Promise((resolve, reject) => {
      const done = (error) => { res.off('drain', done); res.off('close', closed); error ? reject(error) : resolve(); };
      const closed = () => done(gone());
      res.once('drain', done); res.once('close', closed);
      if (res.destroyed) closed();
    });
  }, { signal: abort.signal });
}

/** Settle with `p`, or reject with code `aborted` as soon as `signal` aborts; `p` keeps running. */
function abortable(p, signal) {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(Object.assign(new Error('The raw export was aborted'), { code: 'aborted' }));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/**
 * Stream one durable conversation's raw records, in history order, as JSONL to `write`, without
 * holding the history: one wire page at a time, and an oversized body chunk by chunk with its digest
 * checked after the last chunk. A record past `maxEntryBytes` is written as its stub. `start({version})`
 * runs once before the first byte. `write(chunk)` may return a promise, for backpressure. A failure
 * after `start` throws: the caller must end the output as failed, never as complete.
 * `signal` (an AbortSignal, such as the HTTP client's close) ends the export at once, with code
 * `aborted`, even while a node read is outstanding: each read gets `{ signal }` as its second
 * argument, so a node can drop it, and the handle is closed without waiting for the node.
 */
export async function exportDurableRecords({ node, threadId, host, write, start, pageLimit = 100, maxEntryBytes = 64 << 20, signal } = {}) {
  host = checkHost(host);
  parseThread(threadId);
  const opening = node.open({ threadId });
  // An open that answers after the abort still names a handle: close it then.
  if (signal) opening.then(({ handle }) => { if (signal.aborted) node.close({ handle }).catch(() => {}); }, () => {});
  const { handle } = await abortable(opening, signal);
  const read = (op, args) => abortable(node[op](args, signal ? { signal } : undefined), signal);
  let exportId;
  try {
    const { upper } = await read('fence', { handle });
    const version = upper === null ? null : `${READER_VERSION}:${HARNESS}:${host}:${threadId}:${upper}`;
    await start?.({ version });
    let count = 0, bytes = 0;
    const line = async (chunk) => { bytes += chunk.length; await write(chunk); };
    for (let from; upper !== null;) {
      const page = await read('entries', { handle, order: 'ascending', limit: pageLimit, maxEntryId: upper, ...(from === undefined ? {} : { minEntryId: from }) });
      for (const item of page.items) {
        count++;
        if (item.type === 'entry') { await line(Buffer.from(`${JSON.stringify(item.record)}\n`)); continue; }
        if (item.bytes > maxEntryBytes) {
          await line(Buffer.from(`${JSON.stringify({ id: item.id, conversationId: item.conversationId, kind: item.kind, oversized: { bytes: item.bytes, sha256: item.sha256 } })}\n`));
          continue;
        }
        const hash = createHash('sha256');
        exportId = undefined;
        for (let offset = 0; ;) {
          const c = await read('raw', { handle, id: item.id, exportId, offset });
          exportId = c.exportId;
          const part = Buffer.from(c.data, 'base64');
          hash.update(part); offset += part.length;
          await line(part);
          if (c.done) break;
        }
        exportId = undefined;
        if (hash.digest('hex') !== item.sha256) throw Object.assign(new Error(`Entry ${item.id} changed during export`), { code: 'unavailable' });
        await line(Buffer.from('\n'));
      }
      if (!page.more || page.last === null) break;
      from = page.last + 1;
    }
    return { version, count, bytes };
  } finally {
    // Closing the handle releases its export on the node too; after an abort, nothing waits for the node.
    if (signal?.aborted) node.close({ handle }).catch(() => {});
    else {
      if (exportId) await node.cancel({ handle, exportId }).catch(() => {});
      await node.close({ handle }).catch(() => {});
    }
  }
}

/**
 * Open one durable conversation for incremental reading through `node`, one connection of the
 * node's reader service (durable-wire.mjs): open, entries, fence, raw, cancel, watch, close.
 * Nothing is read until refresh(). `onChange` hears watch invalidations. `restore` is a snapshot()
 * from an earlier reader; the first refresh validates it against the node before trusting it.
 * With `retain: false` the reader holds only its checkpoint (last ID, boundary digest, lineage):
 * each refresh returns the raw `records` it absorbed, for a caller that keeps its own disk copy,
 * and page, entry, visit and session have nothing to read. `refresh({ sink })` bounds the refresh
 * itself: see refresh.
 */
export function openDurableSession({ node, threadId, host, pageLimit = 100, extractors = {}, onChange,
  maxEntryBytes = 16 << 20, restore, retain = true } = {}) {
  host = checkHost(host);
  parseThread(threadId);
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_LIMIT) throw new Error(`Page limit must be 1..${MAX_LIMIT}`);
  const session = sessionIdOf(threadId);
  let items, byId, lineage, lastId, boundary;
  const reinit = () => { items = []; byId = new Map(); lineage = undefined; lastId = null; boundary = null; };
  reinit();
  let pendingReset = null; // a reset decided before the first refresh (an incompatible snapshot)
  if (restore) {
    if (restore.format !== SNAPSHOT_FORMAT || restore.reader !== READER_VERSION || restore.host !== host || restore.threadId !== threadId) pendingReset = 'incompatible';
    else {
      items = retain ? restore.items.slice() : []; byId = new Map(items.map((i) => [i.entry.id, i]));
      lineage = restore.lineage; lastId = restore.lastId; boundary = restore.boundary;
    }
  }
  let attachment = null; // { handle, epoch, watch, verified }
  let revision = 0, scanned = -1; // watch revision seen, and the one the last scan absorbed
  let active = [], activeComplete = true, conversation = null, docs = {}, clipped = {};
  let status = 'stale', error = null, closed = false;
  const stats = { received: 0, normalized: 0, scans: 0, resets: 0, rawChunks: 0 };

  const lineageOf = (c) => JSON.stringify({ parent: c?.parent ?? null, owner: c?.owner ?? null });
  function observe(frame) {
    if (frame.conversation) conversation = frame.conversation;
    if (frame.active) { active = expandRanges(frame.active).map(String); activeComplete = frame.active.complete; }
    if (frame.docs) { docs = frame.docs; clipped = frame.clipped ?? {}; }
    revision++;
  }
  function detach() {
    const a = attachment; attachment = null;
    if (!a) return;
    try { a.watch?.stop(); } catch {}
    Promise.resolve().then(() => node.close({ handle: a.handle })).catch(() => {});
  }
  const closedError = () => Object.assign(new Error('Reader is closed'), { code: 'closed' });
  /** After each node answer: a reader closed meanwhile reads nothing more. */
  const live = () => { if (closed) throw closedError(); };
  async function attach() {
    const opened = await node.open({ threadId });
    // close() ran while the open was in flight: it saw no handle to close, so close this one.
    if (closed) { node.close({ handle: opened.handle }).catch(() => {}); throw closedError(); }
    const a = { handle: opened.handle, epoch: opened.epoch, watch: null, verified: false };
    attachment = a;
    observe(opened.frame);
    const watch = await node.watch({ handle: a.handle }, (frame) => {
      if (attachment !== a) return;
      observe(frame);
      if (status === 'ready') status = 'stale';
      onChange?.();
    }, () => { if (attachment === a) { attachment = null; if (status === 'ready') status = 'stale'; onChange?.(); } });
    // A close or a transport end during the watch request detached `a` already; stop the watch it returned.
    if (attachment !== a) { try { watch.stop(); } catch {} live(); throw Object.assign(new Error('The node ended the watch'), { code: 'unavailable' }); }
    a.watch = watch;
  }
  /** An oversized item, reassembled from raw chunks and checked against its digest; a stub past maxEntryBytes. */
  async function fetchRaw(handle, item) {
    if (item.bytes > maxEntryBytes) return { id: item.id, conversationId: item.conversationId, kind: item.kind, oversized: { bytes: item.bytes, sha256: item.sha256 } };
    const parts = [];
    let exportId, offset = 0;
    try {
      for (;;) {
        const c = await node.raw({ handle, id: item.id, exportId, offset });
        live();
        stats.rawChunks++;
        exportId = c.exportId;
        const part = Buffer.from(c.data, 'base64');
        parts.push(part); offset += part.length;
        if (c.done) break;
      }
    } catch (e) {
      // Closing the handle releases its export; only a still-open reader cancels it.
      if (exportId && !closed) node.cancel({ handle, exportId }).catch(() => {});
      throw e;
    }
    const buf = Buffer.concat(parts);
    if (createHash('sha256').update(buf).digest('hex') !== item.sha256) throw Object.assign(new Error(`Entry ${item.id} changed during export`), { code: 'unavailable' });
    return JSON.parse(buf.toString('utf8'));
  }
  /**
   * Read the range a page at a time; `take(records)` absorbs each page before the next fetch, or returns false to stop.
   * A page splits after each oversized body, so the reader holds one page and at most one oversized body.
   */
  async function scan({ minEntryId, maxEntryId }, take) {
    const { handle } = attachment;
    for (let from = minEntryId; ;) {
      const page = await node.entries({ handle, order: 'ascending', limit: pageLimit, maxEntryId, ...(from === undefined ? {} : { minEntryId: from }) });
      live();
      stats.received += page.items.length;
      // An expanded oversized body goes to `take` with the plain records before it, before the next body is fetched.
      let records = [], took = false;
      for (const item of page.items) {
        if (item.type === 'entry') { records.push(item.record); continue; }
        records.push(await fetchRaw(handle, item));
        took = true;
        if ((await take(records)) === false) return false;
        records = [];
      }
      if ((records.length || !took) && (await take(records)) === false) return false;
      if (!page.more || page.last === null) return true;
      from = page.last + 1;
    }
  }
  function absorb(records, fresh) {
    const added = [];
    for (const r of records) {
      if (lastId !== null && r.id <= lastId) continue;
      const parent = lastId === null ? null : String(lastId);
      const item = durableItem(r, { host, threadId, parent, extractors });
      if (r.oversized) item.source.oversized = r.oversized;
      stats.normalized++;
      if (retain) { items.push(item); byId.set(item.entry.id, item); }
      lastId = r.id; boundary = digest(r); added.push(item.entry); fresh.push(r);
    }
    return added;
  }

  async function read({ sink } = {}) {
    if (closed) throw new Error('Reader is closed');
    let reason = pendingReset;
    pendingReset = null;
    const added = [], fresh = [];
    // The sink's next batch replaces its content: after a reset, and first for a reader with no checkpoint.
    let resetDue = reason !== null || lastId === null;
    const drop = (why) => { reinit(); reason ??= why; stats.resets++; added.length = 0; fresh.length = 0; resetDue = true; };
    const toSink = async (records) => {
      try { await sink({ reset: resetDue, records }); }
      catch (e) { throw Object.assign(new Error(`The refresh sink failed: ${e?.message ?? e}`), { code: 'sink_failed', cause: e }); }
      resetDue = false;
      live();
    };
    try {
      if (!attachment) await attach();
      if (lineage !== undefined && lineage !== lineageOf(conversation)) drop('lineage');
      for (let round = 0; ; round++) {
        const seen = revision;
        const { upper } = await node.fence({ handle: attachment.handle });
        live();
        if (lastId !== null && (upper === null || upper < lastId)) drop('shorter');
        if (upper !== null && (upper !== lastId || !attachment.verified)) {
          let first = lastId !== null;
          const take = async (records) => {
            // The held prefix must end in this history's entry: never join it otherwise.
            if (first) { first = false; if (records[0]?.id !== lastId || digest(records[0]) !== boundary) return false; }
            if (!sink) { added.push(...absorb(records, fresh)); return true; }
            const batch = [];
            absorb(records, batch);
            if (batch.length) await toSink(batch);
            return true;
          };
          if (!(await scan({ maxEntryId: upper, ...(lastId === null ? {} : { minEntryId: lastId }) }, take))) {
            drop('divergent');
            await scan({ maxEntryId: upper }, take);
          }
          attachment.verified = true;
        }
        lineage ??= lineageOf(conversation);
        stats.scans++;
        scanned = seen;
        if (revision === seen || round + 1 >= MAX_ROUNDS) break;
      }
      // A history that became empty, or an empty first read, still replaces the sink's content.
      if (sink && resetDue) await toSink([]);
      status = revision === scanned && attachment ? 'ready' : 'stale';
      error = null;
    } catch (e) {
      // A failed sink holds less than this reader absorbed: close it, so the caller reopens from the sink's checkpoint.
      if (codeOf(e) === 'sink_failed') closed = true;
      detach();
      status = codeOf(e) === 'not_found' ? 'not_found' : 'unavailable';
      error = { code: codeOf(e), message: e?.message ?? String(e) };
    }
    const reset = reason !== null;
    // After a reset, `added` and `records` hold the whole new history this refresh read.
    return { reset, ...(reset ? { resetReason: reason } : {}), added: reset && retain ? items.map((i) => i.entry) : added, records: fresh, status, ...(error ? { error } : {}) };
  }

  let queue = Promise.resolve();
  const position = (id) => {
    const i = items.findIndex((x) => x.entry.id === String(id));
    if (i < 0) throw new Error('Entry is not in this Session history');
    return i;
  };
  return {
    host, threadId, ref: sessionRef(host, session),
    /**
     * Catch up to the node's current history. Never throws for node failure: see status and error.
     * With `sink`, each page's absorbed raw records go to `await sink({ reset, records })` before the
     * next page is fetched, and the result holds no records: the refresh keeps at most one page (and one
     * oversized body up to maxEntryBytes) in memory. `reset` asks the sink to replace its content; the
     * checkpoint, snapshot(), ends at the batch the sink receives. A sink that throws closes the reader.
     */
    refresh({ sink } = {}) { const p = queue.then(() => read({ sink })); queue = p.catch(() => {}); return p; },
    /** ready: absorbed the newest observed revision; stale: behind or detached; unavailable / not_found: node failed. */
    status() { return { status, ...(error ? { error } : {}) }; },
    info() {
      return { version: lastId === null ? null : `${READER_VERSION}:${HARNESS}:${host}:${threadId}:${lastId}`,
        count: items.length, branch: 'complete', status, lastId, epoch: attachment?.epoch ?? null, stats: { ...stats } };
    },
    /**
     * The held history as a persistable checkpoint. A reader opened with it as `restore` trusts it only
     * after the node's history still ends a prefix at `lastId` with the same boundary bytes.
     */
    snapshot() {
      if (lastId === null) return null;
      return { format: SNAPSHOT_FORMAT, reader: READER_VERSION, host, threadId, lineage, lastId, boundary,
        items: retain ? JSON.parse(JSON.stringify(items)) : [] };
    },
    /** SESSION record (src/record.mjs). Role is a provisional inference (K5.I4). */
    session() {
      const own = conversation?.id ?? parseThread(threadId).conversationId;
      const fold = items.reduce((f, i) => foldSession(f, i, own), emptySessionFold());
      return durableSessionRecord({ host, threadId, fold, conversation, docs });
    },
    /** The node's conversation descriptor (parent, owner) from the last watch frame. */
    conversation() { return conversation; },
    /** History TranscriptEntries, oldest first. */
    entries() { return items.map((i) => i.entry); },
    /** Entry IDs of the model's active context at the last watch frame; `complete` is false when the node cut its ranges. */
    activeContext() { return [...active]; },
    activeComplete() { return activeComplete; },
    /** Watch documents as the node bounded them, and what it cut from each. */
    docs() { return { docs, clipped }; },
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
