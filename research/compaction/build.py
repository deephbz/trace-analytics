"""Build the compaction dataset from local agent logs.

One row per compaction -> compactions.jsonl. Per-harness totals of ordinary model calls
-> totals.json. Window: SINCE .. build time. Run: python3 -I build.py [days]

Harness semantics (see README.md for the field table):
  pi     `compaction` entry. Native: Pi's own summarizer request; usage on the entry.
         Blackmagic: remote Codex compaction; usage and latencyMs in details.
         Native wall time and TTFT come from the Magpie ledger when the call went
         through Magpie. hc-auto-compact adds a handoff turn before the compaction.
  codex  `compacted` item, its request usage in the token_usage_record whose
         response_id equals compaction_response_id. Wall = that record's time minus
         the last rollout line before it.
  cc     `compact_boundary` system entry: preTokens, postTokens, durationMs, trigger.
         The summarizer request's usage is not logged; its tokens are estimates.
"""

import glob, hashlib, json, os, sys, time
from collections import defaultdict
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 28
NOW = time.time()
SINCE = NOW - DAYS * 86400

PI_DIRS = {"pi": f"{HOME}/.pi/agent/sessions", "pi-eval": f"{HOME}/.local/state/agentlog/eval/cass-evaluator/role-home/.pi/agent/sessions"}
CODEX_DIRS = [f"{HOME}/.codex/sessions", f"{HOME}/.codex/archived_sessions"]
CC_DIR = f"{HOME}/.claude/projects"
LEDGER = f"{HOME}/.config/magpie/usage.jsonl"
PI_AI = f"{HOME}/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/providers/data"


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if isinstance(s, str) else s / 1000


def recent(paths):
    return [p for p in paths if os.path.getmtime(p) >= SINCE]


def lines(path):
    with open(path) as f:
        for l in f:
            try:
                yield json.loads(l)
            except ValueError:
                pass


# ---- prices: USD per million tokens, list price (subscription traffic is priced as if metered)

def load_prices():
    p = {}
    for prov in ("anthropic.json", "openai.json"):
        for api in json.load(open(f"{PI_AI}/{prov}")).values():
            for m in api.values():
                if isinstance(m, dict) and m.get("cost"):
                    p.setdefault(m["id"], m["cost"])
    for m in json.load(open(f"{HOME}/.pi/agent/models.json"))["providers"]["magpie"]["models"]:
        if m.get("cost"):
            p[m["id"].split("/", 1)[-1]] = {**p.get(m["id"].split("/", 1)[-1], {}), **m["cost"]}
    return p


PRICES = load_prices()
DROPPED = defaultdict(int)  # exclusions, reported in totals.json


def base_model(m):
    return (m or "").split("/")[-1]


def cost(model, uncached, cache_read, cache_write, out):
    c = PRICES.get(base_model(model))
    if not c:
        return None
    total_in = uncached + cache_read + cache_write
    for tier in c.get("tiers", []):
        if total_in > tier["inputTokensAbove"]:
            c = {**c, **tier}
    return (uncached * c["input"] + cache_read * c["cacheRead"] + cache_write * c["cacheWrite"] + out * c["output"]) / 1e6


def new_totals():
    return defaultdict(float)


def add_call(tot, model, unc, cr, cw, out, wall_ms=None):
    tot["calls"] += 1
    tot["uncached"] += unc
    tot["cache_read"] += cr
    tot["cache_write"] += cw
    tot["out"] += out
    c = cost(model, unc, cr, cw, out)
    if c is None:
        tot["unpriced_calls"] += 1
    else:
        tot["cost"] += c
    if wall_ms is not None:
        tot["wall_ms"] += wall_ms
        tot["timed_calls"] += 1


# ---- Magpie ledger: wall time and TTFT for Pi native summarizer calls through Magpie

LED = []
for d in lines(LEDGER):
    if d.get("status") == 200 and d.get("out"):
        LED.append((ts(d["t"]), d))


def ledger_match(end_t, out):
    """Pi native compaction makes one or two parallel summarizer requests (history and
    split-turn prefix) and logs their summed usage. Find the ledger records whose
    output tokens sum to the logged output and that end at or just before the entry."""
    cand = [(t, d) for t, d in LED if -300 <= t + d["ms"] / 1000 - end_t <= 10]
    for t, d in cand:
        if d["out"] == out:
            return [(t, d)]
    for a in range(len(cand)):
        for b in range(a + 1, len(cand)):
            if cand[a][1]["out"] + cand[b][1]["out"] == out:
                return [cand[a], cand[b]]
    return None


# ---- pi

