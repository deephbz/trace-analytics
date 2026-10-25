// Node-side durable reader service: the native reader wire (reader-design.md "Node read API").
// The AmPi node serves it; the durable source (durable.mjs) is its only client.
//
//   connection ─ open ──► handle (bound to this connection) + first watch frame
//                         ├ entries  budgeted page of PageItems, continued by entry ID
//                         ├ fence    newest history ID and the watch revision it was read at
//                         ├ raw      byte chunks of one oversized entry; cancel releases them
//                         └ watch    bounded frames: conversation, active-context ranges, allowed docs
//              disconnect ──► closes every handle, watch, and export of the connection
//
// The service reads through a public pi-durable Conversation (`entries`, `watch`) that the node
// resolves. It never opens a store and never imports pi-durable. Every limit below is a bound on
// what one request encodes; the values are provisional until the node concurrency run measures them.
import { createHash, randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({
  /** Encoded bytes of one entries page (all items together). */
  pageBytes: 1 << 20,
  /** An entry whose UTF-8 JSON is larger than this travels as an `oversized` item and then as raw chunks. */
  entryBytes: 256 << 10,
  /**
   * Records fetched from the store per sub-page. pi-durable 1.4.0 materializes whole records, so one
   * sub-page holds subPage × the largest record (measured: about 4× its JSON size transiently). After an
   * oversized record the page continues one record at a time.
   */
  subPage: 16,
  /** Most items in one page. */
  pageItems: 400,
  /** Bytes of one raw chunk before base64. */
  chunkBytes: 256 << 10,
  /** Largest entry the node exports at all. */
  exportBytes: 64 << 20,
  /** Most active-context ID ranges in one watch frame. */
  activeRanges: 1024,
  /** Per-document watch bounds: longest string kept, longest array kept, which end survives, whole-document cap. */
  docs: {
    'pi.live': { stringBytes: 16 << 10, arrayItems: 64, keep: 'tail', docBytes: 128 << 10 },
    'pi.inbox': { stringBytes: 4 << 10, arrayItems: 20, keep: 'head', docBytes: 64 << 10 },
    'pi.agent': { stringBytes: 4 << 10, arrayItems: 64, keep: 'head', docBytes: 16 << 10 },
    'pi.usage': { stringBytes: 1 << 10, arrayItems: 256, keep: 'head', docBytes: 64 << 10 },
  },
});

/** Error with a wire code: bad_request, not_found, expired_handle, cancelled, too_large, disconnected. */
export class ReaderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ReaderError(code, message); };
/** Digest of a Buffer, or of a string's UTF-8 bytes without a Buffer copy of them. */
const sha256 = (data) => createHash('sha256').update(data, 'utf8').digest('hex');
const isId = (x) => Number.isSafeInteger(x) && x >= 0;

/** Encode one record once; size and digest come from the same bytes. */
function encode(record) {
  const buf = Buffer.from(JSON.stringify(record), 'utf8');
  return { buf, bytes: buf.length };
}

/** Cut a string to at most `max` UTF-8 bytes from the kept end, never inside a code point. */
export function clipString(s, max, keep = 'head') {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return { text: s, omitted: 0 };
  let cut;
  if (keep === 'tail') {
    cut = buf.length - max;
    while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut++;
    return { text: buf.subarray(cut).toString('utf8'), omitted: cut };
  }
  cut = max;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), omitted: buf.length - cut };
}

/**
 * Bound one watch document by shape-blind rules: long strings keep their `keep` end, long arrays keep
 * their `keep` items. While the result is over `docBytes`, the string cap halves; below 256 bytes the
 * document is dropped whole. The document keeps its native shape; what was cut is reported beside it,
 * never inside it. Returns { value?, clipped? } with clipped = { strings, bytes, items, whole? }.
 */
