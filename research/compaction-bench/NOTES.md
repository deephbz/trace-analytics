# Compaction benchmark: handoff

## Scope and stage
Exploratory pi-only comparison of native summary, remote Codex compaction,
in-session summary, and in-session keepset. The experiment uses private session
slices. Public artifacts must exclude session text, probe answers, and judge notes.
The README owns the pipeline and reproduction steps.

## Results
- Original matrix: 63 completed compactions across two models and three context tiers.
- Probe v2, two no-compaction controls per slice, and two judge passes are complete.
- Follow-up arms `summaryc` and `keepsetc` test preservation of harness-delivered
  `custom_message` instructions. The local extension patch requires
  `KEEPSET_RAREBIT_CUSTOM=1`; its source is outside this repository.
- The record selector omitted custom messages in the original arms. In the
  follow-up, instruction retention improved from 0/36 to 30/36. REQUEST scores
  improved from 1.78 to 1.93; native scored 2.00. These are local benchmark results.
- Timing analysis attributes 76–97% of wall time to decoding. Native summary
  makes two sequential summarizer requests. See local stats and report for methods.

## Publication boundary
`report.html`, rows, judgements, slice metadata, and raw sessions contain private
material. Keep them local. Some were tracked before this handoff; ignoring a file
does not remove it from Git history. Publication requires a separate history audit.
The inference-physics directory contains reviewed aggregates for its public build.
Local results and evidence live in `results/compaction-bench/current/`.

## Remaining work
- Review the follow-up recall and timing findings with the owner.
- Port reusable session and ledger parsing into shared source adapters. Keep
  experiment arms, prompts, judge rubric, and analyses here.
- Retain the external keepset worktree until the owner authorizes removal.
- No new paid benchmark or judge calls are required for this handoff.
