// Bounded Pi transcript prototype. Native JSONL remains authoritative. SQLite holds
// offsets and ancestry; range reads retain at most 400 entries with bounded text.
// The index is private and rebuildable. Call refresh before reading a changed file.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkHost, observe, sessionState, sessionRef } from './session-state.mjs';
import { transcriptEntry } from './transcript.mjs';

const VERSION = 1;
const CHUNK = 64 * 1024;
const SAMPLE = 128;
const hash = (x) => createHash('sha256').update(x).digest('hex');

function bytes(fd, at, length) {
  const b = Buffer.allocUnsafe(length);
  const n = readSync(fd, b, 0, length, at);
  if (n !== length) throw new Error('Source changed during range read');
  return b;
}
function sample(fd, length) {
  const n = Math.min(length, SAMPLE);
  return hash(Buffer.concat([bytes(fd, 0, n), bytes(fd, length - n, n)]));
}

/** A preview never claims to be the full entry. Tool arguments remain on disk. */
function preview(entry, maxChars) {
  let left = maxChars, shortened = false;
  const text = (value) => {
    if (typeof value !== 'string') return value;
    const out = value.slice(0, left); left -= out.length;
    shortened ||= out.length !== value.length;
    return out;
  };
  const out = { ...entry };
  for (const key of ['summary', 'text', 'error']) if (key in out) out[key] = text(out[key]);
  if (out.result) out.result = { ...out.result, text: text(out.result.text) };
  if (out.blocks) out.blocks = out.blocks.slice(0, 32).map((block) => {
    if (block.type === 'toolCall') { shortened = true; return { ...block, args: null }; }
    return 'text' in block ? { ...block, text: text(block.text) } : block;
  });
  shortened ||= (entry.blocks?.length ?? 0) > 32;
  return { ...out, truncated: shortened };
}

/**
 * Disk-backed active-branch ranges beside openPiSession. Each index belongs to one
 * Host and source path. Warm reads validate length and head/tail samples; refresh
 * rebuilds on changed same-size files or inode changes. Mutations outside the
 * append-only contract require refresh({ force: true }). No global cache.
 */
