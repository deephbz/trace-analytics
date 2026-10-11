// Cache TTL: which prompt-cache retention would have cost least, replayed on real usage.
// Read it to choose a retention setting per route. See sim.mjs for the replay model
// and policies.mjs for the provider terms.

import { resolvePrices } from "../prices.mjs";
import { SCENARIOS } from "./policies.mjs";
import { actualLogged, actualRepriced, coverage, prepare, simulate } from "./sim.mjs";
import { requestTable } from "./table.mjs";

/** data: load() output. catalog: price catalog entries (prices.mjs). */
export function analyzeCacheTtl(data, catalog, { overrides = {}, sources = ["pi"] } = {}) {
  const table = requestTable(data, { sources });
  const prices = resolvePrices(table.models, catalog, overrides);
  const prep = prepare(table.rows, table.models);
  return {
    table,
    prices,
    prep,
    results: SCENARIOS.map((s) => ({ scenario: s, ...simulate(prep, prices, s) })),
    repriced: actualRepriced(prep, prices, table.warm),
    logged: actualLogged(prep, table.warm),
    coverage: coverage(prep, prices),
  };
}
