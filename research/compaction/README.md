# Compaction in local agent logs

Exploration study. One row per compaction from local pi, Codex, and Claude Code
logs, with request tokens, wall time, cost, and the context the next request
carried. `report.html` holds the findings; this file explains how the data
is made.

```
build.py ──> compactions.jsonl   one row per compaction
   │    └──> totals.json         ordinary model calls per population (denominators),
   │                             exclusions, ordinary decode speed per model
   └─ denoms.mjs (agent-speed ingest: Codex call wall time, decode speed)
analyze.py ──> stats.json, report.html (page.html + data + Paper Mono), fig-*.png
```

Run from this directory:

```sh
python3 -I build.py 28          # window in days
uv run --with matplotlib --with numpy python -I analyze.py
open report.html
```

## Sources and field semantics

| harness | compaction record | request tokens | wall time |
|---|---|---|---|
| pi native | `compaction` entry with a summary | entry `usage`; cache split from the Magpie ledger (1-2 parallel requests whose output sums to the entry's) | Magpie ledger, else the entry gap (≤ 10 min) |
| pi blackmagic | `compaction` entry, `details.state = remote_applied` | `details.usage`, no cache split | `details.latencyMs` |
| Codex | `compacted` rollout item | `token_usage_record` with `response_id = compaction_response_id` | usage record time − last synchronous line |
| Claude Code | `compact_boundary` system entry | estimated (summary chars / 3.6) | `compactMetadata.durationMs` |

Exclusions (counted in `totals.json`): Magpie bridge transcripts in
`~/.claude/projects/*magpie-c*`; Codex compactions a forked thread inherits
from its parent; copies of pi sessions in the evaluation home; resumed Claude
Code copies; wall times implying under 5 output tok/s (idle time).

Cost is list price per token (pi-ai and Magpie price tables), also for
subscription traffic.
