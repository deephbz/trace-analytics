// Calls -> the compact request rows that sim.mjs replays (see COL there).
//
// A request's predecessor is its prev call when that call ran on the same route and no
// compaction or branch summary lies between: its prompt is the prefix this request can
// reuse. The predecessor can lie before the window. "side" calls (outside the
// conversation path) keep their cost in the actual totals but have no predecessor.

/** data: load() output. sources: which sources' calls to replay. */
export function requestTable({ window, calls }, { sources = ["pi"] } = {}) {
  const { sinceMs, untilMs } = window;
  const byId = new Map();
  for (const c of calls) if (sources.includes(c.source)) byId.set(`${c.source}|${c.session}|${c.id}`, c);
  const models = [];
  const modelIdx = new Map();
  const sessionIdx = new Map();
  const rows = [];
  const warm = [];
  for (const c of calls) {
    if (!sources.includes(c.source) || (c.purpose !== "turn" && c.purpose !== "side") || c.t < sinceMs || c.t >= untilMs) continue;
    let m = modelIdx.get(c.route);
    if (m === undefined) modelIdx.set(c.route, (m = models.push(c.route) - 1));
    let s = sessionIdx.get(c.session);
    if (s === undefined) sessionIdx.set(c.session, (s = sessionIdx.size));
    const p = c.purpose === "turn" && c.prev != null && c.reset == null ? byId.get(`${c.source}|${c.session}|${c.prev}`) : null;
    const pw = p?.cacheWrite ?? 0;
    // predT, predPrompt (input + cacheRead + cacheWrite), predCached (cacheRead + cacheWrite)
    const pred = p && p.route === c.route ? [p.t, p.input + p.cacheRead + pw, p.cacheRead + pw] : [-1, 0, 0];
    const row = [c.t, s, m, c.input, c.cacheRead, c.cacheWrite ?? 0, c.cacheWrite1h ?? 0, c.out, c.cost ?? 0, ...pred];
    (c.purpose === "side" ? warm : rows).push(row);
  }
  rows.sort((a, b) => a[0] - b[0]);
  warm.sort((a, b) => a[0] - b[0]);
  return { sinceMs, untilMs, rows, warm, models, sessions: sessionIdx.size };
}
