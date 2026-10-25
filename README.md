# trace-analytics

Status: exploration. Repo scope, privacy, and result retention: [AGENTS.md](AGENTS.md).

Studies of local coding-agent logs: how fast model calls are, which prompt-cache
retention would cost least, and what context compaction costs. All three run
the same pipeline on shared adapters. The independent interval study adds tool waiting and residual session time.

```
 sources (knowledge)              analytics (intentions)             reports (presentation)
 ─────────────────────            ─────────────────────────          ──────────────────────
 pi ────────┐                     speed.mjs ─────────────────────►   speed/      text, page
 codex ─────┤  scan ─► load ─►    cache-ttl/ table ─► sim ───────►   cache-ttl/  text, page (reruns sim)
 claude ────┤  (CALL,             compaction.mjs ────────────────►   compaction/ text, page
 magpie ────┘   COMPACTION)       prices, rates, stats (shared)
                    ▲
             src/record.mjs: the protocol
```

- **Sources** (`src/sources/`) know each harness: its files, schemas, quirks, and
  what it does not log. The session reader reuses these adapters and their scanner.
- **The protocol** (`src/record.mjs`) defines CALL, COMPACTION, TOOL, SESSION, and ENTRY. A field is
  `null` when the source does not log it; adapters never impute.
- **Analytics** (`src/analytics/`) hold the questions and their formulas. They
  read records only, so a new harness needs only an adapter.
- **Reports** (`src/reports/`) render a result as text and as a page. They never
  read sources.
- `src/pipeline.mjs` wires the layers per study. `test/boundaries.test.mjs`
  enforces the import rules.

## Session reader

The reader owns local harness parsing. Consumers call its CLI and own their
questions. It reads logs without changing them. Protocol fields live in
`src/record.mjs`; `node bin/sessions.mjs --help` lists options.

```sh
node bin/sessions.mjs sessions --format json
node bin/sessions.mjs sessions --id pi:example --text --format table
node bin/sessions.mjs entries pi:example --text
node bin/sessions.mjs calls --since 2026-01-01 --until 2026-02-01
node bin/sessions.mjs search 'example question' --all --limit 20
```

JSONL is the default. JSON writes one array. The compact Session table shows
UTC ISO minute, id, role, human turns, cwd, and title with `--text`. Each Session
has a shell-quoted `cd CWD && ARGV` resume line. Search tables show time,
Session, kind, and snippet.
Every output record carries `reader`. Times use epoch milliseconds.
SESSION and ENTRY records carry `host` and `ref` (`<host>/<id>`, `<host>/<id>#<entry>`).
The Host comes from `--host`, then `TRACE_ANALYTICS_HOST`, then `local`, never from the path.
Library consumers can follow one live Pi Session with `openPiSession(path, { host })`
from `trace-analytics/transcript`: `refresh()` parses only appended bytes.
A disk-backed range-reader prototype lives beside it in
[`src/sources/transcript-range.mjs`](src/sources/transcript-range.mjs).
Its contract and isolated memory/cold-open check are in
[the range-reader note](docs/transcript-range.md). It does not change the
existing full-reader API.
A durable source, `openDurableSession({ node, threadId, host })` in
[`src/sources/durable.mjs`](src/sources/durable.mjs), reads one pi-durable
conversation through an injected node client and never opens a store. It is an
exploration prototype with an in-memory index. Its real-store tests need
pi-durable 1.4.0 installed and are skipped otherwise.
`--since` and `--until` accept absolute dates or nonnegative integer spans:
`Nm`, `Nh`, `Nd`, `Nw`. A span subtracts minutes, hours, days, or weeks from
one shared current-time anchor. For example, `sessions --since 7d` selects
Sessions whose `[started, updated]` span overlaps the last seven days.
Windows include `updated >= since` and `started < until`. Malformed values exit 1. Defaults
exclude workers, automation, scratch directories, and Sessions without human
turns. `--all` includes them; `--role` selects a role. `sessions --id` bypasses
visibility filters. IDs can be qualified IDs or unique prefixes. Unknown and
ambiguous IDs exit 2 and list candidates on stderr.

Default output contains no titles or message text. Only `search` and `--text`
read text. Search returns human turns, titles, and the last assistant reply.
Each whitespace-separated query term must match the same human turn, title,
or last reply, case-insensitive. Each hit includes its kind and logged time.
Unlogged title times stay null and sort last. Pi and Claude entries, human-turn
counts, search and text summaries follow the exact active branch. A Pi
`session_info` title labels the whole Session; this is a ratified exception.
Claude compact boundaries follow `logicalParentUuid` when `parentUuid` is null.
SESSION `branch` reports `complete`, `partial` for a missing parent or cycle,
or `file-order` for Codex. Role inference uses the whole history. A parentSession fork does not imply
leadership. Logged team-tool use or a worker child supplies leadership evidence.
Role and injected-turn
classification remain provisional. A human turn can start with an angle bracket.

