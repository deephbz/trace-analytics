// Checks for the input adapters and load(), on small synthetic files.
import "./home.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claude } from "../src/sources/claude.mjs";
import { codex } from "../src/sources/codex.mjs";
import { load } from "../src/sources/load.mjs";
import { magpie } from "../src/sources/magpie.mjs";
import { pi } from "../src/sources/pi.mjs";
import { scan } from "../src/sources/scan.mjs";

const T0 = Date.parse("2026-10-10T05:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();
const tmp = () => mkdtempSync(join(tmpdir(), "trace-analytics-"));
const CODEX_FILE = "rollout-2026-10-10T05-00-00-00000000-0000-4000-8000-000000000001.jsonl";

function piLines() {
  const msg = (id, parent, at, role, extra) => JSON.stringify({ type: "message", id, parentId: parent, timestamp: iso(at), message: { role, ...extra } });
  const tps = (id, parent, ttft) => JSON.stringify({ type: "custom", customType: "tps", data: { model: { provider: "p", modelId: "m" }, timing: { ttftMs: ttft, streamMs: 900, stallMs: 0, stallCount: 0, messageCount: 1 }, isPrimaryBranch: true }, id, parentId: parent, timestamp: iso(0) });
  const asst = (at) => ({ provider: "p", model: "m", timestamp: T0 + at, stopReason: "toolUse", usage: { input: 10, cacheRead: 1000, cacheWrite: 5, output: 200, reasoning: 0 } });
  return [
    JSON.stringify({ type: "session", version: 3, id: "s", timestamp: iso(0) }),
    msg("u1", null, 0, "user", { content: "hi" }),
    msg("a1", "u1", 2000, "assistant", asst(0)),
    msg("r1", "a1", 2100, "toolResult", { content: "x".repeat(5000) }),
    tps("t1", "r1", 800),
    msg("a2", "t1", 5000, "assistant", asst(3000)),
    tps("t2", "a2", 700),
  ];
}

const codexLine = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload });
const codexItem = (at, type, s, c) => `{"timestamp":"${iso(at)}","type":"event_msg","payload":{"type":"item_completed","item":{"type":"${type}","id":"x"},"started_at_ms":${T0 + s},"completed_at_ms":${T0 + c}}}`;
const codexUsage = (out, id) => ({ ...(id && { response_id: id }), usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: out, reasoning_output_tokens: 10 } });

function codexLines() {
  return [
    codexLine(0, "event_msg", { type: "task_started" }),
    codexLine(5, "turn_context", { model: "gpt-x" }),
    codexLine(10, "response_item", { type: "message", role: "user", content: [] }),
    codexItem(1500, "Reasoning", 1200, 1500), // call 1: request at 10, first item at 1200
    codexLine(1600, "response_item", { type: "function_call", name: "f" }),
    codexLine(1700, "token_usage_record", codexUsage(50)),
    codexLine(3000, "response_item", { type: "function_call_output", output: "y" }),
    codexLine(3001, "response_item", { type: "agent_message", author: "/root/a" }), // another agent's message: an input
    codexItem(3500, "AgentMessage", 3400, 3500), // call 2: request at 3001
    codexLine(3450, "response_item", { type: "custom_tool_call_output", output: "late" }), // written after the call began: not its start
    codexLine(3600, "token_usage_record", codexUsage(30)),
    codexLine(3700, "event_msg", { type: "task_complete" }),
  ];
}

async function recordsOf(adapter, path, dir) {
  const { files } = await scan({ ...adapter, list: async () => [path] }, { sinceMs: 0, cacheDir: dir });
  return files[0][1].records;
}

const callsOf = (records) => records.filter((r) => r.kind === "call");

