import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableSession, piShaped } from '../src/sources/durable.mjs';
import { durableCopyCheckpoint, durableCopyFiles, openDurableCopy, removeDurableCopy, writeDurableCopy } from '../src/sources/durable-copy.mjs';

let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), ...await import('./fixtures/durable-node.mjs'),
    context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const HOST = 'demo';
async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-copy-'));
  const { harness, root } = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  const node = fixture.serviceNode(harness);
  t.after(async () => { await node.harness.close(fixture.context); rmSync(dir, { recursive: true, force: true }); });
  return { dir, node, root, harness };
}
/** One hub-side sync step: refresh without retaining, then commit what it read into the copy. */
async function sync(r, file) {
  const change = await r.refresh();
  assert.equal(change.status, 'ready', JSON.stringify(change.error));
  writeDurableCopy(file, { host: HOST, threadId: r.threadId, reset: change.reset, records: change.records,
    checkpoint: r.snapshot(), conversation: r.conversation(), docs: r.docs().docs });
  return change;
}
const visitAll = (copy, options) => { const rows = []; copy.visit((row) => rows.push(row), options); return rows; };

test('real store: the copy equals a retained read, streams from disk, and cites like the source', real, async (t) => {
  const { dir, node, root, harness } = await store(t);
  const { fork } = await fixture.buildFixture(harness, root);
  for (const conversation of [root, fork]) {
    const threadId = `tree-a.${conversation.id}`, file = join(dir, `${conversation.id}.jsonl`);
    const hub = openDurableSession({ node, threadId, host: HOST, retain: false });
    const full = openDurableSession({ node, threadId, host: HOST });
    t.after(() => { hub.close(); full.close(); });
    await sync(hub, file); await full.refresh();
    assert.equal(hub.entries().length, 0, 'a non-retaining reader holds no history');
    const copy = openDurableCopy(file, { host: HOST });
    copy.refresh();
    const rows = visitAll(copy);
    assert.deepEqual(rows.map((r) => r.entry), full.entries(), 'copy entries equal the retained reader');
    assert.deepEqual(rows.map((r) => r.position), rows.map((_, i) => i));
    const session = copy.session(), expected = full.session();
    for (const key of ['id', 'ref', 'role', 'parent', 'forkAt', 'owner', 'started', 'updated', 'humanTurns', 'firstAsk', 'lastAsk', 'lastReply'])
      assert.deepEqual(session[key], expected[key], key);
    assert.equal(session.tip, rows.at(-1).entry.id);
    const one = rows[Math.floor(rows.length / 2)];
    assert.deepEqual(copy.entry(one.entry.id), one.entry);
    const raw = JSON.parse(copy.entryBytes(one.entry.id).text);
    assert.equal(String(raw.id), one.entry.id);
    assert.deepEqual(one.native, piShaped(raw));
    if (conversation === fork) assert.ok(Number.isFinite(session.inheritedBefore), 'a fork marks its inherited span');
    else assert.ok(Number.isNaN(session.inheritedBefore));
    copy.close();
  }
});

test('real store: appends commit incrementally; a restart restores the checkpoint and validates it first', real, async (t) => {
  const { dir, node, root, harness } = await store(t);
  await fixture.buildFixture(harness, root);
  const threadId = `tree-a.${root.id}`, file = join(dir, 'root.jsonl');
  const a = openDurableSession({ node, threadId, host: HOST, retain: false });
  t.after(() => a.close());
  await sync(a, file);
  const before = statSync(durableCopyFiles(file).data).size;
  const copy = openDurableCopy(file, { host: HOST });
  const v1 = copy.refresh().version;
  const tip = copy.session().tip;
  await fixture.ask(root, 'one more');
  const change = await sync(a, file);
  assert.equal(change.reset, false);
  assert.ok(change.records.length >= 2 && change.records.length <= 3, 'only new records are written');
  assert.ok(statSync(durableCopyFiles(file).data).size > before);
  const second = copy.refresh();
  assert.equal(second.reset, false);
  assert.ok(copy.continues(v1), 'the same generation continues the older version');
  const appended = visitAll(copy, { after: tip });
  assert.equal(appended.length, change.records.length);
  assert.equal(appended[0].entry.parent, tip);

  // A hub restart: the reader restores the copy's checkpoint and the first refresh validates it.
  const checkpoint = durableCopyCheckpoint(file, { host: HOST, threadId });
  assert.equal(checkpoint.items.length, 0, 'the checkpoint holds no history');
  const b = openDurableSession({ node, threadId, host: HOST, retain: false, restore: checkpoint });
  t.after(() => b.close());
  const resumed = await sync(b, file);
  assert.equal(resumed.reset, false);
  assert.equal(resumed.records.length, 0);
  copy.close();
});

