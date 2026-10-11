// Price resolution at public API prices, whatever route served the request.
// Shared reference data for the analytics: cache-ttl and compaction price calls with it.
// Order: explicit override > API vendor catalog entry (anthropic / openai) by normalized id.
// Prices are $/M tokens: { input, output, cacheRead, cacheWrite, tiers? }.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { vendorOf } from "./rates.mjs";

const AGENT_DIR = join(homedir(), ".pi", "agent");
/** Where the pi extension snapshots the live price catalog for the CLI (the TTL backtester's old state dir). */
export const CATALOG_DIR = join(AGENT_DIR, "ttl-backtester");

const priced = (c) => c && (c.input > 0 || c.output > 0);
export const norm = (id) => id.split("/").pop().replace(/[.:]/g, "-").replace(/-latest$/, "").toLowerCase();

/** Catalog entries from pi's model registry: [{ provider, id, cost }]. */
export function catalogFromRegistry(registry) {
  return registry.getAll().map((m) => ({ provider: m.provider, id: m.id, cost: m.cost }));
}

/** Offline catalog for the CLI: extension snapshot, else models-store.json + models.json. */
export async function catalogFromDisk(stateDir) {
  const snap = await readJson(join(stateDir, "catalog.json"));
  if (Array.isArray(snap?.models)) return { models: snap.models, source: `extension snapshot ${snap.savedAt}` };
  const out = [];
  for (const file of ["models-store.json", "models.json"]) {
    const d = await readJson(join(AGENT_DIR, file));
    const providers = d?.providers ?? d ?? {};
    for (const [provider, v] of Object.entries(providers)) for (const m of v?.models ?? []) out.push({ provider, id: m.id, cost: m.cost });
  }
  return { models: out, source: "models-store.json + models.json" };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Resolve API prices for "provider/model" keys. Out-of-scope models resolve to null.
 * overrides: { "<provider/model>" | "<model>" | "<normalized model>": { input, output, cacheRead, cacheWrite } }
 */
export function resolvePrices(modelKeys, catalog, overrides = {}) {
  const vendor = new Map();
  for (const m of catalog) if ((m.provider === "anthropic" || m.provider === "openai") && priced(m.cost)) vendor.set(`${m.provider}:${norm(m.id)}`, m);
  return modelKeys.map((key) => {
    const family = vendorOf(key);
    if (!family) return null;
    const id = key.slice(key.indexOf("/") + 1);
    const o = overrides[key] ?? overrides[id] ?? overrides[norm(id)];
    if (o) return { ...pick(o), source: "override" };
    const hit = vendor.get(`${family}:${norm(id)}`);
    if (hit) return { ...pick(hit.cost), source: `${hit.provider}/${hit.id}` };
    return null;
  });
}

const pick = (c) => ({
  input: +c.input || 0,
  output: +c.output || 0,
  cacheRead: +c.cacheRead || 0,
  cacheWrite: +c.cacheWrite || 0,
  ...(Array.isArray(c.tiers) && c.tiers.length ? { tiers: c.tiers.map((t) => ({ ...pick(t), inputTokensAbove: +t.inputTokensAbove })) } : {}),
});
