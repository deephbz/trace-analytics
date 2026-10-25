#!/usr/bin/env node
// Synthetic benchmark: the memory an openDurableCopy offset index costs on a long history.
// Usage: node --expose-gc bin/bench-durable-copy-index.mjs [ENTRIES=1000000]
// Writes a copy of small synthetic records to a temporary directory, removes it after, and prints numbers only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDurableCopy, writeDurableCopy } from '../src/sources/durable-copy.mjs';

if (typeof gc !== 'function') { console.error('usage: node --expose-gc bin/bench-durable-copy-index.mjs [ENTRIES]'); process.exit(2); }
const entries = Number(process.argv[2] ?? 1_000_000);
const host = 'demo', threadId = 'tree-b.4', BATCH = 50_000;
const record = (id) => ({ id, conversationId: 4, kind: 'pi.user', model: [{ role: 'user', content: `m${id}`, timestamp: 1000 + id }] });
const MiB = (bytes) => Number((bytes / 2 ** 20).toFixed(1));

const dir = mkdtempSync(join(tmpdir(), 'bench-durable-copy-'));
try {
  const file = join(dir, 'copy.jsonl');
  for (let from = 1; from <= entries; from += BATCH) {
    const records = Array.from({ length: Math.min(BATCH, entries - from + 1) }, (_, i) => record(from + i));
    writeDurableCopy(file, { host, threadId, reset: from === 1, records, checkpoint: null, conversation: { id: 4 } });
  }
  gc(); gc();
  const base = process.memoryUsage();
  const copy = openDurableCopy(file, { host });
  copy.refresh();
  const started = performance.now();
  copy.entry(entries); // The first lookup loads the whole index.
  const loadMs = performance.now() - started;
  const peak = process.memoryUsage();
  gc(); gc();
  const held = process.memoryUsage();
  console.log(JSON.stringify({ entries, loadMs: Math.round(loadMs),
    retainedHeapMiB: MiB(held.heapUsed - base.heapUsed), retainedOffHeapMiB: MiB(held.arrayBuffers - base.arrayBuffers),
    peakHeapMiB: MiB(peak.heapUsed - base.heapUsed), peakRssMiB: MiB(Math.max(peak.rss, held.rss) - base.rss) }));
  copy.close();
} finally { rmSync(dir, { recursive: true, force: true }); }
