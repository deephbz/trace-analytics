# Inference physics

Interactive teaching page for client-side latency, throughput, context, and cache
costs. This is an exploratory teaching model, not a hardware benchmark. Its
utilisation factors and synchronisation delays are illustrative assumptions.

## Build and publish

Run `python3 -I research/inference-physics/build.py` from the repository root.
The script uses `page.html`, `benchmark.json`, and the repository's Paper Mono font.
It writes the self-contained `index.html`; no server or JavaScript package build
is required. A Pages deployment can copy that file to its artifact root. No Pages
workflow is configured here.

`benchmark.json` contains only model/arm labels, numeric benchmark measurements,
and regression coefficients. It excludes session IDs, private paths, probe
answers, and judge notes. Refresh it from local benchmark data with
`python3 -I research/inference-physics/build.py --refresh-benchmark`.
This command needs the private benchmark rows and stats; the default build does not.

## Review and limits

An independent Astra review prompted corrections to capacity checks, MLA attention
arithmetic, the prefill memory floor, and the scope of measured claims. The review
brief is in `REVIEW-BUNDLE.md`. Hardware comparisons remain illustrative.

The owner's latest audience guidance is productivity-focused: explain one layer
below client measurements. Detailed MoE and attention internals can be deferred.
The page has not yet been simplified to that scope.
