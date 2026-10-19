// Synthetic logs only. Tests target branch loss, disclosure, and population drift.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, appendFile, readdir, readFile, stat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pi } from '../src/sources/pi.mjs';
import { claude } from '../src/sources/claude.mjs';
import { codex } from '../src/sources/codex.mjs';
import { load } from '../src/sources/load.mjs';
import { readSessions, searchTurns } from '../src/sources/sessions.mjs';

const t = Date.parse('2026-01-01T00:00:00Z');
const iso = n => new Date(t + n).toISOString();
const head = id => ({ type: 'session', id, timestamp: iso(0), cwd: '/work/example' });
const msg = (id, parent, n, role, text, extra = {}) => ({ type: 'message', id, parentId: parent, timestamp: iso(n),
  message: { role, content: text, ...extra } });
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'session-reader-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const source = (adapter, paths) => ({ ...adapter, list: async () => paths });

// More than the CALL lineage cap, then a fork to the root. No abandoned turn leaks.
test('exact deep Pi active branch and append refresh; metadata never stores text', () => fixture(async dir => {
  const path = join(dir, 'arbitrary-file.jsonl');
  const rows = [head('native'), msg('root', null, 1, 'user', '<sample> human question')];
  for (let i = 0; i < 2200; i++) rows.push(msg(`a${i}`, i ? `a${i - 1}` : 'root', i + 2, 'assistant', 'private answer'));
  rows.push(msg('dead', 'a2199', 2300, 'user', 'abandoned question'));
  rows.push(msg('fork', 'root', 2400, 'user', 'active question'));
  await writeFile(path, jsonl(rows));
  const sources = { pi: source(pi, [path]) }, cacheDir = join(dir, 'cache');
  const options = { sources, cacheDir, codexDb: null };
  const before = await load({ sources, sinceMs: t - 1, useCache: false });
  const plain = await readSessions(options);
  assert.equal(plain.sessions[0].id, 'pi:native');
  assert.equal(plain.sessions[0].humanTurns, 2);
  assert.deepEqual(plain.entries.get('pi:native').map(r => r.id), ['root', 'fork']);
  assert.ok(!JSON.stringify(plain.sessions).includes('question'));
  assert.deepEqual(plain.sessions[0].resume, { cwd: '/work/example', argv: ['pi', '--session', 'native'] });
  assert.deepEqual(await readdir(cacheDir), ['sessions-pi-plain.jsonl']);
  const stored = await readFile(join(cacheDir, 'sessions-pi-plain.jsonl'), 'utf8');
  assert.ok(!stored.includes('private answer') && !stored.includes('human question'));
  const text = await readSessions({ ...options, text: true });
  assert.equal(searchTurns(text, 'question', { all: true }).length, 2);
  assert.equal(text.sessions[0].firstAsk, '<sample> human question');
  await appendFile(path, jsonl([msg('next', 'fork', 2500, 'user', 'new turn')]));
  const refreshed = await readSessions({ ...options, text: true });
  assert.equal(refreshed.sessions[0].humanTurns, 3);
  // Reader scan must not put ENTRY records in analytics caches or alter CALL results.
  const after = await load({ sources, sinceMs: t - 1, useCache: false });
  assert.deepEqual(after.calls, before.calls);
  assert.deepEqual(after.compactions, before.compactions);
}));

test('Pi titles preserve the stored date prefix', () => fixture(async dir => {
  const path = join(dir, 'dated.jsonl');
  const name = '20260101-Investigate a long Session title';
  await writeFile(path, jsonl([head('dated'),
    { type: 'session_info', id: 'title', parentId: null, timestamp: iso(1), name }]));
  const catalog = await readSessions({ sources: { pi: source(pi, [path]) }, text: true, useCache: false, codexDb: null });
  assert.equal(catalog.sessions[0].title, name);
}));

test('copies select the newest divergent stream; roles use the whole history', () => fixture(async dir => {
  const a = join(dir, 'a.jsonl'), b = join(dir, 'b.jsonl');
  const start = [head('shared'), msg('u', null, 1, 'user', 'common')];
  await writeFile(a, jsonl([...start, msg('old', 'u', 2, 'user', 'old branch')]));
  await writeFile(b, jsonl([...start,
    msg('leader', 'u', 3, 'assistant', [{ type: 'toolCall', name: 'team_create' }]),
    msg('live', 'u', 4, 'user', 'new branch')]));
  const catalog = await readSessions({ sources: { pi: source(pi, [a, b]) }, useCache: false, text: true, codexDb: null });
  assert.equal(catalog.sessions.length, 1);
  assert.equal(catalog.sessions[0].role, 'leader');
  assert.equal(catalog.coverage[0].copies, 1);
  assert.deepEqual(catalog.entries.get('pi:shared').map(e => e.id), ['u', 'live']);
  assert.equal(searchTurns(catalog, 'old', { all: true }).length, 0);
}));

