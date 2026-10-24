// Fake node endpoint for the durable source tests. It serves the node read protocol
// (reader-design.md) from public Conversation calls only: entries() and watch(). Every
// value crosses a JSON round-trip, as on the wire. Tests flip `down` or call disconnect().
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';

const wire = (x) => JSON.parse(JSON.stringify(x));
const fail = (code, message) => Object.assign(new Error(message), { code });

export function fakeNode(harness, { storeId = 'tree-a' } = {}) {
  const handles = new Map();
  let next = 1;
  const node = {
    harness, epoch: 1, down: false, calls: [],
    async open({ threadId }) {
      node.calls.push('open');
      if (node.down) throw fail('unavailable', 'node unreachable');
      const dot = threadId.lastIndexOf('.');
      if (threadId.slice(0, dot) !== storeId) throw fail('not_found', `No store ${threadId.slice(0, dot)}`);
      const conversation = await node.harness.conversation(Number(threadId.slice(dot + 1)), context);
      if (!conversation) throw fail('not_found', `No conversation ${threadId}`);
      const watch = await conversation.watch(context);
      const handle = `h${next++}`;
      handles.set(handle, { conversation, watch, revision: 0, listeners: [] });
      const v = watch.value;
      return wire({ handle, epoch: node.epoch, conversation: v.conversation, activeEntryIds: v.entries.map((e) => e.id), watchRevision: 0 });
    },
    async entries({ handle, order, minEntryId, maxEntryId, limit, cursor }) {
      node.calls.push(`entries:${order}`);
      if (node.down) throw fail('unavailable', 'node unreachable');
      const h = handles.get(handle);
      if (!h) throw fail('expired', 'handle expired');
      const page = await h.conversation.entries({ order, minEntryId, maxEntryId }, limit, cursor, context);
      node.served = (node.served ?? 0) + page.items.length;
      return wire({ items: page.items, ...(page.next ? { next: page.next } : {}) });
    },
    async watch({ handle }, onFrame, onEnd) {
      const h = handles.get(handle);
      if (!h) throw fail('expired', 'handle expired');
      h.listeners.push(onEnd);
      h.watch.start(async (value) => {
        if (!handles.has(handle)) return;
        onFrame(wire({ epoch: node.epoch, watchRevision: ++h.revision, conversation: value.conversation, activeEntryIds: value.entries.map((e) => e.id) }));
      });
      return { stop: () => {} };
    },
    async close({ handle }) {
      const h = handles.get(handle);
      handles.delete(handle);
      await h?.watch.stop();
    },
    /** Drop every attachment, as a transport loss or node restart does. */
    async disconnect() {
      const all = [...handles.values()];
      handles.clear();
      for (const h of all) { await h.watch.stop(); for (const end of h.listeners) end?.(); }
    },
  };
  return node;
}
