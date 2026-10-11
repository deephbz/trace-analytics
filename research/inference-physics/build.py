"""Build the public explainer from approved aggregates, template, and font.

Reject unexpected fields and undersized groups before embedding any data.
This structural check supplements semantic publication review.
"""
from pathlib import Path
import base64
import json
import math

HERE = Path(__file__).resolve().parent
MODELS = {"sonnet", "sol"}
ARMS = {"native", "blackmagic", "summary", "keepset", "summaryc", "keepsetc"}


def validate(data):
    def require(condition):
        if not condition:
            raise ValueError("Public aggregate schema violation")
    def number(value):
        return type(value) in (int, float) and math.isfinite(value)
    def count(value):
        return type(value) is int and value >= 5
    require(set(data) == {"groups", "fit_out", "fit_before"})
    require(isinstance(data["groups"], list) and bool(data["groups"]))
    seen = set()
    for group in data["groups"]:
        require(set(group) == {"model", "arm", "n", "c_out", "wall_s"})
        require(group["model"] in MODELS and group["arm"] in ARMS)
        key = (group["model"], group["arm"])
        require(key not in seen)
        seen.add(key)
        require(count(group["n"]))
        require(all(number(group[k]) and group[k] >= 0 for k in ("c_out", "wall_s")))
    for name in ("fit_out", "fit_before"):
        require(set(data[name]) == MODELS)
        for fit in data[name].values():
            require(set(fit) == {"n", "a", "b", "r2"} and count(fit["n"]))
            require(all(number(fit[k]) for k in ("a", "b", "r2")))
    return data


def build():
    data = validate(json.loads((HERE / "aggregates.json").read_text()))
    font = base64.b64encode((HERE / "../../src/reports/fonts/PaperMono-wght.woff2").read_bytes()).decode()
    page = (HERE / "page.html").read_text()
    page = page.replace("/*FONT*/", f"url(data:font/woff2;base64,{font})")
    page = page.replace("/*DATA*/null", json.dumps(data))
    (HERE / "index.html").write_text(page)
    print("Built index.html from", len(data["groups"]), "aggregate groups")


if __name__ == "__main__":
    build()
