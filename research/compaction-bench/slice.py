"""Cut real pi sessions into benchmark slices, one set per model.

A slice is the root-to-cut chain of one session branch, written as a linear session
file. The branch is the session's deepest path with no compaction. The cut follows a
complete tool round (an assistant message and all its tool results) or a finished
turn, where threshold compaction would fire.

Slices are sized per model, because the same history is a different number of
tokens to each model: est = o200k tokens of text, tool calls, tool results, and old
thinking (replayed as text), plus 3.3k for the system prompt. Calibrated on one
measured request each: gpt-6.1-sol request ≈ 1.12 × est, claude-sonnet-5-5 ≈ 1.75 × est.
Each run records the measured size; the tier is nominal.

Ground truth for the probe judge: the slice's latest instruction (user message, or
harness custom message in Worker sessions), and the original agent's next actions
after the cut (up to six, until the next instruction).

Run: uv run --with tiktoken python -I slice.py  ->  slices/<session>-<model>-<tier>k.jsonl, slices/index.json
"""

import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tok import ENC, tokens

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
# Session selectors: label -> "<pi session dir>/<file name prefix>". They name private
# sessions, so they live in a local file next to this one (sessions.local.json, gitignored).
SESSIONS_FILE = os.path.join(HERE, "sessions.local.json")
SESSIONS = json.load(open(SESSIONS_FILE)) if os.path.exists(SESSIONS_FILE) else {}
SYSTEM = 3300
SCALE = {"sonnet": 1.75, "sol": 1.12}
TIERS = {"sonnet": [90_000, 200_000, 300_000], "sol": [90_000, 200_000, 250_000]}


def find(prefix):
    d, f = prefix.split("/")
    hits = [x for x in os.listdir(f"{HOME}/.pi/agent/sessions/{d}") if x.startswith(f)]
    assert len(hits) == 1, (prefix, hits)
    return f"{HOME}/.pi/agent/sessions/{d}/{hits[0]}"


def est(d):
    n = tokens(d)
    for x in (d.get("message") or {}).get("content") or []:
        if isinstance(x, dict) and x.get("type") == "thinking":
            n += len(ENC.encode(x.get("thinking") or "", disallowed_special=()))
    return n


def text(d):
    c = (d.get("message") or {}).get("content") if d.get("type") == "message" else d.get("content")
    return c if isinstance(c, str) else "\n".join(x.get("text", "") for x in c or [] if x.get("type") == "text")


def deepest(L):
    kids = {}
    for d in L:
        kids.setdefault(d.get("parentId"), []).append(d)
    best, stack = (0, None), [(d, 0, None) for d in kids.get(None, []) if d.get("type") != "session"]
    parent = {}
    while stack:
        d, acc, par = stack.pop()
        if d.get("type") == "compaction":
            continue
        parent[d["id"]] = par
        acc += est(d)
        if acc > best[0]:
            best = (acc, d["id"])
        for k in kids.get(d.get("id"), []):
            stack.append((k, acc, d["id"]))
    byid = {d["id"]: d for d in L if d.get("id")}
    out, n = [], best[1]
    while n:
        out.append(byid[n])
        n = parent[n]
    return out[::-1]


def main():
    os.makedirs(f"{HERE}/slices", exist_ok=True)
    index = {}
    for name, prefix in SESSIONS.items():
        path = find(prefix)
        L = [json.loads(l) for l in open(path) if l.strip()]
        header = L[0]
        assert header.get("type") == "session"
        branch = deepest(L)
        cum, acc = [], SYSTEM
        for d in branch:
            acc += est(d)
            cum.append(acc)
        # Valid cuts: after a finished turn, or after the last tool result of a round.
        def ok(i):
            m = branch[i].get("message") or {}
            nxt = (branch[i + 1].get("message") or {}) if i + 1 < len(branch) else {}
            if m.get("role") == "assistant" and m.get("stopReason") == "stop":
                return True
            return m.get("role") == "toolResult" and nxt.get("role") != "toolResult"
        cuts = [i for i in range(len(branch)) if ok(i)]
        for model, tiers in TIERS.items():
            for tier in tiers:
                # The cut nearest the tier, within 30% (analysis uses the measured size); Sol stays under its 272k window.
                cap = 255_000 if model == "sol" else 10**9
                fit = [i for i in cuts if abs(SCALE[model] * cum[i] - tier) <= 0.30 * tier and SCALE[model] * cum[i] <= cap]
                if not fit:
                    print("no cut", name, model, tier, sorted((round(SCALE[model] * cum[i]) for i in cuts), key=lambda x: abs(x - tier))[:3])
                    continue
                cut = min(fit, key=lambda i: abs(SCALE[model] * cum[i] - tier))
                entries = branch[: cut + 1]
                files, cwd = set(), header.get("cwd", "")
                for d in entries:
                    m = d.get("message") or {}
                    for c in m.get("content") or [] if m.get("role") == "assistant" else []:
                        if c.get("type") == "toolCall" and c.get("name") in ("edit", "write"):
                            a = c.get("arguments") or {}
                            p = a.get("path") or a.get("file_path")
                            if p:
                                files.add(os.path.normpath(p if os.path.isabs(p) else os.path.join(cwd, p)))
                # Worker sessions get their tasks as harness custom messages; both count as the latest instruction.
                last_user = next((text(d) for d in reversed(entries) if (d.get("message") or {}).get("role") == "user" or d.get("type") == "custom_message"), "")
                after = []
                for d in branch[cut + 1:]:
                    m = d.get("message") or {}
                    if m.get("role") == "assistant":
                        for c in m.get("content") or []:
                            if c.get("type") == "text" and c.get("text", "").strip():
                                after.append("said: " + c["text"].strip()[:600])
                            elif c.get("type") == "toolCall":
                                after.append(f"called {c.get('name')} {json.dumps(c.get('arguments'))[:300]}")
                    elif m.get("role") == "user" or d.get("type") == "custom_message":
                        break
                    if len(after) >= 6:
                        break
                key = f"{name}-{model}-{tier // 1000}k"
                out = f"{HERE}/slices/{key}.jsonl"
                body = "".join(json.dumps(d) + "\n" for d in [header, *entries])
                if not os.path.exists(out) or open(out).read() != body:  # a running bench may be copying it
                    open(out, "w").write(body)
                index[key] = dict(session=name, model=model, tier=tier, source=path, cwd=cwd, predicted=round(SCALE[model] * cum[cut]),
                                  est_o200k=cum[cut], entries=len(entries),
                                  tool_calls=sum(1 for d in entries for c in ((d.get("message") or {}).get("content") or []) if isinstance(c, dict) and c.get("type") == "toolCall"),
                                  user_messages=sum(1 for d in entries if (d.get("message") or {}).get("role") == "user"),
                                  files_modified=sorted(files), last_user=last_user[:4000], next_actions=after, file=out)
                print(key, index[key]["predicted"], len(entries), len(files))
    json.dump(index, open(f"{HERE}/slices/index.json", "w"), indent=1)


main()
