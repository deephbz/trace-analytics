# trace-analytics

Status: review-pending convention proposed from the operator's scope and privacy decisions.
Stage: exploration for studies; consolidation for the shared pipeline; sharing for public artifacts.

## Purpose and scope

Explain coding-agent latency, throughput, cache behavior, compaction, and cost.
Keep a reusable methodology and a complete input → analytics → report pipeline.
Use inference physics to explain measurements and their limits.

- `src/sources/` owns harness log knowledge and normalization. Unavailable facts stay null.
- `src/record.mjs` owns the small shared record contract.
- `src/analytics/` owns questions, treatments, derivations, and findings.
- `src/reports/` owns presentation. Reports render findings; they do not invent them.
- `research/<study>/` owns experiment source: hypotheses, plans, prompts, controls,
  judging criteria, orchestration, and reproduction instructions.

Read sources without changing them. Keep account operations, trading, agent
runtime management, and private transcript archives outside this project's scope.
Ask the operator before moving these responsibility boundaries.

## Public source and private results

Git is the public source bundle. Version code, methodology, configuration schemas,
synthetic fixtures, and instructions required to reproduce a study.

`results/<study>/<condition>/` is the operator's local artifact home. The whole
`results/` tree is ignored. Put final machine-readable results, rendered reports,
private configuration, and necessary experiment evidence there. Use an explicit
condition name for controls, ablations, parameter changes, and accepted baselines.
Original harness logs remain in their owning stores; retain pointers locally.

Each persisted result needs its input or source pointer, parameters, code version,
environment assumptions, interpretation, and verification anchor. Mark unknown
provenance as unknown. Keep provenance with the result; do not invent a separate
registry. A report must retain its machine-readable backend or a working pointer.

Public results require operator review. Publish only approved aggregates or
synthetic examples. Numeric-only rows are not anonymization. Per-trace/per-run
rows, identifiers, timestamps, private paths, project associations, prompts,
answers, and judge notes remain private, including inside HTML and fixtures.
Check small groups for disclosure before publishing aggregates.

Review staged content and full reachable history before publication. Inspect
embedded report data as well as source files. A privacy scanner cannot establish
this semantic boundary. `.gitignore` does not remove tracked files or past commits.
Use only the approved public Git identity. Ask before rewriting published history.

## Retention and cleanup

Classify each artifact before deleting it:

- Source: version the generative bundle, including natural-language instructions.
- Final result: keep one canonical generation for each distinct condition.
- Candidate: temporarily retain one useful predecessor until verification completes.
- Retry or intermediate: delete after promotion if it adds no distinct evidence.

Keep distinct controls, judge-agreement passes, treatments, and declared baselines.
Retain costly or irreproducible model outputs needed to investigate findings.
Never discard original evidence merely because a summary exists. Preserve a failed
attempt only if the failure is useful evidence. Record uncertain classifications
locally and resolve them before deletion.

Use `/tmp` only for disposable execution work. Promote needed results into
`results/` before closing a task. Keep privacy-recovery backups until publication
repair is verified. Ignored files need a separate private backup; Git is not one.

## Change and verification

Check the base revision and pending edits before changing shared files. Keep
unrelated work separate. Choose checks for the changed failure modes; avoid paid
benchmark reruns for path or documentation changes. Verify moved files before
removing duplicates. Update reproduction commands when artifact paths change.

Treat new governance and research conclusions as proposals until the operator
ratifies them. Keep active limitations beside the relevant study instructions.
