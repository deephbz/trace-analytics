# Compaction methods in pi: local benchmark

`report.html` compares four compaction methods on real pi session slices, driven
through pi itself (RPC mode) on the Claude subscription (Magpie) and the Codex
subscription:

- pi native summary
- blackmagic (Codex remote compaction; gpt-6.1-sol only)
- in-session summary and in-session keepset (`experiment/keepset-compaction` @ f519d2a)

Models: claude-sonnet-5-5, gpt-6.1-sol. Context tiers: about 90k, 200k, 300k
(gpt-6.1-sol: 250k, its window is 272k).

## Pipeline

```
slice.py    real sessions -> slices/<session>-<model>-<tier>k.jsonl + index.json (ground truth)
bench.mjs   slice x model x method -> runs/<id>/{session.jsonl,events.jsonl,meta.json}
reprobe.mjs probe v2 on each compacted session; no-compaction controls (__none, __none2)
collect.py  runs -> rows.json
judge.mjs   blind claude-opus-5-5 scores of probe answers -> judge.json (JUDGE_OUT=judge2.json: second pass)
timing.py   per-request timing: Magpie ledger (Sonnet) + RPC events -> timing.json
split.py    in-session handoff turn: before first visible token / streaming -> split.json
prefill.mjs time to first token, thinking off, uncached then cached, per slice -> prefill.json
analyze.py  rows + judge -> stats.json, report.html (page.html + Paper Mono)
```

Reproduction requires private source sessions and configured pi subscriptions.
Set `BENCH_KEEPSET_EXTENSION` and `BENCH_BLACKMAGIC_EXTENSION` to the absolute
paths of the external extensions before selecting those arms. The slice selector
currently contains local source coordinates and needs a separate publication review.

Reproduce:

```
uv run --with tiktoken python -I slice.py
node bench.mjs && node reprobe.mjs && python3 -I collect.py
node judge.mjs && JUDGE_OUT=judge2.json node judge.mjs
node prefill.mjs && python3 -I timing.py && uv run --with tiktoken python -I split.py
python3 -I analyze.py
```

Arms `summaryc` and `keepsetc` need the local patch in the keepset worktree
(`KEEPSET_RAREBIT_CUSTOM=1` keeps harness `custom_message` entries in the verbatim record).

Finished runs, probes and judgements are skipped on rerun.

## Privacy

`slices/*.jsonl` and `runs/` hold copies of private session content. Do not
publish them. `report.html` embeds probe answers and judge notes, which quote
session content. Rows, judgements, and slice metadata also contain private text.
Some were tracked in earlier commits. The local ignore rules do not sanitize
those commits; audit history before publication.

The self-contained public teaching artifact is `../inference-physics/index.html`.
Its numeric snapshot lets it rebuild without these private files.
