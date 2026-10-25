// Durable copy: a consumer's disk cache of one durable conversation's raw history records.
// Contract and rationale: HyperCarrier apps/ampi/docs/durable/reader-design.md, "Hub copy".
//
//   openDurableSession({ retain: false }).refresh() ──► { reset, records } ──► writeDurableCopy
//   openDurableCopy(file) ──► visit / entry / entryBytes / session, streamed from disk
//
// The copy owns no source facts. The node stays the authority; a copy is deletable and rebuilds
// from the node. Files, beside each other (durableCopyFiles names them):
//   <file>.g-<generation>      JSONL, one raw EntryRecord (or oversized stub) per line, history order
//   <file>.g-<generation>.idx  JSONL, one [id, offset, length] per record line
//   <file>.meta.json           format, Host, thread, generation, committed byte and line counts, the
//                              reader checkpoint, conversation, docs, the Session head and the running session fold
// The meta file commits a write, by an atomic rename: readers see only the committed prefix of the
// generation it names, and the next write truncates any uncommitted tail first. A reset writes a new
// generation beside the committed one and removes the older generations after its meta commits, so a
// kill at any point leaves a whole committed copy. A bundle whose data or index file is missing or
// shorter than its meta states has no checkpoint: the next write starts a new generation.
// A reader holds the offset index and the fold, never the whole history.
import { randomBytes } from 'node:crypto';
import { closeSync, ftruncateSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { READER_VERSION } from '../record.mjs';
import { durableItem, durableSessionRecord, emptySessionFold, foldSession, HARNESS, parseThread, piShaped, sessionHeadOf } from './durable.mjs';
import { checkHost } from './session-state.mjs';

export const COPY_FORMAT = 'durable-copy/2';
const CHUNK = 1 << 20;

const metaFile = (file) => `${file}.meta.json`;
const dataFile = (file, generation) => `${file}.g-${generation}`;
const idxFile = (file, generation) => `${dataFile(file, generation)}.idx`;
function readMeta(file) {
  let meta;
  try { meta = JSON.parse(readFileSync(metaFile(file), 'utf8')); } catch { return null; }
  return meta?.format === COPY_FORMAT && meta.reader === READER_VERSION ? meta : null;
}
const sizeOf = (path) => { try { return statSync(path).size; } catch { return -1; } };
/** The committed meta when its generation's data and index files hold at least the committed bytes. */
function wholeMeta(file) {
  const meta = readMeta(file);
  return meta && sizeOf(dataFile(file, meta.generation)) >= meta.bytes && sizeOf(idxFile(file, meta.generation)) >= meta.idxBytes ? meta : null;
}
/** Remove every generation of `file` except `keep`, and the durable-copy/1 layout's files. */
function removeGenerations(file, keep) {
  const prefix = `${basename(file)}.g-`;
  let names = [];
  try { names = readdirSync(dirname(file)); } catch {}
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const generation = name.slice(prefix.length).replace(/\.idx$/, '');
    if (generation !== keep) rmSync(join(dirname(file), name), { force: true });
  }
  for (const legacy of [file, `${file}.idx`]) rmSync(legacy, { force: true });
}
function writeMeta(file, meta) {
  const tmp = `${metaFile(file)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(tmp, metaFile(file));
}

/**
 * The checkpoint a copy was last written with, to restore an openDurableSession; null when there is
 * no usable copy: no meta, another Host or thread, or a data or index file missing or short.
 */
export function durableCopyCheckpoint(file, { host, threadId }) {
  const meta = wholeMeta(file);
  return meta && meta.host === host && meta.threadId === threadId ? meta.checkpoint : null;
}

/** The bundle's files: its meta, and the data and index files of the committed generation (null without meta). */
export function durableCopyFiles(file) {
  const meta = readMeta(file);
  return { meta: metaFile(file), data: meta ? dataFile(file, meta.generation) : null, index: meta ? idxFile(file, meta.generation) : null };
}

/** Remove a copy: its meta first, so no reader trusts a partial bundle, then every generation. */
export function removeDurableCopy(file) {
  rmSync(metaFile(file), { force: true });
  removeGenerations(file, null);
}

/**
 * Commit one refresh result into the copy. `records` are the raw records the reader absorbed;
 * after a reset they are the whole new history. `checkpoint` is the reader's snapshot() (retain:
 * false), `conversation` and `docs` its latest watch state. Returns the committed meta.
 */
export function writeDurableCopy(file, { host, threadId, reset, records, checkpoint, conversation, docs = {} }) {
  host = checkHost(host);
  const { conversationId } = parseThread(threadId);
  let meta = wholeMeta(file);
  if (meta && (meta.host !== host || meta.threadId !== threadId)) meta = null;
  const fresh = reset || !meta;
  if (fresh) {
    meta = { format: COPY_FORMAT, reader: READER_VERSION, host, threadId, generation: randomBytes(6).toString('hex'),
      bytes: 0, idxBytes: 0, lines: 0, fold: emptySessionFold() };
  }
  // A new generation never opens the committed one's files: until its meta commits, the old copy stays whole.
  const fd = openSync(dataFile(file, meta.generation), fresh ? 'w' : 'r+', 0o600), ifd = openSync(idxFile(file, meta.generation), fresh ? 'w' : 'r+', 0o600);
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
  if (fresh) removeGenerations(file, meta.generation);
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
  /**
   * The offset index as typed columns, streamed from disk in bounded chunks: 20 bytes an entry. The copy appends
   * ascending integer IDs, so a lookup is a binary search; an index that breaks that order is damaged.
   */
  function loadIndex() {
    if (index) return index;
    const damaged = () => new Error('Copy index is damaged; rebuild it from the node');
    const ids = new Float64Array(meta.lines), offsets = new Float64Array(meta.lines), lengths = new Uint32Array(meta.lines);
    let count = 0;
    const fd = openSync(idxFile(file, meta.generation), 'r');
    try {
      let carry = Buffer.alloc(0), offset = 0;
      const buffer = Buffer.alloc(Math.min(CHUNK, meta.idxBytes));
      while (offset < meta.idxBytes) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, meta.idxBytes - offset), offset);
        if (!n) throw new Error('Copy is shorter than its committed length; rebuild it from the node');
        offset += n;
        let data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n), from = 0;
        for (let nl = data.indexOf(10, from); nl >= 0; nl = data.indexOf(10, from)) {
          // A line is `["<id>",<offset>,<length>]`, the writer's own JSON: parse its digits without allocating.
          let i = from;
          const digits = (end) => {
            let v = 0, start = i;
            while (i < nl && data[i] >= 48 && data[i] <= 57) v = v * 10 + data[i++] - 48;
            if (i === start || i - start > 15 || (data[start] === 48 && i - start > 1) || data[i++] !== end) throw damaged();
            return v;
          };
          if (data[i++] !== 91 || data[i++] !== 34) throw damaged();
          const key = digits(34);
          if (data[i++] !== 44) throw damaged();
          const at = digits(44), length = digits(93);
          if (i !== nl || count >= meta.lines || (count && key <= ids[count - 1])) throw damaged();
          ids[count] = key; offsets[count] = at; lengths[count] = length; count++;
          from = nl + 1;
        }
        carry = Buffer.from(data.subarray(from));
      }
    } finally { closeSync(fd); }
    if (count !== meta.lines) throw damaged();
    index = {
      get(id) {
        const key = Number(id);
        for (let lo = 0, hi = count - 1; lo <= hi;) {
          const mid = (lo + hi) >>> 1;
          if (ids[mid] === key) return String(key) === String(id) ? { offset: offsets[mid], length: lengths[mid], position: mid } : undefined;
          if (ids[mid] < key) lo = mid + 1; else hi = mid - 1;
        }
        return undefined;
      },
      idAt: (position) => String(ids[position]),
    };
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
      if (sizeOf(dataFile(file, next.generation)) < next.bytes) throw new Error('Copy is shorter than its committed length; rebuild it from the node');
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
      const fd = openSync(dataFile(file, meta.generation), 'r');
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
      const record = JSON.parse(readRange(dataFile(file, meta.generation), at.offset, at.length).toString('utf8'));
      const parent = at.position ? index.idAt(at.position - 1) : null;
      return itemOf(record, parent).entry;
    },
    /** The raw record's JSON bytes, paged like openPiSessionRange.entryBytes; `format: 'durable-json'`. */
    entryBytes(id, { offset = 0, limit = 65536 } = {}) {
      assertOpen();
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 65536) throw new Error('Invalid byte range');
      const at = loadIndex().get(String(id));
      if (!at) throw new Error('Entry offset unavailable');
      const remaining = Math.max(0, at.length - offset);
      const buffer = readRange(dataFile(file, meta.generation), at.offset + offset, Math.min(limit, remaining));
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
