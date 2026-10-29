import "./home.mjs";
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeBranch } from '../src/sources/lineage.mjs';
import { openPiSession } from '../src/sources/transcript.mjs';
import { openPiSessionRange } from '../src/sources/transcript-range.mjs';

const line = (o) => `${JSON.stringify(o)}\n`;
const header = { type: 'session', id: 'synthetic', timestamp: '2026-01-01T00:00:00Z', cwd: '/example', parentSession: '/example/parent.jsonl' };
const msg = (id, parentId, text = id) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text }] } });
function setup(t, records) {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-range-'));
  const path = join(dir, 'source.jsonl'), indexPath = join(dir, 'index.sqlite');
  writeFileSync(path, [header, ...records].map(line).join(''));
  const reader = openPiSessionRange(path, { host: 'example', indexPath });
  t.after(() => { reader.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, indexPath, reader };
}
async function parity(path, reader) {
  await reader.refresh();
  const full = openPiSession(path, { host: 'example' });
  await full.refresh();
  const native = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.id && r.type !== 'session');
  const expected = activeBranch(native.map((r) => ({ id: r.id, parent: r.parentId ?? null })), native.at(-1)?.id);
  const ids = [];
  let before, page;
  do {
    page = reader.page({ before, limit: 137 });
    ids.unshift(...page.entries.map((e) => e.id));
    before = page.entries[0]?.id;
  } while (page.more);
  assert.deepEqual(ids, expected.entries.map((e) => e.id));
  assert.deepEqual(ids, full.entries().map((e) => e.id));
  assert.equal(page.branch, expected.branch);
  assert.deepEqual(reader.page().entries.map((e) => e.id), ids.slice(-400));
  return ids;
}

test('range ancestry survives an append whose parent is outside the newest 400 entries', async (t) => {
  const records = Array.from({ length: 650 }, (_, i) => msg(`e${i}`, i ? `e${i - 1}` : null));
  const { path, reader } = setup(t, records);
  assert.equal((await parity(path, reader)).length, 650);
  const old = reader.page();
  appendFileSync(path, line(msg('fork', 'e10')));
  assert.equal((await parity(path, reader)).length, 12);
  assert.throws(() => reader.page({ before: 'e600' }), /active branch/);
  assert.throws(() => reader.page({ version: old.version }), /stale/);
});

test('range parity retains imported fork and compaction ancestry across reset and restart', async (t) => {
  const records = [
    { ...msg('seed', null), rarebitFork: { version: 'rarebit-fork-entry/1', kind: 'seed' } },
    { ...msg('import', 'seed'), rarebitFork: { version: 'rarebit-fork-entry/1', kind: 'import' } },
    { type: 'custom', id: 'lineage', parentId: 'import', customType: 'rarebit-fork-lineage', data: { schemaVersion: 1, importedEntryIds: ['import'], opening: { seedEntryId: 'seed' } } },
    { type: 'compaction', id: 'compact', parentId: 'lineage', summary: 'Synthetic summary', firstKeptEntryId: 'import' },
    msg('last', 'compact'),
  ];
  const { path, indexPath, reader } = setup(t, records);
  assert.equal((await parity(path, reader)).length, 5);
  reader.close();
  const reopened = openPiSessionRange(path, { host: 'example', indexPath });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.page().entries.map((e) => e.id), records.map((r) => r.id));
  writeFileSync(path, line(header) + line(msg('other', null)));
  assert.deepEqual(await parity(path, reopened), ['other']);
  const prior = reopened.info().version;
  writeFileSync(path, line(header) + line(msg('equal', null))); // same length replacement
  assert.deepEqual(await parity(path, reopened), ['equal']);
  assert.notEqual(reopened.info().version, prior);
});

test('range pages disclose previews and recover tool bodies by exact offset', async (t) => {
  const result = { type: 'message', id: 'tool', parentId: null, message: { role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text: 'x'.repeat(200_000) }] } };
  const { reader } = setup(t, [result]);
  await reader.refresh();
  const tail = reader.page();
  assert.equal(tail.entries[0].result.text.length, 2048);
  assert.equal(tail.entries[0].truncated, true);
  assert.equal(reader.entry('tool', { full: true, version: tail.version }).result.text.length, 200_000);
  assert.equal(tail.entries[0].ref, 'example/pi:synthetic#tool');
});

