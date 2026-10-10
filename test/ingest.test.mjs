// Checks for the incremental scan and the codex call rules, on small synthetic files.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codex } from "../src/adapters/codex.mjs";
import { magpie } from "../src/adapters/magpie.mjs";
import { pi } from "../src/adapters/pi.mjs";
import { ingest } from "../src/ingest.mjs";
import { scan } from "../src/scan.mjs";

const T0 = Date.parse("2026-10-10T05:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

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

function codexLines() {
  const line = (at, type, payload) => JSON.stringify({ timestamp: iso(at), type, payload });
  const item = (at, type, s, c) => `{"timestamp":"${iso(at)}","type":"event_msg","payload":{"type":"item_completed","item":{"type":"${type}","id":"x"},"started_at_ms":${T0 + s},"completed_at_ms":${T0 + c}}}`;
  const usage = (out) => ({ usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: out, reasoning_output_tokens: 10 } });
  return [
    line(0, "event_msg", { type: "task_started" }),
    line(5, "turn_context", { model: "gpt-x" }),
    line(10, "response_item", { type: "message", role: "user", content: [] }),
    item(1500, "Reasoning", 1200, 1500), // call 1: request at 10, first item at 1200
    line(1600, "response_item", { type: "function_call", name: "f" }),
    line(1700, "token_usage_record", usage(50)),
    line(3000, "response_item", { type: "function_call_output", output: "y" }),
    line(3001, "response_item", { type: "agent_message", author: "/root/a" }), // another agent's message: an input
    item(3500, "AgentMessage", 3400, 3500), // call 2: request at 3001
    line(3450, "response_item", { type: "custom_tool_call_output", output: "late" }), // written after the call began: not its start
    line(3600, "token_usage_record", usage(30)),
    line(3700, "event_msg", { type: "task_complete" }),
  ];
}

async function rowsOf(adapter, path, dir) {
  const { index } = await scan({ ...adapter, list: async () => [path] }, { sinceMs: 0, cacheDir: dir });
  return index.files[path].rows;
}

// Fails if the append path loses a line cut at a chunk end, or the join state between reads.
for (const [adapter, lines] of [[pi, piLines()], [codex, codexLines()]]) {
  test(`${adapter.name}: appended reads give the rows of one whole read`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-speed-"));
    const whole = join(dir, "whole.jsonl");
    writeFileSync(whole, lines.join("\n") + "\n");
    const expected = await rowsOf(adapter, whole, join(dir, "c1"));
    assert.ok(expected.length >= 2);

    const grown = join(dir, "grown.jsonl");
    const text = lines.join("\n") + "\n";
    const cuts = [0, Math.floor(text.length / 3), Math.floor(text.length / 3) + 7, text.length - 3, text.length];
    writeFileSync(grown, "");
    let rows;
    for (let i = 1; i < cuts.length; i++) {
      appendFileSync(grown, text.slice(cuts[i - 1], cuts[i]));
      rows = await rowsOf(adapter, grown, join(dir, "c2"));
    }
    assert.deepEqual(rows.map((r) => ({ ...r, session: null })), expected.map((r) => ({ ...r, session: null })));
  });
}

// Fails if a late input line or another agent's message moves the request start wrongly.
test("codex: request start, first item, and end of each call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-speed-"));
  const path = join(dir, "rollout-2026-10-10T05-00-00-00000000-0000-4000-8000-000000000001.jsonl");
  writeFileSync(path, codexLines().join("\n") + "\n");
  const [c1, c2] = await rowsOf(codex, path, join(dir, "c"));
  assert.deepEqual([c1.t - T0, c1.ttft, c1.stream, c1.wall], [10, 1190, 400, 1690]);
  assert.deepEqual([c2.t - T0, c2.ttft, c2.stream, c2.wall], [3001, 399, 100, 599]);
  assert.deepEqual([c1.route, c1.uncached, c1.cached, c1.stall], ["codex/gpt-x", 200, 800, null]);
});

// Fails if a call that pi recorded is counted again from the gateway ledger, or if the
// ledger's own calls are lost.
test("magpie: the ledger adds only calls no other source has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-speed-"));
  const session = join(dir, "s.jsonl");
  const lines = piLines();
  // pi call a1 carries a response id; a2 has none, as in older sessions.
  lines[2] = lines[2].replace('"stopReason"', '"responseId":"r-1","stopReason"');
  writeFileSync(session, lines.join("\n") + "\n");
  const rec = (at, out, id) => JSON.stringify({ t: iso(at), agent: "pi", provider: "claude", model: "m", req: "claude/m", in: 2, out, ms: 4000, ttft_ms: 1500, status: 200, ...(id && { response_id: id }) });
  const ledger = join(dir, "usage.jsonl");
  writeFileSync(ledger, [
    rec(30, 200, "r-1"), // pi's a1, by id
    rec(3040, 200), // pi's a2, no id: equal output 40 ms apart
    rec(9000, 200, "r-9"), // a call pi has no session for
    rec(20000, 77), // likewise, no id
    JSON.stringify({ t: iso(25000), out: 0, ms: 50, status: 429, err: "rate limited" }),
  ].join("\n") + "\n");
  const adapters = { pi: { ...pi, list: async () => [session] }, magpie: { ...magpie, list: async () => [ledger] } };
  const { rows, sources } = await ingest({ sinceMs: 0, untilMs: T0 + 60000, adapters, cacheDir: join(dir, "c") });
  assert.deepEqual(rows.map((r) => [r.agent, r.t - T0]), [["pi", 0], ["pi", 3000], ["magpie", 9000], ["magpie", 20000]]);
  assert.deepEqual(sources.find((s) => s.adapter === "magpie").skipped, { failed: 1, notStreamed: 0, noOutput: 0, inOtherSource: 2 });
  assert.equal(rows[2].route, "gateway/claude/m");
});
