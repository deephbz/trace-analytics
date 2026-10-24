// Durable copy: a consumer's disk cache of one durable conversation's raw history records.
// Contract and rationale: HyperCarrier apps/ampi/docs/durable/reader-design.md, "Hub copy".
//
//   openDurableSession({ retain: false }).refresh() ──► { reset, records } ──► writeDurableCopy
//   openDurableCopy(file) ──► visit / entry / entryBytes / session, streamed from disk
//
// The copy owns no source facts. The node stays the authority; a copy is deletable and rebuilds
// from the node. Files, beside each other:
//   <file>           JSONL, one raw EntryRecord (or oversized stub) per line, history order
//   <file>.idx       JSONL, one [id, offset, length] per record line
//   <file>.meta.json format, Host, thread, generation, committed byte and line counts, the
//                    reader checkpoint, conversation, docs, the Session head and the running session fold
// The meta file commits a write: readers see only the committed prefix, and the next write
// truncates any uncommitted tail first. A reset rewrites the copy under a new generation.
// A reader holds the offset index and the fold, never the whole history.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { READER_VERSION } from '../record.mjs';
import { durableItem, durableSessionRecord, emptySessionFold, foldSession, HARNESS, parseThread, piShaped, sessionHeadOf } from './durable.mjs';
import { checkHost } from './session-state.mjs';

export const COPY_FORMAT = 'durable-copy/1';
const CHUNK = 1 << 20;

