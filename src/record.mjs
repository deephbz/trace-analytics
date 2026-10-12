// The protocol between the input adapters (src/sources) and the analytics (src/analytics).
// This file is the authority for what a record means. Adapters fill it; analytics read it.
//
// A field is null when the source does not record it. Adapters never impute: an estimate
// is an analytics choice. Times are epoch ms; tokens are counts.
//
// CALL: one model request, as one source saw it.
//   source      adapter that read it: "pi", "codex", "claude", or "magpie" (the gateway ledger)
//   session     session id; null for gateway records
//   role        the session's role: "main", "subagent", or the harness's own label
//               (Codex "guardian_review", "automation", ...); null when unknown
//   id          call id within the source: pi entry id, Codex response id, Claude message
//               id, gateway response id. Copied session files repeat calls: two calls of one
//               source with the same responseId, or the same id and t, are one; load() keeps one.
//   responseId  the vendor response id; null where the source does not keep it
//   prev        id of the nearest earlier call on this call's conversation path, same
//               session; null at the root or when the path is not known
//   reset       what lies between prev and this call: "compaction", "branch" (a branch
//               summary), or null. The prompt prefix of prev is then not this call's prefix.
//   compaction  id of the compaction when reset is "compaction"; null otherwise
//   cause       the input this request answers: "user", "tool", "compaction", "other";
//               null when unknown
//   inputAt     last explicit input entry time on this branch; null if unavailable
//   purpose     "turn" (a conversation request), "compaction" (a summarizer or remote
//               compaction request), "side" (outside the conversation path); null when unknown
//   route       "provider/model" as the source names it
//   t           request start
//   end         end of the response; null when unknown
//   ttft        ms from request start to the first streamed content; null when unknown
//   stream      ms of the streamed window: second update to last (pi-tps), or first model
//               item's start to the last one's end (codex); null when unknown
//   stall       ms of pauses >= 500 ms inside the stream; null when the source cannot see them
//   stalls      count of stall episodes; null as stall
//   streamValid the source trusts `stream` as a time span (pi-tps guard); false otherwise
//   input       prompt tokens neither read from nor written to the cache. Routes that do
//               not report cache writes fold them in here.
//   cacheRead   prompt tokens read from the cache
//   cacheWrite  prompt tokens written to the cache, as logged; null when the source never
//               logs writes. A logged 0 can still mean "folded into input" (pi on some routes).
//   cacheWrite1h  the part of cacheWrite with a 1-hour TTL; null when not logged
//   out         output tokens, reasoning included
//   reasoning   reasoning tokens inside `out`; null when unknown
//   stop        stop reason; null when unknown
//   cost        USD the harness logged at request time; null when not logged
//
// TOOL: one tool result (Pi) or completed tool item (Codex).
//   source, session, id: owning source and result entry identity
//   call: requesting assistant call id, or null when its record is missing
//   name: logged tool name; no arguments or output content
//   t, end: response-end to result-entry interval when available; otherwise end only
//   duration: ms between these anchors, or null (never a configured timeout)
//   timing: "response-to-result-proxy" includes execution plus scheduling/overhead;
//           "execution-events" uses Codex item start/end events;
//           "unknown" has no start. Parallel intervals can overlap.
//   outcome: success | failure | timeout | cancelled | unknown, from logged status.
//            success describes tool-wrapper completion, not success of nested jobs.
//
// COMPACTION: one context compaction.
//   source, session, role   as for a call
//   id          compaction id within the source; (source, id, t) identifies it across copies
//   t           when the compaction was recorded (its end)
//   prev        id of the last call before it on its conversation path; null when unknown
//   method      "pi-native" (pi's summarizer), "pi-blackmagic" (remote Codex compaction from
//               pi), "codex-remote", "claude-summary"
//   trigger     the harness's label: "auto", "manual", "threshold", "hc-auto-compact",
//               "turn-start", "mid-turn"; null when unknown
//   model       model that compacted; null when the record does not name it
//   before      context tokens before compaction, as the harness counted them
//   afterEst    the harness's estimate of context after; null when not logged
//   usage       { prompt, input, cacheRead, cacheWrite, out, reasoning } of the compaction
//               requests as the record logged them; null when not logged. prompt is the
//               total; the split fields are null when the record does not split them.
//   wall        ms the record attributes to the compaction; null when not logged
//   calls       keys (callKey) of CALLs that performed it, from its own source or, after
//               load() links them, from the gateway ledger; [] when none are known
//   handoff     keys of turn CALLs the harness spent preparing it (hc-auto-compact); [] otherwise
//   handoffStart  time the handoff began; null without a handoff
//   detail      source-specific facts: retainedItems, summaryChars, gapMs (time since the
//               previous session entry), retention, artifactChars

// SESSION: one harness Session. id is <harness>:<native id>; session is native.
//   reader: protocol version on every CLI record; harness: pi | claude | codex.
//   role: solo | leader | worker | automated (provisional inference over the history).
//   parent: Session id or null; cwd, path: logged cwd and selected source file.
//   scratch: cwd is under a temporary directory (null if cwd is unknown).
//   started, updated: epoch ms or null; archived: logged archive state.
//   humanTurns: count on the selected entry stream; resume: {cwd, argv}, no shell.
//   Only with text opt-in: title, firstAsk, lastAsk, lastReply (null when absent).
// ENTRY: session is the SESSION id; id and parent identify source entries.
//   t: epoch ms or null; kind: human | injected | assistant | tool | compaction |
//   branch-summary | other; name: tool name or null. Only with text opt-in: text.
//   Pi uses the path from the last appended entry to the root, without a depth cap.
//   Other sources use file order. Codex unlabelled entries use line:<ordinal> ids.
// SEARCH: session, entry, t identify a match; kind: human | title | reply.
//   snippet carries text. Title entry/time can be null when the source does not log them.
export const READER_VERSION = '1';

/** Key of a call or compaction across sources. */
export const callKey = (source, id) => `${source}:${id}`;

/** Total prompt tokens of a call. */
export const prompt = (c) => c.input + c.cacheRead + (c.cacheWrite ?? 0);

/** Wall time, ms; null when the end is unknown. */
export const wall = (c) => (c.end != null && c.end >= c.t ? c.end - c.t : null);

/** Bare model id: the last segment of the route. */
export const modelOf = (route) => (route ?? "").split("/").pop();

export const inWindow = (r, { sinceMs, untilMs }) => r.t >= sinceMs && r.t < untilMs;