test('real store: a divergent node history rewrites the copy under a new generation', real, async (t) => {
  const { dir, node, root, harness } = await store(t);
  await fixture.buildFixture(harness, root);
  const threadId = `tree-a.${root.id}`, file = join(dir, 'root.jsonl');
  const a = openDurableSession({ node, threadId, host: HOST, retain: false });
  t.after(() => a.close());
  await sync(a, file);
  const copy = openDurableCopy(file, { host: HOST });
  const v1 = copy.refresh().version;
  const count = copy.info().count;
  // A checkpoint whose boundary bytes do not match the node's entry at that ID: never joined.
  const forged = { ...durableCopyCheckpoint(file, { host: HOST, threadId }), boundary: '0'.repeat(64) };
  const b = openDurableSession({ node, threadId, host: HOST, retain: false, restore: forged });
  t.after(() => b.close());
  const change = await sync(b, file);
  assert.equal(change.reset, true);
  assert.equal(change.resetReason, 'divergent');
  assert.equal(change.records.length, count, 'a reset writes the whole history');
  const next = copy.refresh();
  assert.equal(next.reset, true);
  assert.ok(!copy.continues(v1), 'a new generation never continues an older version');
  assert.equal(visitAll(copy).length, count);
  copy.close();
});

test('copy: an uncommitted tail is invisible and the next write drops it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-copy-tail-'));
  try {
    const file = join(dir, 'c.jsonl'), threadId = 'tree-a.1';
    const rec = (id, text) => ({ id, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 1000 + id }] });
    const conversation = { id: 1 };
    writeDurableCopy(file, { host: HOST, threadId, reset: true, records: [rec(1, 'a'), rec(2, 'b')], checkpoint: null, conversation });
    appendFileSync(durableCopyFiles(file).data, `${JSON.stringify(rec(3, 'torn'))}\n`);
    const copy = openDurableCopy(file, { host: HOST });
    copy.refresh();
    assert.deepEqual(visitAll(copy).map((r) => r.entry.id), ['1', '2']);
    writeDurableCopy(file, { host: HOST, threadId, reset: false, records: [rec(3, 'c')], checkpoint: null, conversation });
    copy.refresh();
    assert.deepEqual(visitAll(copy).map((r) => r.entry.blocks[0].text), ['a', 'b', 'c']);
    assert.equal(readFileSync(durableCopyFiles(file).data, 'utf8').trim().split('\n').length, 3);
    assert.equal(copy.session().humanTurns, 3);
    removeDurableCopy(file);
    assert.throws(() => copy.refresh(), /rebuild it from the node/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('piShaped: Pi-native shapes for published readers; no guessed Pi analog', () => {
  const m = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 0 };
  assert.deepEqual(piShaped({ id: 4, kind: 'pi.assistant', model: [m] }), { type: 'message', id: '4', parentId: null, timestamp: '1970-01-01T00:00:00.000Z', message: m });
  assert.equal(piShaped({ id: 5, kind: 'pi.compaction', model: [{ role: 'user', content: 'sum', timestamp: 0 }] }).summary, 'sum');
  assert.equal(piShaped({ id: 6, kind: 'pi.system', model: [] }).type, 'durable');
  assert.equal(piShaped({ id: 7, kind: 'x.note', data: { a: 1 } }).type, 'custom');
  assert.equal(piShaped({ id: 8, kind: 'x.mention', model: [{ role: 'user', content: 'yo', timestamp: 0 }] }).content, 'yo');
});
