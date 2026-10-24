import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { durableItem, exportDurableRecords, piShaped, sessionHeadOf } from '../src/sources/durable.mjs';
import { openDurableCopy, writeDurableCopy } from '../src/sources/durable-copy.mjs';
import { piSpendOfTotal, durableSpend, spendLabel } from '../src/sources/spend.mjs';

let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), ...await import('./fixtures/durable-node.mjs'),
    context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const HOST = 'demo', THREAD = 'tree-a.1';
const at = (kind, id, extra = {}) => ({ id, conversationId: 1, kind, model: [{ role: 'user', content: 'Continue.', timestamp: 1_000 + id }], ...extra });

test('pi.reset is a reset entry that keeps its handoff text', () => {
  const { entry } = durableItem(at('pi.reset', 3), { host: HOST, threadId: THREAD });
  assert.equal(entry.kind, 'reset');
  assert.equal(entry.text, 'Continue.');
});

test('an oversized stub carries its size, digest and kind on the entry and the Pi shape', () => {
  const stub = { id: 4, conversationId: 1, kind: 'fixture.blob', oversized: { bytes: 300_000, sha256: 'ab'.repeat(32) } };
  assert.deepEqual(durableItem(stub, { host: HOST, threadId: THREAD }).entry.oversized, { bytes: 300_000, sha256: 'ab'.repeat(32), kind: 'fixture.blob' });
  assert.deepEqual(piShaped(stub), { type: 'durable', id: '4', kind: 'fixture.blob', timestamp: null, oversized: stub.oversized });
});

test('a cwd-only change moves the copy version, and the old version still continues', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-followups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'copy.jsonl'), conversation = { id: 1 };
  const docs = (cwd) => ({ 'pi.agent': { cwd } });
  assert.notEqual(sessionHeadOf({ conversation, docs: docs('/a') }), sessionHeadOf({ conversation, docs: docs('/b') }));
  writeDurableCopy(file, { host: HOST, threadId: THREAD, reset: true, records: [at('pi.user', 1)], conversation, docs: docs('/a') });
  const copy = openDurableCopy(file, { host: HOST });
  const before = copy.refresh().version;
  writeDurableCopy(file, { host: HOST, threadId: THREAD, reset: false, records: [], conversation, docs: docs('/b') });
  const after = copy.refresh();
  assert.equal(after.reset, false);
  assert.notEqual(after.version, before);
  assert.ok(copy.continues(before), 'same generation: a reader keeps its entries and re-derives the Session');
  assert.equal(copy.session().cwd, '/b');
  copy.close();
});

test('spendLabel equals AmPi money() when nothing is left out, and names the gap when something is', () => {
  // money() in apps/ampi/web/src/util.ts, character for character.
  for (const [usd, money] of [[0, '$0'], [0.004, '<$0.01'], [0.25, '$0.25'], [12.5, '$12.50']]) {
    assert.equal(spendLabel(durableSpend({ models: { m: { cost: { total: usd } } } })), money);
  }
  assert.equal(spendLabel(piSpendOfTotal(0.25)), '$0.25 (excludes failed, compaction, tools)');
  assert.equal(spendLabel(piSpendOfTotal(0)), '$0 (excludes failed, compaction, tools)');
  assert.equal(piSpendOfTotal(Number.NaN).usd, null);
});

async function exportStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-export-'));
  const { harness, root } = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  await fixture.buildFixture(harness, root);
  // Larger than one wire entry (256 KiB), so it travels as raw chunks.
  await (await root.submit({ type: 'write', entry: { kind: 'fixture.blob', data: { blob: 'x'.repeat(300_000) } } }, fixture.context)).wait(fixture.context);
  const node = fixture.serviceNode(harness);
  t.after(async () => { await harness.close(fixture.context); rmSync(dir, { recursive: true, force: true }); });
  return { node, threadId: `tree-a.${root.id}` };
}

test('exportDurableRecords streams every record a page at a time and closes its handle', real, async (t) => {
  const { node, threadId } = await exportStore(t);
  const chunks = [];
  let started;
  const result = await exportDurableRecords({ node, threadId, host: HOST, pageLimit: 2, start: (s) => { started = s; }, write: (c) => { chunks.push(c); } });
  const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, result.count);
  assert.equal(Buffer.concat(chunks).length, result.bytes);
  assert.equal(started.version, result.version);
  assert.equal(lines.at(-1).data.blob.length, 300_000, 'the large record exports whole');
  assert.deepEqual(lines.map((l) => l.id), [...lines.map((l) => l.id)].sort((a, b) => a - b), 'ascending');
  assert.ok(node.calls.filter((c) => c === 'entries').length > 1, 'more than one page');
  assert.equal(node.calls.at(-1), 'close');
});

test('exportDurableRecords throws when a raw body does not match its digest, and still closes', real, async (t) => {
  const { node, threadId } = await exportStore(t);
  const raw = node.raw;
  node.raw = async (args) => { const c = await raw(args); return { ...c, data: Buffer.from(Buffer.from(c.data, 'base64').toString().replace('x', 'y')).toString('base64') }; };
  await assert.rejects(exportDurableRecords({ node, threadId, host: HOST, write: () => {} }), { code: 'unavailable', message: /changed during export/ });
  assert.equal(node.calls.at(-1), 'close');
});
