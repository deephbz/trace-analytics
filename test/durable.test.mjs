import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { durableItem, openDurableSession, parseThread } from '../src/sources/durable.mjs';

// Real-store tests need pi-durable 1.4.0, which the HyperCarrier checkout installs. trace-analytics
// itself has no dependencies, so a standalone checkout skips them and says why.
let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), ...await import('./fixtures/durable-node.mjs'),
    context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const HOST = 'demo';
async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-source-'));
  let { harness, root } = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  const node = fixture.fakeNode(harness);
  t.after(async () => { await node.harness.close(fixture.context); rmSync(dir, { recursive: true, force: true }); });
  return { dir, node, root, harness };
}
const reader = (t, node, conversationId, options = {}) => {
  const r = openDurableSession({ node, threadId: `tree-a.${conversationId}`, host: HOST, ...options });
  t.after(() => r.close());
  return r;
};
const fresh = async (conversation) => {
  const out = [];
  let cursor;
  do {
    const page = await conversation.entries({ order: 'ascending' }, 3, cursor, fixture.context);
    out.push(...page.items.map((e) => String(e.id))); cursor = page.next;
  } while (cursor);
  return out;
};
const byKind = (r, kind) => r.entries().filter((e) => r.item(e.id).source.kind === kind);

test('real store: every mapping row, citations, and predecessor links', real, async (t) => {
  const { node, root, harness } = await store(t);
  await fixture.buildFixture(harness, root);
  const r = reader(t, node, root.id);
  const first = await r.refresh();
  assert.equal(first.status, 'ready');
  assert.equal(first.reset, false);
  const entries = r.entries();
  assert.deepEqual(entries.map((e) => e.id), await fresh(root), 'one reader entry per native entry, same IDs, same order');
  entries.forEach((e, i) => {
    assert.equal(e.ref, `demo/pi-durable:tree-a.${root.id}#${e.id}`);
    assert.equal(e.parent, i ? entries[i - 1].id : null);
  });

  const [user] = byKind(r, 'pi.user');
  assert.equal(user.kind, 'human');
  assert.deepEqual(user.blocks, [{ type: 'text', text: 'use echo please' }]);
  assert.equal(typeof user.t, 'number');

  const [call, answer] = byKind(r, 'pi.assistant');
  assert.equal(call.kind, 'assistant');
  assert.equal(call.stop, 'toolUse');
  assert.equal(call.blocks[0].type, 'toolCall');
  assert.equal(call.blocks[0].name, 'echo');
  assert.deepEqual(call.blocks[0].args, { say: 'hi' });
  assert.equal(call.model, 'sim-1');
  assert.equal(call.provider, 'fixture-sim');
  assert.deepEqual(Object.keys(call.usage), ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']);
  assert.equal(call.usage.input, 42);
  assert.equal(answer.blocks[0].text, 'echo said hi');

  const [tool] = byKind(r, 'pi.tool-result');
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.name, 'echo');
  assert.deepEqual(tool.result, { callId: call.blocks[0].id, isError: false, text: 'echo: hi' });
  assert.deepEqual(r.item(tool.id).semantics.toolDiagnostics, []);

  const [mention] = r.entries().filter((e) => e.customType === 'fixture.mention');
  assert.equal(mention.kind, 'injected', 'a custom input is not human input');
  assert.equal(mention.text, 'ann: check the build');
  assert.deepEqual(r.item(mention.id).source.data, { author: 'ann', text: 'check the build' });

  const [note] = r.entries().filter((e) => e.customType === 'fixture.note');
  assert.equal(note.kind, 'other');
  assert.equal(note.text, undefined, 'no published extractor, no guessed text');
  assert.equal(note.t, null);

  const [compaction] = byKind(r, 'pi.compaction');
  assert.equal(compaction.kind, 'compaction');
  assert.match(compaction.summary, /<summary>\n## Goal\n- fixture summary\n<\/summary>/);
  const boundary = r.item(compaction.id).semantics.contextBoundary;
  assert.equal(boundary.type, 'compaction');
  assert.equal(boundary.reason, 'manual');
  assert.ok(r.entry(boundary.head), 'the kept head is an entry in history');

  const [reset] = byKind(r, 'pi.reset');
  assert.equal(reset.kind, 'other');
  assert.equal(reset.text, 'We were testing the reader. Continue.');
  assert.deepEqual(r.item(reset.id).semantics.contextBoundary, { type: 'reset', head: reset.id, handoff: reset.text });

  const systems = byKind(r, 'pi.system');
  assert.ok(systems.length >= 1);
  assert.equal(systems[0].kind, 'other');
  assert.deepEqual(r.item(systems[0].id).semantics.systemAudit.toolsAdded, ['echo']);

  // Compaction and reset hide evidence from the model, never from the reader.
  assert.ok(r.activeContext().length < entries.length);
  assert.ok(r.activeContext().every((id) => r.entry(id)));

  const s = r.session();
  assert.equal(s.id, `pi-durable:tree-a.${root.id}`);
  assert.equal(s.ref, `demo/pi-durable:tree-a.${root.id}`);
  assert.equal(s.harness, 'pi-durable');
  assert.equal(s.humanTurns, 2, 'the custom mention is not a human turn');
  assert.equal(s.parent, null);
  assert.equal(s.role, 'solo');
  assert.equal(s.firstAsk, 'use echo please');
});

test('real store: a fork inherits history up to its cutoff and cites it as its own', real, async (t) => {
  const { node, root, harness } = await store(t);
  const { fork, cutoff } = await fixture.buildFixture(harness, root);
  const rootReader = reader(t, node, root.id), forkReader = reader(t, node, fork.id);
  await rootReader.refresh(); await forkReader.refresh();
  const ids = forkReader.entries().map((e) => e.id);
  assert.deepEqual(ids, await fresh(fork));
  const inherited = forkReader.entries().filter((e) => forkReader.item(e.id).source.conversationId === root.id);
  assert.equal(inherited.at(-1).id, String(cutoff), 'inheritance stops at the cutoff');
  const later = rootReader.entries().filter((e) => Number(e.id) > cutoff).map((e) => e.id);
  assert.ok(later.length > 0);
  assert.ok(later.every((id) => !ids.includes(id)), 'root entries after the cutoff do not leak into the fork');
  for (const e of inherited) {
    assert.equal(e.ref, `demo/pi-durable:tree-a.${fork.id}#${e.id}`, 'the occurrence cites the viewed Session');
    assert.equal(forkReader.item(e.id).source.originRef, rootReader.entry(e.id).ref, 'provenance names the origin Session');
  }
  const own = forkReader.entries().filter((e) => forkReader.item(e.id).source.conversationId === fork.id);
  assert.equal(own[0].parent, String(cutoff));
  // Fleet totals count each physical entry once: (host, store, entry ID).
  const physical = new Set([...rootReader.entries(), ...forkReader.entries()].map((e) => e.id));
  assert.equal(physical.size, rootReader.entries().length + own.length);
  const s = forkReader.session();
  assert.equal(s.parent, `pi-durable:tree-a.${root.id}`);
  assert.equal(s.forkAt, `demo/pi-durable:tree-a.${root.id}#${cutoff}`);
});

test('real store: an append costs only new entries plus the boundary and a fence probe', real, async (t) => {
  const { node, root } = await store(t);
  await fixture.ask(root, 'one');
  let changes = 0;
  const r = reader(t, node, root.id, { onChange: () => changes++ });
  await r.refresh();
  const before = r.info();
  const served = node.served;
  await fixture.ask(root, 'two');
  assert.ok(changes > 0, 'the watch invalidates the reader');
  assert.equal(r.status().status, 'stale');
  const next = await r.refresh();
  assert.equal(next.reset, false);
  assert.deepEqual(next.added.map((e) => e.kind), ['human', 'assistant']);
  assert.equal(r.info().stats.normalized - before.stats.normalized, 2);
  assert.ok(node.served - served <= 2 + 2 + 1, `served ${node.served - served}: new entries, boundary, fence probe`);
  assert.equal(r.status().status, 'ready');
});

test('real store: reconnect and node restart catch up without gaps or duplicates', real, async (t) => {
  const { dir, node, root } = await store(t);
  await fixture.ask(root, 'before');
  const r = reader(t, node, root.id, { pageLimit: 2 });
  await r.refresh();
  await node.disconnect();
  assert.equal(r.status().status, 'stale');
  for (const q of ['a', 'b', 'c']) await fixture.ask(root, q);
  // Restart: the store reopens in a new Harness and the node epoch changes.
  await node.harness.close(fixture.context);
  const reopened = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  node.harness = reopened.harness; node.epoch = 2;
  await fixture.ask(reopened.root, 'd');
  const out = await r.refresh();
  assert.equal(out.status, 'ready');
  assert.equal(out.reset, false);
  assert.equal(r.info().epoch, 2);
  const ids = r.entries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.deepEqual(ids, await fresh(reopened.root), 'equals a fresh entries() traversal');
  assert.equal(r.info().stats.resets, 0);
});

test('real store: an unavailable node keeps cached evidence and never reports ready', real, async (t) => {
  const { node, root } = await store(t);
  await fixture.ask(root, 'cached');
  const r = reader(t, node, root.id);
  await r.refresh();
  const held = r.entries().length;
  node.down = true;
  await node.disconnect();
  await fixture.ask(root, 'unseen');
  const out = await r.refresh();
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error.code, 'unavailable');
  assert.equal(r.entries().length, held, 'the held prefix stays readable');
  assert.equal(r.status().status, 'unavailable');
  node.down = false;
  const back = await r.refresh();
  assert.equal(back.status, 'ready');
  assert.equal(r.entries().length, held + 2);
});

