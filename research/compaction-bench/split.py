"""Split each in-session handoff turn into: before first visible token, visible streaming, harness tail.
Hidden (reasoning) tokens = usage.output - visible tool-call tokens (o200k estimate)."""
import json, glob, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiktoken
enc = tiktoken.get_encoding("o200k_base")
out = []
for d in sorted(glob.glob("runs/*__summary") + glob.glob("runs/*__keepset") + glob.glob("runs/*__summaryc") + glob.glob("runs/*__keepsetc")):
    E = [json.loads(l) for l in open(f"{d}/events.jsonl")]
    sends = [e for e in E if e["type"] == "sent" and e["cmd"].get("type") == "prompt"]
    c0 = sends[1]["t"]; c1 = next(e["t"] for e in E if e["type"] == "compaction_end")
    tc = next(e["t"] for e in E if e["type"] == "message_update" and e.get("kind") == "toolcall_start" and c0 <= e["t"] <= c1)
    me = [e["t"] for e in E if e["type"] == "message_end" and c0 <= e["t"] <= c1]
    S = [json.loads(l) for l in open(f"{d}/session.jsonl")]
    msg = next(m["message"] for m in S if m.get("type") == "message" and m["message"].get("role") == "assistant"
               and any(b.get("type") == "toolCall" and b.get("name") == "compaction_plan" for b in m["message"]["content"]))
    vis = sum(len(enc.encode(json.dumps(b.get("arguments"), ensure_ascii=False))) for b in msg["content"] if b.get("type") == "toolCall")
    vis += sum(len(enc.encode(b.get("text", ""))) for b in msg["content"] if b.get("type") == "text")
    u = msg["usage"]
    # assistant message_end that closes the handoff turn (before tool execution)
    end = min(t for t in me if t > tc)
    out.append(dict(id=d.split("/")[-1], model="sol" if "__sol__" in d else "sonnet", before_visible=(tc - c0) / 1e3,
                    stream=(end - tc) / 1e3, tail=(c1 - end) / 1e3, wall=(c1 - c0) / 1e3, out=u["output"], visible=vis,
                    hidden=max(0, u["output"] - vis), ctx=u["input"] + u["cacheRead"] + u.get("cacheWrite", 0), uncached=u["input"] + u.get("cacheWrite", 0)))
json.dump(out, open("split.json", "w"), indent=1)
for r in out:
    print(f'{r["id"][:34]:34} wall {r["wall"]:6.1f} = pre {r["before_visible"]:5.1f} + stream {r["stream"]:5.1f} + tail {r["tail"]:.2f} | out {r["out"]:5} vis {r["visible"]:5} hid {r["hidden"]:5} | vis/stream {r["visible"]/r["stream"]:5.0f} t/s  hid/pre {r["hidden"]/max(r["before_visible"],.01):5.0f} t/s ctx {r["ctx"]//1000}k')
