// Incremental scanner: session files -> records, through a per-adapter index.
//
//   stat ─► size and mtime unchanged ─────────────────► reuse the file's records
//        ├► grew, same inode and head ────────────────► feed only the appended bytes
//        └► new, shrank, or replaced ─────────────────► feed the whole file
//
// Agents append to session files, so a refresh costs the bytes written since the last
// one. The index is a cache: its key holds a hash of this file and the adapter's
// source, so a code change rebuilds it instead of serving records from older logic.
//
// Adapter: { name, source (its module URL), list() -> paths, init(path) -> state,
//            line(state, buf, start, end, emit) }. State must survive JSON.
// emit(record): a CALL or COMPACTION (src/record.mjs) with `kind` "call" or "compaction",
// or a patch { kind: "patch", of: "call" | "compaction", id, set: {fields} } for a record
// emitted earlier from the same file. Records already emitted are never rewritten, so a
// later fact about them (stream timing, a summary's length) arrives as a patch.
// list() may set `excluded` on the returned array: { reason: file count }.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_DIR = join(homedir(), ".cache", "trace-analytics");
const HEAD_BYTES = 64;
const CHUNK = 1 << 20;

async function codeKey(adapter) {
  const h = createHash("sha256");
  for (const u of [import.meta.url, adapter.source, ...(adapter.uses ?? [])]) h.update(await readFile(fileURLToPath(u)));
  return h.digest("hex").slice(0, 12);
}

// A long-lived process (the live view) keeps each index in memory between scans.
const loaded = new Map();

async function loadIndex(path, key) {
  const held = loaded.get(path);
  if (held?.key === key) return held;
  let idx = { key, files: {} };
  try {
    await chmod(path, 0o600);
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let valid = false;
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (row.key) valid = row.key === key;
      else if (valid) idx.files[row.path] = row.file;
    }
  } catch { idx = { key, files: {} }; }
  loaded.set(path, idx);
  return idx;
}

async function readHead(fh) {
  const b = Buffer.alloc(HEAD_BYTES);
  const { bytesRead } = await fh.read(b, 0, HEAD_BYTES, 0);
  return createHash('sha256').update(b.subarray(0, bytesRead)).digest('hex');
}

/** Feed complete lines in [from, to) to onLine(buf, start, end). Returns the offset after the last newline. */
export async function feed(fh, from, to, onLine) {
  let pos = from;
  let carry = Buffer.alloc(0);
  let consumed = from;
  while (pos < to) {
    const b = Buffer.allocUnsafe(Math.min(CHUNK, to - pos));
    const { bytesRead } = await fh.read(b, 0, b.length, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    const buf = carry.length ? Buffer.concat([carry, b.subarray(0, bytesRead)]) : b.subarray(0, bytesRead);
    let start = 0;
    for (let nl; (nl = buf.indexOf(10, start)) !== -1; start = nl + 1) {
      if (nl > start) onLine(buf, start, nl);
    }
    consumed = pos - (buf.length - start);
    carry = Buffer.from(buf.subarray(start));
  }
  return consumed;
}

/** Bring the adapter's index up to date for files modified since sinceMs; return it with scan stats. */
export async function scan(adapter, { sinceMs, cacheDir = CACHE_DIR, useCache = true } = {}) {
  const started = performance.now();
  if (useCache) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await chmod(cacheDir, 0o700);
  }
  const key = await codeKey(adapter);
  const indexPath = join(cacheDir, `${adapter.name}.jsonl`);
  const index = useCache ? await loadIndex(indexPath, key) : { key, files: {} };
  const paths = await adapter.list();
  const stats = { files: paths.length, excluded: paths.excluded ?? {}, inWindow: 0, reused: 0, appended: 0, full: 0, bytes: 0 };
  const current = new Set();
  let dirty = false;

  const queue = [...paths];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let path; (path = queue.shift()); ) {
        const st = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!st || st.mtimeMs < sinceMs) continue;
        stats.inWindow++;
        current.add(path);
        let e = index.files[path];
        if (e && e.size === st.size && e.mtimeMs === st.mtimeMs) {
          stats.reused++;
          continue;
        }
        const fh = await open(path, "r");
        try {
          const head = await readHead(fh);
          const grew = e && e.ino === st.ino && st.size >= e.offset && e.head === head;
          if (grew) stats.appended++;
          else {
            stats.full++;
            e = { ino: st.ino, head, offset: 0, records: [], state: adapter.init(path) };
          }
          stats.bytes += st.size - e.offset;
          e.offset = await feed(fh, e.offset, st.size, (buf, s, t) => adapter.line(e.state, buf, s, t, (r) => e.records.push(r)));
          e.size = st.size;
          e.mtimeMs = st.mtimeMs;
          index.files[path] = e;
          dirty = true;
        } finally {
          await fh.close();
        }
      }
    }),
  );

  if (useCache && dirty) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await chmod(cacheDir, 0o700);
    const tmp = `${indexPath}.${process.pid}.tmp`;
    const out = await open(tmp, 'w', 0o600);
    try {
      await out.chmod(0o600);
      await out.write(`${JSON.stringify({ key })}\n`);
      for (const [path, file] of Object.entries(index.files)) await out.write(`${JSON.stringify({ path, file })}\n`);
    } finally { await out.close(); }
    await rename(tmp, indexPath);
  }
  stats.ms = Math.round(performance.now() - started);
  // Only files in this scan's window: the index can hold older ones from a wider earlier scan.
  const files = [...current].sort().map((path) => [path, index.files[path]]);
  return { files, stats };
}