def pi_usage(m):
    u = m.get("usage") or {}
    return u.get("input", 0) or 0, u.get("cacheRead", 0) or 0, u.get("cacheWrite", 0) or 0, u.get("output", 0) or 0


def build_pi(rows, totals):
    seen_c, seen_m, seen_u = set(), set(), set()
    for source, root in PI_DIRS.items():
        tot = totals.setdefault(source, new_totals())
        for path in recent(glob.glob(f"{root}/*/*.jsonl")):
            L = list(lines(path))
            session = os.path.basename(path)[:-6]
            tot["sessions"] += 1
            last_model, last_end, calls_since, handoff_i, last_user_i = None, None, 0, None, None
            pending = []  # compaction rows waiting for the next request
            parent = {d.get("id"): d.get("parentId") for d in L if d.get("id")}
            for i, d in enumerate(L):
                t = ts(d.get("timestamp")) if d.get("timestamp") else None
                typ = d.get("type")
                if typ == "message":
                    m = d["message"]
                    if m.get("role") == "user":
                        last_user_i, handoff_i = i, None
                        if t and t >= SINCE and (d.get("id"), d.get("timestamp")) not in seen_u:
                            seen_u.add((d.get("id"), d.get("timestamp")))
                            tot["user_turns"] += 1
                    if m.get("role") != "assistant" or not m.get("usage"):
                        continue
                    unc, cr, cw, out = pi_usage(m)
                    if unc + cr + cw + out == 0:
                        continue
                    model = m.get("model")
                    start = ts(m["timestamp"]) if isinstance(m.get("timestamp"), (int, float)) else None
                    # Sessions are trees: the next request is the first one under the compaction.
                    anc, n = set(), d.get("parentId")
                    while n and n not in anc and len(anc) < 400:
                        anc.add(n)
                        n = parent.get(n)
                    # A request that started before the compaction ended still carried the old context.
                    for r in [r for r in pending if r["id"] in anc and (start is None or start >= r["t"] - 1)]:
                        r.update(ctx_next=unc + cr + cw, next_cache_read=cr, next_cache_write=cw, next_uncached=unc,
                                 next_gap_s=round(start - r["t"], 1) if start else None)
                        pending.remove(r)
                    key = m.get("responseId") or (d.get("id"), d.get("timestamp"))
                    if key not in seen_m and t and t >= SINCE:
                        seen_m.add(key)
                        add_call(tot, model, unc, cr, cw, out, (t - start) * 1000 if start and t > start else None)
                    last_model, last_end = f"{m.get('provider')}/{model}", t
                    calls_since += 1
                elif typ == "custom_message" and d.get("customType") == "auto-compact.handoff":
                    handoff_i = i
                elif typ == "compaction":
                    key = (d.get("id"), d.get("timestamp"))
                    if key in seen_c or t < SINCE:
                        DROPPED[f"{source}: compaction copied from another session file" if key in seen_c else "pi: before window"] += 1
                        calls_since = 0
                        continue
                    seen_c.add(key)
                    det = d.get("details") or {}
                    row = dict(harness="pi", source=source, session=session, id=d.get("id"), t=t,
                               ctx_pre=d.get("tokensBefore"), role="main", calls_since_prev=calls_since,
                               prev_call_gap_s=None, session_model=last_model)
                    calls_since = 0
                    # handoff turn (hc-auto-compact): assistant calls after the handoff message
                    hand = [x["message"] for x in L[handoff_i + 1:i] if x.get("type") == "message" and x["message"].get("role") == "assistant" and x["message"].get("usage")] if handoff_i is not None else []
                    row["trigger"] = "hc-auto-compact" if handoff_i is not None else "pi-threshold-or-manual"
                    if handoff_i is not None:
                        hu = [pi_usage(m) for m in hand]
                        row.update(handoff_calls=len(hand), handoff_in=sum(u[0] + u[1] + u[2] for u in hu), handoff_cache_read=sum(u[1] for u in hu),
                                   handoff_out=sum(u[3] for u in hu),
                                   handoff_cost=sum(cost(m.get("model"), *pi_usage(m)) or 0 for m in hand),
                                   handoff_wall_ms=(last_end - ts(L[handoff_i]["timestamp"])) * 1000 if hand and last_end else 0)
                    handoff_i = None
                    if det.get("state") == "remote_applied":
                        u = det.get("usage") or {}
                        model = (det.get("identity") or {}).get("model")
                        row.update(method="pi-blackmagic", model=model, req_in_total=u.get("input_tokens"), req_out=u.get("output_tokens"),
                                   req_cache_read=u.get("cached_tokens"), wall_ms=det.get("latencyMs"), wall_source="latencyMs",
                                   tokens_source="logged (cache split not kept)", retention=(det.get("checkpoint") or {}).get("retention"),
                                   artifact_chars=(det.get("checkpoint") or {}).get("length"))
                        tin, tout = row["req_in_total"] or 0, row["req_out"] or 0
                        row["cost_lo"] = cost(model, 0, tin, 0, tout)  # all of the input read from cache
                        row["cost_hi"] = cost(model, tin, 0, 0, tout)  # none of it
                        row["cost"] = None
                    else:
                        u = d.get("usage") or {}
                        unc, cr, cw, out = u.get("input", 0), u.get("cacheRead", 0), u.get("cacheWrite", 0), u.get("output", 0)
                        row.update(method="pi-native-summary", req_uncached=unc, req_cache_read=cr, req_cache_write=cw, req_in_total=unc + cr + cw,
                                   req_out=out, req_reasoning=u.get("reasoning"), tokens_source="logged" if u else "missing",
                                   summary_chars=len(d.get("summary") or ""))
                        lm = ledger_match(t, out) if out else None
                        if lm:
                            start = min(x[0] for x in lm)
                            g = lambda k: sum(x[1].get(k) or 0 for x in lm)
                            # The ledger has the cache split pi folds into input.
                            unc, cr, cw = g("in"), g("cache_read"), g("cache_write")
                            row.update(model=lm[0][1].get("req") or lm[0][1].get("model"), wall_ms=(max(x[0] + x[1]["ms"] / 1000 for x in lm) - start) * 1000,
                                       ttft_ms=min(x[1].get("ttft_ms") or 1e9 for x in lm), wall_source="magpie ledger", summarizer_requests=len(lm),
                                       req_uncached=unc, req_cache_read=cr, req_cache_write=cw, req_in_total=unc + cr + cw, tokens_source="magpie ledger")
                        else:
                            prev_t = ts(L[i - 1]["timestamp"]) if i and L[i - 1].get("timestamp") else None
                            gap = (t - prev_t) * 1000 if prev_t else None
                            # A gap over 10 minutes holds user idle time (manual /compact).
                            row.update(model=last_model, wall_ms=gap if gap and gap < 600000 else None, wall_source="gap to previous entry (upper bound)")
                        row["cost"] = cost(row["model"], unc, cr, cw, out) if u else None
                    if last_end and row.get("wall_ms"):
                        row["prev_call_gap_s"] = round(t - row["wall_ms"] / 1000 - last_end, 1)
                    rows.append(row)
                    pending.append(row)