test('real store: an unknown thread reports not_found, never an empty history', real, async (t) => {
  const { node } = await store(t);
  const r = reader(t, node, 999);
  const out = await r.refresh();
  assert.equal(out.status, 'not_found');
  assert.equal(r.info().version, null);
});

// Synthetic records: rows the simulated store cannot produce, and protocol edge cases.
const ctx = { host: HOST, threadId: 'tree-b.4' };
const user = (id, content, conversationId = 4) => ({ id, conversationId, kind: 'pi.user', model: [{ role: 'user', content, timestamp: 1000 + id }] });

test('mapping: a known wrapper is injected; image bytes never enter the record', () => {
  assert.equal(durableItem(user(1, '<system-reminder>x</system-reminder>'), ctx).entry.kind, 'injected');
  const img = durableItem(user(2, [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }]), ctx).entry;
  assert.equal(img.kind, 'human');
  assert.deepEqual(img.blocks, [{ type: 'text', text: 'see' }, { type: 'image', mimeType: 'image/png' }]);
});

test('mapping: an unknown pi.* kind stays other, with no guessed text', () => {
  const item = durableItem({ id: 3, conversationId: 4, kind: 'pi.future', data: { text: 'not prose' } }, ctx);
  assert.equal(item.entry.kind, 'other');
  assert.equal(item.entry.text, undefined);
  assert.equal(item.entry.customType, undefined);
  assert.equal(item.source.unknown, true);
});

