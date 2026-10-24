// Child for the kill-mid-reset test: commits a copy, then starts a reset and blocks inside it until killed.
import { writeSync } from 'node:fs';
import { writeDurableCopy } from '../../src/sources/durable-copy.mjs';

// `node --test` also loads this file, without a path: then it does nothing.
const file = process.argv[2];
if (!file) process.exit(0);
const host = 'demo', threadId = 'tree-b.4', conversation = { id: 4 };
const user = (id, content) => ({ id, conversationId: 4, kind: 'pi.user', model: [{ role: 'user', content, timestamp: 1000 + id }] });
writeDurableCopy(file, { host, threadId, reset: true, records: [1, 2, 3].map((i) => user(i, `old${i}`)), checkpoint: { lastId: 3 }, conversation });
writeSync(1, 'committed\n');
function* torn() {
  yield user(1, 'new1'); yield user(2, 'new2');
  writeSync(1, 'mid-reset\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
writeDurableCopy(file, { host, threadId, reset: true, records: torn(), checkpoint: { lastId: 2 }, conversation });