test('range index never accepts a partial trailing line or loops on cyclic ancestry', async (t) => {
  const { path, reader } = setup(t, [msg('a', 'b'), msg('b', 'a')]);
  assert.deepEqual(await parity(path, reader), ['a', 'b']);
  assert.equal(reader.info().branch, 'partial');
  const row = line(msg('c', 'b'));
  appendFileSync(path, row.slice(0, -1));
  await reader.refresh();
  assert.deepEqual(reader.page().entries.map((e) => e.id), ['a', 'b']);
  appendFileSync(path, '\n');
  assert.deepEqual(await parity(path, reader), ['a', 'b', 'c']);
});

test('range index keeps missing-parent uncertainty instead of inventing a root', async (t) => {
  const { path, reader } = setup(t, [msg('a', 'missing'), msg('b', 'a')]);
  assert.deepEqual(await parity(path, reader), ['a', 'b']);
  assert.equal(reader.info().branch, 'partial');
  appendFileSync(path, line(msg('c', 'b')));
  assert.deepEqual(await parity(path, reader), ['a', 'b', 'c']);
  assert.equal(reader.info().branch, 'partial');
});

test('range preview budget changes invalidate persisted text rather than retaining oversized pages', async (t) => {
  const { path, indexPath, reader } = setup(t, [msg('a', null, 'x'.repeat(4096))]);
  await reader.refresh(); reader.close();
  const smaller = openPiSessionRange(path, { host: 'example', indexPath, previewChars: 128 });
  t.after(() => smaller.close());
  await smaller.refresh();
  assert.equal(smaller.page().entries[0].blocks[0].text.length, 128);
});

test('stream visits keep full source records outside the preview and byte pages preserve UTF-8', async (t) => {
  const text = '你好🌟'.repeat(30000);
  const record = msg('a', null, text);
  const { path, reader } = setup(t, [record]);
  await reader.refresh();
  const visited = [];
  reader.visit(({ native, entry, position }) => visited.push([native.message.content[0].text.length, entry.id, position]));
  assert.deepEqual(visited.map(v => v.slice(0, 2)), [[text.length, 'a']]);
  let offset = 0, result = '', part;
  do { part = reader.entryBytes('a', { offset, limit: 65536 }); assert.ok(Buffer.byteLength(part.text) <= 65536); result += part.text; offset = part.next; } while (part.more);
  assert.deepEqual(JSON.parse(result), record);
  appendFileSync(path, line(msg('b', 'a'))); await reader.refresh();
  const ids = []; reader.visit(({ entry }) => ids.push(entry.id), { after: 'a' });
  assert.deepEqual(ids, ['b']);
  assert.throws(() => reader.entryBytes('a', { limit: 65537 }), /Invalid/);
  assert.throws(() => reader.visit(() => {}, { after: 'missing' }), /active branch/);
});

test('title records survive a warm reopen without retaining source text in observations', async (t) => {
  const { path, indexPath, reader } = setup(t, [msg('a', null), { type: 'session_info', id: 'name', parentId: 'a', name: '20260101-Synthetic title' }]);
  await reader.refresh(); assert.equal(reader.session().title, '20260101-Synthetic title'); reader.close();
  const reopened = openPiSessionRange(path, { host: 'example', indexPath });
  t.after(() => reopened.close());
  assert.equal(reopened.session().title, '20260101-Synthetic title');
});

test('range index identity cannot reuse another Hosts citations', async (t) => {
  const { path, indexPath, reader } = setup(t, [msg('a', null)]);
  await reader.refresh(); reader.close();
  const other = openPiSessionRange(path, { host: 'other', indexPath });
  t.after(() => other.close());
  await other.refresh();
  assert.equal(other.page().entries[0].ref, 'other/pi:synthetic#a');
});
