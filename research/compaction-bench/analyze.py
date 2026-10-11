"""Benchmark statistics and the HTML report.

Inputs: rows.json (collect.py), judge.json (judge.mjs), slices/index.json.
Outputs: stats.json, report.html (page.html + Paper Mono + data).

Comparisons are paired: every arm of one model ran on the same slice, so each
slice gives one ratio per arm against native. Medians are over slices.

Run: python3 -I analyze.py
"""

import base64, json, os, statistics as st

SOURCE = os.path.dirname(os.path.abspath(__file__))
HERE = os.path.abspath(os.path.join(SOURCE, "../../results/compaction-bench/current"))
CACHE_READ = {"sonnet": 0.2, "sol": 0.1}  # USD per Mtok: price of carrying context into each later request
ARMS = {"sonnet": ["native", "summary", "keepset", "summaryc", "keepsetc"], "sol": ["native", "blackmagic", "summary", "keepset", "summaryc", "keepsetc"]}


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def fit(x, y):
    # Least squares y = a + b x, with R².
    n, mx, my = len(x), st.mean(x), st.mean(y)
    sxx = sum((u - mx) ** 2 for u in x)
    b = sum((u - mx) * (v - my) for u, v in zip(x, y)) / sxx
    a = my - b * mx
    ss = sum((v - a - b * u) ** 2 for u, v in zip(x, y)) / max(1e-9, sum((v - my) ** 2 for v in y))
    return dict(n=n, a=a, b=b, r2=1 - ss)


def lstsq(cols, y):
    # Multiple least squares y = c0 + sum ci xi via normal equations; returns coefficients, R², RMSE.
    X = [[1.0] + [c[i] for c in cols] for i in range(len(y))]
    p = len(X[0])
    A = [[sum(r[i] * r[j] for r in X) for j in range(p)] + [sum(r[i] * v for r, v in zip(X, y))] for i in range(p)]
    for i in range(p):
        piv = max(range(i, p), key=lambda r: abs(A[r][i])); A[i], A[piv] = A[piv], A[i]
        for r in range(p):
            if r != i:
                f = A[r][i] / A[i][i]; A[r] = [u - f * w for u, w in zip(A[r], A[i])]
    b = [A[i][p] / A[i][i] for i in range(p)]
    pred = [sum(c * v for c, v in zip(b, r)) for r in X]
    my = st.mean(y)
    return dict(coef=b, r2=1 - sum((v - q) ** 2 for v, q in zip(y, pred)) / sum((v - my) ** 2 for v in y), rmse=(sum((v - q) ** 2 for v, q in zip(y, pred)) / len(y)) ** 0.5)


