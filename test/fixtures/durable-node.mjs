// Node endpoint for the durable source tests: the real reader service (src/sources/durable-wire.mjs)
// over a real store, with a JSON round-trip on every value, as on the wire. Tests flip `down`, call
// disconnect() for a transport loss, or swap `harness` and `epoch` for a node restart.
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createReaderService } from '../../src/sources/durable-wire.mjs';

const wire = (x) => x === undefined ? x : JSON.parse(JSON.stringify(x));
const fail = (code, message) => Object.assign(new Error(message), { code });

export function serviceNode(harness, { storeId = 'tree-a', limits } = {}) {
  let service, connection;
  const node = {
    harness, epoch: 1, down: false, calls: [], served: 0,
    get service() { return service; },
    async open({ threadId }) { return call('open', { threadId }); },
    async entries(args) { const page = await call(`entries`, args); node.served += page.items.length; return page; },
    async fence(args) { const f = await call('fence', args); node.served += f.upper === null ? 0 : 1; return f; },
    async raw(args) { return call('raw', args); },
    async cancel(args) { return call('cancel', args); },
    async watch(args, onFrame, onEnd) {
      return connection.watch(wire(args), (f) => onFrame(wire(f)), onEnd);
    },
    async close(args) { return call('close', args); },
    /** Transport loss: the connection's handles close; the next call uses a new connection. */
    async disconnect() { const c = connection; connection = service.connect(); await c.disconnect(); },
    /** A node restart: a new service (and epoch) over the reopened store. */
    restart(nextHarness, epoch) { node.harness = nextHarness; node.epoch = epoch; boot(); },
  };
  async function call(op, args) {
    node.calls.push(op);
    if (node.down) throw fail('unavailable', 'node unreachable');
    return wire(await connection[op](wire(args)));
  }
  function boot() {
    service = createReaderService({ context, epoch: node.epoch, ...(limits ? { limits } : {}), resolve: async (threadId) => {
      const dot = threadId.lastIndexOf('.');
      if (threadId.slice(0, dot) !== storeId) return null;
      return node.harness.conversation(Number(threadId.slice(dot + 1)), context);
    } });
    connection = service.connect();
  }
  boot();
  return node;
}
