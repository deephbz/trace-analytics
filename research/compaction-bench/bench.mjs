// Compaction benchmark: real pi session slices, real pi (RPC mode), four methods.
//
// One run = one slice x one model x one arm, in a fresh pi process on a copy of the slice:
//   1. set model and thinking; auto-compaction off
//   2. warm-up turn (no tools), so the prefix is cached as in a live session
//   3. compaction: `compact` (native, blackmagic) or `/keepset run` (keepset, summary)
//   4. recall probe on the compacted context
// Every RPC event is logged with its arrival time; analyze.py reads the run's session
// file, the events, and the Magpie ledger.
//
// Usage: node bench.mjs [--slices hc-90k,..] [--models sonnet,sol] [--arms native,...] [--dry]

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
// Supply absolute extension paths for the selected experimental arms.
const KEEPSET = process.env.BENCH_KEEPSET_EXTENSION;
const BLACKMAGIC = process.env.BENCH_BLACKMAGIC_EXTENSION;

export const MODELS = {
  sonnet: { provider: "magpie", id: "claude/claude-sonnet-5-5" },
  sol: { provider: "openai-codex", id: "gpt-6.1-sol" },
};
// Blackmagic is remote Codex compaction: OpenAI routes only.
export const ARMS = {
  native: { ext: [], trigger: "compact" },
  blackmagic: { ext: [BLACKMAGIC], trigger: "compact", only: "sol" },
  summary: { ext: [KEEPSET], trigger: "keepset", env: { KEEPSET_MODE: "summary" } },
  keepset: { ext: [KEEPSET], trigger: "keepset", env: { KEEPSET_MODE: "keepset" } },
  // Same methods with harness-delivered messages kept in the verbatim record (KEEPSET_RAREBIT_CUSTOM).
  summaryc: { ext: [KEEPSET], trigger: "keepset", env: { KEEPSET_MODE: "summary", KEEPSET_RAREBIT_CUSTOM: "1" } },
  keepsetc: { ext: [KEEPSET], trigger: "keepset", env: { KEEPSET_MODE: "keepset", KEEPSET_RAREBIT_CUSTOM: "1" } },
};
const WARMUP = "[Benchmark checkpoint] Do not call any tools. In two sentences, state the task you are working on and where it stands.";
const PROBE = [
  "[Benchmark probe] This is a measurement step. Answer from your current context, under three headings.",
  "REQUEST: the user's most recent request, as close to their words as you can.",
  "NEXT: the exact next action you would take now (tool and target, or what you would say).",
  "FACTS: the three most important facts from earlier tool output that the next action depends on (paths, numbers, names, errors).",
  "Use the read tool only to open a saved file that your context points to. Do not run anything else.",
].join("\n");
const TIMEOUT = { warmup: 15 * 60e3, compaction: 20 * 60e3, probe: 15 * 60e3 };

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}

export class Rpc {
  constructor(cmd, argv, opts, log) {
    this.p = spawn(cmd, argv, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    this.waiters = [];
    this.log = log;
    this.buf = "";
    this.n = 0;
    this.p.stdout.on("data", (b) => {
      this.buf += b;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const t = Date.now();
        // Streaming deltas are large and carry no timing we need beyond their arrival.
        if (ev.type === "message_update") {
          const k = ev.assistantMessageEvent?.type;
          if (k !== "start" && k !== "text_start" && k !== "thinking_start" && k !== "toolcall_start") continue;
          this.log({ t, type: "message_update", kind: k });
        } else this.log({ t, ...ev, ...(ev.type === "message_end" || ev.type === "agent_end" || ev.type === "turn_end" ? { message: undefined, messages: undefined, toolResults: undefined } : {}) });
        for (const w of [...this.waiters]) if (w.match(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve({ ev, t }); }
      }
    });
    this.p.stderr.on("data", (b) => this.log({ t: Date.now(), type: "stderr", text: String(b).slice(0, 2000) }));
    this.exited = new Promise((r) => this.p.on("exit", (code) => { this.log({ t: Date.now(), type: "exit", code }); r(code); for (const w of this.waiters) w.reject(new Error(`pi exited ${code}`)); }));
  }
  wait(match, ms) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error("timeout")); } }, ms);
    });
  }
  async send(cmd, ms = 60e3) {
    const id = `c${++this.n}`;
    const t = Date.now();
    this.log({ t, type: "sent", cmd: { ...cmd, id } });
    const done = this.wait((e) => e.type === "response" && e.id === id, ms);
    this.p.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    const { ev } = await done;
    if (!ev.success) throw new Error(`${cmd.type}: ${ev.error}`);
    return { ev, t };
  }
}

