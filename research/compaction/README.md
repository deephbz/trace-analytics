# Compaction in local agent logs

Exploration study. One row per compaction from local pi, Codex, and Claude Code
logs, with request tokens, wall time, cost, and the context the next request
carried. `report.html` holds the findings; this file explains how the data
is made.

```
trace-analytics compaction ──► compactions.jsonl   one row per compaction
                     ├──► totals.json         ordinary model calls per population (denominators),
                     │                        exclusions, ordinary decode speed per model
                     ├──► stats.json          profiles, shares, fits, factors
                     └──► report.html         src/reports/compaction/page.html + data + Paper Mono
```

Run from the repository root:

```sh
node bin/trace-analytics.mjs compaction 2026-09-13T10:08:20Z 2026-10-11T10:08:20Z --out research/compaction
```

The derivations live in `src/analytics/compaction.mjs`; the record fields they
read are defined in `src/record.mjs`. The outputs hold per-session rows from
private logs, so they are generated locally and ignored by git. The findings in
`src/reports/compaction/page.html` were written for 2026-09-13T10:08Z to
2026-10-11T10:08Z.

## Sources and field semantics

| harness | compaction record | request tokens | wall time |
|---|---|---|---|
| pi native | `compaction` entry with a summary | entry `usage`; cache split from the Magpie ledger (1-2 parallel requests whose output sums to the entry's) | Magpie ledger, else the entry gap (≤ 10 min) |
| pi blackmagic | `compaction` entry, `details.state = remote_applied` | `details.usage`, no cache split | `details.latencyMs` |
| Codex | `compacted` rollout item | `token_usage_record` with `response_id = compaction_response_id` | usage record time − last synchronous line |
| Claude Code | `compact_boundary` system entry | estimated (summary text chars / 3.6) | `compactMetadata.durationMs` |

The next request is the first call under the compaction on the session's
conversation path that started after the compaction ended.

Exclusions (in `totals.json`): Magpie bridge transcripts in
`~/.claude/projects/*magpie-c*`; Codex compactions a forked thread inherits
from its parent; resumed Claude Code copies; wall times implying under 5
output tok/s (idle time).

Cost is list price per token (`src/analytics/prices.mjs`: the API vendor's
catalog entry), also for subscription traffic.

## Changes from the Python build (2026-10-11)

The study moved from `build.py`, `analyze.py`, and `denoms.mjs` to the shared
adapters. On the same window, Codex rows, totals, and shares are identical.
Differences:

- Each call and compaction is in the window by its start; the old build had no
  upper bound.
- An agent turn is a call that answers a user input. The old build counted user
  entries, including copies in resumed Claude Code sessions.
- Claude Code summary length counts the summary's text. The old build counted
  its JSON, about 3% more.
- A Claude Code compaction's previous call follows the conversation path, not
  file order.
- Prices come from pi's catalog snapshot, not the pi-ai data tables.
- The matplotlib figures are gone; the page draws its charts.