# ---- codex

ASYNC = {"token_usage_record", "item_completed", "agent_message", "inter_agent_communication_metadata", "world_state"}


def build_codex(rows, totals):
    usage_seen, turns_seen = set(), set()
    comp_seen = {}
    role_of = {}
    for path in recent([p for d in CODEX_DIRS for p in glob.glob(f"{d}/**/rollout-*.jsonl", recursive=True)]):
        L = list(lines(path))
        if not L:
            continue
        meta = L[0].get("payload", {}) if L[0].get("type") == "session_meta" else {}
        role = meta.get("thread_source") or ("subagent" if isinstance(meta.get("source"), dict) else "user")
        sid = os.path.basename(path)[-42:-6]
        role_of[sid] = role
        tot = totals.setdefault(f"codex:{role}", new_totals())
        tot["sessions"] += 1
        recs = {}
        model, last_input_t, calls_since = None, None, 0
        pending = []
        comp_rids = {d["payload"].get("compaction_response_id") for d in L if d.get("type") == "compacted"}
        for i, d in enumerate(L):
            typ, p = d.get("type"), d.get("payload") or {}
            t = ts(d["timestamp"]) if d.get("timestamp") else None
            if typ == "turn_context":
                model = p.get("model") or model
            elif typ == "event_msg" and p.get("type") == "task_started" and t and t >= SINCE:
                k = p.get("turn_id") or (sid, d["timestamp"])
                if k not in turns_seen:  # forks replay the parent's turns
                    turns_seen.add(k)
                    tot["user_turns"] += 1
            elif typ == "token_usage_record":
                u = p.get("usage") or {}
                rid = p.get("response_id")
                recs[rid] = (i, t, u)
                if rid in comp_rids:
                    continue
                for r in pending:
                    r.update(ctx_next=u.get("input_tokens", 0), next_cache_read=u.get("cached_input_tokens", 0),
                             next_uncached=u.get("input_tokens", 0) - u.get("cached_input_tokens", 0), next_gap_s=None)
                pending = []
                calls_since += 1
                if rid not in usage_seen and t >= SINCE:
                    usage_seen.add(rid)
                    cr = u.get("cached_input_tokens", 0)
                    add_call(tot, model, u.get("input_tokens", 0) - cr, cr, u.get("cache_write_input_tokens", 0), u.get("output_tokens", 0))
            elif typ == "compacted":
                rid = p.get("compaction_response_id")
                key = rid or p.get("window_id") or hashlib.sha1(json.dumps(p.get("replacement_history"), sort_keys=True).encode()).hexdigest()
                # A forked thread replays its parent's compactions before its own first call.
                inherited = not recs
                if t < SINCE or key in comp_seen or inherited:
                    DROPPED["codex: before window" if t < SINCE else "codex: inherited by a forked thread" if inherited else "codex: duplicate"] += 1
                    calls_since = 0
                    continue
                rec = recs.get(rid) if rid else None
                if rec is None and i and L[i - 1].get("type") == "token_usage_record":
                    rec = recs.get(L[i - 1]["payload"].get("response_id"))
                row = dict(harness="codex", source="codex", session=sid, id=key, t=t, role=role, method="codex-remote",
                           model=(p.get("resume_metadata") or {}).get("previous_turn_settings", {}).get("model") or model,
                           calls_since_prev=calls_since, retained_items=len(p.get("replacement_history") or []), trigger=None)
                calls_since = 0
                if rec:
                    ri, rt, u = rec
                    cr = u.get("cached_input_tokens", 0)
                    tin = u.get("input_tokens", 0)
                    # start: the last synchronous line before the compaction's usage record.
                    # item_completed events, agent messages from other threads, and world
                    # state can arrive while the compaction request runs.
                    j = ri - 1
                    while j >= 0 and (L[j].get("type") in ASYNC or (L[j].get("payload") or {}).get("type") in ASYNC):
                        j -= 1
                    start = ts(L[j]["timestamp"])
                    prev = L[j]
                    pt = (prev.get("payload") or {}).get("type")
                    row.update(ctx_pre=tin, req_in_total=tin, req_uncached=tin - cr, req_cache_read=cr, req_cache_write=u.get("cache_write_input_tokens", 0),
                               req_out=u.get("output_tokens", 0), req_reasoning=u.get("reasoning_output_tokens", 0), tokens_source="logged",
                               wall_ms=(rt - start) * 1000, wall_source="usage record minus last synchronous line",
                               trigger="turn-start" if pt in ("task_started", "user_message", "turn_context", "thread_settings_applied") or prev.get("type") == "session_meta" else "mid-turn")
                    row["cost"] = cost(row["model"], tin - cr, cr, row["req_cache_write"], row["req_out"])
                    # context in the next request; Codex's own estimate of the new window
                    for x in L[i + 1:i + 8]:
                        if (x.get("payload") or {}).get("type") == "token_count":
                            row["ctx_post_est"] = ((x["payload"].get("info") or {}).get("last_token_usage") or {}).get("total_tokens")
                            break
                    tot["compaction_requests_in_records"] += 1
                else:
                    row.update(tokens_source="missing")
                comp_seen[key] = True
                rows.append(row)
                pending.append(row)
    return role_of


