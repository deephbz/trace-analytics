import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { activeRanges, boundDoc, clipString, createReaderService, expandRanges, LIMITS, watchFrame } from '../src/sources/durable-wire.mjs';
import { openDurableSession } from '../src/sources/durable.mjs';
import { linkKey, parseRef } from '../src/sources/session-state.mjs';

// Real-store tests need pi-durable 1.4.0 (installed by the HyperCarrier checkout); see durable.test.mjs.
let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), ...await import('./fixtures/durable-node.mjs'),
    context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const HOST = 'demo';
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const bytes = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
async function store(t, name = 'store.sqlite', dir = mkdtempSync(join(tmpdir(), 'durable-wire-'))) {
  const opened = await fixture.openFixtureStore(join(dir, name));
  t.after(async () => { await opened.harness.close(fixture.context).catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  return { dir, ...opened };
}
const write = async (conversation, kind, data) =>
  (await conversation.submit({ type: 'write', entry: { kind, data } }, fixture.context)).wait(fixture.context);
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

// (c) Watch bounds.

test('watch: a long string keeps its kept end and never splits a code point', () => {
  const s = 'é'.repeat(10) + '🙂'.repeat(10);
  const tail = clipString(s, 9, 'tail');
  assert.equal(tail.text, '🙂🙂');
  assert.equal(tail.omitted, Buffer.byteLength(s) - 8);
  const head = clipString(s, 5, 'head');
  assert.equal(head.text, 'éé');
  assert.equal(head.omitted, Buffer.byteLength(s) - 4);
});

test('watch: pi.live and pi.inbox stay within their bounds and report what was cut', () => {
  const live = { run: { taskId: 't1', inputs: ['s1'] },
    generation: { attempt: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1 << 20) + 'END' }] } },
    tools: Array.from({ length: 200 }, (_, i) => ({ callId: `c${i}`, name: 'bash', status: 'running', output: `${i}:` + 'o'.repeat(100 << 10) })) };
  const inbox = { items: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, mode: 'followUp', content: `${i}:` + 'q'.repeat(10 << 10) })) };
  const view = { conversation: { id: 1 }, entries: [1, 2, 3, 7].map((id) => ({ id })),
    docs: { 'pi.live': live, 'pi.inbox': inbox, 'pi.provider': { sessionId: 'x' } } };
  const frame = watchFrame(view, { epoch: 1, watchRevision: 3 });

  const rule = LIMITS.docs['pi.live'];
  assert.ok(bytes(frame.docs['pi.live']) <= rule.docBytes);
  assert.ok(frame.docs['pi.live'].generation.message.content[0].text.endsWith('END'), 'streaming text keeps its newest bytes');
  assert.equal(frame.docs['pi.live'].tools.length, rule.arrayItems);
  assert.equal(frame.docs['pi.live'].tools[0].callId, 'c136', 'the newest tool slots survive');
  assert.equal(frame.clipped['pi.live'].items, 200 - rule.arrayItems);

  const kept = frame.docs['pi.inbox'].items;
  assert.equal(kept.length, LIMITS.docs['pi.inbox'].arrayItems);
  assert.equal(kept[0].id, 's0', 'the queue keeps its oldest items');
  assert.ok(kept.every((x) => Buffer.byteLength(x.content) <= LIMITS.docs['pi.inbox'].stringBytes));
  assert.equal(frame.clipped['pi.inbox'].items, 30);
  assert.equal(frame.clipped['pi.inbox'].strings, 20);

  assert.deepEqual(frame.omittedDocs, ['pi.provider'], 'a doc outside the allow list is named, never sent');
  assert.deepEqual(frame.active, { count: 4, ranges: [[1, 3], [7, 7]], complete: true });
  const worst = 4096 + Object.values(LIMITS.docs).reduce((n, d) => n + d.docBytes, 0) + LIMITS.activeRanges * 48;
  assert.ok(bytes(frame) <= worst, `frame ${bytes(frame)} B within ${worst} B`);
});

test('watch: a document over its cap is dropped whole; active ranges cap and round-trip', () => {
  const b = boundDoc({ a: Array.from({ length: 64 }, () => 'x'.repeat(4000)) }, { stringBytes: 4096, arrayItems: 64, keep: 'head', docBytes: 1000 });
  assert.equal(b.value, undefined);
  assert.ok(b.clipped.whole > 1000);
  const ids = [1, 2, 3, 5, 6, 9, 11, 12];
  const r = activeRanges(ids);
  assert.deepEqual(r.ranges, [[1, 3], [5, 6], [9, 9], [11, 12]]);
  assert.deepEqual(expandRanges(r), ids);
  const capped = activeRanges(ids, 2);
  assert.equal(capped.complete, false);
  assert.equal(capped.count, 8);
});

