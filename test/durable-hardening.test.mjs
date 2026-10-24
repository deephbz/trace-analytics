// Systems review milestone 1, risks 3, 5, 6 and 7 (HyperCarrier apps/ampi/docs/durable/review-milestone-1-systems.md):
// a cold refresh streams to its sink, a copy survives a kill mid-reset and refuses a partial bundle, a closed
// reader leaves no handle, and an aborted export settles without waiting for the node.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportDurableRecords, openDurableSession } from '../src/sources/durable.mjs';
import { durableCopyCheckpoint, durableCopyFiles, openDurableCopy, writeDurableCopy } from '../src/sources/durable-copy.mjs';

let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), ...await import('./fixtures/durable-node.mjs'),
    context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const HOST = 'demo', THREAD = 'tree-b.4';
const user = (id, content = `m${id}`) => ({ id, conversationId: 4, kind: 'pi.user', model: [{ role: 'user', content, timestamp: 1000 + id }] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
/** Settles to 'hung' when `p` has not settled once every queued microtask ran. */
const settled = (p) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setImmediate(() => r('hung')))]);
const tmp = (t, prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

/**
 * A fake reader connection over `records`. `log` records each op; `gate[op]` holds the next call of `op` until
 * the test resolves it. `live` counts handles opened and not closed.
 */
function fakeNode(records = []) {
  const node = { records, log: [], gate: {}, live: new Set(), next: 1, watchers: new Map(), callbacks: [], signals: [],
    async open() { node.log.push('open'); await node.hold('open'); const handle = `h${node.next++}`; node.live.add(handle);
      return { handle, epoch: 1, frame: { conversation: { id: 4 }, active: { count: 0, ranges: [], complete: true }, docs: {} } }; },
    async fence(_a, opts) { node.log.push('fence'); node.signals.push(opts?.signal); await node.hold('fence'); return { upper: node.records.at(-1)?.id ?? null }; },
    async entries({ minEntryId = -Infinity, maxEntryId = Infinity, limit }) {
      const rows = node.records.filter((r) => r.id >= minEntryId && r.id <= maxEntryId);
      node.log.push(`fetch:${rows[0]?.id}`);
      await node.hold('entries');
      const items = rows.slice(0, limit).map((r) => r.oversized ? { type: 'oversized', id: r.id, conversationId: 4, kind: r.kind, bytes: 10, sha256: 'x' } : { type: 'entry', record: r });
      return { items, more: rows.length > limit, last: items.at(-1)?.id ?? items.at(-1)?.record.id ?? null };
    },
    async raw() { node.log.push('raw'); await node.hold('raw'); return { exportId: 'x1', data: Buffer.from('{}').toString('base64'), done: true }; },
    async cancel() { node.log.push('cancel'); },
    async watch({ handle }, onFrame, onEnd) { node.log.push('watch'); node.callbacks.push(onFrame, onEnd); await node.hold('watch'); node.watchers.set(handle, onFrame);
      return { stop() { node.log.push('stop'); node.watchers.delete(handle); } }; },
    async close({ handle }) { node.log.push(`close:${handle}`); node.live.delete(handle); node.watchers.delete(handle); },
    hold(op) { const g = node.gate[op]; if (!g) return undefined; delete node.gate[op]; return g.promise; },
  };
  return node;
}

// Risk 3: a cold refresh holds one page, and each page reaches the sink before the next fetch.

test('a cold refresh with a sink delivers every page before it fetches the next, and returns no records', async () => {
  const node = fakeNode(Array.from({ length: 1000 }, (_, i) => user(i + 1)));
  const r = openDurableSession({ node, threadId: THREAD, host: HOST, retain: false, pageLimit: 10 });
  let largest = 0, ids = [];
  const sink = ({ reset, records }) => {
    assert.equal(reset, ids.length === 0, 'a reader with no checkpoint replaces the sink first');
    node.log.push(`sink:${records[0]?.id}`);
    largest = Math.max(largest, records.length); ids.push(...records.map((x) => x.id));
    assert.equal(r.snapshot().lastId, records.at(-1).id, 'the checkpoint ends at the batch the sink receives');
  };
  const change = await r.refresh({ sink });
  assert.equal(change.status, 'ready');
  assert.equal(change.records.length, 0, 'a sink receives the history; the result holds none of it');
  assert.equal(largest, 10, 'the reader holds at most one page of records');
  assert.deepEqual(ids, node.records.map((x) => x.id));
  const order = node.log.filter((x) => x.startsWith('fetch:') || x.startsWith('sink:'));
  for (let i = 0; i < 100; i++) assert.deepEqual(order.slice(2 * i, 2 * i + 2), [`fetch:${10 * i + 1}`, `sink:${10 * i + 1}`]);
  r.close();
});

test('a sink hears a reset once, on its first batch, and never the unverified prefix', async () => {
  const node = fakeNode([user(1), user(2), user(3)]);
  const a = openDurableSession({ node, threadId: THREAD, host: HOST, retain: false, pageLimit: 2 });
  await a.refresh({ sink: () => {} });
  const forged = { ...a.snapshot(), boundary: '0'.repeat(64) };
  a.close();
  const b = openDurableSession({ node, threadId: THREAD, host: HOST, retain: false, pageLimit: 2, restore: forged });
  const batches = [];
  const change = await b.refresh({ sink: (batch) => { batches.push({ reset: batch.reset, ids: batch.records.map((x) => x.id) }); } });
  assert.equal(change.reset, true);
  assert.deepEqual(batches, [{ reset: true, ids: [1, 2] }, { reset: false, ids: [3] }]);
  // A history that became empty still reaches the sink as a reset.
  node.records = [];
  const empty = [];
  await b.refresh({ sink: (batch) => { empty.push(batch); } });
  assert.deepEqual(empty, [{ reset: true, records: [] }]);
  b.close();
});

test('a failing sink closes the reader, so the caller reopens from its own committed checkpoint', async () => {
  const node = fakeNode([user(1), user(2), user(3)]);
  const r = openDurableSession({ node, threadId: THREAD, host: HOST, retain: false, pageLimit: 2 });
  const change = await r.refresh({ sink: ({ records }) => { if (records[0].id === 3) throw new Error('disk full'); } });
  assert.equal(change.status, 'unavailable');
  assert.equal(change.error.code, 'sink_failed');
  assert.equal(node.live.size, 0);
  await assert.rejects(r.refresh({ sink: () => {} }), /closed/);
});

// Risk 5: a reset writes a new generation; meta is the only commit point; a partial bundle has no checkpoint.

const CHILD = fileURLToPath(new URL('./fixtures/durable-copy-kill.mjs', import.meta.url));
test('a kill mid-reset leaves the committed copy whole, and the next commit removes the torn generation', async (t) => {
  const dir = tmp(t, 'durable-copy-kill-'), file = join(dir, 'c.jsonl');
  const child = spawn(process.execPath, [CHILD, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes('mid-reset\n')) resolve(); });
    child.once('exit', (code) => reject(new Error(`child exited ${code} before the reset: ${out}`)));
  });
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.match(out, /^committed\n/);

  const checkpoint = durableCopyCheckpoint(file, { host: HOST, threadId: THREAD });
  assert.equal(checkpoint?.lastId, 3, 'the old checkpoint still names a whole copy');
  const copy = openDurableCopy(file, { host: HOST });
  copy.refresh();
  const rows = []; copy.visit((row) => rows.push(row.entry.blocks[0].text));
  assert.deepEqual(rows, ['old1', 'old2', 'old3']);
  assert.ok(readdirSync(dir).length > 3, 'the torn generation is still on disk');

  writeDurableCopy(file, { host: HOST, threadId: THREAD, reset: true, records: [user(1, 'new1')], checkpoint: null, conversation: { id: 4 } });
  const files = durableCopyFiles(file);
  assert.deepEqual(readdirSync(dir).sort(), [files.data, files.index, files.meta].map((f) => f.slice(dir.length + 1)).sort());
  copy.refresh();
  const after = []; copy.visit((row) => after.push(row.entry.blocks[0].text));
  assert.deepEqual(after, ['new1']);
  copy.close();
});

