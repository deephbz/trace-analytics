#!/usr/bin/env node
// Prefill probe: time to first visible token on each slice, thinking off, two turns in a row.
// Turn 1 finds the prefix uncached (bench runs are hours old); turn 2 reads it from cache.
// Each turn's session usage records the actual cache split, so "cold" is verified per run.
// Output: prefill/<slice>__<model>/{session.jsonl,events.jsonl}, prefill.json
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, Rpc, turn } from "./bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASK = "[Benchmark timing probe] Do not call any tools. Reply with exactly: OK";
const index = JSON.parse(readFileSync(join(HERE, "slices", "index.json"), "utf8"));

async function probe(sliceId, modelKey) {
  const model = MODELS[modelKey];
  const dir = join(HERE, "prefill", `${sliceId}__${modelKey}`);
  mkdirSync(dir, { recursive: true });
  const session = join(dir, "session.jsonl");
  copyFileSync(join(HERE, "slices", `${sliceId}.jsonl`), session);
  const logf = join(dir, "events.jsonl");
  writeFileSync(logf, "");
  const log = (e) => appendFileSync(logf, JSON.stringify(e) + "\n");
  const argv = ["--mode", "rpc", "--session", session, "--no-extensions", "--no-mcp", "--provider", model.provider, "--model", model.id,
    "--thinking", "off", "--tools", "read,grep,find,ls"];
  const rpc = new Rpc("pi", argv, { cwd: dir, env: process.env }, log);
  const turns = [];
  try {
    await rpc.send({ type: "set_model", provider: model.provider, modelId: model.id });
    await rpc.send({ type: "set_thinking_level", level: "off" });
    await rpc.send({ type: "set_auto_compaction", enabled: false });
    for (const label of ["cold", "warm"]) {
      const first = rpc.wait((e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_start", 300_000);
      const t = await turn(rpc, ASK, 300_000);
      turns.push({ label, ...t, first: (await first).t });
    }
  } finally {
    rpc.p.kill();
  }
  const usages = readFileSync(session, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.message.role === "assistant").slice(-2).map((e) => e.message.usage);
  return turns.map((t, i) => ({ slice: sliceId, model: modelKey, label: t.label, ttft: (t.first - t.t0) / 1e3, wall: (t.t1 - t.t0) / 1e3,
    input: usages[i].input, cacheRead: usages[i].cacheRead, cacheWrite: usages[i].cacheWrite ?? 0, output: usages[i].output }));
}

const out = [];
await Promise.all(["sonnet", "sol"].map(async (m) => {
  for (const id of Object.keys(index).filter((k) => index[k].model === m)) {
    try { for (const r of await probe(id, m)) { out.push(r); console.log(JSON.stringify(r)); } }
    catch (e) { console.log(id, m, "error", String(e.message ?? e)); }
  }
}));
writeFileSync(join(HERE, "prefill.json"), JSON.stringify(out, null, 1));
process.exit(0);