test('watch: real frames carry the active context as ranges and only allowed docs', real, async (t) => {
  const { harness, root } = await store(t);
  await fixture.buildFixture(harness, root);
  const node = fixture.serviceNode(harness);
  const opened = await node.open({ threadId: `tree-a.${root.id}` });
  t.after(() => node.close({ handle: opened.handle }));
  const view = await root.watch(fixture.context);
  const native = view.value.entries.map((e) => e.id);
  await view.stop();
  assert.deepEqual(expandRanges(opened.frame.active), native);
  assert.deepEqual(Object.keys(opened.frame.docs).sort(), ['pi.agent', 'pi.inbox', 'pi.live', 'pi.usage']);
  assert.deepEqual(opened.frame.omittedDocs, ['pi.provider']);
  const fence = await node.fence({ handle: opened.handle });
  assert.equal(fence.upper, Math.max(...native));
  assert.equal(fence.watchRevision, 0);
});

// (c) Allocation, (d) oversized entries.

test('oversized: an entry over the item cap travels as raw chunks with a digest; allocation is measured', real, async (t) => {
  const { harness, root } = await store(t);
  await fixture.ask(root, 'small');
  const big = 'x'.repeat(5 << 20);
  await write(root, 'fixture.note', { note: big });
  await fixture.ask(root, 'after');
  const node = fixture.serviceNode(harness);
  const { handle } = await node.open({ threadId: `tree-a.${root.id}` });
  t.after(() => node.close({ handle }));

  gc();
  const before = process.memoryUsage();
  const t0 = performance.now();
  const page = await node.entries({ handle, order: 'ascending', limit: 400 });
  const ms = performance.now() - t0;
  const after = process.memoryUsage();
  const huge = page.items.find((i) => i.type === 'oversized');
  assert.ok(huge, 'the 5 MiB entry is an oversized item');
  assert.equal(huge.kind, 'fixture.note');
  assert.ok(huge.bytes > 5 << 20);
  assert.ok(bytes(page) <= LIMITS.pageBytes, 'the page stays within its byte budget');
  assert.ok(page.items.filter((i) => i.type === 'entry').every((i) => bytes(i.record) <= LIMITS.entryBytes));
  const delta = (k) => ((after[k] - before[k]) / 2 ** 20).toFixed(1);
  t.diagnostic(`largest record ${(node.service.stats().maxRecordBytes / 2 ** 20).toFixed(2)} MiB; one page ${ms.toFixed(0)} ms; heapUsed +${delta('heapUsed')} MiB, external +${delta('external')} MiB, arrayBuffers +${delta('arrayBuffers')} MiB, rss +${delta('rss')} MiB`);

  const parts = [];
  let exportId, offset = 0, chunks = 0;
  for (;;) {
    const c = await node.raw({ handle, id: huge.id, exportId, offset });
    exportId = c.exportId; chunks++;
    assert.equal(c.offset, offset);
    assert.equal(c.encoding, 'base64');
    const part = Buffer.from(c.data, 'base64');
    assert.ok(part.length <= LIMITS.chunkBytes);
    parts.push(part); offset += part.length;
    if (c.done) { assert.equal(c.sha256, huge.sha256); break; }
  }
  assert.equal(chunks, Math.ceil(huge.bytes / LIMITS.chunkBytes));
  const record = JSON.parse(Buffer.concat(parts).toString('utf8'));
  assert.equal(record.data.note, big);
  assert.equal(node.service.stats().exports, 0, 'a completed export is released');
  await rejects(node.raw({ handle, id: huge.id, exportId, offset: 0 }), 'cancelled');

  // The reader reassembles it; past its own cap it keeps a stub with size and digest.
  const r = openDurableSession({ node, threadId: `tree-a.${root.id}`, host: HOST });
  t.after(() => r.close());
  await r.refresh();
  const note = r.entries().find((e) => e.customType === 'fixture.note');
  assert.equal(r.item(note.id).source.data.note.length, big.length);
  assert.ok(r.info().stats.rawChunks >= chunks);
  const small = openDurableSession({ node, threadId: `tree-a.${root.id}`, host: HOST, maxEntryBytes: 1 << 20 });
  t.after(() => small.close());
  await small.refresh();
  const stub = small.item(note.id).source;
  assert.deepEqual(stub.oversized, { bytes: huge.bytes, sha256: huge.sha256 });
  assert.equal(stub.data, undefined);
  assert.equal(small.entries().length, r.entries().length);
});