test('a copy with a missing or short data or index file has no checkpoint', async (t) => {
  const dir = tmp(t, 'durable-copy-partial-');
  const damage = {
    'data deleted': (f) => rmSync(f.data), 'index deleted': (f) => rmSync(f.index), 'meta deleted': (f) => rmSync(f.meta),
    'data short': (f) => truncateSync(f.data, 5), 'index short': (f) => truncateSync(f.index, 5), 'meta torn': (f) => writeFileSync(f.meta, '{"form'),
  };
  for (const [name, hurt] of Object.entries(damage)) {
    const file = join(dir, `${name.replace(' ', '-')}.jsonl`);
    writeDurableCopy(file, { host: HOST, threadId: THREAD, reset: true, records: [user(1), user(2)], checkpoint: { lastId: 2 }, conversation: { id: 4 } });
    assert.equal(durableCopyCheckpoint(file, { host: HOST, threadId: THREAD })?.lastId, 2, name);
    hurt(durableCopyFiles(file));
    assert.equal(durableCopyCheckpoint(file, { host: HOST, threadId: THREAD }), null, name);
    // The next write starts a new generation instead of appending to the damaged one.
    const meta = writeDurableCopy(file, { host: HOST, threadId: THREAD, reset: false, records: [user(1), user(2)], checkpoint: { lastId: 2 }, conversation: { id: 4 } });
    assert.equal(meta.lines, 2, name);
    assert.ok(existsSync(durableCopyFiles(file).data), name);
  }
});