def timing(rows):
    """Where compaction wall time goes, per run: before the first visible token, and decoding.

    Sonnet: Magpie ledger per request (timing.json: ttft and duration). Sol in-session: RPC stream
    events (split.json). Sol native and blackmagic expose no per-request timing; their before-first-token
    time is estimated from the cold prefill fit (prefill.json), and decoding is the rest.
    """
    T = {t["id"]: t for t in json.load(open(f"{HERE}/timing.json"))}
    SP = {s["id"]: s for s in json.load(open(f"{HERE}/split.json"))}
    P = json.load(open(f"{HERE}/prefill.json"))
    out = {"prefill": {}, "regress": {}, "runs": []}
    for m in ARMS:
        cold = [r for r in P if r["model"] == m and r["label"] == "cold"]
        warm = [r for r in P if r["model"] == m and r["label"] == "warm"]
        f = fit([(r["input"] + r["cacheWrite"]) / 1000 for r in cold], [r["ttft"] for r in cold])
        out["prefill"][m] = dict(cold=f, warm_p50=med([r["ttft"] for r in warm]), warm_min=min(r["ttft"] for r in warm), warm_max=max(r["ttft"] for r in warm),
                                 cold_uncached_min=min(r["cacheRead"] for r in cold), points=[dict(label=r["label"], ctx=r["input"] + r["cacheRead"] + r["cacheWrite"], ttft=r["ttft"], slice=r["slice"]) for r in cold + warm])
        mr = [r for r in rows if r["model"] == m]
        y = [r["wall_s"] for r in mr]
        o = [r["c_out"] / 1000 for r in mr]; u = [(r["c_in"] + (r["c_cw"] or 0)) / 1000 for r in mr]; c = [(r["c_cr"] or 0) / 1000 for r in mr]
        out["regress"][m] = dict(n=len(mr), out=lstsq([o], y), out_unc=lstsq([o, u], y), out_unc_cr=lstsq([o, u, c], y), unc_p50={a: med([x for x, r in zip(u, mr) if r["arm"] == a]) for a in ARMS[m]})
        for r in mr:
            if m == "sonnet":
                q = T[r["id"]]["comp"]; first = sum(x["ttft"] for x in q); dec = sum(x["ms"] - x["ttft"] for x in q); src = "measured"
            elif r["id"] in SP:
                first = SP[r["id"]]["before_visible"]; dec = SP[r["id"]]["stream"]; src = "measured"
            else:
                calls = 2 if r["arm"] == "native" else 1
                first = calls * f["a"] + f["b"] * (r["c_in"] + (r["c_cw"] or 0)) / 1000; dec = r["wall_s"] - first; src = "estimated"
            out["runs"].append(dict(id=r["id"], model=m, arm=r["arm"], wall=r["wall_s"], first=first, decode=dec, src=src))
    out["arms"] = {m: {a: dict(first_p50=med([x["first"] for x in out["runs"] if x["model"] == m and x["arm"] == a]),
                               decode_p50=med([x["decode"] for x in out["runs"] if x["model"] == m and x["arm"] == a]),
                               share_p50=med([x["decode"] / x["wall"] for x in out["runs"] if x["model"] == m and x["arm"] == a]),
                               share_min=min([x["decode"] / x["wall"] for x in out["runs"] if x["model"] == m and x["arm"] == a] or [None]),
                               src=next((x["src"] for x in out["runs"] if x["model"] == m and x["arm"] == a), None)) for a in ARMS[m]} for m in ARMS}
    return out


