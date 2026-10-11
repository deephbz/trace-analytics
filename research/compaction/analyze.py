"""Analyze compactions.jsonl + totals.json -> report figures and stats.json.

Run: uv run --with matplotlib --with numpy python -I analyze.py
"""

import json, os
from collections import defaultdict
import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
R = [json.loads(l) for l in open(f"{HERE}/compactions.jsonl")]
TOT = json.load(open(f"{HERE}/totals.json"))
T = TOT["totals"]

# Groups: harness x method; codex split by role because sub-agents dominate its count.
def group(r):
    if r["harness"] == "codex":
        return f"codex ({'user thread' if r['role'] == 'user' else 'sub-agent' if r['role'] == 'subagent' else r['role']})"
    return {"pi-native-summary": "pi native summary", "pi-blackmagic": "pi blackmagic", "cc-summary": "claude code"}[r["method"]]

ORDER = ["pi native summary", "pi blackmagic", "codex (user thread)", "codex (sub-agent)", "codex (guardian_review)", "claude code"]
COLOR = {"pi native summary": "#2f6fd6", "pi blackmagic": "#6c4fc4", "codex (user thread)": "#c2408a", "codex (sub-agent)": "#e08bb5",
         "codex (guardian_review)": "#999999", "claude code": "#b08900"}
G = defaultdict(list)
for r in R:
    # A compaction that left the next request at over 90% of the old context did not apply.
    r["applied"] = None if not (r.get("ctx_next") and r.get("ctx_pre")) else r["ctx_next"] < 0.9 * r["ctx_pre"]
    G[group(r)].append(r)


def q(xs, p):
    xs = [x for x in xs if x is not None]
    return float(np.percentile(xs, p)) if xs else None


def cost_mid(r):
    if r.get("cost") is not None:
        return r["cost"]
    if r.get("cost_lo") is not None:
        return (r["cost_lo"] + r["cost_hi"]) / 2
    return None


stats = {"groups": {}, "shares": {}, "fits": {}}

# ---- per-compaction profile
for g in ORDER:
    rs = G.get(g, [])
    if not rs:
        continue
    wall = [r["wall_ms"] / 1000 for r in rs if r.get("wall_ms")]
    tin = [r.get("req_in_total") for r in rs]
    cr_share = [r["req_cache_read"] / r["req_in_total"] for r in rs if r.get("req_cache_read") is not None and r.get("req_in_total")]
    tps = [r["req_out"] / ((r["wall_ms"] - (r.get("ttft_ms") or 0)) / 1000) for r in rs if r.get("wall_ms") and r.get("req_out") and r["wall_ms"] > (r.get("ttft_ms") or 0)]
    keep = [r["ctx_next"] / r["ctx_pre"] for r in rs if r.get("applied")]
    stats["groups"][g] = dict(
        n=len(rs), sessions=len({r["session"] for r in rs}),
        models=sorted({str(r.get("model")).split("/")[-1] for r in rs}),
        ctx_pre_p50=q([r.get("ctx_pre") for r in rs], 50), ctx_pre_p10=q([r.get("ctx_pre") for r in rs], 10), ctx_pre_p90=q([r.get("ctx_pre") for r in rs], 90),
        req_in_p50=q(tin, 50), out_p50=q([r.get("req_out") for r in rs], 50),
        ctx_next_p50=q([r.get("ctx_next") for r in rs if r.get("applied")], 50), not_applied=sum(1 for r in rs if r.get("applied") is False),
        not_applied_days=sorted({r["iso"][:10] for r in rs if r.get("applied") is False}),
        req_in_over_ctx_p50=q([r["req_in_total"] / r["ctx_pre"] for r in rs if r.get("req_in_total") and r.get("ctx_pre")], 50),
        req_cache_write_share_p50=q([r["req_cache_write"] / r["req_in_total"] for r in rs if r.get("tokens_source") == "magpie ledger"], 50),
        ctx_pre_list=[r.get("ctx_pre") for r in rs], ctx_next_over_pre_p50=q(keep, 50),
        next_cache_read_share_p50=q([r["next_cache_read"] / r["ctx_next"] for r in rs if r.get("ctx_next") and r.get("next_cache_read") is not None], 50),
        wall_n=len(wall), wall_p50=q(wall, 50), wall_p90=q(wall, 90), wall_max=max(wall) if wall else None,
        ttft_p50=q([r["ttft_ms"] / 1000 for r in rs if r.get("ttft_ms")], 50),
        out_tps_p50=q(tps, 50), req_cache_read_share_p50=q(cr_share, 50),
        cost_p50=q([cost_mid(r) for r in rs], 50), cost_sum=sum(cost_mid(r) or 0 for r in rs),
        cost_lo_sum=sum(r.get("cost_lo") or 0 for r in rs), cost_hi_sum=sum(r.get("cost_hi") or 0 for r in rs),
        handoff_n=sum(1 for r in rs if r.get("handoff_calls") is not None),
        handoff_cost_p50=q([r.get("handoff_cost") for r in rs if r.get("handoff_calls") is not None], 50),
        handoff_wall_p50=q([r["handoff_wall_ms"] / 1000 for r in rs if r.get("handoff_wall_ms")], 50),
        handoff_in_p50=q([r.get("handoff_in") for r in rs if r.get("handoff_calls")], 50),
        handoff_cold=sum(1 for r in rs if r.get("handoff_in") and r["handoff_cache_read"] / r["handoff_in"] < 0.5),
        calls_between_p50=q([r.get("calls_since_prev") for r in rs], 50),
        tokens_source=sorted({str(r.get("tokens_source")) for r in rs}), wall_source=sorted({str(r.get("wall_source")) for r in rs}),
    )

