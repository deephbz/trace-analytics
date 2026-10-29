import "./home.mjs";
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLASSES, durableSpend, piSpend, SPEND_RULE, spendLabel, teamSpend } from '../src/sources/spend.mjs';

// Real-store tests need pi-durable 1.4.0 (installed by the HyperCarrier checkout); see durable.test.mjs.
let fixture;
try {
  fixture = { ...await import('./fixtures/durable-store.mjs'), context: (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT };
} catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const real = fixture ? {} : { skip: 'pi-durable 1.4.0 is not installed' };

const usage = (input, output, total) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total } });

test('rule: a durable Session spends what pi.usage holds, models and tools together', () => {
  const s = durableSpend({ models: { 'a/m1': usage(100, 10, 0.5), 'b/m2': usage(20, 2, 0.25) }, tools: { search: usage(5, 0, 0.125) } });
  assert.deepEqual(s, { rule: SPEND_RULE, usd: 0.875, tokens: 137, covers: [...CLASSES] });
  assert.equal(spendLabel(s), '$0.88');
  assert.equal(durableSpend(undefined).usd, null, 'no usage doc is unknown, never zero');
});

test('rule: a Pi Session covers responses and failed attempts, and says so', () => {
  const s = piSpend([{ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }, { kind: 'human' },
    { usage: { input: 1, output: 1, cost: { total: 0.5 } } }]);
  assert.deepEqual(s, { rule: SPEND_RULE, usd: 0.75, tokens: 17, covers: ['responses', 'failed'] });
  assert.equal(spendLabel(s), '$0.75 (excludes compaction, tool model calls)');
  assert.equal(piSpend([{ usage: { input: 3 } }]).usd, null, 'no price stays null');
});

test('rule: a mixed Team sums its members under one rule and labels the gap', () => {
  const durable = durableSpend({ models: { 'a/m1': usage(100, 10, 1) }, tools: {} });
  const pi = piSpend([{ usage: { input: 10, output: 5, cost: 0.5 } }]);
  const team = teamSpend([durable, pi]);
  assert.equal(team.usd, 1.5);
  assert.deepEqual(team.covers, ['responses', 'failed']);
  assert.equal(team.mixed, true);
  assert.equal(spendLabel(team), '$1.50 (some Sessions exclude compaction, tool model calls)');
  const pure = teamSpend([durable, durable]);
  assert.deepEqual(pure.covers, [...CLASSES]);
  assert.equal(pure.mixed, undefined);
  assert.equal(spendLabel(pure), '$2.00');
});

test('facts: pi.usage counts the compaction request the history does not, and a fork owns only its own spend', real, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-'));
  const { harness, root } = await fixture.openFixtureStore(join(dir, 'store.sqlite'));
  t.after(async () => { await harness.close(fixture.context); rmSync(dir, { recursive: true, force: true }); });
  const { fork } = await fixture.buildFixture(harness, root);
  const docOf = async (c) => { const w = await c.watch(fixture.context); const v = w.value.docs['pi.usage']; await w.stop(); return v; };
  const all = async (c) => {
    const out = []; let cursor;
    do { const p = await c.entries({ order: 'ascending' }, 100, cursor, fixture.context); out.push(...p.items); cursor = p.next; } while (cursor);
    return out;
  };
  const inputOf = (records, conversationId) => records.filter((r) => r.kind === 'pi.assistant' && (conversationId === undefined || r.conversationId === conversationId))
    .reduce((n, r) => n + r.model[0].usage.input, 0);

  const rootDoc = await docOf(root);
  const rootHistory = await all(root);
  const responses = inputOf(rootHistory);
  const doc = Object.values(rootDoc.models).reduce((n, u) => n + u.input, 0);
  assert.ok(doc > responses, `pi.usage input ${doc} > response input ${responses}: the compaction request counts`);
  assert.ok(rootHistory.some((r) => r.kind === 'pi.compaction'));

  const forkDoc = await docOf(fork);
  const forkHistory = await all(fork);
  const own = inputOf(forkHistory, fork.id);
  assert.ok(inputOf(forkHistory) > own, 'the fork history shows inherited responses');
  assert.equal(Object.values(forkDoc.models).reduce((n, u) => n + u.input, 0), own, 'the fork pi.usage holds only its own requests');
});