def mechanism(allrows, index, judge):
    """Why in-session recall fell: does the compacted context still hold the latest instruction?

    The keepset record keeps only user and assistant `message` entries. Worker sessions receive every
    instruction as a `custom_message`, so the original arms drop them; the *c arms keep them.
    Presence = three 40-character windows of the latest instruction all appear in the summary or kept entries.
    """
    import re
    norm = lambda t: re.sub(r"\s+", " ", t)
    j2 = json.load(open(f"{HERE}/judge2.json")) if os.path.exists(f"{HERE}/judge2.json") else {}
    out = {"user_messages": sum(int(v["user_messages"]) for v in index.values()), "slices": len(index), "arms": {}}
    for a in ["native", "blackmagic", "summary", "keepset", "summaryc", "keepsetc", "none"]:
        rs = [r for r in allrows if r["arm"] == a and r.get("rep", 1) == 1]
        present = named = only_warm = 0
        for r in rs:
            if a != "none":
                E = [json.loads(l) for l in open(f"{HERE}/runs/{r['id']}/session.jsonl")]
                ids = {e.get("id"): i for i, e in enumerate(E)}
                ci = max(i for i, e in enumerate(E) if e.get("type") == "compaction")
                c = E[ci]; kept = E[ids.get(c.get("firstKeptEntryId"), ci):ci]
                text = norm(" ".join([c.get("summary") or ""] + [json.dumps(e, ensure_ascii=False) for e in kept])).replace("\\n", " ")
                lu = norm(index[r["slice"]]["last_user"])
                present += all(lu[i:i + 40] in text for i in (len(lu) // 4, len(lu) // 2, 3 * len(lu) // 4))
                users = re.findall(r"\[USER\]\n(.*?)(?=\n\n\[|\Z)", c.get("summary") or "", re.S)
                only_warm += bool(users) and all("Benchmark checkpoint" in u for u in users)
            ans = (judge.get(r["id"]) or {}).get("answer", "").split("NEXT")[0]
            named += bool(re.search(r"(latest|most recent)[^.]{0,80}(checkpoint|benchmark|two sentences)", ans, re.I))
        per = lambda f: sum(((judge.get(r["id"]) or {}).get(f) or 0) + ((j2.get(r["id"]) or {}).get(f) or 0) for r in rs) / 2 / max(1, len(rs))
        out["arms"][a] = dict(n=len(rs), present=present, named_checkpoint=named, record_only_warmup=only_warm,
                              request=per("request"), next=per("next"), facts=per("facts"), total=per("request") + per("next") + per("facts"))
    return out


def quality(rs):
    # Judge points: request and facts on every slice, next only where ground truth exists.
    return dict(q_request=sum(r["q_request"] or 0 for r in rs), q_next=sum(r["q_next"] or 0 for r in rs if r["q_next"] is not None),
                q_next_n=sum(1 for r in rs if r["q_next"] is not None), q_facts=sum(r["q_facts"] or 0 for r in rs),
                q_total=sum((r["q_request"] or 0) + (r["q_next"] or 0) + (r["q_facts"] or 0) for r in rs),
                q_max=sum(2 * (2 + (r["q_next"] is not None)) for r in rs), q_n=len(rs))


def main():
    allrows = [r for r in json.load(open(f"{HERE}/rows.json")) if r["ok"]]
    judge = json.load(open(f"{HERE}/judge.json"))
    for r in allrows:
        j = judge.get(r["id"]) or {}
        r.update(q_request=j.get("request"), q_next=j.get("next"), q_facts=j.get("facts"), q_note=j.get("note"))
    rows = [r for r in allrows if not r.get("control")]
    controls = [r for r in allrows if r.get("control") and r["rep"] == 1]
    controls2 = {r["slice"]: r for r in allrows if r.get("control") and r["rep"] == 2}
    index = json.load(open(f"{HERE}/slices/index.json"))
    for r in rows:
        r["cost_mid"] = (r["cost"] + r["cost_hi"]) / 2
        r["carry_per_call"] = r["after"] * CACHE_READ[r["model"]] / 1e6
        r["after_share"] = r["after"] / r["before"]
        r["cache_share"] = r["c_cr"] / (r["c_in"] + r["c_cr"] + r["c_cw"]) if r["c_cr"] is not None else None
        r["out_tps"] = r["c_out"] / r["wall_s"]
        r["session_tier"] = f'{r["session"]} {r["tier"] // 1000}k'
    by = {(r["slice"], r["arm"]): r for r in rows}
    stats = {"n": len(rows), "models": {}}
    for model, arms in ARMS.items():
        slices = sorted({r["slice"] for r in rows if r["model"] == model}, key=lambda s: (index[s]["session"], index[s]["tier"]))
        M = {"slices": slices, "arms": {}}
        for a in arms:
            rs = [by[(s, a)] for s in slices if (s, a) in by]
            nat = [by[(s, "native")] for s in slices if (s, a) in by]
            M["arms"][a] = dict(
                n=len(rs),
                wall_p50=med([r["wall_s"] for r in rs]), wall_min=min(r["wall_s"] for r in rs), wall_max=max(r["wall_s"] for r in rs),
                cost_p50=med([r["cost_mid"] for r in rs]), cost_lo_p50=med([r["cost"] for r in rs]), cost_hi_p50=med([r["cost_hi"] for r in rs]),
                cost_sum=sum(r["cost_mid"] for r in rs),
                out_p50=med([r["c_out"] for r in rs]), out_tps_p50=med([r["out_tps"] for r in rs]),
                req_p50=med([r["c_in"] + (r["c_cr"] or 0) + (r["c_cw"] or 0) for r in rs]),
                cache_share_p50=med([r["cache_share"] for r in rs]),
                after_p50=med([r["after"] for r in rs]), after_share_p50=med([r["after_share"] for r in rs]),
                carry_p50=med([r["carry_per_call"] for r in rs]),
                kept_tokens_p50=med([r.get("kept_tokens") for r in rs]), kept_rounds_p50=med([r.get("kept_rounds") for r in rs]),
                # paired against native on the same slice
                wall_ratio_p50=med([r["wall_s"] / n["wall_s"] for r, n in zip(rs, nat)]),
                cost_ratio_p50=med([r["cost_mid"] / n["cost_mid"] for r, n in zip(rs, nat)]),
                faster_than_native=sum(r["wall_s"] < n["wall_s"] for r, n in zip(rs, nat)),
                cheaper_than_native=sum(r["cost_mid"] < n["cost_mid"] for r, n in zip(rs, nat)),
                **quality(rs),
            )
        mr = [r for r in rows if r["model"] == model]
        M["fit_wall_out"] = fit([r["c_out"] / 1000 for r in mr], [r["wall_s"] for r in mr])
        M["fit_wall_before"] = fit([r["before"] / 1000 for r in mr], [r["wall_s"] for r in mr])
        for a in arms:
            ar = [r for r in mr if r["arm"] == a]
            M["arms"][a]["fit_cost_before"] = fit([r["before"] / 100_000 for r in ar], [r["cost_mid"] for r in ar])
            # Later calls until a cheaper compaction's larger leftover context has cost the saving back.
            sv = [(by[(s, "native")]["cost_mid"] - by[(s, a)]["cost_mid"], by[(s, a)]["carry_per_call"] - by[(s, "native")]["carry_per_call"]) for s in slices if (s, a) in by]
            M["arms"][a]["saving_p50"] = med([x for x, _ in sv])
            M["arms"][a]["extra_carry_p50"] = med([y for _, y in sv])
            M["arms"][a]["breakeven_calls_p50"] = med([x / y if y > 0 and x > 0 else None for x, y in sv])
            M["arms"][a]["never_loses"] = sum(1 for x, y in sv if x > 0 and y <= 0)
        cs = [r for r in controls if r["model"] == model]
        M["control"] = quality(cs)
        # Answer noise: the same uncompacted slice probed twice, both judged.
        c2 = [controls2[r["slice"]] for r in cs if r["slice"] in controls2]
        if c2:
            M["control_rep2"] = quality(c2)
            pt = lambda r: (r["q_request"] or 0) + (r["q_next"] or 0) + (r["q_facts"] or 0)
            M["control_rep_diff"] = dict(n=len(c2), per_slice_abs=[abs(pt(r) - pt(controls2[r["slice"]])) for r in cs if r["slice"] in controls2])
        # Paired against the control: slices where the method scored lower / higher.
        ctl = {r["slice"]: r for r in cs}
        for a in arms:
            d = [((r["q_request"] or 0) + (r["q_next"] or 0) + (r["q_facts"] or 0)) - ((ctl[r["slice"]]["q_request"] or 0) + (ctl[r["slice"]]["q_next"] or 0) + (ctl[r["slice"]]["q_facts"] or 0)) for r in mr if r["arm"] == a and r["slice"] in ctl]
            M["arms"][a].update(q_vs_control_lower=sum(x < 0 for x in d), q_vs_control_higher=sum(x > 0 for x in d), q_vs_control_diffs=d)
        stats["models"][model] = M
    stats["before_p50"] = {m: {t: med([r["before"] for r in rows if r["model"] == m and r["tier"] == t]) for t in sorted({r["tier"] for r in rows if r["model"] == m})} for m in ARMS}
    # Judge agreement: a second, independent pass over the same answers (judge2.json).
    if os.path.exists(f"{HERE}/judge2.json"):
        j2 = json.load(open(f"{HERE}/judge2.json"))
        pairs = [(judge[k], j2[k]) for k in judge if k in j2 and judge[k]["answer"] == j2[k]["answer"]]
        items = [(a[f], b[f]) for a, b in pairs for f in ("request", "next", "facts") if a.get(f) is not None and b.get(f) is not None]
        stats["judge_agreement"] = dict(answers=len(pairs), items=len(items), exact=sum(x == y for x, y in items) / len(items), off_by_2=sum(abs(x - y) == 2 for x, y in items))
        for m, M in stats["models"].items():
            for a in list(M["arms"]) + ["none"]:
                rs = [r for r in allrows if r["model"] == m and r["arm"] == a and r.get("rep", 1) == 1]
                tot2 = sum((j2.get(r["id"], {}).get("request") or 0) + (j2.get(r["id"], {}).get("next") or 0) + (j2.get(r["id"], {}).get("facts") or 0) for r in rs)
                (M["arms"][a] if a in M["arms"] else M["control"])["q_total_pass2"] = tot2
    stats["timing"] = timing(rows)
    stats["mechanism"] = mechanism(allrows, index, judge)
    stats["judge_null_next"] = sorted({r["slice"] for r in rows if r["q_next"] is None})
    json.dump(stats, open(f"{HERE}/stats.json", "w"), indent=1)
    for m, M in stats["models"].items():
        c = M["control"]
        print(m, "wall~out", {k: round(v, 2) for k, v in M["fit_wall_out"].items()}, "wall~before", {k: round(v, 2) for k, v in M["fit_wall_before"].items()})
        for a, x in M["arms"].items():
            print("   ", a, "cost/100k", round(x["fit_cost_before"]["b"], 3), "r2", round(x["fit_cost_before"]["r2"], 2), "saving", x["saving_p50"], "extra carry", x["extra_carry_p50"], "breakeven", x["breakeven_calls_p50"], "never", x["never_loses"])
        print(m, f'control quality {c["q_total"]}/{c["q_max"]} (req {c["q_request"]} next {c["q_next"]}/{2*c["q_next_n"]} facts {c["q_facts"]})')
        for a, x in M["arms"].items():
            print(f'  {a:<10} wall {x["wall_p50"]:5.1f}s ({x["wall_min"]:.0f}-{x["wall_max"]:.0f}) x{x["wall_ratio_p50"]:.2f} faster {x["faster_than_native"]}/{x["n"]}  cost ${x["cost_p50"]:.3f} x{x["cost_ratio_p50"]:.2f} cheaper {x["cheaper_than_native"]}  '
                  f'out {x["out_p50"]:.0f} {x["out_tps_p50"]:.0f}t/s  after {x["after_p50"]/1000:.1f}k ({x["after_share_p50"]:.0%})  quality {x["q_total"]}/{x["q_max"]} (req {x["q_request"]} next {x["q_next"]}/{2*x["q_next_n"]} facts {x["q_facts"]})')
    keep = ["id", "slice", "session", "model", "arm", "tier", "before", "wall_s", "c_in", "c_cr", "c_cw", "c_out", "calls", "cost", "cost_hi", "cost_mid", "after", "after_share", "carry_per_call",
            "kept_tokens", "kept_rounds", "rounds", "summary_chars", "probe_cost", "out_tps", "answer_v1", "cache_share", "q_request", "q_next", "q_facts", "q_note", "answer", "latency_s"]
    data = json.dumps({"stats": stats, "rows": [{k: r.get(k) for k in keep} for r in rows], "controls": [{k: r.get(k) for k in ("id", "slice", "session", "model", "tier", "after", "q_request", "q_next", "q_facts", "q_note", "answer")} for r in controls],
                       "slices": {k: {f: v[f] for f in ("session", "model", "tier", "entries", "tool_calls", "est_o200k", "predicted", "source")} for k, v in index.items()}}).replace("<", "\\u003c")
    if os.path.exists(f"{SOURCE}/page.html"):
        font = base64.b64encode(open(f"{SOURCE}/../../src/reports/fonts/PaperMono-wght.woff2", "rb").read()).decode()
        page = open(f"{SOURCE}/page.html").read()
        open(f"{HERE}/report.html", "w").write(page.replace("/*FONT*/", f"data:font/woff2;base64,{font}").replace("/*DATA*/null", data))


main()
