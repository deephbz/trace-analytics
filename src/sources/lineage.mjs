// Conversation paths in tree-shaped session files (pi, Claude Code).
//
// Each entry names its parent. Every node stores the state of its path at that point,
// so a new entry resolves its own state from its parent in one lookup:
//
//   [call, reset, compaction, cause]
//   call        id of the nearest call above, or the node's own id when it is a call
//   reset       "compaction" or "branch" when one lies between that call and here
//   compaction  id of that compaction
//   cause       the strongest input since that call: user > compaction > tool > other
//
// The map keeps the last LIMIT nodes. A parent older than that resolves as a root,
// so a branch from very far back loses its prev call.

const LIMIT = 2048;
const RANK = { other: 0, tool: 1, compaction: 2, user: 3 };
const ROOT = [null, null, null, null];

export const initPaths = () => ({ nodes: {}, order: [] });

/** Path state at a parent id. */
export const at = (paths, parent) => (parent != null && paths.nodes[parent]) || ROOT;

/**
 * Add a node. step: "call" | "input" | "compaction" | "branch" | null (pass-through).
 * arg: the input kind for an "input" step; the call id for a "call" step when it differs
 * from the node id (one Claude Code message spans several entries). Returns the parent's path state.
 */
export function place(paths, id, parent, step, arg = null) {
  const p = at(paths, parent);
  const cause = arg;
  let s = p;
  if (step === "call") s = [arg ?? id, null, null, null];
  else if (step === "compaction") s = [p[0], "compaction", id, "compaction"];
  else if (step === "branch") s = [p[0], "branch", null, p[3]];
  else if (step === "input" && (p[3] == null || RANK[cause] > RANK[p[3]])) s = [p[0], p[1], p[2], cause];
  if (id != null) {
    if (!(id in paths.nodes)) paths.order.push(id);
    paths.nodes[id] = s;
    if (paths.order.length > LIMIT) for (const old of paths.order.splice(0, LIMIT / 2)) delete paths.nodes[old];
  }
  return p;
}
