"""Per-request timing of each compaction and warm-up, from pi RPC events and the Magpie ledger.

Sonnet: Magpie ledger rows (ttft_ms, ms) inside each phase window, model claude-sonnet-5-5.
Sol: RPC events only (in-session turns stream through pi; native summarizer calls are internal).
Writes timing.json.
"""
import json, glob, datetime as dt, os
HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../results/compaction-bench/current"))
L = [json.loads(l) for l in open(os.path.expanduser("~/.config/magpie/usage.jsonl"))]
L = [r for r in L if r.get("t", "") >= "2026-10-11" and r.get("served", "").startswith("claude-sonnet-5-5")]
for r in L:
    r["te"] = dt.datetime.fromisoformat(r["t"]).timestamp() * 1000  # ledger t = request start

def ledger(t0, t1):
    return [dict(ctx=r.get("in", 0) + r.get("cache_read", 0) + r.get("cache_write", 0), uncached=r.get("in", 0) + r.get("cache_write", 0), out=r.get("out", 0),
                 ttft=r["ttft_ms"] / 1e3, ms=r["ms"] / 1e3) for r in L if t0 - 50 <= r["te"] <= t1]

out = []
for d in sorted(glob.glob(f"{HERE}/runs/*")):
    meta = json.load(open(f"{d}/meta.json"))
    if meta.get("arm", "").startswith("none") or not meta.get("ok", True): continue
    E = [json.loads(l) for l in open(f"{d}/events.jsonl")]
    sends = [e for e in E if e["type"] == "sent" and e["cmd"].get("type") in ("prompt", "compact")]
    settled = [e["t"] for e in E if e["type"] == "agent_settled"]
    w0, w1 = sends[0]["t"], settled[0]                       # warm-up turn
    c0 = sends[1]["t"]; c1 = next(e["t"] for e in E if e["type"] == "compaction_end")
    # assistant stream inside the compaction window (in-session handoff turn)
    st = [e["t"] for e in E if e["type"] == "message_start" and (e.get("message") or {}).get("role") == "assistant" and c0 <= e["t"] <= c1]
    en = [e["t"] for e in E if e["type"] == "message_end" and c0 <= e["t"] <= c1]
    ws = [e["t"] for e in E if e["type"] == "message_start" and (e.get("message") or {}).get("role") == "assistant" and w0 <= e["t"] <= w1]
    rec = dict(id=meta["id"], model=meta["model"], arm=meta["arm"], wall=(c1 - c0) / 1e3,
               warm_wall=(w1 - w0) / 1e3, warm_first=(ws[0] - w0) / 1e3 if ws else None,
               rpc_first=(st[0] - c0) / 1e3 if st else None, rpc_last=(c1 - en[-1]) / 1e3 if st else None)
    # Per-turn usage from the run's session (assistant messages in order: warm-up, handoff?, probe).
    S = [json.loads(l) for l in open(f"{d}/session.jsonl")]
    rec["turns"] = [m["message"]["usage"] for m in S if m.get("type") == "message" and m["message"].get("role") == "assistant" and m["message"].get("usage")][-3:]
    rec["probe"] = None
    ps = [e["t"] for e in E if e["type"] == "sent" and e["cmd"].get("type") == "prompt" and e["t"] > c1]
    if ps:
        pe = next((e["t"] for e in E if e["type"] == "agent_settled" and e["t"] > ps[0]), None)
        pst = [e["t"] for e in E if e["type"] == "message_start" and (e.get("message") or {}).get("role") == "assistant" and ps[0] <= e["t"] <= (pe or 1e15)]
        rec["probe"] = dict(wall=(pe - ps[0]) / 1e3 if pe else None, first=(pst[0] - ps[0]) / 1e3 if pst else None)
        if meta["model"] == "sonnet" and pe: rec["probe_ledger"] = ledger(ps[0], pe)
    if meta["model"] == "sonnet":
        rec["warm"] = ledger(w0, w1)
        rec["comp"] = ledger(c0, c1)
    out.append(rec)
json.dump(out, open(f"{HERE}/timing.json", "w"), indent=1)
print(len(out), "runs")
