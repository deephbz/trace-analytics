# Interval accounting and conditional TTL

Status: exploration; implementation follows the operator's approved two-workstream request.

## Questions and plan

1. Account for model time, tool-return waiting, and residual time independently
   of the cache-policy study. Pi tool-result timestamps can bound waiting even
   when execution-start telemetry is absent. Codex tool items supply explicit
   start/end events. Bash and shell outcomes distinguish reported
   success, failure, timeout, cancellation, and unknown. A timeout setting is not
   an observed duration. Preserve proxy timing labels and missingness.
2. Estimate the conditional distribution of time to the next reusable-prefix
   request from local logs. Compare pooled and conditional estimates on a later
   time window. Features must exist when the current request starts. Model
   durations and future tool outcomes cannot leak into those features.

```
logs → adapters → calls + tool observations → interval unions / residuals → report
               → call lineage → next-access observations → temporal split
                 → conditional probabilities → held-out calibration / cost → TTL report
```

## Definitions and evaluator

An interval is bounded by request or result timestamps. A tool return-wait proxy
starts when its requesting model response ends; it includes harness overhead.
Parallel tool intervals contribute their union. Report session-local elapsed
coverage, never a sum across sessions as the operator's wall-clock time. Residual
waiting is unclassified unless an observed input justifies a narrower label.

TTL outcomes are next same-route lineage access within 5 minutes, between 5 minutes
and one hour, or no compatible access within one hour. Exclude right-censored
observations whose one-hour outcome is not yet known. Prefix identity and actual
cache-touch time are not logged by all sources; request starts and lineage are
explicit proxies. Route changes and resets break session-prefix reuse.

Use a chronological training/test split with a one-hour purge at the boundary.
Compare conditional frequency estimates (with pooled shrinkage) to a pooled
baseline using held-out Brier scores and reliability bins. Evaluate a narrowly
defined cold-write, one-next-access decision at API prices. Compare adaptive choice
with both fixed TTLs on the same test population; report uncertainty by session.
Also replay the chosen policy sequentially against fixed 5m and 1h baselines on
the later period. Start all caches cold at the split. Preserve longer-lived prefix
segments, refresh hits, and charge upgrade writes. Report costs by route. This
proxy does not establish exact mixed-marker lifetime savings, warming economics,
or provider hits.

Cache Goblin has mixed marker TTLs, pinned prefixes, upgrade-write costs, and
policy-dependent warming eligibility. Show those boundaries beside suggestions.
Do not treat its static global/project 1h markers as session-policy decisions.
The local calibration can justify a candidate experiment, not an automatic runtime
policy change without marker-level evidence.

## Artifacts and checks

Keep raw observations and fitted results under ignored `results/`. Version only
source and synthetic tests. Use the common pipeline and TTL report. Add a separate
interval report, plus a compact TTL/prefix visual in the TTL report's own style.
Test interval overlap, incomplete timings, outcome classification, temporal leakage,
censoring, cost arithmetic, and sparse-group fallback. Check rendered views against
their backend. No paid model calls or cache-setting changes are required.
