"""Local token estimate of a pi entry as a model request sees it: text, tool-call
arguments and tool-result text; thinking is left out (pi does not replay another
model's thinking). o200k_base is gpt-6.1-sol's tokenizer family."""
import json
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")


def entry_text(d):
    m = d.get("message") or {}
    if d.get("type") == "custom_message":
        c = d.get("content")
        return c if isinstance(c, str) else json.dumps(c)
    if d.get("type") != "message" or m.get("role") not in ("user", "assistant", "toolResult"):
        return ""
    c = m.get("content")
    if isinstance(c, str):
        return c
    out = []
    for x in c or []:
        if x.get("type") == "text":
            out.append(x.get("text", ""))
        elif x.get("type") == "toolCall":
            out.append(x.get("name", "") + json.dumps(x.get("arguments")))
    return "\n".join(out)


def tokens(d):
    t = entry_text(d)
    return len(ENC.encode(t, disallowed_special=())) if t else 0