test('oversized: cancel releases the export; a later chunk answers cancelled', real, async (t) => {
  const { harness, root } = await store(t);
  await write(root, 'fixture.note', { note: 'y'.repeat(1 << 20) });
  const node = fixture.serviceNode(harness);
  const { handle } = await node.open({ threadId: `tree-a.${root.id}` });
  const { upper } = await node.fence({ handle });
  const first = await node.raw({ handle, id: upper, offset: 0 });
  assert.equal(first.done, false);
  assert.equal(node.service.stats().exports, 1);
  await node.cancel({ handle, exportId: first.exportId });
  assert.equal(node.service.stats().exports, 0);
  await rejects(node.raw({ handle, id: upper, exportId: first.exportId, offset: LIMITS.chunkBytes }), 'cancelled');
  // Closing the handle releases an export in flight too.
  const again = await node.raw({ handle, id: upper, offset: 0 });
  await node.close({ handle });
  await rejects(node.raw({ handle, id: upper, exportId: again.exportId, offset: LIMITS.chunkBytes }), 'expired_handle');
  assert.equal(node.service.stats().handles, 0);
});

// (d) Handles are bound to their connection.

test('handles: another connection cannot use a handle; disconnect closes every handle and its watch', real, async (t) => {
  const { harness, root } = await store(t);
  await fixture.ask(root, 'hello');
  const service = createReaderService({ context: fixture.context, resolve: (id) => harness.conversation(Number(id.split('.')[1]), fixture.context) });
  const a = service.connect(), b = service.connect();
  const ha = await a.open({ threadId: `tree-a.${root.id}` });
  const hb = await b.open({ threadId: `tree-a.${root.id}` });
  await rejects(b.entries({ handle: ha.handle, limit: 1 }), 'expired_handle');
  await rejects(b.close({ handle: ha.handle }), 'expired_handle');
  let ended = null;
  await a.watch({ handle: ha.handle }, () => {}, (reason) => { ended = reason; });
  await a.disconnect();
  assert.equal(ended, 'closed');
  assert.equal(service.stats().handles, 1, 'only the other connection keeps its handle');
  await rejects(a.entries({ handle: ha.handle, limit: 1 }), 'disconnected');
  assert.equal((await b.entries({ handle: hb.handle, limit: 1 })).items.length, 1);
  await b.disconnect();
  assert.equal(service.stats().handles, 0);
});

test('handles: an open interrupted by disconnect stops its watch and leaves no handle', async () => {
  let release, stopped = 0;
  const gate = new Promise((r) => { release = r; });
  const conversation = { watch: async () => { await gate; return { value: { conversation: { id: 1 }, entries: [], docs: {} }, start() {}, stop: async () => { stopped++; } }; } };
  const service = createReaderService({ resolve: async () => conversation });
  const c = service.connect();
  const opening = c.open({ threadId: 's.1' });
  await c.disconnect();
  release();
  await rejects(opening, 'disconnected');
  assert.equal(stopped, 1);
  assert.equal(service.stats().handles, 0);
  assert.equal(service.stats().opened, 0);
});

test('handles: requests outside the contract are refused with codes', async () => {
  const service = createReaderService({ resolve: async () => null });
  const c = service.connect();
  await rejects(c.open({ threadId: 's.9' }), 'not_found');
  await rejects(c.entries({ handle: 'r1', limit: 1 }), 'expired_handle');
});

// (e) Restore validation.

/** Copy a stopped store, so a test can hold an older history of the same store. */
function copyStore(dir, from, to) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(dir, from + suffix))) copyFileSync(join(dir, from + suffix), join(dir, to + suffix));
}

