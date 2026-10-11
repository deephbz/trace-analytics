// The layers' import rules: sources know harnesses, analytics know intentions, reports know
// presentation. Only src/record.mjs is shared between sources and analytics, and only
// src/pipeline.mjs (and the entry points) wire all three.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const FORBIDDEN = { sources: ["analytics", "reports"], analytics: ["sources", "reports"], reports: ["sources"] };

function* files(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* files(p);
    else if (/\.(mjs|html)$/.test(d.name)) yield p;
  }
}

// Fails if a module reaches into a layer it must not know.
test("layers import only what they may", () => {
  const bad = [];
  for (const f of files(SRC)) {
    const layer = relative(SRC, f).split("/")[0];
    for (const [, spec] of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const target = relative(SRC, resolve(join(f, ".."), spec)).split("/")[0];
      if (FORBIDDEN[layer]?.includes(target)) bad.push(`${relative(SRC, f)} -> ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});