export function boundDoc(value, { stringBytes, arrayItems, keep, docBytes }) {
  for (let cap = stringBytes; ; cap = Math.floor(cap / 2)) {
    const clipped = { strings: 0, bytes: 0, items: 0 };
    const walk = (v) => {
      if (typeof v === 'string') {
        const c = clipString(v, cap, keep);
        if (c.omitted) { clipped.strings++; clipped.bytes += c.omitted; }
        return c.text;
      }
      if (Array.isArray(v)) {
        const kept = v.length > arrayItems ? (keep === 'tail' ? v.slice(-arrayItems) : v.slice(0, arrayItems)) : v;
        clipped.items += v.length - kept.length;
        return kept.map(walk);
      }
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(value);
    const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (bytes <= docBytes) return clipped.strings || clipped.items ? { value: out, clipped: { ...clipped, stringBytes: cap } } : { value: out };
    if (cap <= 256) return { clipped: { ...clipped, whole: bytes } };
  }
}

/** Active-context IDs as inclusive integer runs, capped; `complete: false` when runs were cut. */
export function activeRanges(ids, max = LIMITS.activeRanges) {
  const ranges = [];
  for (const id of ids) {
    const last = ranges.at(-1);
    if (last && id === last[1] + 1) last[1] = id; else ranges.push([id, id]);
  }
  return { count: ids.length, ranges: ranges.slice(0, max), complete: ranges.length <= max };
}
/** Expand ranges back to IDs (client side). */
export const expandRanges = (active) => active.ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** One bounded watch frame from a ConversationView. Docs outside the allow list are named, never sent. */
export function watchFrame(view, { epoch, watchRevision, limits = LIMITS }) {
  const docs = {}, clipped = {}, omittedDocs = [];
  for (const [kind, doc] of Object.entries(view.docs ?? {})) {
    const rule = limits.docs[kind];
    if (!rule) { omittedDocs.push(kind); continue; }
    const b = boundDoc(doc, rule);
    if (b.value !== undefined) docs[kind] = b.value;
    if (b.clipped) clipped[kind] = b.clipped;
  }
  return { epoch, watchRevision, conversation: view.conversation,
    active: activeRanges(view.entries.map((e) => e.id), limits.activeRanges), docs,
    ...(Object.keys(clipped).length ? { clipped } : {}), ...(omittedDocs.length ? { omittedDocs } : {}) };
}

/**
 * The reader service of one node. `resolve(threadId)` returns the public Conversation or null; the
 * node owns the thread key, the store, and the context. `context` is passed through to pi-durable.
 */
export function createReaderService({ resolve, context, epoch = 1, limits = LIMITS } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('resolve is required');
  const handles = new Map(); // handle → { connection, conversation, watch, revision, listeners, export }
  // `buffered` counts the export bytes held now (at most one record per handle); a page holds none after it returns.
  const stats = { opened: 0, closed: 0, exports: 0, maxRecordBytes: 0, buffered: 0, maxBuffered: 0 };
  let nextHandle = 1;

  function own(connection, handle) {
    const h = handles.get(handle);
    if (!h || h.connection !== connection) fail('expired_handle', 'The handle is unknown or belongs to another connection');
    return h;
  }
  /** Replace or clear a handle's one export; every export change goes through here. */
  function setExport(h, x) {
    if (h.export) { stats.exports--; stats.buffered -= h.export.buf.length; }
    h.export = x;
    if (x) { stats.exports++; stats.buffered += x.buf.length; stats.maxBuffered = Math.max(stats.maxBuffered, stats.buffered); }
  }
  async function release(handle) {
    const h = handles.get(handle);
    if (!h) return;
    handles.delete(handle);
    setExport(h, null);
    stats.closed++;
    try { await h.watch.stop(); } catch {}
    for (const end of h.listeners) try { end('closed'); } catch {}
  }

  async function page(h, { order = 'ascending', minEntryId, maxEntryId, limit = 100 }) {
    if (order !== 'ascending' && order !== 'descending') fail('bad_request', 'order must be ascending or descending');
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.pageItems) fail('bad_request', `limit must be 1..${limits.pageItems}`);
    for (const x of [minEntryId, maxEntryId]) if (x !== undefined && !isId(x)) fail('bad_request', 'entry bounds must be entry IDs');
    const items = [];
    let bytes = 0, cursor, more = false, sub = limits.subPage, large = false;
    fill: do {
      sub = Math.min(sub, limit - items.length);
      const got = await h.conversation.entries({ order, minEntryId, maxEntryId }, sub, cursor, context);
      for (const record of got.items) {
        // One JSON string per record measures it, and an oversized record's digest hashes the same string.
        const json = JSON.stringify(record);
        const size = Buffer.byteLength(json, 'utf8');
        stats.maxRecordBytes = Math.max(stats.maxRecordBytes, size);
        const item = size > limits.entryBytes
          ? { type: 'oversized', id: record.id, conversationId: record.conversationId, kind: record.kind, bytes: size, sha256: sha256(json) }
          : { type: 'entry', record };
        const itemBytes = item.type === 'entry' ? size : 256;
        if (items.length && bytes + itemBytes > limits.pageBytes) { more = true; break fill; }
        items.push(item); bytes += itemBytes;
        large ||= item.type === 'oversized';
        if (items.length === limit) { more = got.next !== undefined || record !== got.items.at(-1); break fill; }
      }
      // After an oversized record, read one record at a time: at most one large record is held.
      if (large) sub = 1;
      cursor = got.next;
      more = cursor !== undefined;
    } while (cursor);
    const tail = items.at(-1);
    return { items, more, last: tail ? (tail.record?.id ?? tail.id) : null };
  }

  /** One connection's view of the service. A transport creates one per peer and calls disconnect() at loss. */
  function connect() {
    const connection = { id: randomUUID(), live: true };
    const mine = () => [...handles].filter(([, h]) => h.connection === connection).map(([k]) => k);
    const check = () => { if (!connection.live) fail('disconnected', 'The connection is closed'); };
    return {
      /** open({threadId}) → { handle, epoch, frame } */
      async open({ threadId }) {
        check();
        const conversation = await resolve(threadId);
        if (!conversation) fail('not_found', `No durable conversation ${threadId}`);
        const watch = await conversation.watch(context);
        if (!connection.live) {
          // The peer left while the open was in flight: nothing may outlive it.
          try { await watch.stop(); } catch {}
          fail('disconnected', 'The connection closed during open');
        }
        const handle = `r${nextHandle++}`;
        handles.set(handle, { connection, conversation, watch, revision: 0, listeners: [], export: null });
        stats.opened++;
        return { handle, epoch, frame: watchFrame(watch.value, { epoch, watchRevision: 0, limits }) };
      },
      /** entries({handle, order, minEntryId?, maxEntryId?, limit}) → { items: PageItem[], more, last } */
      async entries({ handle, ...query }) { check(); return page(own(connection, handle), query); },
      /** fence({handle}) → { upper, watchRevision }: the newest history ID, read after the revision. */
      async fence({ handle }) {
        check();
        const h = own(connection, handle);
        const watchRevision = h.revision;
        const got = await h.conversation.entries({ order: 'descending' }, 1, undefined, context);
        return { upper: got.items[0]?.id ?? null, watchRevision };
      },
      /**
       * raw({handle, id, exportId?, offset}) → { exportId, offset, encoding: 'base64', data, bytes, sha256, done }.
       * The bytes are the record's UTF-8 JSON; `offset` and `bytes` count them before base64.
       */
      async raw({ handle, id, exportId, offset = 0 }) {
        check();
        const h = own(connection, handle);
        if (!isId(id) || !Number.isInteger(offset) || offset < 0) fail('bad_request', 'raw needs an entry ID and a byte offset');
        let x = h.export;
        if (exportId === undefined) {
          const got = await h.conversation.entries({ order: 'ascending', minEntryId: id, maxEntryId: id }, 1, undefined, context);
          const record = got.items[0];
          if (!record) fail('not_found', `Entry ${id} is not in this history`);
          const { buf, bytes } = encode(record);
          if (bytes > limits.exportBytes) fail('too_large', `Entry ${id} is ${bytes} bytes`);
          // A new export replaces the handle's previous one, so a handle holds at most one record's bytes.
          setExport(h, x = { exportId: randomUUID(), id, buf, sha256: sha256(buf) });
        } else if (!x || x.exportId !== exportId || x.id !== id) fail('cancelled', 'The export was cancelled or replaced');
        if (offset > x.buf.length) fail('bad_request', 'offset is past the end');
        const end = Math.min(offset + limits.chunkBytes, x.buf.length);
        const out = { exportId: x.exportId, offset, encoding: 'base64', data: x.buf.subarray(offset, end).toString('base64'),
          bytes: x.buf.length, sha256: x.sha256, done: end === x.buf.length };
        if (out.done) setExport(h, null);
        return out;
      },
      /** cancel({handle, exportId}): release an export; a later raw for it answers `cancelled`. */
      async cancel({ handle, exportId }) {
        const h = own(connection, handle);
        if (h.export?.exportId === exportId) setExport(h, null);
        return {};
      },
      /** watch({handle}, onFrame, onEnd) → { stop() }. Frames are bounded; onEnd(reason) is final. */
      async watch({ handle }, onFrame, onEnd) {
        check();
        const h = own(connection, handle);
        if (h.watching) fail('bad_request', 'The handle is already watched');
        h.watching = true;
        if (onEnd) h.listeners.push(onEnd);
        let stopped = false;
        h.watch.start(async (view) => {
          if (stopped || !handles.has(handle)) return;
          onFrame(watchFrame(view, { epoch, watchRevision: ++h.revision, limits }));
        });
        return { stop: () => { stopped = true; } };
      },
      async close({ handle }) { own(connection, handle); await release(handle); return {}; },
      /** Transport loss: every handle of this connection closes, including opens still in flight. */
      async disconnect() {
        connection.live = false;
        for (const handle of mine()) await release(handle);
      },
    };
  }

  return {
    connect,
    stats: () => ({ ...stats, handles: handles.size }),
  };
}