# ---- claude code

def build_cc(rows, totals):
    allf = recent(glob.glob(f"{CC_DIR}/*/*.jsonl"))
    # Magpie's Claude subscription bridge drives Claude Code as transport for other agents' calls.
    files = [p for p in allf if "magpie-c" not in p]
    DROPPED["claude-code: Magpie bridge transcript files"] = len(allf) - len(files)
    tot = totals.setdefault("claude-code", new_totals())
    seen_b, msgs = set(), {}
    for path in files:
        L = list(lines(path))
        tot["sessions"] += 1
        session = os.path.basename(path)[:-6]
        last_in_t = None
        order = []
        for i, d in enumerate(L):
            t = ts(d["timestamp"]) if d.get("timestamp") else None
            typ = d.get("type")
            if typ == "user":
                c = (d.get("message") or {}).get("content")
                real = isinstance(c, str) or (isinstance(c, list) and any(x.get("type") == "text" for x in c))
                if real and not d.get("isMeta") and not d.get("isCompactSummary") and t and t >= SINCE:
                    tot["user_turns"] += 1
                last_in_t = t
            elif typ == "assistant":
                m = d["message"]
                mid = m.get("id")
                if not mid or m.get("model") == "<synthetic>":
                    continue
                e = msgs.get(mid)
                if e is None:
                    e = msgs[mid] = dict(start=last_in_t, end=t, model=m.get("model"), u=m.get("usage") or {}, file=path, i=i)
                    order.append((i, mid))
                else:
                    e["end"], e["u"] = max(e["end"], t), m.get("usage") or e["u"]
            elif typ == "system" and d.get("subtype") == "compact_boundary":
                if d["uuid"] in seen_b or t < SINCE:
                    DROPPED["claude-code: resumed-session copy" if d["uuid"] in seen_b else "claude-code: before window"] += 1
                    continue
                seen_b.add(d["uuid"])
                cm = d.get("compactMetadata") or {}
                prev = [msgs[mid] for j, mid in order if j < i]
                prev = max(prev, key=lambda e: e["end"]) if prev else None
                summ = next((x for x in L[i + 1:i + 6] if x.get("isCompactSummary")), None)
                schars = len(json.dumps((summ or {}).get("message", {}).get("content", "")))
                dur = cm.get("durationMs")
                gap = t - dur / 1000 - prev["end"] if prev and dur else None
                model = prev["model"] if prev else None
                pre, out_est = cm.get("preTokens"), round(schars / 3.6)
                warm = gap is not None and gap < 3600  # Claude Code writes 1-hour cache entries on subscription plans
                row = dict(harness="claude-code", source="claude-code", session=session, id=d["uuid"], t=t, role="main",
                           method="cc-summary", trigger=cm.get("trigger"), model=model, ctx_pre=pre, ctx_post_est=cm.get("postTokens"),
                           wall_ms=dur, wall_source="compactMetadata.durationMs", prev_call_gap_s=round(gap, 1) if gap is not None else None,
                           summary_chars=schars, req_in_total=pre, req_out=out_est, req_cache_read=pre if warm else 0,
                           req_uncached=0 if warm else pre, tokens_source="estimated (summary chars/3.6; cache by gap)")
                row["cost"] = cost(model, row["req_uncached"], row["req_cache_read"], 0, out_est)
                nxt = next((x for x in L[i + 1:] if x.get("type") == "assistant" and (x["message"].get("usage") or {}).get("input_tokens") is not None and x["message"].get("model") != "<synthetic>"), None)
                if nxt:
                    u = nxt["message"]["usage"]
                    row.update(ctx_next=u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0),
                               next_cache_read=u.get("cache_read_input_tokens", 0), next_cache_write=u.get("cache_creation_input_tokens", 0),
                               next_uncached=u.get("input_tokens", 0), next_gap_s=round(ts(nxt["timestamp"]) - t, 1))
                rows.append(row)
    for e in msgs.values():
        if e["end"] < SINCE:
            continue
        u = e["u"]
        wall = (e["end"] - e["start"]) * 1000 if e["start"] and e["end"] > e["start"] else None
        add_call(tot, e["model"], u.get("input_tokens", 0), u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0), u.get("output_tokens", 0), wall)