export async function turn(rpc, message, ms) {
  const settled = rpc.wait((e) => e.type === "agent_settled", ms);
  const { t } = await rpc.send({ type: "prompt", message });
  return { t0: t, t1: (await settled).t };
}

export async function run(slice, modelKey, armKey) {
  // slice: <session>-<model>-<tier>k (slices are sized per model)
  const model = MODELS[modelKey], arm = ARMS[armKey];
  if (arm.ext.some((p) => !p || !existsSync(p))) {
    throw new Error("Selected arm needs an existing BENCH_KEEPSET_EXTENSION or BENCH_BLACKMAGIC_EXTENSION path");
  }
  const id = `${slice}__${modelKey}__${armKey}`;
  const dir = join(HERE, "runs", id);
  if (existsSync(join(dir, "meta.json")) && JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).ok) return { id, skipped: true };
  mkdirSync(dir, { recursive: true });
  const session = join(dir, "session.jsonl");
  copyFileSync(join(HERE, "slices", `${slice}.jsonl`), session);
  const logf = join(dir, "events.jsonl");
  writeFileSync(logf, "");
  const log = (e) => appendFileSync(logf, JSON.stringify(e) + "\n");
  const argv = ["--mode", "rpc", "--session", session, "--no-extensions", "--no-mcp", "--provider", model.provider, "--model", model.id, "--thinking", "medium",
    "--tools", ["read", "grep", "find", "ls", ...(arm.trigger === "keepset" ? ["compaction_plan"] : [])].join(","), ...arm.ext.flatMap((e) => ["-e", e])];
  const env = { ...process.env, KEEPSET_THRESHOLD: "1000", ...(arm.env ?? {}) };
  const meta = { id, slice, model: modelKey, arm: armKey, argv, started: Date.now(), ok: false, steps: {} };
  const rpc = new Rpc("pi", argv, { cwd: dir, env }, log);
  try {
    await rpc.send({ type: "set_model", provider: model.provider, modelId: model.id });
    await rpc.send({ type: "set_thinking_level", level: "medium" });
    await rpc.send({ type: "set_auto_compaction", enabled: false });
    meta.steps.warmup = await turn(rpc, WARMUP, TIMEOUT.warmup);
    const end = rpc.wait((e) => e.type === "compaction_end", TIMEOUT.compaction);
    const start = rpc.wait((e) => e.type === "compaction_start", TIMEOUT.compaction);
    const t0 = Date.now();
    if (arm.trigger === "compact") rpc.send({ type: "compact" }, TIMEOUT.compaction).catch((e) => log({ t: Date.now(), type: "compact_error", error: String(e.message) }));
    else await rpc.send({ type: "prompt", message: "/keepset run" });
    const s = await start, e = await end;
    meta.steps.compaction = { t0, start: s.t, end: e.t, aborted: e.ev.aborted, error: e.ev.errorMessage ?? null };
    if (e.ev.aborted || !e.ev.result) throw new Error(`compaction did not complete: ${JSON.stringify(e.ev).slice(0, 300)}`);
    // Keepset compacts on agent_settled; let that settle before the probe.
    await new Promise((r) => setTimeout(r, 1500));
    meta.steps.probe = await turn(rpc, PROBE, TIMEOUT.probe);
    meta.ok = true;
  } catch (err) {
    meta.error = String(err?.message ?? err);
  } finally {
    meta.finished = Date.now();
    rpc.p.stdin.end();
    setTimeout(() => rpc.p.kill("SIGTERM"), 5000);
    await rpc.exited;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 1));
  }
  return { id, ok: meta.ok, error: meta.error, secs: Math.round((meta.finished - meta.started) / 1000) };
}

async function main() {
  const o = args();
  const index = JSON.parse(readFileSync(join(HERE, "slices/index.json"), "utf8"));
  const slices = (o.slices ? o.slices.split(",") : Object.keys(index)).filter((k) => index[k]);
  const models = o.models ? o.models.split(",") : Object.keys(MODELS);
  const arms = o.arms ? o.arms.split(",") : Object.keys(ARMS);
  // One queue per model (provider), run in parallel; arms rotate across slices.
  const queues = models.map((m) => slices.filter((s) => index[s].model === m).flatMap((s, i) => {
    const as = arms.filter((a) => !ARMS[a].only || ARMS[a].only === m);
    return as.map((_, j) => [s, m, as[(i + j) % as.length]]);
  }));
  if (o.dry) return console.log(queues.map((q) => q.map((x) => x.join("/")).join("\n")).join("\n\n"));
  await Promise.all(queues.map(async (q) => {
    for (const [s, m, a] of q) console.log(JSON.stringify(await run(s, m, a)));
  }));
}

// Pending wait() timers would keep the process alive after the last run.
if (process.argv[1] === fileURLToPath(import.meta.url)) { await main(); process.exit(0); }