const metaFile = (file) => `${file}.meta.json`;
const idxFile = (file) => `${file}.idx`;
function readMeta(file) {
  if (!existsSync(metaFile(file))) return null;
  const meta = JSON.parse(readFileSync(metaFile(file), 'utf8'));
  return meta.format === COPY_FORMAT && meta.reader === READER_VERSION ? meta : null;
}
function writeMeta(file, meta) {
  const tmp = `${metaFile(file)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(tmp, metaFile(file));
}

/** The checkpoint a copy was last written with, to restore an openDurableSession; null when there is no usable copy. */
export function durableCopyCheckpoint(file, { host, threadId }) {
  const meta = readMeta(file);
  return meta && meta.host === host && meta.threadId === threadId ? meta.checkpoint : null;
}

/** Remove a copy and its sidecars. */
export function removeDurableCopy(file) {
  for (const f of [file, idxFile(file), metaFile(file)]) rmSync(f, { force: true });
}

/**
 * Commit one refresh result into the copy. `records` are the raw records the reader absorbed;
 * after a reset they are the whole new history. `checkpoint` is the reader's snapshot() (retain:
 * false), `conversation` and `docs` its latest watch state. Returns the committed meta.
 */
export function writeDurableCopy(file, { host, threadId, reset, records, checkpoint, conversation, docs = {} }) {
  host = checkHost(host);
  const { conversationId } = parseThread(threadId);
  let meta = readMeta(file);
  if (meta && (meta.host !== host || meta.threadId !== threadId)) meta = null;
  const fresh = reset || !meta;
  if (fresh) {
    meta = { format: COPY_FORMAT, reader: READER_VERSION, host, threadId, generation: randomBytes(6).toString('hex'),
      bytes: 0, idxBytes: 0, lines: 0, fold: emptySessionFold() };
  }
  const fd = openSync(file, fresh ? 'w' : 'r+', 0o600), ifd = openSync(idxFile(file), fresh ? 'w' : 'r+', 0o600);
  try {
    // An uncommitted tail from an interrupted write is never visible; drop it.
    ftruncateSync(fd, meta.bytes); ftruncateSync(ifd, meta.idxBytes);
    let at = meta.bytes, idxAt = meta.idxBytes, parent = meta.fold.lastId;
    for (const record of records) {
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      writeSync(fd, line, 0, line.length, at);
      const idx = Buffer.from(`${JSON.stringify([String(record.id), at, line.length - 1])}\n`);
      writeSync(ifd, idx, 0, idx.length, idxAt);
      at += line.length; idxAt += idx.length;
      const item = durableItem(record, { host, threadId, parent });
      foldSession(meta.fold, item, conversationId);
      parent = item.entry.id;
    }
    conversation = conversation ?? meta.conversation ?? null;
    meta = { ...meta, bytes: at, idxBytes: idxAt, lines: meta.lines + records.length, checkpoint: checkpoint ?? null,
      conversation, docs, head: sessionHeadOf({ conversation, docs }) };
  } finally { closeSync(fd); closeSync(ifd); }
  writeMeta(file, meta);
  return meta;
}

/**
 * Open a copy for reading, with the range surface of openPiSessionRange: refresh, info, session,
 * visit, entry, entryBytes, close. Visit rows carry `native` (piShaped, for published readers that
 * take Pi entries), `entry` and `source` (durableItem), and `position`.
 */
export function openDurableCopy(file, { host } = {}) {
  host = checkHost(host);
  let meta = null, index = null, closed = false;
  const assertOpen = () => { if (closed) throw new Error('Copy reader is closed'); };
  function loadIndex() {
    if (index) return index;
    index = new Map();
    const order = [];
    if (meta.idxBytes) {
      const lines = readRange(idxFile(file), 0, meta.idxBytes).toString('utf8').split('\n');
      for (const line of lines) if (line) { const [id, offset, length] = JSON.parse(line); index.set(id, { offset, length, position: order.length }); order.push(id); }
    }
    index.order = order;
    return index;
  }
  function readRange(path, offset, length) {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) { const n = readSync(fd, buffer, read, length - read, offset + read); if (!n) break; read += n; }
      if (read < length) throw new Error('Copy is shorter than its committed length; rebuild it from the node');
      return buffer;
    } finally { closeSync(fd); }
  }
  // The last segment names the history tip and the Session head, so a cwd change without a new entry re-derives.
  const version = () => meta ? `${READER_VERSION}:${HARNESS}:${host}:${meta.threadId}:${meta.generation}:${meta.fold.lastId ?? ''}.${meta.head ?? ''}` : null;
  const itemOf = (record, parent) => durableItem(record, { host, threadId: meta.threadId, parent });
  function info() {
    assertOpen();
    return { version: version(), bytes: meta?.bytes ?? 0, branch: 'complete', invalidLines: 0, count: meta?.lines ?? 0, generation: meta?.generation ?? null };
  }
  return {
    /** Load the committed meta. A copy rebuilt under a new generation does not continue an older version. */
    refresh() {
      assertOpen();
      const next = readMeta(file);
      if (!next || next.host !== host) throw new Error('No durable copy for this Host; rebuild it from the node');
      if (statSync(file).size < next.bytes) throw new Error('Copy is shorter than its committed length; rebuild it from the node');
      const reset = meta !== null && meta.generation !== next.generation;
      meta = next; index = null;
      return { reset, added: 0, ...info() };
    },
    info,
    /** Whether `sourceVersion` names a prefix of this copy: same Host, thread and generation. */
    continues(sourceVersion) {
      const v = version();
      return v !== null && typeof sourceVersion === 'string' && sourceVersion.slice(0, sourceVersion.lastIndexOf(':')) === v.slice(0, v.lastIndexOf(':'));
    },
    session() {
      assertOpen();
      if (!meta?.conversation) return null;
      const s = durableSessionRecord({ host, threadId: meta.threadId, fold: meta.fold, conversation: meta.conversation, docs: meta.docs });
      return { ...s, tip: meta.fold.lastId, header: null, inheritedBefore: meta.fold.inheritedUntil === null ? Number.NaN : meta.fold.inheritedUntil + 1 };
    },
    /** Visit records in history order, after `after` when given, streamed from disk in bounded chunks. */
    visit(visitor, { after } = {}) {
      assertOpen();
      if (!meta) throw new Error('Refresh the reader first');
      const idx = loadIndex();
      let start = 0, position = 0, parent = null;
      if (after != null) {
        const at = idx.get(String(after));
        if (!at) throw new Error('Entry is not in this Session history');
        start = at.offset + at.length + 1; position = at.position + 1; parent = String(after);
      }
      const fd = openSync(file, 'r');
      try {
        let carry = Buffer.alloc(0), offset = start;
        while (offset < meta.bytes) {
          const buffer = Buffer.alloc(Math.min(CHUNK, meta.bytes - offset));
          const n = readSync(fd, buffer, 0, buffer.length, offset);
          if (!n) throw new Error('Copy is shorter than its committed length; rebuild it from the node');
          offset += n;
          let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n), from = 0;
          for (let nl = data.indexOf(10, from); nl >= 0; nl = data.indexOf(10, from)) {
            const record = JSON.parse(data.subarray(from, nl).toString('utf8'));
            const { entry, source, semantics } = itemOf(record, parent);
            visitor({ native: piShaped(record), entry, source, semantics, position: position++ });
            parent = entry.id; from = nl + 1;
          }
          carry = Buffer.from(data.subarray(from));
        }
      } finally { closeSync(fd); }
    },
    /** One entry by ID, read from disk. `full` is accepted for the Pi range surface: copy entries are always whole. */
    entry(id, { version: wanted } = {}) {
      assertOpen();
      if (wanted && wanted !== version()) throw new Error('Entry reference is stale');
      const at = loadIndex().get(String(id));
      if (!at) return undefined;
      const record = JSON.parse(readRange(file, at.offset, at.length).toString('utf8'));
      const parent = at.position ? index.order[at.position - 1] : null;
      return itemOf(record, parent).entry;
    },
    /** The raw record's JSON bytes, paged like openPiSessionRange.entryBytes; `format: 'durable-json'`. */
    entryBytes(id, { offset = 0, limit = 65536 } = {}) {
      assertOpen();
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 65536) throw new Error('Invalid byte range');
      const at = loadIndex().get(String(id));
      if (!at) throw new Error('Entry offset unavailable');
      const remaining = Math.max(0, at.length - offset);
      const buffer = readRange(file, at.offset + offset, Math.min(limit, remaining));
      let length = buffer.length;
      if (remaining > length) {
        let first = length - 1;
        while (first > 0 && (buffer[first] & 0xc0) === 0x80) first--;
        const lead = buffer[first], width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
        if (length - first < width) length = first;
      }
      return { text: buffer.subarray(0, length).toString('utf8'), next: offset + length, more: remaining > length, format: 'durable-json' };
    },
    /** Docs as the node bounded them at the last write (pi.agent, pi.live, ...). */
    docs() { assertOpen(); return meta?.docs ?? {}; },
    close() { closed = true; index = null; },
  };
}
