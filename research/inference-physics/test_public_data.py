"""Publication checks: reject per-run payloads, identifiers, and small groups."""
import copy
import importlib.util
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PublicDataTest(unittest.TestCase):
    def setUp(self):
        fit = {"n": 6, "a": 1, "b": 2, "r2": 0.8}
        self.input = {
            "rows": [dict(model="sol", arm="native", c_out=x, wall_s=x / 100,
                          session="private", answer="private") for x in range(100, 700, 100)],
            "fit_out": {m: fit for m in ("sol", "sonnet")},
            "fit_before": {m: fit for m in ("sol", "sonnet")},
        }
        self.aggregate = load("aggregate").aggregate
        self.validate = load("build").validate

    def test_aggregation_drops_private_fields_and_combines_runs(self):
        data = self.aggregate(self.input)
        self.assertEqual(data["groups"], [dict(model="sol", arm="native", n=6, c_out=400, wall_s=4)])
        self.validate(data)

    def test_rejects_row_payload_or_nested_identifier(self):
        for location in ("rows", "group", "fit"):
            data = self.aggregate(self.input)
            if location == "rows":
                data["rows"] = self.input["rows"]
            elif location == "group":
                data["groups"][0]["session"] = "private"
            else:
                data["fit_out"]["sol"]["source"] = "private"
            with self.assertRaises(ValueError):
                self.validate(data)

    def test_suppresses_small_groups_and_rejects_them_in_public_input(self):
        small = copy.deepcopy(self.input)
        small["rows"] = small["rows"][:4]
        self.assertEqual(self.aggregate(small)["groups"], [])
        data = self.aggregate(self.input)
        data["groups"][0]["n"] = 1
        with self.assertRaises(ValueError):
            self.validate(data)


if __name__ == "__main__":
    unittest.main()
