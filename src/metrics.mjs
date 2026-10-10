// Metric definitions. This file is the authority for every formula in the report.
//
// A call's wall time splits into five parts:
//
//   request ─► first token ─────────────────────────► last update ─► end
//   │◄─ TTFT floor ─►│◄─ TTFT variance ─►│◄ decoding │ stall during decoding │ … ►│◄ stall after last token ►│
//
// ROW: one model call, from any adapter.
//   t          request start, epoch ms
//   wall       ms from request start to the end of the response; null if unknown
//   agent      the source: "pi", "codex", or "magpie" (the gateway ledger)
//   session    session id
//   route      "provider/model" as the agent named it
//   id         the vendor response id, where the source keeps it; null otherwise
//   uncached   prompt tokens the server had to prefill (input + cache write)
//   cached     prompt tokens read from the prompt cache
//   out        output tokens, reasoning included
//   reasoning  reasoning tokens inside `out`
//   stop       stop reason ("stop", "toolUse", ...)
//   ttft       ms from request start to the first streamed content
//   stream     ms from the second streamed update to the last (pi), or from the
//              first model item's start to the last one's end (codex); null if unknown
//   stall      ms of pauses >= STALL_MS from the first token to the last update;
//              null when the source times whole items and cannot see them (codex)
//   stalls     count of stall episodes (consecutive long pauses count once); null as stall
//   streamValid the adapter trusts `stream` as a time span (pi-tps guard)

/** A pause between streamed updates that counts as a stall. pi-tps uses the same value. */
export const STALL_MS = 500;
/** A call is held when it decoded in under 1/HELD_SHARE of the call (Magpie's HeldShare). */
export const HELD_SHARE = 4;
/** Lower quantile that defines the TTFT floor. */
export const FLOOR_Q = 0.1;
/** A route needs this many calls for a summary line. */
export const MIN_CALLS = 30;
/** Above this share of held calls, a route's decode speed is not identifiable. */
export const MAX_HELD = 0.25;

export const context = (r) => r.uncached + r.cached;

/**
 * Span: first token to last update. `stream` starts at the second update, but `stall`
 * can hold the pause before it, so max(stream, stall) is the tightest lower bound.
 */
export const span = (r) => (r.stream == null ? null : Math.max(r.stream, r.stall ?? 0));

/** The source saw stalls during decoding (update-level timing). */
export const stallsSeen = (r) => r.stream != null && r.stall != null;

/** Decoding: the span less its stalls. Where stalls are not seen, the span holds both: see unsplit. */
export const decoding = (r) => (stallsSeen(r) ? span(r) - r.stall : null);

/** Decoding incl. stalls: the span of a call whose stalls the source cannot see. */
export const unsplit = (r) => (r.stream != null && r.stall == null ? span(r) : null);

/** Stall after last token: wall time after the last streamed update (the response's end, or span the bound missed). */
export const stallAfter = (r) => (r.wall == null || r.stream == null ? 0 : Math.max(0, r.wall - r.ttft - span(r)));

/**
 * Stall statistics use calls without reasoning only. In reasoning calls, hidden
 * reasoning between streamed parts also shows as a stall during decoding.
 */
export const noReasoning = (r) => stallsSeen(r) && r.reasoning === 0;

/**
 * End-to-end speed, tok/s: all output tokens, reasoning included, over the wall time
 * from request start to the end of the response. The headline metric: it holds every
 * wait the user sees, and needs no stream timing, so held delivery does not bias it.
 */
export const e2e = (r) => (r.wall > 0 && r.out > 0 ? (r.out / r.wall) * 1000 : null);

/**
 * Held delivery: the server or a proxy buffered the reply and released it in a burst,
 * so decoding looks shorter than the generation was. Generation time then sits in
 * TTFT variance, and out/decoding overstates decode speed.
 */
export const held = (r) => r.streamValid && decoding(r) * HELD_SHARE < r.ttft + span(r);

/**
 * Decode speed, tok/s: visible output over decoding time. Reasoning tokens are left
 * out, because hidden reasoning (OpenAI) is generated before the first content and
 * its time is in TTFT. null when the window is not trustworthy or held.
 */
export function decode(r) {
  if (!r.streamValid || held(r)) return null;
  const tokens = r.out - r.reasoning;
  return tokens > 0 ? (tokens / decoding(r)) * 1000 : null;
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const a = Float64Array.from(xs).sort();
  const i = q * (a.length - 1);
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
}

/**
 * TTFT floor: ln(ttft) = a + b * context, fitted to the FLOOR_Q quantile.
 * Method: sort calls by context into equal-count bins, take each bin's FLOOR_Q
 * quantile of ln(ttft), then a count-weighted least-squares line through the
 * (median context, quantile) points. A negative slope is clamped to 0.
 * Returns { a, b, bins } with floor(ctx) = exp(a + b * ctx) ms.
 */
export function fitFloor(rows) {
  const pts = rows.map((r) => [context(r), Math.log(r.ttft)]).sort((p, q) => p[0] - q[0]);
  const k = Math.max(4, Math.min(15, Math.floor(pts.length / 40)));
  const bins = [];
  for (let i = 0; i < k; i++) {
    const s = pts.slice(Math.floor((i * pts.length) / k), Math.floor(((i + 1) * pts.length) / k));
    if (s.length) bins.push({ x: quantile(s.map((p) => p[0]), 0.5), y: quantile(s.map((p) => p[1]), FLOOR_Q), n: s.length });
  }
  let sw = 0, sx = 0, sy = 0;
  for (const p of bins) (sw += p.n), (sx += p.n * p.x), (sy += p.n * p.y);
  const mx = sx / sw, my = sy / sw;
  let sxy = 0, sxx = 0;
  for (const p of bins) (sxy += p.n * (p.x - mx) * (p.y - my)), (sxx += p.n * (p.x - mx) ** 2);
  const b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
  return { a: my - b * mx, b, bins };
}

export const floorAt = (fit, ctx) => Math.exp(fit.a + fit.b * ctx);

/**
 * Split TTFT into the TTFT floor and the TTFT variance above it. The variance is
 * pre-first-token time the context does not explain: queueing, stalls before the
 * first token, hidden reasoning, and for held calls, buffered generation.
 */
export function splitTtft(fit, r) {
  const floor = Math.min(r.ttft, floorAt(fit, context(r)));
  return { floor, variance: r.ttft - floor };
}
