// Synthetic logs only. Tests target the live transcript: appends, resets, branch moves,
// Host identity across copies, and agreement with the catalog reader.
import "./home.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, appendFile, copyFile, rm, mkdir, truncate, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPiSession } from 'trace-analytics/transcript';
import { pi } from '../src/sources/pi.mjs';
import { readSessions } from '../src/sources/sessions.mjs';

const t0 = Date.parse('2026-01-01T00:00:00Z');
const iso = n => new Date(t0 + n).toISOString();
const head = id => ({ type: 'session', id, timestamp: iso(0), cwd: '/work/example' });
const msg = (id, parent, n, role, content, extra = {}) => ({ type: 'message', id, parentId: parent, timestamp: iso(n),
  message: { role, content, ...extra } });
const line = r => JSON.stringify(r) + '\n';
const jsonl = rows => rows.map(line).join('');
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const rich = () => [head('native'),
  msg('u1', null, 1, 'user', 'synthetic ask'),
  msg('a1', 'u1', 2, 'assistant', [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'calling' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'x.txt' } }],
  { provider: 'example', model: 'model-1', stopReason: 'toolUse', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } } }),
  msg('r1', 'a1', 3, 'toolResult', [{ type: 'text', text: 'line one' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }, { type: 'text', text: 'line two' }],
    { toolCallId: 'c1', toolName: 'read', isError: false }),
  msg('u2', 'r1', 4, 'user', [{ type: 'text', text: '<system-reminder>injected' }, { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }]),
  { type: 'custom_message', id: 'cm', parentId: 'u2', timestamp: iso(5), customType: 'example.note', content: 'note text', display: true },
  { type: 'custom', id: 'cu', parentId: 'cm', timestamp: iso(6), customType: 'tps', data: { n: 1 } },
  { type: 'compaction', id: 'k1', parentId: 'cu', timestamp: iso(7), summary: 'summary text', tokensBefore: 100 },
];

test('TranscriptEntry carries blocks, results, usage, custom and compaction without image bytes', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl(rich()));
  const s = openPiSession(path, { host: 'hostA' });
  const { reset, added } = await s.refresh();
  assert.equal(reset, true);
  assert.deepEqual(added, s.entries());
  const [u1, a1, r1, u2, cm, cu, k1] = s.entries();
  assert.deepEqual(u1, { ref: 'hostA/pi:native#u1', id: 'u1', parent: null, t: t0 + 1, kind: 'human', name: null, role: 'user',
    blocks: [{ type: 'text', text: 'synthetic ask' }] });
  assert.deepEqual(a1.blocks, [{ type: 'thinking', text: 'plan' }, { type: 'text', text: 'calling' },
    { type: 'toolCall', id: 'c1', name: 'read', args: { path: 'x.txt' } }]);
  assert.equal(a1.model, 'model-1');
  assert.equal(a1.stop, 'toolUse');
  assert.equal(a1.error, undefined);
  assert.deepEqual(a1.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01 });
  assert.deepEqual(r1.result, { callId: 'c1', isError: false, text: 'line one\nline two' });
  assert.equal(r1.kind, 'tool'); assert.equal(r1.name, 'read');
  assert.equal(u2.kind, 'injected');
  assert.deepEqual(u2.blocks[1], { type: 'image', mimeType: 'image/jpeg' });
  assert.ok(!JSON.stringify(s.entries()).includes('QUJD'));
  assert.deepEqual([cm.kind, cm.customType, cm.text], ['injected', 'example.note', 'note text']);
  assert.deepEqual([cu.kind, cu.customType, cu.text], ['other', 'tps', undefined]);
  assert.deepEqual([k1.kind, k1.summary], ['compaction', 'summary text']);
  const session = s.session();
  assert.equal(session.id, 'pi:native');
  assert.equal(session.ref, 'hostA/pi:native');
  assert.equal(session.host, 'hostA');
  assert.equal(session.humanTurns, 1);
}));

test('incremental refresh across appends, including a partial trailing line', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl([head('inc'), msg('u1', null, 1, 'user', 'ask')]));
  const s = openPiSession(path);
  assert.equal((await s.refresh()).added.length, 1);
  assert.deepEqual(await s.refresh(), { reset: false, added: [] });
  const next = line(msg('a1', 'u1', 2, 'assistant', 'reply'));
  await appendFile(path, next.slice(0, 20));
  assert.deepEqual(await s.refresh(), { reset: false, added: [] });
  await appendFile(path, next.slice(20) + line(msg('u2', 'a1', 3, 'user', 'more')));
  const r = await s.refresh();
  assert.equal(r.reset, false);
  assert.deepEqual(r.added.map(e => e.id), ['a1', 'u2']);
  assert.equal(r.added[0].ref, 'local/pi:inc#a1');
  assert.deepEqual(s.entries().map(e => e.id), ['u1', 'a1', 'u2']);
}));

test('truncation and replacement reset to a full reparse', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  const rows = [head('trunc'), msg('u1', null, 1, 'user', 'ask'), msg('a1', 'u1', 2, 'assistant', 'reply')];
  await writeFile(path, jsonl(rows));
  const s = openPiSession(path);
  await s.refresh();
  await truncate(path, jsonl(rows.slice(0, 2)).length);
  let r = await s.refresh();
  assert.equal(r.reset, true);
  assert.deepEqual(r.added.map(e => e.id), ['u1']);
  // Atomic replacement: a new inode with other content and a longer length.
  const other = join(dir, 'other.jsonl');
  await writeFile(other, jsonl([head('trunc'), msg('x1', null, 1, 'user', 'replaced'), msg('x2', 'x1', 2, 'assistant', 'r'),
    msg('x3', 'x2', 3, 'user', 'again')]));
  await rename(other, path);
  r = await s.refresh();
  assert.equal(r.reset, true);
  assert.deepEqual(s.entries().map(e => e.id), ['x1', 'x2', 'x3']);
}));