// Risk 6: close during an in-flight open, watch or raw read leaves no handle and no callback.

for (const [op, until] of [['open', 'open'], ['watch', 'watch'], ['raw', 'raw']]) {
  test(`a reader closed during its ${op} leaves zero handles and calls back nothing`, { timeout: 2000 }, async () => {
    const node = fakeNode([user(1), { id: 2, conversationId: 4, kind: 'pi.note', oversized: true }]);
    let changes = 0;
    const r = openDurableSession({ node, threadId: THREAD, host: HOST, retain: false, onChange: () => { changes++; } });
    const gate = (node.gate[until] = deferred());
    const refreshing = r.refresh({ sink: () => {} });
    while (!node.log.includes(op)) await new Promise((x) => setImmediate(x));
    r.close();
    gate.resolve();
    const change = await refreshing;
    for (let i = 0; i < 3; i++) await new Promise((x) => setImmediate(x));
    assert.equal(node.live.size, 0, `no handle survives: ${node.log}`);
    assert.equal(node.watchers.size, 0);
    assert.deepEqual(node.log.filter((x) => ['fence', 'raw'].includes(x)), op === 'raw' ? ['fence', 'raw'] : [], 'no read after close');
    for (const callback of node.callbacks) callback({ conversation: { id: 4 } });
    assert.equal(changes, 0, 'a frame or end after close calls back nothing');
    assert.equal(change.status, 'unavailable');
    assert.equal(change.error.code, 'closed');
  });
}

// Risk 7: an abort settles the export without waiting for the node, and the handle closes.

test('an export aborted while the node holds its fence settles at once and closes its handle', async () => {
  const node = fakeNode([user(1)]);
  node.gate.fence = deferred();
  const ac = new AbortController();
  const exporting = exportDurableRecords({ node, threadId: THREAD, host: HOST, write: () => {}, signal: ac.signal });
  while (!node.log.includes('fence')) await new Promise((x) => setImmediate(x));
  assert.equal(node.signals[0], ac.signal, 'the node call carries the abort signal');
  ac.abort();
  assert.equal(await settled(exporting), 'settled');
  await assert.rejects(exporting, (e) => e.code === 'aborted');
  assert.equal(node.live.size, 0);
});

test('an export aborted during its open closes the handle the open returns later', async () => {
  const node = fakeNode([user(1)]);
  const gate = (node.gate.open = deferred());
  const ac = new AbortController();
  const exporting = exportDurableRecords({ node, threadId: THREAD, host: HOST, write: () => {}, signal: ac.signal });
  ac.abort();
  assert.equal(await settled(exporting), 'settled');
  gate.resolve();
  for (let i = 0; i < 3; i++) await new Promise((x) => setImmediate(x));
  assert.equal(node.live.size, 0);
  assert.ok(!node.log.includes('fence'));
});

test('closing a handle with an export in flight releases its export count', real, async (t) => {
  const dir = tmp(t, 'durable-hardening-');
  const { harness, root } = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  t.after(() => harness.close(fixture.context).catch(() => {}));
  await (await root.submit({ type: 'write', entry: { kind: 'fixture.note', data: { note: 'y'.repeat(1 << 20) } } }, fixture.context)).wait(fixture.context);
  const node = fixture.serviceNode(harness);
  const { handle } = await node.open({ threadId: `tree-a.${root.id}` });
  const { upper } = await node.fence({ handle });
  assert.equal((await node.raw({ handle, id: upper, offset: 0 })).done, false);
  assert.equal(node.service.stats().exports, 1);
  await node.close({ handle });
  assert.equal(node.service.stats().exports, 0);
});
