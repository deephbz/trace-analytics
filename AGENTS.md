# trace-analytics

Status: review-pending wording of the operator's agreed contract.
Stage: exploration for studies; consolidation for the shared pipeline; sharing for public artifacts.

## Purpose and objectives

Turn local coding-agent traces into evidence about latency, throughput, cache
behavior, compaction, cost, and the user's experienced wait. Own the reusable
methodology, framework, and complete input → analytics → report pipeline.
Own the shared session reader and its JSON/JSONL CLI for local consumers.
This purpose extension is review-pending wording.

The analytical questions govern development:

| Question | Intended decision |
|---|---|
| How does TTFT vary with context? | Investigate prefill and other pre-generation delays. |
| How fast does output decode? | Compare generation rates where telemetry can identify them. |
| What determines end-to-end throughput and stalls? | Explain the user's wait. |
| How much time and cost does compaction add? | Compare compaction methods and summary tradeoffs. |
| How do idle gaps and cache reuse interact? | Compare TTL policies. |
| How does prefix placement affect reuse? | Investigate cache layout choices. |
| How much time goes to tools versus model calls? | Identify bottlenecks as generation gets faster. |

These are directions, not a claim that every study is implemented. The current
study inventory and usage live in `README.md`. Extend analytics through shared
normalized inputs instead of building a separate parser for each question.

Use inference physics to explain one layer below client measurements. Keep the
public explainer useful to readers making productivity decisions. Label toy
hardware assumptions; do not infer private serving internals from client timings.

## Layer contract

```
harness logs → sources → normalized records → analytics → findings → reports
                  └── session reader CLI → consumers
                                  pipeline wires the studies
```

- **Sources** own knowledge of harness formats, semantics, availability, lineage,
  and duplicate records. `src/sources/` reads logs and normalizes observations.
  Unlogged facts stay null. Preserve missingness instead of inventing measurements.
  The session reader owns discovery, identity, roles, entry streams, branch selection,
  and copy selection. Consumers own their questions and must not add harness parsers.
  Reader text is opt-in; its rebuildable caches stay private. Keep analytics populations
  independent from reader discovery.
- **Records** are the small contract in `src/record.mjs`. Add a concept only when
  an analytical question needs it. Give equivalent facts equivalent semantics
  across adapters; preserve distinctions that affect interpretation.
- **Analytics** own intentions, populations, transformations, estimates, and
  findings. `src/analytics/` consumes normalized records, never harness files.
  Keep estimates distinguishable from observations and expose their assumptions.
- **Reports** own mental models, visual language, and audience-fit explanation.
  `src/reports/` renders analytical results, never raw logs. An interactive report
  may call shared analytics; it must not maintain a second set of formulas.
- **Wiring** belongs in `src/pipeline.mjs` and the entry points. Keep study logic
  inside its owning layer so the three layers can evolve independently.
- **Experiments** belong in `research/<study>/`: plans, orchestration, prompts,
  controls, judging criteria, and reproduction instructions. Move reusable
  harness parsing into sources; keep experiment-specific treatments in research.

Read original logs without changing them. The repo does not own harness runtime
implementations, model serving, account operations, or the original log archive.
Controlled experiments may use local copies and authorized model calls. Ask before
broadening scope, moving a responsibility boundary, or incurring unapproved costs.

## Evidence and interpretation

Before a new study or experiment, state the question, hypotheses, comparison
conditions, evaluator, and source-to-result flow in its source bundle. Read the
study's instructions before running it. Ordinary report refreshes reuse that plan.

For each result, state the window and time zone, included population, coverage,
exclusions, and missing telemetry. Keep source/harness, route/model, and measured
phase distinctions visible where they affect comparisons. Explain deduplication
and lineage assumptions through the owning source and analysis code.

Separate observed usage, estimated usage, modeled API-price cost, and actual
billed spend. A cache-policy simulation is a counterfactual. TTFT is not an
isolated prefill measurement; stalls do not establish a unique cause. Support
causal claims with evidence beyond correlation, or mark them provisional.

Reports must fit their selected window and population. Handle absent groups and
zero events without borrowing findings or dates from another run. Mark snapshots
and live views distinctly. Preserve comparison windows when showing studies
side by side, and disclose differences in coverage.

## Artifact placement and retention

| Home | Contents and authority |
|---|---|
| Tracked source | Reusable code, methods, plans, prompts, schemas, synthetic fixtures, evaluation criteria, and reproduction instructions. |
| `results/<study>/<condition>/` | Ignored local results, private configuration, necessary input slices, experiment evidence, and reports. |
| Original source stores | Authoritative harness logs. Keep local pointers; avoid unnecessary copies. |

A condition identifies a meaningful comparison, including input window when
relevant. Keep one canonical result per condition. A persisted result carries
its data or pointer, parameters, code version, environment assumptions,
interpretation, and verification anchor. Record unknown provenance as unknown.
Keep this with the result rather than creating a separate bookkeeping system.
A rendered report retains its machine-readable backend or a working pointer.

Apply promotion and cleanup together:

1. Classify outputs as distinct conditions, candidates, retries, or intermediates.
2. While verification is unresolved, retain at most one useful predecessor.
3. Promote the verified candidate and remove superseded retries and intermediates.

Retain controls, ablations, judge-agreement passes, and declared baselines. Keep
costly or irreproducible evidence needed to investigate findings. A summary does
not replace original evidence. Keep a failed attempt only when its failure adds
useful evidence. Resolve uncertain classifications before deletion.

Use `/tmp` for disposable work only. Promote needed artifacts into `results/`.
Verify moved files before removing their old copies. Ignored results require a
separate private backup; Git does not protect them.

## Public boundary

The repository and GitHub Pages are public. Local results remain private.
Version sanitized source bundles; keep private source coordinates in ignored
configuration. Tests use synthetic identities and content.

Publish only operator-approved aggregates or synthetic examples. Per-trace and
per-run rows remain private even when they contain only numbers or pseudonyms.
Exclude personal identifiers, session UUIDs, source timestamps, private paths,
project associations, prompts, answers, and judge notes from tracked artifacts.
Inspect embedded HTML/JavaScript data, fixtures, screenshots, and Git metadata.
Review small groups and combinations of aggregates for disclosure. A minimum
sample count or an allowlisted schema does not prove anonymity.

Pages must build from reviewed public inputs without reading local results.
Serve private reports on loopback. Public previews, uploads, and wider network
access require explicit authorization.

Before publishing, review staged content and reachable history semantically and
run the installed privacy checks. Use only the approved public Git identity.
Neither a clean scan nor `.gitignore` proves that private data is absent.

For an authorized history repair, record the audited cutoff, keep a private
recovery copy, sanitize only that history, and preserve later work. Use
compare-and-swap locally and a force-with-lease remotely. Audit the replacement
before publication. Check old deployment artifacts and retained host references;
a force-push does not erase caches or external clones. Keep audit receipts outside
the public repo and retain recovery evidence until cleanup is resolved.

## Change discipline

Inspect the base revision and pending edits before changing shared files. Keep
unrelated work separate. Escalate changes to this governing contract for operator
review; optimize implementation freely inside it. Agent-written governance and
new conclusions remain proposals until ratified.

Choose verification for the changed failure modes. Reuse unchanged evidence;
avoid paid reruns for path or documentation edits. Verify analytics and their
rendered views separately. Update reproduction instructions when paths change.
Record active limitations beside the study they affect. Report completed work,
verification, and unresolved blockers without claiming more than the evidence.
