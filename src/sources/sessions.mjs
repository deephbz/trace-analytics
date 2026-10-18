// Reader wiring: the existing adapters and incremental scanner own all log reads.
// Consumers receive versioned records. The cache is disposable and private.
import { chmod, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pi } from './pi.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { scan, CACHE_DIR } from './scan.mjs';
import { activeBranch } from './lineage.mjs';
import { sessionState, sessionRecord, entryRecord, sessionRef, checkHost, isScratch } from './session-state.mjs';
import { READER_VERSION } from '../record.mjs';

const run = promisify(execFile);
const adapters = { pi, claude, codex };
const uses = ['./session-state.mjs', './sessions.mjs', './lineage.mjs', '../record.mjs'].map(p => new URL(p, import.meta.url).href);

async function codexMetadata(path) {
  if (!path || !await access(path).then(() => true, () => false)) return [];
  // SQLite opens the harness database read-only. No dependency on its journal mode.
  const query = async sql => {
    const { stdout } = await run('sqlite3', ['-readonly', '-json', path, sql], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout || '[]');
  };
  const tables = await query("select name from sqlite_master where type='table'");
  if (!tables.some(t => t.name === 'threads')) return [];
  const edges = tables.some(t => t.name === 'thread_spawn_edges') ? await query('select * from thread_spawn_edges') : [];
  const parents = new Set(edges.map(e => e.parent_thread_id));
  return (await query('select * from threads')).map(r => ({ ...r, is_parent: parents.has(r.id),
    parent: edges.find(e => e.child_thread_id === r.id)?.parent_thread_id ?? null }));
}

export async function readSessions({ text = false, sources = adapters, cacheDir = join(CACHE_DIR, 'reader'),
  useCache = true, paths, host, codexDb = join(homedir(), '.codex', 'state_5.sqlite') } = {}) {
  host = checkHost(host);
  if (useCache) { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); await chmod(cacheDir, 0o700); }
  const sessions = new Map();
  const streams = new Map();
  const searchExtras = new Map();
  const parents = new Map();
  const selectedMtime = new Map();
  const pathIds = new Map();
  const coverage = [];
  for (const [harness, source] of Object.entries(sources)) {
    const adapter = { ...source, name: `sessions-${harness}-${text === 'full' ? 'full' : text ? 'text' : 'plain'}`, uses: [...(source.uses ?? []), ...uses],
      list: async () => {
        const discovered = harness === 'claude' && source === claude ? await claude.list(undefined, true) : await source.list();
        return paths ? discovered.filter(p => paths.includes(p)) : discovered;
      },
      init: path => ({ reader: sessionState(harness, path, text) }) };
    const { files, stats } = await scan(adapter, { sinceMs: -Infinity, cacheDir, useCache });
    const cov = { harness, files: stats.files, copies: 0, missing: stats.files === 0 };
    coverage.push(cov);
    for (const [path, file] of files) {
      const s = file.state.reader;
      if (s.started === null || s.native === null) continue;
      const entries = file.records.filter(r => r.kind === 'entry');
      const ancestry = harness === 'pi' || harness === 'claude' ? activeBranch(entries, s.tip) : { entries, branch: 'file-order' };
      const branch = ancestry.entries;
      const { record, replies } = sessionRecord(harness, s, ancestry, { version: READER_VERSION, host, path, text });
      const id = record.id;
      pathIds.set(path, id);
      // Keep the freshest complete copy of a Session. Repeated entries in that copy collapse by identity.
      if (sessions.has(id)) cov.copies++;
      if ((selectedMtime.get(id) ?? -Infinity) > file.mtimeMs) continue;
      selectedMtime.set(id, file.mtimeMs);
      sessions.set(id, record);
      parents.set(id, s.parent);
      if (text) searchExtras.set(id, [
        ...(s.title ? [{ kind: 'title', entry: s.titleEntry ?? null, t: s.titleTime ?? null, text: s.title }] : []),
        ...(replies.length ? [{ kind: 'reply', entry: replies.at(-1).id, t: replies.at(-1).t, text: replies.at(-1).text }] : []),
      ]);
      streams.set(id, [...new Map(branch.map(r => [r.id, entryRecord(r, { version: READER_VERSION, host, text })])).values()]);
    }
  }
  if (sources.codex) for (const row of await codexMetadata(codexDb)) {
    const id = `codex:${row.id}`;
    let r = sessions.get(id);
    const first = row.first_user_message ?? '';
    if (!r) {
      if (paths && !paths.includes(row.rollout_path)) continue;
      r = { reader: READER_VERSION, id, host, ref: sessionRef(host, id), harness: 'codex', session: row.id, role: 'solo', parent: row.parent ? `codex:${row.parent}` : null,
        cwd: row.cwd ?? null, scratch: isScratch(row.cwd ?? null),
        path: row.rollout_path ?? null, started: row.created_at_ms ?? (row.created_at == null ? null : row.created_at * 1000),
        updated: row.updated_at_ms ?? (row.updated_at == null ? null : row.updated_at * 1000), archived: Boolean(row.archived), branch: 'file-order', humanTurns: 0,
        resume: { cwd: row.cwd ?? null, argv: ['codex', 'resume', row.id] } };
      if (text) Object.assign(r, { title: null, firstAsk: null, lastAsk: null, lastReply: null });
      sessions.set(id, r); streams.set(id, []);
    }
    if (row.parent) r.parent = `codex:${row.parent}`;
    const origin = row.thread_source;
    r.role = (row.source ?? '').startsWith('{') || origin === 'subagent' || /^\s*(You are Worker|Controlled BB plugin test)/.test(first) ? 'worker'
      : row.source === 'exec' || ['automation', 'agent_created_thread'].includes(origin) || row.originator === 'bb' || first.startsWith('Write a concise human re-entry summary') ? 'automated'
      : row.is_parent ? 'leader' : 'solo';
    r.archived = Boolean(row.archived);
    if (text && row.name) {
      r.title = row.name;
      const extras = searchExtras.get(id) ?? [];
      searchExtras.set(id, [...extras.filter(e => e.kind !== 'title'), { kind: 'title', entry: null, t: row.updated_at_ms ?? null, text: row.name }]);
    }
  }
  for (const r of sessions.values()) {
    const raw = parents.get(r.id);
    if (raw?.includes('/')) r.parent = pathIds.get(raw) ?? null;
  }
  // A fork parent is not a coordinator. A worker child supplies a spawn edge.
  for (const r of sessions.values()) if (r.role === 'worker' && r.parent && sessions.has(r.parent) && sessions.get(r.parent).role === 'solo') sessions.get(r.parent).role = 'leader';
  return { sessions: [...sessions.values()].sort((a, b) => b.updated - a.updated), entries: streams, searchExtras, coverage };
}