# ---- frequency and shares, per harness population
POP = {
    "pi": (["pi"], lambda r: r["harness"] == "pi"),
    "codex (user thread)": (["codex:user"], lambda r: r["harness"] == "codex" and r["role"] == "user"),
    "codex (sub-agent)": (["codex:subagent"], lambda r: r["harness"] == "codex" and r["role"] == "subagent"),
    "codex (guardian_review)": (["codex:guardian_review"], lambda r: r["harness"] == "codex" and r["role"] == "guardian_review"),
    "claude code": (["claude-code"], lambda r: r["harness"] == "claude-code"),
}
for name, (keys, sel) in POP.items():
    t = defaultdict(float)
    for k in keys:
        for a, b in T.get(k, {}).items():
            t[a] += b
    rs = [r for r in R if sel(r)]
    c_in = sum(r.get("req_in_total") or 0 for r in rs)
    c_out = sum(r.get("req_out") or 0 for r in rs)
    c_cost = sum(cost_mid(r) or 0 for r in rs)
    c_wall = sum(r.get("wall_ms") or 0 for r in rs)
    h_cost = sum(r.get("handoff_cost") or 0 for r in rs)
    h_wall = sum(r.get("handoff_wall_ms") or 0 for r in rs)
    calls_in = t["uncached"] + t["cache_read"] + t["cache_write"]
    stats["shares"][name] = dict(
        compactions=len(rs), sessions=t["sessions"], sessions_with_compaction=len({r["session"] for r in rs}),
        agent_turns=t["user_turns"], model_calls=t["calls"],
        per_100_turns=100 * len(rs) / t["user_turns"] if t["user_turns"] else None,
        per_1000_calls=1000 * len(rs) / t["calls"] if t["calls"] else None,
        input_share=c_in / (calls_in + c_in) if calls_in else None, output_share=c_out / (t["out"] + c_out) if t["out"] else None,
        cost_share=c_cost / (t["cost"] + c_cost) if t["cost"] else None, compaction_cost=c_cost, calls_cost=t["cost"],
        cost_share_with_handoff=(c_cost + h_cost) / (t["cost"] + c_cost) if t["cost"] else None,
        time_share=c_wall / (t["wall_ms"] + c_wall) if t["wall_ms"] else None, compaction_wall_h=c_wall / 3.6e6, calls_wall_h=t["wall_ms"] / 3.6e6,
        time_share_with_handoff=(c_wall + h_wall) / (t["wall_ms"] + c_wall) if t["wall_ms"] else None,
        timed_rows=sum(1 for r in rs if r.get("wall_ms")),
    )

# ---- wall time vs context: OLS wall_s ~ a + b*input_k + c*output_k, per group
for g in ORDER:
    rs = [r for r in G.get(g, []) if r.get("wall_ms") and r.get("req_in_total") and r.get("req_out")]
    if len(rs) < 8:
        continue
    y = np.array([r["wall_ms"] / 1000 for r in rs])
    xin = np.array([r["req_in_total"] / 1000 for r in rs])
    xout = np.array([r["req_out"] / 1000 for r in rs])
    def fit(X):
        X = np.column_stack([np.ones(len(y))] + X)
        b, *_ = np.linalg.lstsq(X, y, rcond=None)
        res = y - X @ b
        return b.tolist(), 1 - res.var() / y.var()
    b1, r1 = fit([xin])
    b2, r2 = fit([xin, xout])
    rank = lambda a: np.argsort(np.argsort(a))
    stats["fits"][g] = dict(n=len(rs), wall_vs_input=dict(intercept_s=b1[0], s_per_1k_in=b1[1], r2=r1),
                            wall_vs_input_output=dict(intercept_s=b2[0], s_per_1k_in=b2[1], s_per_1k_out=b2[2], r2=r2),
                            spearman_input=float(np.corrcoef(rank(xin), rank(y))[0, 1]), spearman_output=float(np.corrcoef(rank(xout), rank(y))[0, 1]),
                            input_range_k=[float(xin.min()), float(xin.max())])