test('mapping: a custom kind gets text only from its published extractor', () => {
  const record = { id: 5, conversationId: 4, kind: 'app.note', data: { body: 'hello' } };
  assert.equal(durableItem(record, ctx).entry.text, undefined);
  assert.equal(durableItem(record, { ...ctx, extractors: { 'app.note': (r) => r.data.body } }).entry.text, 'hello');
});

test('mapping: missing usage and cost stay null; a failed turn keeps stop and error', () => {
  const e = durableItem({ id: 6, conversationId: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [],
    stopReason: 'error', errorMessage: 'overloaded', usage: { input: 3 } }] }, ctx).entry;
  assert.deepEqual(e.usage, { input: 3, output: null, cacheRead: null, cacheWrite: null, cost: null });
  assert.equal(e.stop, 'error');
  assert.equal(e.error, 'overloaded');
});

test('identity: thread keys split at the last dot and reject ref separators', () => {
  assert.deepEqual(parseThread('a.b.12'), { storeId: 'a.b', conversationId: '12' });
  for (const bad of ['12', '.1', 'a.', 'a/b.1', 'a#b.1']) assert.throws(() => parseThread(bad));
});

/** In-memory node over a mutable record list; `frames` lets a test inject a watch frame mid-scan. */
function memoryNode(records, conversation = { id: 4 }) {
  const node = { records, conversation, watchers: [], duringScan: null,
    async open() { return { handle: 'h', epoch: 1, conversation: node.conversation, activeEntryIds: [], watchRevision: 0 }; },
    async entries({ order, minEntryId = -Infinity, maxEntryId = Infinity, limit, cursor }) {
      let rows = node.records.filter((r) => r.id >= minEntryId && r.id <= maxEntryId);
      if (order === 'descending') rows.reverse();
      const from = cursor?.at ?? 0;
      const items = rows.slice(from, from + limit);
      if (order === 'ascending' && node.duringScan) { const f = node.duringScan; node.duringScan = null; f(); }
      return { items, ...(from + limit < rows.length ? { next: { at: from + limit } } : {}) };
    },
    async watch(_h, onFrame) { node.watchers.push(onFrame); return { stop() {} }; },
    async close() {},
    frame() { for (const w of node.watchers) w({ conversation: node.conversation, activeEntryIds: [] }); },
  };
  return node;
}

