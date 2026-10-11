# Inference physics

Interactive teaching page for client-side latency, throughput, context, and cache
costs. This is an exploratory teaching model, not a hardware benchmark. Its
utilisation factors and synchronisation delays are illustrative assumptions.

## Build and publish

Run `python3 -I research/inference-physics/build.py` from the repository root.
The script uses `page.html`, `aggregates.json`, and the repository's Paper Mono font.
It writes the self-contained `index.html`; no server or JavaScript package build
is required. `.github/workflows/pages.yml` publishes the committed `index.html` to
GitHub Pages on each push to `main` that changes it.

`aggregates.json` contains model/method means, sample counts, and regression
coefficients. Means combine all source sessions and context tiers. Groups need
at least five runs; output length rounds to 100 tokens and wall time to seconds.
This is a disclosure reduction, not a formal anonymity guarantee.

`python3 -I research/inference-physics/aggregate.py` prepares an ignored candidate
from `results/inference-physics/source/benchmark.json`. Review its semantics and
copy it to `aggregates.json` only with publication approval. The build validates
an allowlisted schema before embedding data. It never reads private results.

## Review and limits

An independent Astra review prompted corrections to capacity checks, MLA attention
arithmetic, the prefill memory floor, and the scope of measured claims. The review
brief is in `REVIEW-BUNDLE.md`. Hardware comparisons remain illustrative.

The owner's latest audience guidance is productivity-focused: explain one layer
below client measurements. Detailed MoE and attention internals can be deferred.
The page has not yet been simplified to that scope.