test('active branch follows the tip across a fork, and a tip move resets', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl([head('fork'), msg('u1', null, 1, 'user', 'ask'), msg('a1', 'u1', 2, 'assistant', 'one'),
    msg('dead', 'a1', 3, 'user', 'abandoned')]));
  const s = openPiSession(path);
  await s.refresh();
  assert.deepEqual(s.entries().map(e => e.id), ['u1', 'a1', 'dead']);
  await appendFile(path, jsonl([msg('alt', 'u1', 4, 'assistant', 'two'), msg('live', 'alt', 5, 'user', 'kept')]));
  const r = await s.refresh();
  assert.equal(r.reset, true);
  assert.deepEqual(r.added.map(e => e.id), ['u1', 'alt', 'live']);
  assert.deepEqual(s.entries().map(e => e.id), ['u1', 'alt', 'live']);
  assert.equal(s.session().humanTurns, 2);
  assert.equal(s.session().branch, 'complete');
  await appendFile(path, line(msg('tail', 'live', 6, 'assistant', 'ok')));
  assert.deepEqual((await s.refresh()).added.map(e => e.id), ['tail']);
}));

test('a byte-for-byte copy keeps Host identity: same entries and refs', () => fixture(async dir => {
  const path = join(dir, 'a', 's.jsonl'), copy = join(dir, 'elsewhere', 'copy.jsonl');
  await mkdir(join(dir, 'a')); await mkdir(join(dir, 'elsewhere'));
  await writeFile(path, jsonl(rich()));
  await copyFile(path, copy);
  const a = openPiSession(path, { host: 'remote-1' }), b = openPiSession(copy, { host: 'remote-1' });
  await a.refresh(); await b.refresh();
  assert.deepEqual(b.entries(), a.entries());
  const { path: pa, ...sa } = a.session(), { path: pb, ...sb } = b.session();
  assert.notEqual(pa, pb);
  assert.deepEqual(sb, sa);
  assert.ok(a.entries().every(e => e.ref.startsWith('remote-1/pi:native#')));
  const prior = process.env.TRACE_ANALYTICS_HOST;
  process.env.TRACE_ANALYTICS_HOST = 'env-host';
  try { assert.equal(openPiSession(path).host, 'env-host'); } finally {
    if (prior === undefined) delete process.env.TRACE_ANALYTICS_HOST; else process.env.TRACE_ANALYTICS_HOST = prior;
  }
  assert.throws(() => openPiSession(path, { host: 'a/b' }), /Invalid host/);
}));

test('catalog ENTRY records agree with TranscriptEntry kinds and refs', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl([...rich(), msg('alt', 'u1', 8, 'assistant', 'fork'), msg('u3', 'alt', 9, 'user', 'go on')]));
  const catalog = await readSessions({ sources: { pi: { ...pi, list: async () => [path] } }, useCache: false, codexDb: null, host: 'hostA' });
  const s = openPiSession(path, { host: 'hostA' });
  await s.refresh();
  const pick = e => ({ id: e.id, parent: e.parent, t: e.t, kind: e.kind, name: e.name, ref: e.ref });
  assert.deepEqual(catalog.entries.get('pi:native').map(pick), s.entries().map(pick));
  assert.ok(catalog.entries.get('pi:native').every(e => e.host === 'hostA'));
  const record = catalog.sessions[0];
  assert.equal(record.ref, 'hostA/pi:native');
  const { title, firstAsk, lastAsk, lastReply, ...live } = s.session();
  assert.deepEqual(live, record);
}));

test('refresh after one appended line costs far less than a full parse (timings logged)', () => fixture(async dir => {
  const path = join(dir, 'big.jsonl');
  const rows = [head('big')];
  for (let i = 0; i < 20000; i++) rows.push(msg(`e${i}`, i ? `e${i - 1}` : null, i + 1, i % 2 ? 'assistant' : 'user', `synthetic ${i}`));
  await writeFile(path, jsonl(rows));
  const s = openPiSession(path);
  let start = performance.now();
  assert.equal((await s.refresh()).added.length, 20000);
  const full = performance.now() - start;
  await appendFile(path, line(msg('last', 'e19999', 20001, 'user', 'one more')));
  start = performance.now();
  const r = await s.refresh();
  const inc = performance.now() - start;
  assert.deepEqual(r.added.map(e => e.id), ['last']);
  assert.equal(s.entries().length, 20001);
  console.log(`# transcript 20k entries: full ${full.toFixed(1)} ms, one-line refresh ${inc.toFixed(2)} ms`);
}));

test('a failed assistant turn keeps its stop reason and error text, even with no content', () => fixture(async dir => {
  const path = join(dir, 's.jsonl');
  await writeFile(path, jsonl([head('failed'), msg('u1', null, 1, 'user', 'ask'),
    msg('a1', 'u1', 2, 'assistant', [], { stopReason: 'error', errorMessage: '529 overloaded' })]));
  const s = openPiSession(path, { host: 'hostA' });
  await s.refresh();
  const a1 = s.entries().find(e => e.id === 'a1');
  assert.equal(a1.kind, 'assistant');
  assert.equal(a1.stop, 'error');
  assert.equal(a1.error, '529 overloaded');
}));