test('protocol: a missing boundary entry resets instead of joining an unverified prefix', async () => {
  const node = memoryNode([user(1, 'a'), user(2, 'b')]);
  const r = openDurableSession({ node, ...ctx });
  await r.refresh();
  node.records = [user(1, 'a'), user(3, 'c')];
  const out = await r.refresh();
  assert.equal(out.reset, true);
  assert.deepEqual(out.added.map((e) => e.id), ['1', '3']);
  assert.deepEqual(r.entries().map((e) => e.id), ['1', '3']);
});

test('protocol: a lineage change resets the held history', async () => {
  const node = memoryNode([user(1, 'a')]);
  const r = openDurableSession({ node, ...ctx });
  await r.refresh();
  node.conversation = { id: 4, parent: { conversationId: 2, at: 1 } };
  node.frame();
  const out = await r.refresh();
  assert.equal(out.reset, true);
  assert.equal(r.info().stats.resets, 1);
});

test('protocol: a watch frame during a scan triggers one more catch-up round', async () => {
  const node = memoryNode([user(1, 'a')]);
  const r = openDurableSession({ node, ...ctx });
  node.duringScan = () => { node.records.push(user(2, 'b')); node.frame(); };
  const out = await r.refresh();
  assert.equal(out.status, 'ready');
  assert.deepEqual(r.entries().map((e) => e.id), ['1', '2']);
  assert.equal(r.info().stats.scans, 2);
});

test('protocol: pages are bounded and cursor through the history', async () => {
  const node = memoryNode(Array.from({ length: 7 }, (_, i) => user(i + 1, `m${i}`)));
  const r = openDurableSession({ node, ...ctx, pageLimit: 3 });
  await r.refresh();
  const last = r.page({ limit: 3 });
  assert.deepEqual(last.entries.map((e) => e.id), ['5', '6', '7']);
  assert.equal(last.more, true);
  assert.deepEqual(r.page({ before: '5', limit: 10 }).entries.map((e) => e.id), ['1', '2', '3', '4']);
  assert.throws(() => r.page({ limit: 401 }));
  const seen = [];
  r.visit((item) => seen.push(item.entry.id), { after: '5' });
  assert.deepEqual(seen, ['6', '7']);
});