def main():
    rows, totals = [], {}
    build_pi(rows, totals)
    role_of = build_codex(rows, totals)
    build_cc(rows, totals)
    # codex call wall time: agent-speed's rows (request start -> last model item)
    import subprocess
    dn = json.loads(subprocess.run(["node", f"{HERE}/denoms.mjs", str(int(SINCE * 1000))], capture_output=True, text=True, check=True).stdout)
    for sid, (n, w) in dn.get("codex", {}).get("bySession", {}).items():
        tot = totals.get(f"codex:{role_of.get(sid, 'user')}")
        if tot is not None:
            tot["wall_ms"] += w
            tot["timed_calls"] += n
    # A wall time below 5 output tok/s holds waiting (a sub-agent idle until its parent wrote).
    for r in rows:
        if r.get("wall_ms") and r.get("req_out") and r["req_out"] / (r["wall_ms"] / 1000) < 5 and r["wall_source"] != "compactMetadata.durationMs":
            r.update(wall_ms=None, wall_dropped="implied output rate < 5 tok/s")
            DROPPED[f"{r['harness']}: wall time dropped (idle in gap)"] += 1
    rows.sort(key=lambda r: r["t"])
    for r in rows:
        r["iso"] = datetime.fromtimestamp(r["t"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(f"{HERE}/compactions.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    meta = dict(since=datetime.fromtimestamp(SINCE, timezone.utc).isoformat(), until=datetime.fromtimestamp(NOW, timezone.utc).isoformat(), days=DAYS)
    json.dump(dict(meta=meta, totals=totals, dropped=DROPPED, ordinary_decode=dn.get("decode", {})), open(f"{HERE}/totals.json", "w"), indent=1)
    by = defaultdict(int)
    for r in rows:
        by[(r["harness"], r["method"], r.get("trigger"), r.get("role"))] += 1
    print(meta)
    for k, v in sorted(by.items(), key=lambda kv: -kv[1]):
        print(v, k)


main()
