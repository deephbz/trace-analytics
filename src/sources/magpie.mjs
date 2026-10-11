// Magpie adapter: the Magpie gateway's usage ledger -> CALL records.
//
// Magpie writes one record per call it serves, for any agent, at the gateway: request
// start (t), whole call (ms), first content of any kind (ttft_ms), usage, and the
// requested model (req). It sees calls whose session files are gone or carry no pi-tps
// timing (benchmark harnesses, sub-agents) and pi's native compaction requests, which pi
// logs only as a sum on the compaction entry. load() keeps a ledger call only when no
// session source has it, and links compaction requests to their compaction.
//
// The gateway's clock is not the agent's: wall time and TTFT leave out the agent's own
// time. The ledger has no per-update timing, so stalls are not seen. A record without a
// streamed first token (ttft_ms missing, or past the end) has ttft null.

import { homedir } from "node:os";
import { join } from "node:path";

export const LEDGER = join(homedir(), ".config", "magpie", "usage.jsonl");

export const magpie = {
  name: "magpie",
  source: import.meta.url,
  // Calls from this source give way to a session source's call: see load.mjs.
  fallback: true,

  async list() {
    return [LEDGER];
  },

  init() {
    return { skipped: { failed: 0 } };
  },

  line(st, buf, start, end, emit) {
    const d = JSON.parse(buf.toString("utf8", start, end));
    if (d.status !== 200 || d.err) return void st.skipped.failed++;
    const t = Date.parse(d.t);
    const streamed = d.ttft_ms > 0 && d.ms >= d.ttft_ms;
    emit({
      kind: "call",
      source: "magpie",
      session: null,
      role: null,
      id: d.response_id ?? `t${t}`,
      responseId: d.response_id ?? null,
      prev: null,
      reset: null,
      compaction: null,
      cause: null,
      purpose: null,
      route: d.req || `${d.provider}/${d.model}`,
      t,
      end: t + d.ms,
      ttft: streamed ? d.ttft_ms : null,
      stream: streamed ? d.ms - d.ttft_ms : null,
      stall: null,
      stalls: null,
      streamValid: false,
      input: d.in ?? 0,
      cacheRead: d.cache_read ?? 0,
      cacheWrite: d.cache_write ?? 0,
      cacheWrite1h: null,
      out: d.out ?? 0,
      reasoning: d.reasoning ?? 0,
      stop: null,
      cost: null,
    });
  },
};
