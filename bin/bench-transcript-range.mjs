#!/usr/bin/env node
// Read-only source benchmark. Use a private output directory. Output is numbers
// only; never print source paths, entry IDs, or transcript text.
import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { activeBranch } from '../src/sources/lineage.mjs';
import { openPiSessionRange } from '../src/sources/transcript-range.mjs';

const [mode, source, index] = process.argv.slice(2);
if (!['build', 'parity', 'open'].includes(mode) || !source || !index) {
  console.error('usage: bench-transcript-range.mjs build|parity|open SOURCE PRIVATE_INDEX');
  process.exit(2);
}
try {
  const started = performance.now();
  const reader = openPiSessionRange(source, { host: 'benchmark', indexPath: index });
  if (mode === 'build') {
    const result = await reader.refresh();
    console.log(JSON.stringify({ bytes: statSync(source).size, entries: result.count,
      ms: performance.now() - started, peakHeapBytes: reader.info().peakHeap }));
  } else if (mode === 'open') {
    const page = reader.page();
    console.log(JSON.stringify({ entries: page.entries.length, ms: performance.now() - started,
      peakHeapBytes: reader.info().peakHeap, payloadBytes: Buffer.byteLength(JSON.stringify(page)) }));
  } else {
    // Independent full-node oracle. Its allocations are excluded from reader memory measurements.
    const nodes = []; let tip = null;
    const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
    for await (const text of lines) {
      let o; try { o = JSON.parse(text); } catch { continue; }
      if (o.type === 'session' || o.id == null) continue;
      nodes.push({ id: o.id, parent: o.parentId ?? null }); tip = o.id;
    }
    const expected = activeBranch(nodes, tip);
    const found = []; let before, page, pages = 0;
    do {
      page = reader.page({ before }); pages++;
      found.unshift(...page.entries.map((e) => e.id));
      before = page.entries[0]?.id;
    } while (page.more);
    assert.deepEqual(found, expected.entries.map((r) => r.id));
    assert.equal(page.branch, expected.branch);
    console.log(JSON.stringify({ parity: 1, entries: found.length, pages, nodes: nodes.length }));
  }
  reader.close();
} catch {
  // A private source can put content or its path in an exception. Keep it off stdout/stderr.
  console.error('Benchmark failed; inspect privately.'); process.exitCode = 1;
}