export function openPiSessionRange(path, { host, indexPath, previewChars = 2048 } = {}) {
  host = checkHost(host);
  if (!indexPath) throw new Error('indexPath is required');
  if (!Number.isInteger(previewChars) || previewChars < 0 || previewChars > 8192) throw new Error('Invalid preview budget');
  mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(indexPath);
  chmodSync(indexPath, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA cache_size=-1024; PRAGMA mmap_size=0;
    PRAGMA temp_store=FILE;
    CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, parent TEXT, start INTEGER NOT NULL,
      length INTEGER NOT NULL, observation TEXT NOT NULL, preview TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS branch (position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL);`);
  const saved = db.prepare('SELECT value FROM meta WHERE id=1').get();
  let meta = saved ? JSON.parse(saved.value) : null;
  if (meta && (meta.version !== VERSION || meta.host !== host || meta.path !== path || meta.previewChars !== previewChars)) {
    db.exec('DELETE FROM nodes; DELETE FROM branch; DELETE FROM meta'); meta = null;
  }
  const node = db.prepare('SELECT * FROM nodes WHERE id=?');
  const put = db.prepare('INSERT OR REPLACE INTO nodes VALUES (?, ?, ?, ?, ?, ?)');
  const addBranch = db.prepare('INSERT INTO branch VALUES (?, ?)');
  const writeMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (1, ?)');
  let closed = false, refreshing = false;
  let peakHeap = process.memoryUsage().heapUsed;
  const measure = () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
  const assertOpen = () => { if (closed) throw new Error('Reader is closed'); };

  function rebuild(tip) {
    db.exec('DELETE FROM branch');
    let id = tip, position = 0;
    while (id != null) {
      const r = node.get(id);
      if (!r || db.prepare('SELECT 1 FROM branch WHERE id=?').get(id)) break;
      addBranch.run(position--, id); id = r.parent;
    }
    return id == null ? 'complete' : 'partial';
  }

  async function refresh({ force = false } = {}) {
    assertOpen();
    if (refreshing) throw new Error('Refresh already in progress');
    refreshing = true;
    let fd;
    try {
      fd = openSync(path, 'r');
      const stat = statSync(path);
      const prefixMatches = meta && stat.size >= meta.offset && sample(fd, meta.offset) === meta.sample;
      if (!force && prefixMatches && stat.ino === meta.ino && stat.size === meta.size && stat.mtimeMs === meta.mtimeMs) {
        return { reset: false, added: 0, ...info() };
      }
      const reset = force || !prefixMatches || stat.ino !== meta?.ino || stat.size <= (meta?.size ?? 0);
      const next = reset ? { version: VERSION, host, path, previewChars, offset: 0, digest: hash(''), generation: (meta?.generation ?? 0) + 1,
        state: { reader: sessionState('pi', path, false) }, branch: 'complete', header: null, invalidLines: 0 } : structuredClone(meta);
      // observe needs text for human/injected classification, but no text is kept in state.
      next.state.reader.text = false;
      let branchChanged = reset, added = 0, carry = Buffer.alloc(0), pos = next.offset;
      let top = reset ? -1 : Number(db.prepare('SELECT COALESCE(MAX(position),-1) AS n FROM branch').get().n);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (reset) db.exec('DELETE FROM nodes; DELETE FROM branch');
        while (pos < stat.size) {
          const b = bytes(fd, pos, Math.min(CHUNK, stat.size - pos)); pos += b.length;
          const buf = carry.length ? Buffer.concat([carry, b]) : b;
          const base = pos - buf.length;
          let start = 0;
          for (let nl; (nl = buf.indexOf(10, start)) !== -1; start = nl + 1) {
            const raw = buf.subarray(start, nl);
            next.digest = createHash('sha256').update(next.digest).update(buf.subarray(start, nl + 1)).digest('hex');
            next.offset = base + nl + 1;
            let o;
            try { o = JSON.parse(raw.toString('utf8')); } catch { if (raw.length) next.invalidLines++; continue; }
            if (o.type === 'session') next.header = { parentSession: o.parentSession ?? null, timestamp: o.timestamp ?? null };
            const previousTip = next.state.reader.tip;
            let r;
            observe(next.state, o, (record) => { r = record; });
            if (!r) continue;
            if (node.get(r.id) || r.parent !== previousTip) branchChanged = true;
            const view = preview(transcriptEntry(o, r, host), previewChars);
            put.run(r.id, r.parent, base + start, nl - start, JSON.stringify(r), JSON.stringify(view));
            if (!branchChanged) addBranch.run(++top, r.id);
            added++; measure();
          }
          carry = Buffer.from(buf.subarray(start));
          measure();
          // One bounded chunk per turn lets callers serve already committed copies.
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (branchChanged) next.branch = rebuild(next.state.reader.tip);
        next.sample = sample(fd, next.offset);
        Object.assign(next, { size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs });
        const finalStat = statSync(path);
        if (finalStat.ino !== stat.ino || finalStat.size < stat.size || (finalStat.size === stat.size && finalStat.mtimeMs !== stat.mtimeMs)) {
          throw new Error('Source changed during indexing; retry refresh');
        }
        writeMeta.run(JSON.stringify(next)); db.exec('COMMIT'); meta = next;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { reset: branchChanged, added, ...info() };
    } finally { if (fd !== undefined) closeSync(fd); refreshing = false; }
  }

  function info() {
    assertOpen();
    return { version: meta ? `${VERSION}:${meta.digest}:${meta.offset}` : null,
      bytes: meta?.offset ?? 0, branch: meta?.branch ?? 'partial', invalidLines: meta?.invalidLines ?? 0,
      count: Number(db.prepare('SELECT COUNT(*) AS n FROM branch').get().n), peakHeap };
  }
  function source() {
    assertOpen();
    if (refreshing) throw new Error('Index is refreshing');
    if (!meta) throw new Error('Refresh the reader first');
    const fd = openSync(path, 'r');
    try {
      if (statSync(path).size < meta.offset || sample(fd, meta.offset) !== meta.sample) throw new Error('Source version changed; refresh before reading');
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  function decode(fd, r, full) {
    const value = full
      ? transcriptEntry(JSON.parse(bytes(fd, Number(r.start), Number(r.length)).toString('utf8')), JSON.parse(r.observation), host)
      : JSON.parse(r.preview);
    measure();
    return value;
  }
  function page({ before, limit = 400, version } = {}) {
    assertOpen();
    if (version && version !== info().version) throw new Error('Range cursor is stale');
    if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('Page limit must be 1..400');
    let position = Number.MAX_SAFE_INTEGER;
    if (before != null) {
      const row = db.prepare('SELECT position FROM branch WHERE id=?').get(before);
      if (!row) throw new Error('Entry is not on the active branch');
      position = Number(row.position);
    }
    const rows = db.prepare(`SELECT n.*, b.position FROM branch b JOIN nodes n ON n.id=b.id
      WHERE b.position < ? ORDER BY b.position DESC LIMIT ?`).all(position, limit + 1);
    const more = rows.length > limit;
    if (more) rows.pop();
    const fd = source();
    try {
      const entries = rows.reverse().map((r) => decode(fd, r, false));
      measure();
      return { entries, more, version: info().version, branch: meta.branch };
    } finally { closeSync(fd); }
  }
  function entry(id, { full = false, version } = {}) {
    if (version && version !== info().version) throw new Error('Entry reference is stale');
    const fd = source();
    try {
      const r = node.get(id);
      return r ? decode(fd, r, full) : undefined;
    } finally { closeSync(fd); }
  }
  return { refresh, page, entry, info,
    session() {
      const s = meta?.state.reader;
      return s?.native == null ? null : { id: `pi:${s.native}`, host, ref: sessionRef(host, `pi:${s.native}`),
        cwd: s.cwd, started: s.started, updated: s.updated, header: meta.header };
    },
    close() { if (!closed) { if (refreshing) throw new Error('Refresh in progress'); db.close(); closed = true; } },
  };
}