// Fails if the append path loses a line cut at a chunk end, or the join state between reads.
for (const [adapter, lines] of [[pi, piLines()], [codex, codexLines()]]) {
  test(`${adapter.name}: appended reads give the records of one whole read`, async () => {
    const dir = tmp();
    const whole = join(dir, "whole.jsonl");
    writeFileSync(whole, lines.join("\n") + "\n");
    const expected = await recordsOf(adapter, whole, join(dir, "c1"));
    assert.ok(callsOf(expected).length >= 2);

    const grown = join(dir, "grown.jsonl");
    const text = lines.join("\n") + "\n";
    const cuts = [0, Math.floor(text.length / 3), Math.floor(text.length / 3) + 7, text.length - 3, text.length];
    writeFileSync(grown, "");
    let records;
    for (let i = 1; i < cuts.length; i++) {
      appendFileSync(grown, text.slice(cuts[i - 1], cuts[i]));
      records = await recordsOf(adapter, grown, join(dir, "c2"));
    }
    const strip = (rs) => rs.map((r) => ({ ...r, session: null }));
    assert.deepEqual(strip(records), strip(expected));
  });
}

// Fails if a late input line or another agent's message moves the request start wrongly.
test("codex: request start, first item, and end of each call", async () => {
  const dir = tmp();
  const path = join(dir, CODEX_FILE);
  writeFileSync(path, codexLines().join("\n") + "\n");
  const [c1, c2] = callsOf(await recordsOf(codex, path, join(dir, "c")));
  assert.deepEqual([c1.t - T0, c1.ttft, c1.stream, c1.end - c1.t], [10, 1190, 400, 1690]);
  assert.deepEqual([c2.t - T0, c2.ttft, c2.stream, c2.end - c2.t], [3001, 399, 100, 599]);
  assert.deepEqual([c1.route, c1.input, c1.cacheRead, c1.cacheWrite, c1.stall, c1.cause, c2.cause, c2.prev], ["codex/gpt-x", 200, 800, null, null, "user", "tool", c1.id]);
});