test('search returns turn, title and last reply anchors; injected turns stay visible', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl([head('search'), msg('u', null, 1, 'user', 'needle ask'),
    msg('injected', 'u', 2, 'user', '<system-reminder>needle'),
    msg('reply', 'injected', 3, 'assistant', 'needle reply'),
    { type: 'session_info', id: 'title', parentId: 'reply', timestamp: iso(4), name: 'needle title' }]));
  const c = await readSessions({ sources: { pi: source(pi, [path]) }, text: true, useCache: false, codexDb: null });
  const hits = searchTurns(c, 'needle', { all: true });
  assert.deepEqual(hits.map(h => h.kind), ['title', 'reply', 'human']);
  assert.deepEqual(hits.map(h => h.t), [t + 4, t + 3, t + 1]);
  assert.equal(searchTurns(c, 'needle', { all: true, sinceMs: t + 2 }).length, 2);
  assert.equal(c.entries.get('pi:search')[1].kind, 'injected');
}));

test('Pi fork children do not promote parents; worker children do; worker search needs --all', () => fixture(async dir => {
  const parentPath = join(dir, 'parent.jsonl'), childPath = join(dir, 'child.jsonl');
  const leaderPath = join(dir, 'leader.jsonl'), workerPath = join(dir, 'worker.jsonl');
  await writeFile(parentPath, jsonl([head('parent'), msg('ask', null, 1, 'user', 'parent question')]));
  await writeFile(childPath, jsonl([{ ...head('child'), parentSession: parentPath }, msg('ask', null, 2, 'user', 'child question')]));
  await writeFile(leaderPath, jsonl([head('coordinator'), msg('ask', null, 1, 'user', 'coordinate question')]));
  await writeFile(workerPath, jsonl([{ ...head('worker'), parentSession: leaderPath },
    { type: 'custom_message', customType: 'task-change', id: 'task', parentId: null, timestamp: iso(2), content: 'assigned work' },
    msg('reply', 'task', 3, 'assistant', 'unique worker reply')]));
  const catalog = await readSessions({ sources: { pi: source(pi, [parentPath, childPath, leaderPath, workerPath]) }, text: true, useCache: false, codexDb: null });
  assert.equal(catalog.sessions.find(s => s.session === 'parent').role, 'solo');
  assert.equal(catalog.sessions.find(s => s.session === 'child').parent, 'pi:parent');
  assert.equal(catalog.sessions.find(s => s.session === 'coordinator').role, 'leader');
  assert.equal(catalog.sessions.find(s => s.session === 'worker').role, 'worker');
  assert.equal(searchTurns(catalog, 'unique worker reply').length, 0);
  const hits = searchTurns(catalog, 'unique worker reply', { all: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'reply');
  assert.equal(hits[0].t, t + 3);
}));

test('reader cache directory and files resist umask 022', () => fixture(async dir => {
  const path = join(dir, 's.jsonl'), cacheDir = join(dir, 'cache');
  await writeFile(path, jsonl([head('permissions'), msg('u', null, 1, 'user', 'private text')]));
  await mkdir(cacheDir, { mode: 0o755 });
  const old = process.umask(0o022);
  try {
    for (const text of [false, true]) await readSessions({ sources: { pi: source(pi, [path]) }, cacheDir, text, codexDb: null });
  } finally { process.umask(old); }
  assert.equal((await stat(cacheDir)).mode & 0o777, 0o700);
  for (const name of await readdir(cacheDir)) assert.equal((await stat(join(cacheDir, name))).mode & 0o777, 0o600);
}));

test('catalog discovery widens Claude without changing analytics population', () => fixture(async dir => {
  const project = join(dir, 'project');
  await mkdir(join(project, 'main', 'subagents'), { recursive: true });
  const main = join(project, 'main.jsonl'), child = join(project, 'main', 'subagents', 'child.jsonl');
  const bridgeDir = join(dir, 'magpie-c-synthetic'); await mkdir(bridgeDir);
  const bridge = join(bridgeDir, 'bridge.jsonl');
  const log = sid => jsonl([
    { type: 'user', uuid: 'u', parentUuid: null, sessionId: sid === 'child' ? 'main' : sid, ...(sid === 'child' ? { agentId: 'child' } : {}), timestamp: iso(1), cwd: '/work/example', message: { content: 'hello' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', sessionId: sid === 'child' ? 'main' : sid, ...(sid === 'child' ? { agentId: 'child' } : {}), timestamp: iso(2), message: { id: `m-${sid}`, model: 'synthetic-model', content: [], usage: { input_tokens: 10, output_tokens: 2 } } },
  ]);
  await writeFile(main, log('main')); await writeFile(child, log('child')); await writeFile(bridge, log('bridge'));
  const narrow = await claude.list(dir);
  const analyticsSource = source(claude, narrow);
  const before = await load({ sources: { claude: analyticsSource }, sinceMs: t - 1, useCache: false });
  const catalog = await readSessions({ sources: { claude: source(claude, await claude.list(dir, true)) }, useCache: false, codexDb: null });
  assert.equal(catalog.sessions.length, 3);
  assert.equal(catalog.sessions.find(s => s.session === 'child').role, 'worker');
  assert.equal(catalog.sessions.find(s => s.session === 'main').role, 'leader');
  const after = await load({ sources: { claude: source(claude, await claude.list(dir)) }, sinceMs: t - 1, useCache: false });
  assert.equal(before.calls.length, 1);
  assert.deepEqual(after.calls, before.calls);
}));

test('Codex uses header identity, role and archive independently', () => fixture(async dir => {
  const path = join(dir, 'archived_sessions', 'rollout-synthetic.jsonl'); await mkdir(join(dir, 'archived_sessions'));
  await writeFile(path, jsonl([
    { type: 'session_meta', timestamp: iso(0), payload: { id: 'codex-native', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, cwd: '/work/example' } },
    { type: 'response_item', timestamp: iso(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'worker ask' }] } },
  ]));
  const c = await readSessions({ sources: { codex: source(codex, [path]) }, useCache: false, codexDb: null });
  assert.equal(c.sessions[0].id, 'codex:codex-native');
  assert.equal(c.sessions[0].role, 'worker');
  assert.equal(c.sessions[0].archived, true);
  assert.equal(c.sessions[0].parent, 'codex:parent');
}));

// The CLI must filter lineage-only records, retain abandoned-branch usage, and
// keep text absent in all default formats. HOME points only at synthetic logs.
test('CLI privacy, branch populations, text selection and id errors', () => fixture(async dir => {
  const folder = join(dir, '.pi', 'agent', 'sessions', 'example');
  await mkdir(folder, { recursive: true });
  const path = join(folder, 'unrelated-name.jsonl');
  const usage = { provider: 'synthetic', model: 'example', timestamp: t + 2,
    usage: { input: 10, output: 2 }, stopReason: 'stop' };
  await writeFile(path, jsonl([{ ...head('cli'), cwd: "/work/example's space" }, msg('u', null, 1, 'user', 'visible question'),
    msg('old', 'u', 2, 'assistant', 'abandoned answer', usage),
    msg('active', 'u', 3, 'assistant', 'active answer', { ...usage, timestamp: t + 3 }),
    msg('tool', 'active', 4, 'toolResult', 'full tool text', { toolName: 'example' })]));
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL('../bin/sessions.mjs', import.meta.url));
  const invoke = (...args) => run(process.execPath, [cli, ...args], { env: { ...process.env, HOME: dir, TRACE_ANALYTICS_HOST: '' } });
  const sessions = JSON.parse((await invoke('sessions', '--format', 'json')).stdout);
  assert.equal(sessions[0].id, 'pi:cli');
  assert.deepEqual([sessions[0].host, sessions[0].ref], ['local', 'local/pi:cli']);
  const hosted = JSON.parse((await invoke('entries', 'pi:cli', '--host', 'box-2', '--text', '--format', 'json')).stdout);
  assert.deepEqual(hosted.map(e => e.ref), ['box-2/pi:cli#u', 'box-2/pi:cli#active', 'box-2/pi:cli#tool']);
  await assert.rejects(invoke('sessions', '--host', 'a/b'), error => error.code === 1);
  assert.ok(!('firstAsk' in sessions[0]) && !('title' in sessions[0]));
  assert.equal(JSON.parse((await invoke('sessions', '--id', 'pi:cli', '--text', '--format', 'json')).stdout)[0].lastReply, 'active answer');
  const entries = JSON.parse((await invoke('entries', 'pi:cli', '--format', 'json')).stdout);
  assert.deepEqual(entries.map(e => e.id), ['u', 'active', 'tool']);
  assert.ok(entries.every(e => !('text' in e)));
  const full = JSON.parse((await invoke('entries', 'pi:cli', '--text', '--format', 'json')).stdout);
  assert.equal(full.at(-1).text, 'full tool text');
  const calls = JSON.parse((await invoke('calls', '--since', iso(0), '--until', iso(3), '--format', 'json')).stdout);
  assert.equal(calls.filter(c => c.kind === 'call').length, 1);
  assert.equal(calls[0].id, 'old');
  assert.equal(calls[0].session, 'cli');
  assert.equal(JSON.parse((await invoke('calls', '--since', iso(0), '--format', 'json')).stdout).filter(c => c.kind === 'call').length, 2);
  const table = (await invoke('sessions', '--format', 'table')).stdout;
  assert.ok(table.includes('updated\tid\trole\tturns\tcwd'));
  assert.ok(table.includes('2026-01-01T00:00Z\tpi:cli\tsolo\t1'));
  assert.ok(table.includes("cd '/work/example'\\''s space' && 'pi' '--session' 'cli'"));
  assert.ok(!table.includes('answer') && !table.includes('firstAsk'));
  assert.ok((await invoke('sessions', '--text', '--format', 'table')).stdout.includes('\tcwd\ttitle'));
  assert.ok((await invoke('search', 'visible question', '--format', 'table')).stdout.includes('time\tsession\tkind\tsnippet'));
  assert.equal(JSON.parse((await invoke('sessions', '--since', iso(2), '--until', iso(3), '--format', 'json')).stdout).length, 1);
  await assert.rejects(invoke('entries', 'missing'), error => error.code === 2 && error.stderr.includes('pi:cli'));
  await assert.rejects(invoke('sessions', '--since', 'not-a-date'), error => error.code === 1);
}));