The catalog includes Claude subagents and bridge sessions. Analytics keep their
existing discovery population. Claude subagent IDs use logged `agentId`; their
logged `sessionId` names the parent. Codex uses rollouts and, when present,
`state_5.sqlite` in read-only mode through `sqlite3`. Missing sources produce
coverage notes with exit 0. Read failures exit nonzero. Coverage on stderr
counts discovered files and copies. The freshest copy of a Session wins.
`calls` retains usage from all branches and filters each output record by time.
A CALL joins a SESSION through `${source}:${session}`. Resume uses `{cwd, argv}`.

Each run refreshes the incremental index. Reader indexes live under
`~/.cache/trace-analytics/reader/`. Plain and text indexes stay separate.
Directories use mode 700; files use mode 600 under any umask. Delete caches to
rebuild them. Incremental scans support appended or replaced files. They do not
detect a same-inode rewrite beyond the first 64 bytes. The scanner persists one file record per JSONL row to avoid a
single-string size limit. Catalog/search text caches omit tool output.
`entries --text` reads full text only from the selected Session without caching
it. Private results and real logs must not enter public fixtures or Git.

## Use

```
node bin/trace-analytics.mjs <study> [since] [until] [--out dir] [--no-open] [--prices file] [--no-cache]
node bin/trace-analytics.mjs <study> [since] --serve [--port n] [--no-open]
```

| Study | Question | Default window | Sources | Files |
|---|---|---|---|---|
| `intervals` | Where does session time go: models, tools, input gaps, residuals? | 14d | pi, codex | `data.json`, `report.html` |
| `speed` | How fast are calls, and where does call time go? | 14d | pi, codex, claude, magpie | `report.json`, `report.html` |
| `cache-ttl` | Which cache retention would have cost least, per route? | 7d | pi | `data.json` (page: `--serve`) |
| `compaction` | How often do agents compact, at what cost and wait? | 28d | pi, codex, claude, magpie | `compactions.jsonl`, `stats.json`, `totals.json`, `report.html` |

`since`, `until`: `14d`, `12h`, `2026-09-26` (UTC midnight), or ISO time. Output
goes to `results/<study>/<since>_<until>/` by default. `--serve` rebuilds the result
on request, at most every 5 s; a relative `since` rolls with the clock.

In pi, `/ttl-backtest [since] [until] [--prices file] [--no-serve] [--no-open]`
(`src/pi-extension.mjs`) runs the cache-ttl study with the live model registry's
prices. It snapshots that catalog to `~/.pi/agent/ttl-backtester/catalog.json`,
which the CLI uses for prices; without it the CLI reads `models-store.json` and
`models.json`.

`npm test` checks the adapters (appended reads equal one whole read, Codex call
timing, Codex compaction claims, Claude Code messages and copies, ledger dedup
and summarizer links), the speed fits, the cache replay, the compaction joins,
and the layer boundaries.

## Sources