// Fails if a compaction request is left as a turn, or the next call does not see the reset.
test("codex: a compacted line claims its request, also one that streamed a reasoning item", async () => {
  const dir = tmp();
  const path = join(dir, CODEX_FILE);
  const lines = [
    codexLine(0, "session_meta", { thread_source: "user" }),
    codexLine(1, "session_meta", { thread_source: "subagent" }), // a fork's copy of its parent's meta
    ...codexLines().slice(0, -1),
    codexItem(4000, "Reasoning", 3900, 4000), // the compaction request streams reasoning
    codexLine(9000, "token_usage_record", codexUsage(900, "rc")),
    codexLine(9001, "compacted", { compaction_response_id: "rc", replacement_history: [1, 2] }),
    codexLine(9002, "event_msg", { type: "token_count", info: { last_token_usage: { total_tokens: 4321 } } }),
    codexItem(9500, "AgentMessage", 9400, 9500),
    codexLine(9600, "token_usage_record", codexUsage(20, "r3")),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  const data = await load({ sinceMs: 0, untilMs: T0 + 60000, sources: { codex: { ...codex, list: async () => [path] } }, cacheDir: join(dir, "c") });
  const [k] = data.compactions;
  const rc = data.calls.find((c) => c.id === "rc");
  const r3 = data.calls.find((c) => c.id === "r3");
  assert.deepEqual([k.role, k.trigger, k.before, k.usage.out, k.afterEst, k.calls, k.detail.retainedItems], ["main", "mid-turn", 1000, 900, 4321, ["codex:rc"], 2]);
  assert.equal(rc.purpose, "compaction");
  assert.deepEqual([r3.prev, r3.reset, r3.compaction, r3.cause], [data.calls[1].id, "compaction", "rc", "compaction"]);
});

// Fails if a multi-entry message is counted per entry, its final usage is lost, a resumed
// session's copy counts twice, or the bridge's transcripts are read.
test("claude: one call per message, compaction boundary, copies, bridge files", async () => {
  const dir = tmp();
  const projects = join(dir, "projects");
  const entry = (uuid, parent, at, type, extra) => JSON.stringify({ uuid, parentUuid: parent, timestamp: iso(at), type, ...extra });
  const asst = (uuid, parent, at, id, out, content = "text") => entry(uuid, parent, at, "assistant", { message: { id, model: "claude-x", content: [{ type: content }], stop_reason: "end_turn", usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 20 }, output_tokens: out } } });
  const lines = [
    entry("u1", null, 0, "user", { message: { content: "hi" } }),
    asst("a1", "u1", 1000, "m1", 1, "thinking"),
    asst("a2", "a1", 1500, "m1", 40),
    entry("b1", null, 5000, "system", { subtype: "compact_boundary", logicalParentUuid: "a2", compactMetadata: { trigger: "manual", preTokens: 123, postTokens: 45, durationMs: 3000 } }),
    entry("s1", "b1", 5001, "user", { isCompactSummary: true, message: { content: "summary!" } }),
    entry("u2", "s1", 6000, "user", { message: { content: [{ type: "text", text: "go" }] } }),
    asst("a3", "u2", 7000, "m2", 5),
  ];
  mkdirSync(join(projects, "-p"), { recursive: true });
  mkdirSync(join(projects, "-magpie-c1"), { recursive: true });
  writeFileSync(join(projects, "-p", "s1.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(projects, "-p", "s2.jsonl"), lines.slice(0, 3).join("\n") + "\n"); // a resumed session's copy
  writeFileSync(join(projects, "-magpie-c1", "x.jsonl"), lines.join("\n") + "\n");
  const sources = { claude: { ...claude, list: () => claude.list(projects) } };
  const data = await load({ sinceMs: 0, untilMs: T0 + 60000, sources, cacheDir: join(dir, "c") });
  assert.deepEqual(data.calls.map((c) => [c.id, c.t - T0, c.end - T0, c.out, c.cacheWrite1h, c.prev, c.reset, c.cause]), [
    ["m1", 0, 1500, 40, 20, null, null, "user"],
    ["m2", 6000, 7000, 5, 20, "m1", "compaction", "user"],
  ]);
  const [k] = data.compactions;
  assert.deepEqual([k.prev, k.trigger, k.before, k.afterEst, k.wall, k.detail.summaryChars], ["m1", "manual", 123, 45, 3000, 8]);
  const cov = data.coverage[0];
  assert.deepEqual([cov.excluded, cov.copies], [{ magpieBridge: 1 }, 1]);
});

// Fails if a call that pi recorded is counted again from the gateway ledger, if the
// ledger's own calls are lost, or if pi's summarizer requests are not linked.
test("magpie: the ledger adds only calls no other source has, and links pi's summarizer requests", async () => {
  const dir = tmp();
  const session = join(dir, "s.jsonl");
  const lines = piLines();
  // pi call a1 carries a response id; a2 has none, as in older sessions.
  lines[2] = lines[2].replace('"stopReason"', '"responseId":"r-1","stopReason"');
  lines.push(JSON.stringify({ type: "compaction", id: "k1", parentId: "a2", timestamp: iso(30000), tokensBefore: 9000, summary: "s", usage: { input: 900, cacheRead: 0, cacheWrite: 0, output: 300 } }));
  writeFileSync(session, lines.join("\n") + "\n");
  const rec = (at, out, id, ms = 4000) => JSON.stringify({ t: iso(at), agent: "pi", provider: "claude", model: "m", req: "claude/m", in: 2, out, ms, ttft_ms: 1500, status: 200, ...(id && { response_id: id }) });
  const ledger = join(dir, "usage.jsonl");
  writeFileSync(ledger, [
    rec(30, 200, "r-1"), // pi's a1, by id
    rec(3040, 200), // pi's a2, no id: equal output 40 ms apart
    rec(9000, 200, "r-9"), // a call pi has no session for
    rec(20000, 120), // pi's summarizer requests: outputs sum to the compaction's
    rec(21000, 180),
    JSON.stringify({ t: iso(25000), out: 0, ms: 50, status: 429, err: "rate limited" }),
  ].join("\n") + "\n");
  const sources = { pi: { ...pi, list: async () => [session] }, magpie: { ...magpie, list: async () => [ledger] } };
  const data = await load({ sinceMs: 0, untilMs: T0 + 60000, sources, cacheDir: join(dir, "c") });
  assert.deepEqual(data.calls.map((c) => [c.source, c.t - T0, c.purpose]), [["pi", 0, "turn"], ["pi", 3000, "turn"], ["magpie", 9000, null], ["magpie", 20000, "compaction"], ["magpie", 21000, "compaction"]]);
  const cov = data.coverage.find((c) => c.source === "magpie");
  assert.deepEqual([cov.skipped, cov.inOtherSource], [{ failed: 1 }, 2]);
  assert.equal(data.compactions[0].calls.length, 2);
});
