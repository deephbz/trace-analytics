// Magpie adapter: the Magpie gateway's usage ledger -> model-call rows (see ROW in metrics.mjs).
//
// Magpie writes one record per call it serves, for any agent, at the gateway: request
// start (t), whole call (ms), first content of any kind (ttft_ms), and usage. It sees
// calls whose session files are gone or carry no pi-tps timing (benchmark harnesses,
// sub-agents). ingest.mjs keeps a ledger row only when no other source has the same
// response id, so the ledger fills gaps and never counts a call twice.
//
// Routes are gateway/<requested model>: the gateway's clock is not the agent's, so its
// calls stay apart from the agent-side routes. The ledger has no per-update timing:
// stalls are not seen, as with codex.

import { homedir } from "node:os";
import { join } from "node:path";

export const LEDGER = join(homedir(), ".config", "magpie", "usage.jsonl");

export const magpie = {
  name: "magpie",
  source: import.meta.url,
  // Rows from this source give way to another source's row with the same id.
  fallback: true,

  async list() {
    return [LEDGER];
  },

  init() {
    return { skipped: { failed: 0, notStreamed: 0, noOutput: 0 } };
  },

  line(st, buf, start, end, emit) {
    const d = JSON.parse(buf.toString("utf8", start, end));
    if (d.status !== 200 || d.err) return void st.skipped.failed++;
    if (!(d.ttft_ms > 0) || !(d.ms >= d.ttft_ms)) return void st.skipped.notStreamed++;
    if (!(d.out > 0)) return void st.skipped.noOutput++;
    emit({
      t: Date.parse(d.t),
      wall: d.ms,
      agent: "magpie",
      session: null,
      route: `gateway/${d.req || `${d.provider}/${d.model}`}`,
      id: d.response_id ?? null,
      uncached: (d.in ?? 0) + (d.cache_write ?? 0),
      cached: d.cache_read ?? 0,
      out: d.out,
      reasoning: d.reasoning ?? 0,
      stop: null,
      ttft: d.ttft_ms,
      stream: d.ms - d.ttft_ms,
      stall: null,
      stalls: null,
      streamValid: false,
    });
  },
};
