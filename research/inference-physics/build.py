"""Build index.html: page.html + Paper Mono + numeric benchmark rows.

Only numeric fields leave rows.json; probe answers and judge notes stay out.
Run: python3 -I build.py
"""
import base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = f"{HERE}/../compaction-bench"
FONT = f"{HERE}/../../src/reports/fonts/PaperMono-wght.woff2"

SNAPSHOT = f"{HERE}/benchmark.json"
if "--refresh-benchmark" in sys.argv:
    rows = json.load(open(f"{BENCH}/rows.json"))
    stats = json.load(open(f"{BENCH}/stats.json"))
    keep = ("model", "arm", "wall_s", "c_out", "before", "after", "cost")
    data = dict(
        rows=[{k: r.get(k) for k in keep} for r in rows if not r.get("control") and r.get("ok")],
        fit_out={m: stats["models"][m]["fit_wall_out"] for m in stats["models"]},
        fit_before={m: stats["models"][m]["fit_wall_before"] for m in stats["models"]},
    )
    json.dump(data, open(SNAPSHOT, "w"), indent=2)
else:
    data = json.load(open(SNAPSHOT))
font = base64.b64encode(open(FONT, "rb").read()).decode()
page = open(f"{HERE}/page.html").read()
page = page.replace("/*FONT*/", f"url(data:font/woff2;base64,{font})").replace("/*DATA*/null", json.dumps(data))
open(f"{HERE}/index.html", "w").write(page)
print("index.html", len(page) // 1024, "KiB,", len(data["rows"]), "rows")