# Same model, two harnesses: pi native vs Claude Code on Opus 5.5.
for name, sel in [("pi native, Opus 5.5", lambda r: r["method"] == "pi-native-summary" and "opus-5-5" in str(r.get("model"))),
                  ("claude code, Opus 5.5", lambda r: r["harness"] == "claude-code" and "opus-5-5" in str(r.get("model")))]:
    rs = [r for r in R if sel(r) and r.get("wall_ms")]
    stats.setdefault("same_model", {})[name] = dict(n=len(rs), ctx_pre_p50=q([r["ctx_pre"] for r in rs], 50), wall_p50=q([r["wall_ms"] / 1000 for r in rs], 50),
                                                  out_p50=q([r["req_out"] for r in rs], 50), cost_p50=q([r["cost"] for r in rs], 50),
                                                  ctx_next_p50=q([r.get("ctx_next") for r in rs], 50))
# ---- factors: vendor, model, ordinary decode speed, nth compaction, day
ORD = TOT["ordinary_decode"]
bm = lambda m: str(m).split("/")[-1]
vendor = lambda r: "Anthropic" if "claude" in str(r.get("model")) else "OpenAI"
def ord_tps(r):
    o = ORD.get(("codex" if r["harness"] == "codex" else "pi") + "|" + bm(r.get("model")))
    return o["p50"] if o and o["n"] >= 20 else None
def tps(r):
    return r["req_out"] / ((r["wall_ms"] - (r.get("ttft_ms") or 0)) / 1000) if r.get("wall_ms") and r.get("req_out") else None
def prof(rs):
    return dict(n=len(rs), wall_p50=q([r["wall_ms"] / 1000 for r in rs if r.get("wall_ms")], 50), out_p50=q([r.get("req_out") for r in rs], 50),
                tps_p50=q([tps(r) for r in rs], 50), ctx_pre_p50=q([r.get("ctx_pre") for r in rs], 50),
                ctx_next_p50=q([r.get("ctx_next") for r in rs if r.get("applied")], 50), cost_p50=q([cost_mid(r) for r in rs], 50),
                harnesses=sorted({r["harness"] for r in rs}), methods=sorted({r["method"] for r in rs}))
fac = stats["factors"] = {}
byv = defaultdict(list)
for r in R:
    byv[vendor(r)].append(r)
fac["vendor"] = {v: prof(rs) for v, rs in byv.items()}
bym = defaultdict(list)
for r in R:
    bym[(vendor(r), bm(r.get("model")), "codex" if r["harness"] == "codex" else r["harness"])].append(r)
fac["model"] = []
for (v, m, h), rs in sorted(bym.items(), key=lambda kv: -len(kv[1])):
    if len(rs) < 5:
        continue
    o = ORD.get(("codex" if h == "codex" else "pi") + "|" + m)
    fac["model"].append(dict(vendor=v, model=m, harness=h, ordinary_tps=o["p50"] if o and o["n"] >= 20 else None, ordinary_n=o["n"] if o else 0, **prof(rs)))
# one model for all methods: wall = a + b * output / ordinary decode speed of the model
pts = [(r["req_out"] / ord_tps(r), r["wall_ms"] / 1000, group(r), r) for r in R if r.get("wall_ms") and r.get("req_out") and r["harness"] != "claude-code" and ord_tps(r)]
x = np.array([p[0] for p in pts]); y = np.array([p[1] for p in pts])
b, a = np.polyfit(x, y, 1)
res = y - (a + b * x)
fac["unified"] = dict(n=len(pts), a=float(a), b=float(b), r2=float(1 - res.var() / y.var()),
                      residual_p50={g: float(np.median([res[i] for i, p in enumerate(pts) if p[2] == g])) for g in {p[2] for p in pts}},
                      r2_input_only=float(np.corrcoef([p[3]["req_in_total"] for p in pts], y)[0, 1] ** 2))
fac["unified_points"] = [[round(p[0], 1), round(p[1], 1), p[2]] for p in pts]
# nth compaction in a session
bys = defaultdict(list)
for r in sorted(R, key=lambda r: r["t"]):
    bys[(r["harness"], r["session"])].append(r)
