# Reading bundle: fact-check of the inference-physics explainer

## Deliverable
- `page.html` (in this directory) holds the prose and all calculator JS.
- `index.html` is the built copy: `page.html` plus the inlined font and the numeric benchmark rows, made by `build.py`. Open it in a browser to see the demos.
- Do not edit either file.

## Goal, in the user's terms
- Audience: a reader with a physics and CS background who does not know LLM internals.
- Purpose: build a high-level structural intuition.
  - Why kernels (quadratic or linear attention), chips (GPU HBM racks vs a Cerebras wafer) and model shapes (dense vs MoE) give different client-side TPS, TTFT, stalls, and context and cache effects.
  - Which laws about agent speed and compaction hold on any stack.
- The style follows PlanetScale's interactive blog posts.
- Structural accuracy matters more than exhaustive detail.

## Deliberate constraints
Judge whether the page states each constraint honestly. Do not ask to remove it.
- The page uses a toy roofline model:
  - 1 byte per weight;
  - 50% compute utilization in decode and 40% in prefill;
  - a fixed per-layer sync overhead.
- Chip specs are rounded public figures.
- Public open-weight shapes stand in for private frontier models: dense 70B is like Llama 3 70B, and the MoE is like DeepSeek-V3.
- Linear attention is a fixed state the size of 4k tokens of KV cache.
- Prices and fits in section 8 come from a local benchmark (`../compaction-bench/stats.json`, `rows.json`). Take those measured numbers as given.

## Check
1. Check every factual claim in the prose against primary or high-trust sources:
   - vendor spec sheets;
   - model papers or configs: Llama 3 70B, and DeepSeek-V3 (MLA KV size; 256 routed experts, top-8);
   - serving papers: vLLM; Sarathi (chunked prefill); DistServe or Splitwise (disaggregation).

   Topics: memory-bound decode, compute-bound prefill, KV cache growth, MoE expert coverage at batch size B, prompt caching, stalls, speculative decoding.
2. Check the calculator code: `decode()`, `prefill()`, `weightBytes()`, and the KV bytes per token for both models. Look for errors that change the shape of a curve or an order of magnitude.
3. Check the laws table in section 9. Are its status labels (measured, standard, provisional) honest?
4. Find misleading simplifications that a careful reader would notice.

## Return (as Task evidence)
- A verdict.
- Findings ranked by severity. Each finding gives:
  - the exact quote or line;
  - what is wrong;
  - a source URL or a calculation;
  - a concrete corrected sentence or formula.
- A short list of the claims you verified as correct, with sources.
- Keep observation separate from inference, and mark unverified items provisional.