export function visibleSessions(records, { sinceMs = -Infinity, untilMs = Infinity, harness, role, all = false } = {}) {
  return records.filter(r => r.updated >= sinceMs && r.started < untilMs && (!harness || r.harness === harness)
    && (!role || r.role === role) && (all || role || (['solo', 'leader'].includes(r.role) && !r.scratch && r.humanTurns > 0)));
}

export function searchTurns(catalog, query, options = {}) {
  const hits = [];
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return hits;
  for (const s of visibleSessions(catalog.sessions, { ...options, sinceMs: -Infinity, untilMs: Infinity })) for (const e of [
    ...(catalog.entries.get(s.id) ?? []).filter(e => e.kind === 'human'), ...(catalog.searchExtras.get(s.id) ?? []),
  ]) {
    if (e.t !== null && (e.t < (options.sinceMs ?? -Infinity) || e.t >= (options.untilMs ?? Infinity))) continue;
    if (e.t === null && (Number.isFinite(options.sinceMs) || Number.isFinite(options.untilMs))) continue;
    const body = e.text.toLocaleLowerCase();
    if (!terms.every(term => body.includes(term))) continue;
    const at = body.indexOf(terms[0]);
    hits.push({ reader: READER_VERSION, session: s.id, entry: e.id ?? e.entry ?? null, t: e.t, kind: e.kind,
      snippet: e.text.slice(Math.max(0, at - 80), at + terms[0].length + 160).replace(/\s+/g, ' ') });
  }
  return hits.sort((a, b) => a.t === null ? (b.t === null ? 0 : 1) : b.t === null ? -1 : b.t - a.t).slice(0, options.limit ?? 20);
}
