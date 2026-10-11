"""Prepare a local aggregate candidate. Review it before copying into public source.

Input: the numeric benchmark snapshot retained in results/inference-physics/source/.
Output: results/inference-physics/candidate/aggregates.json.
Groups combine all context tiers and source sessions for one model and treatment.
"""
from collections import defaultdict
from pathlib import Path
from statistics import mean
import json

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "results/inference-physics/source/benchmark.json"
OUT = ROOT / "results/inference-physics/candidate/aggregates.json"


def aggregate(data):
    groups = defaultdict(list)
    for row in data["rows"]:
        groups[row["model"], row["arm"]].append(row)
    result = {"groups": []}
    for (model, arm), rows in sorted(groups.items()):
        if len(rows) < 5:
            continue
        result["groups"].append(dict(model=model, arm=arm, n=len(rows),
            c_out=round(mean(r["c_out"] for r in rows) / 100) * 100,
            wall_s=round(mean(r["wall_s"] for r in rows))))
    for name in ("fit_out", "fit_before"):
        result[name] = {model: {key: (int(fit[key]) if key == "n" else round(fit[key], 4))
                               for key in ("n", "a", "b", "r2")}
                        for model, fit in data[name].items() if fit["n"] >= 5}
    return result


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(aggregate(json.loads(SOURCE.read_text())), indent=2) + "\n")
    print("Wrote local aggregate candidate; publication requires review.")