nth = defaultdict(lambda: defaultdict(list))
for rs in bys.values():
    for i, r in enumerate(rs):
        g = {"codex-remote": "codex", "pi-blackmagic": "pi blackmagic", "pi-native-summary": "pi native summary", "cc-summary": "claude code"}[r["method"]]
        nth[g][min(i + 1, 4)].append(r)
fac["nth"] = {g: {n: dict(n=len(rs), out_p50=q([r.get("req_out") for r in rs], 50), ctx_next_p50=q([r.get("ctx_next") for r in rs if r.get("applied")], 50)) for n, rs in d.items()} for g, d in nth.items()}
fac["per_session"] = sorted([len(v) for v in bys.values()], reverse=True)
# day-to-day speed of the most common model
day = defaultdict(list)
for r in R:
    if r["harness"] == "codex" and bm(r.get("model")) == "gpt-6.1-sol" and tps(r):
        day[r["iso"][:10]].append(tps(r))
fac["sol_by_day"] = {d: dict(n=len(v), tps_p50=float(np.median(v))) for d, v in sorted(day.items()) if len(v) >= 3}
rank = lambda a: np.argsort(np.argsort(a))
fac["out_vs_ctx_rho"] = {}
for m in ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-5.6-luna", "claude-opus-5-5"]:
    rs = [r for r in R if bm(r.get("model")) == m and r.get("req_out") and r.get("ctx_pre")]
    fac["out_vs_ctx_rho"][m] = dict(n=len(rs), rho=float(np.corrcoef(rank([r["ctx_pre"] for r in rs]), rank([r["req_out"] for r in rs]))[0, 1]))

stats["meta"] = TOT["meta"]
stats["dropped"] = TOT["dropped"]
for g in stats["groups"].values():
    g.pop("ctx_pre_list")
json.dump(stats, open(f"{HERE}/stats.json", "w"), indent=1)
json.dump([{k: v for k, v in r.items()} for r in R], open(f"{HERE}/rows.json", "w"))

# ---- figures
plt.rcParams.update({"font.family": "monospace", "font.size": 9, "axes.spines.top": False, "axes.spines.right": False})
fig, ax = plt.subplots(1, 2, figsize=(12, 4.6))
for g in ORDER:
    rs = [r for r in G.get(g, []) if r.get("wall_ms") and r.get("req_in_total")]
    if not rs:
        continue
    kw = dict(s=14 if "sub-agent" in g else 22, alpha=0.55 if "sub-agent" in g else 0.85, color=COLOR[g], label=f"{g} ({len(rs)})", marker="^" if "claude" in g else "o")
    ax[0].scatter([r["req_in_total"] / 1000 for r in rs], [r["wall_ms"] / 1000 for r in rs], **kw)
    ax[1].scatter([r["req_out"] / 1000 for r in rs if r.get("req_out")], [r["wall_ms"] / 1000 for r in rs if r.get("req_out")], **kw)
ax[0].set(xlabel="compaction request input (k tokens)", ylabel="compaction wall time (s)", title="wall time vs request input")
ax[1].set(xlabel="compaction output (k tokens; claude code estimated)", title="wall time vs output")
ax[0].legend(frameon=False, fontsize=8)
fig.tight_layout()
fig.savefig(f"{HERE}/fig-wall.png", dpi=130)

fig, ax = plt.subplots(figsize=(7, 4.2))
gs = [g for g in ORDER if G.get(g)]
for i, g in enumerate(gs):
    rs = G[g]
    pre = [r["ctx_pre"] / 1000 for r in rs if r.get("ctx_pre") and r.get("ctx_next")]
    nxt = [r["ctx_next"] / 1000 for r in rs if r.get("ctx_pre") and r.get("ctx_next")]
    ax.scatter(pre, nxt, color=COLOR[g], s=16, alpha=0.7, label=g, marker="^" if "claude" in g else "o")
ax.set(xlabel="context before compaction (k tokens)", ylabel="context in next request (k tokens)", title="what compaction leaves")
ax.legend(frameon=False, fontsize=8)
fig.tight_layout()
fig.savefig(f"{HERE}/fig-context.png", dpi=130)

print(json.dumps(stats, indent=1)[:200])

# ---- HTML report: page.html + Paper Mono (agent-speed's web/fonts) + data
import base64
font = base64.b64encode(open(f"{HERE}/../../web/fonts/PaperMono-wght.woff2", "rb").read()).decode()
page = open(f"{HERE}/page.html").read()
data = json.dumps({"stats": stats, "rows": R}).replace("<", "\\u003c")
open(f"{HERE}/report.html", "w").write(page.replace("/*FONT*/", f"data:font/woff2;base64,{font}").replace("/*DATA*/null", data))
