"""One row per benchmark run, from runs/<id>/{meta.json,session.jsonl} and slices/index.json.

Row fields:
  wall_s       compaction wall time: trigger sent -> compaction_end event
  before       measured context of the warm-up request (input + cacheRead + cacheWrite)
  c_in/c_cr/c_cw/c_out  tokens of the compaction model calls
                 native: the compaction entry's usage (its summarizer requests)
                 keepset/summary: the in-session handoff turns (handoff -> compaction entry)
                 blackmagic: details.usage (no cache split; cost is a lo/hi range)
  cost/cost_hi compaction cost at list price, USD (equal except blackmagic)
  after        measured context of the probe request: what the session carries on
  probe_*      the probe request's tokens and cost (first request on the new context)
  answer       probe v2 answer (reprobe.mjs), for the judge; answer_v1 is the first probe's

Run: python3 -I collect.py  ->  rows.json
"""

import json, os, re

HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../results/compaction-bench/current"))
# USD per Mtok, list price (pi model data): input, output, cacheRead, cacheWrite
PRICE = {"sonnet": (2, 10, 0.2, 2.5), "sol": (2, 10, 0.1, 2.5)}


def usd(model, i, o, cr, cw):
    p = PRICE[model]
    return (i * p[0] + o * p[1] + cr * p[2] + cw * p[3]) / 1e6


def ctx(u):
    return u["input"] + u["cacheRead"] + u["cacheWrite"]


def row(dirname, index):
    meta = json.load(open(f"{HERE}/runs/{dirname}/meta.json"))
    sl = index[meta["slice"]]
    L = [json.loads(l) for l in open(f"{HERE}/runs/{dirname}/session.jsonl")]
    new = L[sl["entries"] + 1:]  # after the slice's header + entries
    r = dict(id=meta["id"], slice=meta["slice"], session=sl["session"], model=meta["model"], arm=meta["arm"], tier=sl["tier"], ok=meta["ok"], error=meta.get("error"))
    if not meta["ok"]:
        return r
    asst = [(i, d["message"]) for i, d in enumerate(new) if (d.get("message") or {}).get("role") == "assistant"]
    ci = next(i for i, d in enumerate(new) if d["type"] == "compaction")
    comp = new[ci]
    warm = asst[0][1]
    r["before"] = ctx(warm["usage"])
    s = meta["steps"]["compaction"]
    r["wall_s"] = (s["end"] - s["t0"]) / 1000
    if meta["arm"] == "native":
        u = comp["usage"]
        r.update(c_in=u["input"], c_cr=u["cacheRead"], c_cw=u["cacheWrite"], c_out=u["output"], calls=None)
        r["cost"] = r["cost_hi"] = usd(meta["model"], u["input"], u["output"], u["cacheRead"], u["cacheWrite"])
    elif meta["arm"] == "blackmagic":
        u = comp["details"]["usage"]
        r.update(c_in=u["input_tokens"], c_cr=None, c_cw=None, c_out=u["output_tokens"], calls=1, latency_s=comp["details"].get("latencyMs", 0) / 1000)
        r["cost"] = usd(meta["model"], 0, u["output_tokens"], u["input_tokens"], 0)
        r["cost_hi"] = usd(meta["model"], u["input_tokens"], u["output_tokens"], 0, 0)
    else:
        h = [m for i, m in asst[1:] if i < ci]  # handoff turn(s), after the warm-up
        r.update(c_in=sum(m["usage"]["input"] for m in h), c_cr=sum(m["usage"]["cacheRead"] for m in h), c_cw=sum(m["usage"]["cacheWrite"] for m in h),
                 c_out=sum(m["usage"]["output"] for m in h), calls=len(h))
        r["cost"] = r["cost_hi"] = usd(meta["model"], r["c_in"], r["c_out"], r["c_cr"], r["c_cw"])
        k = (comp.get("details") or {}).get("keepset") or {}
        r.update(kept_tokens=k.get("keptTokens"), kept_rounds=len(k.get("kept") or []), rounds=k.get("rounds"), plan_summary_tokens=k.get("planSummaryTokens"))
    r["summary_chars"] = len(comp.get("summary") or "")
    probe = [m for i, m in asst if i > ci]
    pu = probe[0]["usage"]
    r["after"] = ctx(pu)
    r.update(probe_in=pu["input"], probe_cr=pu["cacheRead"], probe_cw=pu["cacheWrite"], probe_out=pu["output"],
             probe_cost=usd(meta["model"], pu["input"], pu["output"], pu["cacheRead"], pu["cacheWrite"]),
             probe_tools=sum(1 for m in probe for c in m["content"] if c.get("type") == "toolCall"))
    r["answer_v1"] = "\n".join(c["text"] for c in probe[-1]["content"] if c.get("type") == "text")
    p2 = f"{HERE}/runs/{dirname}/probe2.json"  # reprobe.mjs; the judged answer
    r["answer"] = json.load(open(p2))["answer"] if os.path.exists(p2) else None
    return r


def control(dirname, index):
    # No-compaction control (reprobe.mjs): only the probe answer and the context it saw.
    meta = json.load(open(f"{HERE}/runs/{dirname}/meta.json"))
    sl = index[meta["slice"]]
    r = dict(id=meta["id"], slice=meta["slice"], session=sl["session"], model=meta["model"], arm="none", tier=sl["tier"], ok=True, error=None, control=True,
             rep=2 if dirname.endswith("__none2") else 1)
    p2 = f"{HERE}/runs/{dirname}/probe2.json"
    if os.path.exists(p2):
        p = json.load(open(p2))
        r.update(answer=p["answer"], after=ctx(p["usage"]))
    return r


def main():
    index = json.load(open(f"{HERE}/slices/index.json"))
    rows = [row(d, index) if not re.search(r"__none\d?$", d) else control(d, index) for d in sorted(os.listdir(f"{HERE}/runs")) if os.path.exists(f"{HERE}/runs/{d}/meta.json")]
    json.dump(rows, open(f"{HERE}/rows.json", "w"), indent=1)
    for r in rows:
        if r.get("control"):
            continue
        if not r["ok"]:
            print(f"{r['id']:<36} FAILED {r['error']}")
            continue
        print(f"{r['id']:<36} {r['before']:>7} -> {r['after']:>6}  wall {r['wall_s']:6.1f}s  ${r['cost']:.3f}-{r['cost_hi']:.3f}  out {r['c_out']}")


main()
