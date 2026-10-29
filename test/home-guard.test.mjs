import "./home.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

const root = join(import.meta.dirname, "..");

test("HOME guard: every test file imports test/home.mjs first", () => {
  const missing = [];
  for (const dir of ["test"]) for (const name of readdirSync(join(root, dir))) {
    if (!name.endsWith(".test.mjs")) continue;
    const first = readFileSync(join(root, dir, name), "utf8").match(/^import\b.*$/m)?.[0];
    if (first !== `import "${dir === "test" ? "./home.mjs" : "../test/home.mjs"}";`) missing.push(`${dir}/${name}`);
  }
  assert.deepEqual(missing, []);
});

// Bun caches os.homedir() at start, so a runtime HOME never reaches it. A worker thread is the same case under
// Node: its HOME stays in its own process.env copy.
test("HOME guard: a process whose os.homedir() does not follow HOME stops before any test code runs", async () => {
  const worker = new Worker(new URL("./home.mjs", import.meta.url));
  const error = await new Promise((resolve) => { worker.once("error", resolve); worker.once("exit", () => resolve(undefined)); });
  assert.match(String(error), /HOME isolation failed: .* No test code ran\./);
});
