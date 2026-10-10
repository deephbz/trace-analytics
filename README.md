# agent-speed

Status: exploration. Adapters for pi, Codex, and the Magpie gateway ledger. The name is provisional.

Measures how fast model calls are, as a coding agent sees them. Each call's wall
time splits into five parts with different causes:

```
request ─► first token ─────────────────────────────► last update ─► end
│◄ TTFT floor ►│◄ TTFT variance ►│◄ decoding │ stall │ decoding … ►│◄ stall ►│
                                   └──── stall during decoding ─┘   after last token
```

- **End-to-end speed** (headline): all output tokens over wall time, request start
  to the end of the response. It needs no stream timing, so held delivery does not
  bias it.
- **TTFT floor**: the part of time to first token that the context length explains.
- **TTFT variance**: TTFT above the floor. Queueing, stalls before the first token,
  hidden reasoning, or buffered generation.
- **Decoding**: first token to last update, less stalls. **Decode speed** is visible
  output tokens over decoding time.
- **Stall during decoding**: a pause of 500 ms or more after the first token. Hidden
  reasoning also shows as one, so stall statistics use calls without reasoning.
- **Stall after last token**: time from the last streamed update to the end of the
  response.
- **Held delivery**: a server or proxy released the reply in a burst. Decode speed
  is then not identifiable, and generation time sits in TTFT variance.

`src/metrics.mjs` is the authority for every formula and threshold.

## Scope

- In scope: per-call speed metrics, their definitions, the report artifact, and its
  rendering. One adapter per agent maps the agent's session files to the row schema
  in `src/metrics.mjs`.
- Adapters:
  - `pi`: [pi-tps](https://github.com/monotykamary/pi-tps) `custom/tps` entries
    joined to their assistant messages. Update-level timing.
  - `codex`: Codex rollouts in `~/.codex/sessions` and `archived_sessions`, rebuilt
    into calls from item timing. Item-level timing: decode speed and stalls during
    decoding are not visible; the report shows that time as "decoding incl. stalls".
  - `magpie`: the Magpie gateway's ledger, `~/.config/magpie/usage.jsonl`. It fills
    gaps: calls whose session files are gone or have no pi-tps timing, such as
    benchmark harness runs. A ledger call that another source has is dropped: same
    response id, or, for records without one, equal output tokens with request start
    within 1 s. Its routes are `gateway/<model>`, apart from the agent-side routes,
    because the gateway's clock leaves out the agent's own time. Stalls are not seen.
- Not yet: Claude Code sessions that bypass Magpie. Their files have no per-call
  stream timing.
- Non-goals: cost, routing decisions, alerting.

## Use

```
node bin/agent-speed.mjs                 # last 14 days, written to out/
node bin/agent-speed.mjs 2026-09-26 2026-10-10 --out reports/x --no-open
node bin/agent-speed.mjs 14d --serve     # live view: rolling window, refreshes every 30 s
```

The CLI prints a text summary and writes `report.json` (the artifact: summaries,
fits, per-call points, window, constants, code version, per-source scan stats) and
`report.html` (a self-contained rendering of it) to `out/<since>_<until>/` by default.

```
adapter.list() ─► scan.mjs ─► rows ─ ingest.mjs (window) ─ metrics.mjs ─► report.mjs ─► report.json ─► report.html
                     │
                     └─ ~/.cache/agent-speed/<adapter>.json   per file: size, mtime, inode, head, offset, rows, state
```

Ingest is incremental. Agents append to session files, so the scanner reads only
the bytes written since the last run, from the saved offset, with the adapter's
saved state. A file that shrank or changed its head is read again. The cache key
holds a hash of `scan.mjs` and the adapter, so a code change rebuilds the cache.
Cost on 14 days of data (3.6 GB, 63k calls): 3–4 s cold, 0.8 s warm for the CLI,
0.1–0.5 s per live refresh.

The page uses [Paper Mono](https://github.com/paper-design/paper-mono) v1.000
(`web/fonts`, SIL Open Font License 1.1), inlined so `report.html` stays one file.

`npm test` checks the floor fit, the held-delivery rule, that appended reads give
the rows of one whole read, the codex call rules, and the ledger dedup.

## Known limits of the pi source

- pi-tps measures TTFT from turn start, so it includes pi's own request setup.
- Wall time comes from the assistant entry: `message.timestamp` at request start,
  the entry's `timestamp` when pi appends the finished message.
- pi-tps starts `streamMs` at the second update but can count the pause before it
  as a stall. The span is therefore `max(stream, stall)`, a lower bound.
- pi-tps keeps no per-update times, so held delivery is detected per call from the
  whole call, not from the content's flow as Magpie's `flow_ms` does.

## Known limits of the codex source

- Request start is the last input line before the call's first model item. Codex
  writes it within milliseconds of sending; turn setup before it is not in TTFT.
- TTFT counts the first model item of any kind, reasoning included. Codex's own
  `time_to_first_token_ms` counts the first visible message and starts at
  `task_started`. On 8,540 single-call turns, the first visible message's start
  matched Codex's figure within 5 ms (median), and the call end matched
  `duration_ms` within 5 ms.
- Calls with no model item (414 in 14 days) and calls whose first item started
  before any input line (6) are skipped and counted in the report's sources.