| Adapter | Files | Timing | Not logged |
|---|---|---|---|
| `pi` | `~/.pi/agent/sessions/*/*.jsonl` | update-level, from [pi-tps](https://github.com/monotykamary/pi-tps) `custom/tps` entries | cache writes on routes that fold them into input |
| `codex` | `~/.codex/sessions`, `archived_sessions` rollouts | item-level, rebuilt from item times | cache writes, stalls |
| `claude` | `~/.claude/projects/*/*.jsonl` | request start and end only | stream timing, reasoning tokens, compaction usage |
| `magpie` | `~/.config/magpie/usage.jsonl` (gateway ledger) | first token and end, at the gateway | session, lineage, stalls |

Each adapter's header comment holds its rules. Points that cross adapters:

- **Lineage.** pi and Claude Code sessions are trees; `lineage.mjs` gives each call
  its `prev` call, the compaction or branch summary between, and its cause. Codex
  rollouts are linear.
- **Copies.** Resumed and forked sessions copy earlier records. `load()` keeps one
  per source: same response id, or same id and start.
- **The ledger gives way.** A ledger call another source has is dropped: same
  response id, or equal output within 1 s. Its remaining calls group under
  `gateway/<route>` in speed: the gateway's clock leaves out the agent's own time.
- **pi's summarizer requests.** pi logs only the summed usage of its native
  compaction's one or two requests. `load()` links the ledger calls whose output
  sums to it and that end at most 5 min before the entry.
- **Magpie's Claude bridge** drives Claude Code as transport for other agents. Its
  transcripts (`*magpie-c*` project dirs) are skipped; the ledger has those calls.
- **Incremental scan.** Agents append to session files, so `scan.mjs` reads only
  the bytes written since the last run, with the adapter's saved state. The cache
  (`~/.cache/trace-analytics/<adapter>.json`) is keyed by a hash of the code, so a code
  change rebuilds it. Warm: 0.3 s for 14 days (76k calls).

Known limits:

- pi-tps measures TTFT from turn start, so it includes pi's request setup. It
  starts `streamMs` at the second update but can count the pause before it as a
  stall: the span is `max(stream, stall)`, a lower bound.
- Codex request start is the last input line before the first model item. TTFT
  counts the first model item of any kind, reasoning included; Codex's own figure
  counts the first visible message. Calls with no model item are compaction
  requests (claimed by a `compacted` line) or aborted.
- Claude Code subagent transcripts (`<session>/subagents/`) are not read yet.

## Speed

`src/analytics/speed.mjs` is the authority for every formula and threshold. A
call's wall time splits into parts with different causes:

```
request ─► first token ─────────────────────────────► last update ─► end
│◄ TTFT floor ►│◄ TTFT variance ►│◄ decoding │ stall │ decoding … ►│◄ stall ►│
                                   └──── stall during decoding ─┘   after last token
```

- **End-to-end speed** (headline): all output tokens over wall time. It needs no
  stream timing, so held delivery does not bias it.
- **TTFT floor**: the part of time to first token that context length explains:
  a fit of the 10th percentile of ln(TTFT) against context. Read it for prefill.
- **TTFT variance**: TTFT above the floor: queueing, early stalls, hidden
  reasoning, or buffered generation.
- **Decode speed**: visible output over decoding time (first token to last update,
  less stalls). Not identifiable on routes with held delivery.
- **Stalls**: pauses of 500 ms or more. Stall statistics use calls without
  reasoning, because hidden reasoning also shows as a pause.

Population: calls with a streamed first token and output. Claude Code calls have
no stream timing and do not enter it.

## Cache TTL

`src/analytics/cache-ttl/`: `policies.mjs` hard-codes provider terms with source
URLs and a check date; `sim.mjs` replays requests; `table.mjs` builds its rows.

- A request's predecessor is its `prev` call on the same route with no compaction
  or branch summary between. It counts even before the window.
- The reusable prefix is the predecessor's `cacheRead + cacheWrite` where the
  route logs writes, else its whole prompt. Whether a route logs writes is
  inferred from the data per route.
- Under TTL T, a request hits when its start is within T of the predecessor's.
  Observed reads win where they decide the outcome; only expiry-explained misses
  are imputed.
- Prices are public API prices for every route (`prices.mjs`: the vendor's
  catalog entry by normalized model id). "Actual (logged)" is what pi recorded.

| Group | Models | Policies | Write × input |
|---|---|---|---|
| `anthropic` | `claude-*` | 5m (default), 1h | 1.25, 2 |
| `openai-30m` | GPT-5.6 and later | 30m only | 1.25 |
| `openai-legacy` | earlier GPT, o-series | in_memory, 24h (default) | 1 |

The page reruns `sim.mjs` in the browser, so prices and policies are editable.
Not modeled: prefixes shared across sessions, the minimum cacheable length, and
retention beyond the nominal TTL.

## Conditional TTL and interval accounting

`src/analytics/cache-ttl/conditional.mjs` fits a shrunk conditional distribution of
next compatible lineage access: within 5m, 5m–1h, or no access by 1h. It uses
request-start information and a chronological holdout with a one-hour purge.
The TTL report includes calibration, a bounded cold-write objective, and a separate
sequential prefix replay against fixed 5m and 1h policies. These are counterfactuals;
exact Cache Goblin markers, warming economics, and provider hits remain unverified.
`conditional.json` retains the private fitted model and held-out observations.

`src/analytics/intervals.mjs` partitions session-local elapsed intervals without
adding parallel tool waits twice. Pi supplies response-to-result tool proxies;
Codex supplies explicit tool-item start/end events. Bash and shell outcomes use
logged status, not inferred timeout limits. Await-user gaps are proxies, and
unexplained time stays unclassified. Concurrent sessions produce session-hours,
not the user's wall-clock hours. Other harnesses are outside this interval study.

The study plan and evaluator are in
[`research/intervals-and-ttl/README.md`](research/intervals-and-ttl/README.md).

## Compaction

`src/analytics/compaction.mjs` derives one row per compaction (request tokens,
wall time, cost, the context the next request carried, hc-auto-compact handoff
turns) and the ordinary calls of each population as denominators.
`research/compaction/` holds the study's notes; run with `--out results/compaction/current`.
Its outputs derive from private session logs and stay out of git (`.gitignore`).

- Claude Code logs no usage for its summary request: output is estimated from
  the summary's length (3.6 characters per token), and the history counts as
  cached when the previous call ended under 1 hour before.
- pi blackmagic keeps no cache split: its cost is a range.
- A wall time under 5 output tok/s holds idle time and is dropped.
- An agent turn is a call that answers a user input.

The page holds the narrative, written for the 28-day study window; shorter
windows can lack the rows its text cites.

## Fonts

The pages use [Paper Mono](https://github.com/paper-design/paper-mono) v1.000
(`src/reports/fonts`, SIL Open Font License 1.1), inlined so written pages stay
one file.
