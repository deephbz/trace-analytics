// Blind judge of probe answers. The judge sees the original record (the slice's last
// user message, the record tail before the cut, and what the original agent did next)
// and one probe answer. It does not see the arm or the model.
//
// Judge: claude-opus-5-5 via pi print mode, no tools, no session. Scores 0-2 each:
//   request  the answer states the latest user request correctly
//   next     the next action agrees with the original agent's next actions, or is an equally valid step
//            (null when the slice ends just before a new instruction: no ground truth)
//   facts    the facts are specific and consistent with the record (0 = vague or wrong)
//
// Run after collect.py: node judge.mjs  ->  judge.json (cached per run id and answer)

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const JUDGE = ["--provider", "magpie", "--model", "claude/claude-opus-5-5", "--thinking", "medium"];
const OUT = join(HERE, process.env.JUDGE_OUT ?? "judge.json"); // JUDGE_OUT=judge2.json: a second pass measures judge agreement

function tail(file, n = 8000) {
  // The last entries before the cut as plain text: what the probe answer can be checked against.
  const L = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let s = "";
  for (const d of L.reverse()) {
    const m = d.message ?? {};
    const parts = typeof m.content === "string" ? [m.content] : (m.content ?? []).map((c) => c.text ?? (c.type === "toolCall" ? `[call ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}]` : "")).filter(Boolean);
    if (!m.role || !parts.length) continue;
    s = `<${m.role}>\n${parts.join("\n").slice(0, 2500)}\n</${m.role}>\n` + s;
    if (s.length > n) break;
  }
  return s;
}

function prompt(sl, answer) {
  return `You grade how well an agent kept its working state after its context was compacted.

ORIGINAL RECORD
Latest instruction to the agent (user message, or harness message in Worker sessions):
<<<
${sl.last_user}
>>>
Record tail before the cut:
<<<
${tail(sl.file)}
>>>
What the original agent did next (ground truth):
<<<
${sl.next_actions.length ? sl.next_actions.join("\n") : "(none: a new instruction arrived first; score next as null)"}
>>>

AGENT ANSWER AFTER COMPACTION
<<<
${answer}
>>>

Score each item 0, 1 or 2.
request: 2 = states the latest instruction or the task it serves correctly; 1 = partly or too vague; 0 = wrong or missing.
next: 2 = same next action as ground truth, or an equally valid step for the same goal; 1 = right direction, wrong target; 0 = wrong.
facts: 2 = specific facts consistent with the record; 1 = some vague or unverifiable; 0 = wrong or generic.
Reply with one JSON object only: {"request":n,"next":n,"facts":n,"note":"one sentence"}`;
}

async function main() {
  const index = JSON.parse(readFileSync(join(HERE, "slices/index.json"), "utf8"));
  const rows = JSON.parse(readFileSync(join(HERE, "rows.json"), "utf8")).filter((r) => r.ok && r.answer);
  const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  const todo = rows.filter((r) => !(done[r.id] && done[r.id].answer === r.answer)).slice(0, Number(process.env.JUDGE_LIMIT ?? Infinity));
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const r = todo[i++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // pi -p reads piped stdin until EOF; close it.
          const job = run("pi", ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", ...JUDGE, prompt(index[r.slice], r.answer)],
            { cwd: "/tmp", maxBuffer: 1 << 24, timeout: 180e3 });
          job.child.stdin.end();
          const { stdout } = await job;
          const j = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
          done[r.id] = { ...j, answer: r.answer };
          writeFileSync(OUT, JSON.stringify(done, null, 1));
          console.log(r.id, j.request, j.next, j.facts, j.note);
          break;
        } catch (e) {
          console.error(r.id, "attempt", attempt, e.killed ? "killed (timeout)" : "", String(e.stderr ?? "").slice(-600), String(e.stdout ?? "").slice(-300));
        }
      }
    }
  }));
}

await main();