// Schema evolution must not turn the private database into a required writable store.
test('Codex read-only metadata supports old schema and spawn-edge roles', () => fixture(async dir => {
  const run = promisify(execFile), db = join(dir, 'state.sqlite');
  await run('sqlite3', [db, `create table threads(id text, source text, thread_source text, originator text,
    first_user_message text, archived int, name text, cwd text, rollout_path text, created_at_ms int, updated_at_ms int);
    insert into threads values('parent','cli','user',null,'ask',1,'title','/work/example',null,${t},${t + 2});
    insert into threads values('worker','cli','subagent',null,'ask',0,null,'/work/example',null,${t},${t + 2});
    insert into threads values('auto','exec','user',null,'ask',0,null,'/work/example',null,${t},${t + 2});`]);
  const options = { sources: { codex: source(codex, []) }, codexDb: db, useCache: false };
  const old = await readSessions(options);
  assert.equal(old.sessions.find(s => s.session === 'parent').role, 'solo');
  assert.equal(old.sessions.find(s => s.session === 'auto').role, 'automated');
  assert.equal(old.sessions.find(s => s.session === 'worker').role, 'worker');
  await run('sqlite3', [db, "create table thread_spawn_edges(parent_thread_id text, child_thread_id text); insert into thread_spawn_edges values('parent','worker');"]);
  const before = await readFile(db);
  const current = await readSessions({ ...options, text: true });
  assert.equal(current.sessions.find(s => s.session === 'parent').role, 'leader');
  assert.equal(current.sessions.find(s => s.session === 'parent').archived, true);
  assert.equal(current.sessions.find(s => s.session === 'worker').parent, 'codex:parent');
  assert.equal(searchTurns(current, 'title', { all: true })[0].kind, 'title');
  assert.deepEqual(await readFile(db), before);
}));

