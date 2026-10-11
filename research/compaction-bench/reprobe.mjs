// Probe v2. Probe v1 asked for "the user's most recent request"; gpt-6.1-sol read that
// as the probe itself, so its REQUEST score measured probe wording, not memory.
// v1 also let the bench's read-only tool list steer NEXT toward "report a blocker".
// v2 re-asks on each run's compacted session, cut just before the v1 probe, with the
// same pi arguments (blackmagic needs its extension to replay the opaque window).
// No compaction is repeated.
//
// Output: runs/<id>/probe2/{session.jsonl,events.jsonl}, runs/<id>/probe2.json
// Run: node reprobe.mjs

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc, turn } from "./bench.mjs";

const HERE = fileURLToPath(new URL("../../results/compaction-bench/current/", import.meta.url));
export const PROBE2 = [
  "[Benchmark probe] This is a measurement step, not a new task. Answer from your current context, under three headings.",
  "REQUEST: the task you were working on before this message, and the latest instruction you received about it. Do not describe this message.",
  "NEXT: the exact next action you would take on that task now (tool and target, or what you would say). Assume you have the tools the task needs; this measurement step only limits tools for itself.",
  "FACTS: the three most important facts from earlier tool output that the next action depends on (paths, numbers, names, errors).",
  "Use the read tool only to open a saved file that your context points to. Do not run anything else.",
].join("\n");

async function one(id) {
  const dir = join(HERE, "runs", id), out = join(dir, "probe2.json");
  if (existsSync(out)) return;
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const lines = readFileSync(join(dir, "session.jsonl"), "utf8").trim().split("\n");
  // Control runs (arm "none") carry the uncompacted session up to the warm-up; probe its end.
  const cut = meta.arm === "none" ? lines.length : lines.findIndex((l) => { const d = JSON.parse(l); return d.message?.role === "user" && JSON.stringify(d.message.content).includes("[Benchmark probe]"); });
  if (cut < 0) throw new Error(`${id}: no v1 probe`);
  mkdirSync(join(dir, "probe2"), { recursive: true });
  const session = join(dir, "probe2", "session.jsonl");
  writeFileSync(session, lines.slice(0, cut).join("\n") + "\n");
  const logf = join(dir, "probe2", "events.jsonl");
  writeFileSync(logf, "");
  const argv = meta.argv.map((a, i) => (meta.argv[i - 1] === "--session" ? session : a));
  const env = { ...process.env, KEEPSET_THRESHOLD: "1000", ...(meta.arm === "summary" ? { KEEPSET_MODE: "summary" } : meta.arm === "keepset" ? { KEEPSET_MODE: "keepset" } : {}) };
  const rpc = new Rpc("pi", argv, { cwd: dir, env }, (e) => appendFileSync(logf, JSON.stringify(e) + "\n"));
  try {
    await rpc.send({ type: "set_auto_compaction", enabled: false });
    await turn(rpc, PROBE2, 15 * 60e3);
  } finally {
    rpc.p.stdin.end();
    setTimeout(() => rpc.p.kill("SIGTERM"), 5000);
    await rpc.exited;
  }
  const L = readFileSync(session, "utf8").trim().split("\n").slice(cut).map((l) => JSON.parse(l));
  const asst = L.filter((d) => d.message?.role === "assistant");
  const last = asst.at(-1).message;
  writeFileSync(out, JSON.stringify({ answer: last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), usage: asst[0].message.usage,
    model: `${last.provider}/${last.model}`, tools: asst.flatMap((d) => d.message.content.filter((c) => c.type === "toolCall")).length, stopReason: last.stopReason }, null, 1));
  console.log(id, "ok");
}

// No-compaction control per slice: the native run's session up to its warm-up answer.
// A second replicate (__none2) measures how much one answer varies on an unchanged context.
for (const [d, rep] of readdirSync(join(HERE, "runs")).filter((d) => d.endsWith("__native")).flatMap((d) => [[d, ""], [d, "2"]])) {
  const ctl = join(HERE, "runs", d.replace(/__native$/, `__none${rep}`));
  if (existsSync(join(ctl, "meta.json"))) continue;
  const meta = JSON.parse(readFileSync(join(HERE, "runs", d, "meta.json"), "utf8"));
  const lines = readFileSync(join(HERE, "runs", d, "session.jsonl"), "utf8").trim().split("\n");
  const end = lines.findIndex((l) => JSON.parse(l).type === "compaction");
  mkdirSync(ctl, { recursive: true });
  writeFileSync(join(ctl, "session.jsonl"), lines.slice(0, end).join("\n") + "\n");
  writeFileSync(join(ctl, "meta.json"), JSON.stringify({ ...meta, id: meta.id.replace(/__native$/, `__none${rep}`), arm: "none", control: true }, null, 1));
}

const ids = readdirSync(join(HERE, "runs")).filter((d) => existsSync(join(HERE, "runs", d, "meta.json")));
const pools = { sonnet: ids.filter((d) => d.includes("__sonnet__")), sol: ids.filter((d) => d.includes("__sol__")) };
await Promise.all(Object.values(pools).flatMap((q) => Array.from({ length: 3 }, async () => {
  while (q.length) { const id = q.shift(); try { await one(id); } catch (e) { console.error(id, String(e.message).slice(0, 300)); } }
})));
process.exit(0);
