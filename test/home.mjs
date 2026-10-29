// Test HOME isolation: import this module first in every test file, or load it as a Vitest setup file. It gives the
// test process a fresh HOME and proves that os.homedir() follows it before any test code runs. Bun caches
// os.homedir() at start, so a HOME set at runtime does not reach it; on 2026-10-29 a Bun test run wrote the
// operator's ~/.pi this way. scripts/verify-test-home.mjs keeps every copy of this file identical.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hc-test-home-"));
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
// Pi paths then default inside the fresh HOME; a test that needs an agent directory sets its own.
delete process.env.PI_CODING_AGENT_DIR;
const resolved = realpathSync(homedir()), operator = realpathSync(userInfo().homedir);
if (resolved !== realpathSync(home) || resolved === operator)
	throw new Error(`HOME isolation failed: os.homedir() is ${resolved}, HOME is ${home}, the operator HOME is ${operator}. This runtime does not follow a HOME set at runtime; run the tests under Node. No test code ran.`);