// Fixture times sit far from each cutoff so process startup cannot change membership.
test('CLI relative since/until spans keep all units and reject malformed values', () => fixture(async dir => {
  const folder = join(dir, '.pi', 'agent', 'sessions', 'example');
  await mkdir(folder, { recursive: true });
  const now = Date.now();
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  for (const [unit, span] of Object.entries(units)) for (const [age, factor] of [['recent', 0.5], ['older', 2]]) {
    const id = `${age}-${unit}`, stamp = new Date(now - span * factor).toISOString();
    await writeFile(join(folder, `${id}.jsonl`), jsonl([
      { ...head(id), timestamp: stamp }, { ...msg('ask', null, 1, 'user', 'synthetic ask'), timestamp: stamp },
    ]));
  }
  const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/sessions.mjs', import.meta.url));
  const invoke = (...args) => run(process.execPath, [cli, 'sessions', '--all', '--format', 'json', ...args], { env: { ...process.env, HOME: dir } });
  for (const unit of Object.keys(units)) {
    const since = JSON.parse((await invoke('--since', `1${unit}`)).stdout).map(s => s.session);
    assert.ok(since.includes(`recent-${unit}`));
    assert.ok(!since.includes(`older-${unit}`));
    const until = JSON.parse((await invoke('--until', `1${unit}`)).stdout).map(s => s.session);
    assert.ok(until.includes(`older-${unit}`));
    assert.ok(!until.includes(`recent-${unit}`));
  }
  for (const bad of ['-1d', '1.5h', '7x', 'Infinitym', '9999999999999999999999999d']) {
    await assert.rejects(invoke('--since', bad), error => error.code === 1);
    await assert.rejects(invoke('--until', bad), error => error.code === 1);
  }
}));