test('restore: a matching snapshot resumes; a shorter or divergent history resets with its reason', real, async (t) => {
  const { dir, harness, root } = await store(t);
  await fixture.ask(root, 'one');
  await harness.close(fixture.context);
  copyStore(dir, 'store.sqlite', 'older.sqlite');
  const current = await store(t, 'store.sqlite', dir);
  await fixture.ask(current.root, 'two');
  const threadId = `tree-a.${current.root.id}`;

  const node = fixture.serviceNode(current.harness);
  const r = openDurableSession({ node, threadId, host: HOST });
  await r.refresh();
  r.close();
  const snap = JSON.parse(JSON.stringify(r.snapshot()));
  assert.equal(snap.lastId, Number(r.entries().at(-1).id));

  // Same history plus an append: only the new entries are normalized.
  await fixture.ask(current.root, 'three');
  const resumed = openDurableSession({ node, threadId, host: HOST, restore: snap });
  t.after(() => resumed.close());
  const out = await resumed.refresh();
  assert.equal(out.reset, false);
  assert.deepEqual(out.added.map((e) => e.kind), ['human', 'assistant']);
  assert.equal(resumed.info().stats.normalized, 2);
  assert.equal(resumed.entries().length, snap.items.length + 2);

  // The older copy ends before the snapshot's boundary.
  const older = await store(t, 'older.sqlite', dir);
  const oldNode = fixture.serviceNode(older.harness);
  const shorter = openDurableSession({ node: oldNode, threadId, host: HOST, restore: snap });
  t.after(() => shorter.close());
  const s = await shorter.refresh();
  assert.equal(s.reset, true);
  assert.equal(s.resetReason, 'shorter');
  assert.deepEqual(shorter.entries().map((e) => e.id), s.added.map((e) => e.id), 'the reader holds only the node history');
  assert.ok(Math.max(...shorter.entries().map((e) => Number(e.id))) < snap.lastId);

  // The older copy grows past the boundary with other entries: same IDs, other bytes.
  await fixture.ask(older.root, 'something else');
  const divergent = openDurableSession({ node: oldNode, threadId, host: HOST, restore: snap });
  t.after(() => divergent.close());
  const d = await divergent.refresh();
  assert.equal(d.reset, true);
  assert.equal(d.resetReason, 'divergent');
  assert.ok(divergent.entries().some((e) => e.blocks?.some((b) => b.text === 'something else')));
  assert.ok(!divergent.entries().some((e) => e.blocks?.some((b) => b.text === 'two')), 'nothing of the snapshot leaks in');

  // A snapshot for another Host or thread is never applied.
  const foreign = openDurableSession({ node, threadId, host: 'other', restore: snap });
  t.after(() => foreign.close());
  const f = await foreign.refresh();
  assert.equal(f.resetReason, 'incompatible');
  assert.equal(foreign.info().stats.normalized, foreign.entries().length);
});

test('restore: equal IDs with other boundary bytes reset even when no entry was added', async () => {
  const rec = (id, text) => ({ id, conversationId: 4, kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: id }] });
  let records = [rec(1, 'a'), rec(2, 'b')];
  const node = { async open() { return { handle: 'h', epoch: 1, frame: { conversation: { id: 4 }, active: { count: 0, ranges: [], complete: true }, docs: {} } }; },
    async fence() { return { upper: records.at(-1).id, watchRevision: 0 }; },
    async entries({ minEntryId = 0, maxEntryId = Infinity }) {
      const items = records.filter((r) => r.id >= minEntryId && r.id <= maxEntryId).map((record) => ({ type: 'entry', record }));
      return { items, more: false, last: items.at(-1)?.record.id ?? null };
    },
    async watch() { return { stop() {} }; }, async close() {} };
  const r = openDurableSession({ node, threadId: 'tree-b.4', host: HOST });
  await r.refresh();
  const snap = r.snapshot();
  records = [rec(1, 'a'), rec(2, 'B')];
  const again = openDurableSession({ node, threadId: 'tree-b.4', host: HOST, restore: snap });
  const out = await again.refresh();
  assert.equal(out.resetReason, 'divergent');
  assert.equal(again.entries().at(-1).blocks[0].text, 'B');
});

// (b) Routing.

test('routing: one Host routes Pi and durable refs to different links; a bare thread ID is refused', () => {
  assert.equal(linkKey('demo/pi:0d1f-2a#e9'), 'demo#pi');
  assert.equal(linkKey('demo/pi-durable:tree-a.1#7'), 'demo#durable');
  assert.deepEqual(parseRef('demo/pi-durable:tree-a.1#7'), { host: 'demo', harness: 'pi-durable', session: 'tree-a.1', entry: '7' });
  for (const bad of ['tree-a.1', 'pi-durable:tree-a.1', 'demo/tree-a.1', 'demo/pi-durable:tree-a.1#7#8']) assert.throws(() => linkKey(bad));
  assert.throws(() => linkKey('demo/codex:abc'), /No AmPi source/);
});