test('search requires every term in one record and sorts unlogged title time last', () => fixture(async dir => {
  const path = join(dir, 'keywords.jsonl');
  await writeFile(path, jsonl([head('keywords'),
    msg('human', null, 1, 'user', 'Please IMPROVE this useful skill'),
    msg('second', 'human', 2, 'user', 'improve alone'),
    msg('third', 'second', 3, 'user', 'skill alone'),
    msg('reply', 'third', 4, 'assistant', 'skill can improve'),
    { type: 'session_info', name: 'skill to improve' },
  ]));
  const catalog = await readSessions({ sources: { pi: source(pi, [path]) }, text: true, useCache: false, codexDb: null });
  const hits = searchTurns(catalog, '  improve   SKILL  ', { all: true });
  assert.deepEqual(hits.map(h => h.kind), ['reply', 'human', 'title']);
  assert.deepEqual(hits.map(h => h.t), [t + 4, t + 1, null]);
  assert.equal(searchTurns(catalog, '   ', { all: true }).length, 0);
}));

test('Claude active branch follows logical parent at a compact boundary', () => fixture(async dir => {
  const path = join(dir, 'claude.jsonl');
  const entry = (uuid, parentUuid, n, extra) => ({ uuid, parentUuid, sessionId: 'claude-fork', timestamp: iso(n), cwd: '/work/example', ...extra });
  await writeFile(path, jsonl([
    entry('root', null, 1, { type: 'user', message: { content: 'root ask' } }),
    entry('abandoned', 'root', 2, { type: 'user', message: { content: 'abandoned ask' } }),
    entry('boundary', null, 3, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'root' }),
    entry('summary', 'boundary', 4, { type: 'user', isCompactSummary: true, message: { content: 'summary' } }),
    entry('active', 'summary', 5, { type: 'user', message: { content: 'active ask' } }),
  ]));
  const catalog = await readSessions({ sources: { claude: source(claude, [path]) }, text: true, useCache: false, codexDb: null });
  assert.deepEqual(catalog.entries.get('claude:claude-fork').map(e => e.id), ['root', 'boundary', 'summary', 'active']);
  assert.equal(catalog.sessions[0].branch, 'complete');
  assert.equal(catalog.sessions[0].humanTurns, 2);
  assert.equal(searchTurns(catalog, 'abandoned', { all: true }).length, 0);
}));

test('missing parents and cycles mark ancestry partial; Pi title stays Session-wide', () => fixture(async dir => {
  const missing = join(dir, 'missing.jsonl'), cycle = join(dir, 'cycle.jsonl'), title = join(dir, 'title.jsonl');
  await writeFile(missing, jsonl([head('missing'), msg('ask', 'unlogged', 1, 'user', 'partial ask')]));
  await writeFile(cycle, jsonl([head('cycle'), msg('a', 'b', 1, 'user', 'cycle ask'), msg('b', 'a', 2, 'assistant', 'cycle reply')]));
  await writeFile(title, jsonl([head('title'), msg('root', null, 1, 'user', 'root ask'),
    { type: 'session_info', id: 'offbranch-title', parentId: 'root', timestamp: iso(2), name: 'global label' },
    msg('fork', 'root', 3, 'user', 'fork ask')]));
  const catalog = await readSessions({ sources: { pi: source(pi, [missing, cycle, title]) }, text: true, useCache: false, codexDb: null });
  assert.equal(catalog.sessions.find(s => s.session === 'missing').branch, 'partial');
  assert.equal(catalog.sessions.find(s => s.session === 'cycle').branch, 'partial');
  assert.equal(catalog.sessions.find(s => s.session === 'title').branch, 'complete');
  assert.ok(!catalog.entries.get('pi:title').some(e => e.id === 'offbranch-title'));
  assert.equal(searchTurns(catalog, 'global label', { all: true })[0].kind, 'title');
}));
