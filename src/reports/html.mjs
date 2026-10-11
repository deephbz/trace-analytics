// Self-contained HTML: a study's page with Paper Mono inlined as a data URL (fonts/,
// SIL OFL 1.1) and, for a written report, its data embedded at a /*NAME*/null marker.

import { readFile } from "node:fs/promises";

const FONT = new URL("./fonts/PaperMono-wght.woff2", import.meta.url);

const embed = (x) => JSON.stringify(x).replace(/</g, "\\u003c");

/** page: URL of the page. data: { MARKER: value } replaces each /*MARKER*\/null. */
export async function renderPage(page, data = {}) {
  const [html, font] = await Promise.all([readFile(page, "utf8"), readFile(FONT)]);
  let out = html.replace("/*FONT*/", `data:font/woff2;base64,${font.toString("base64")}`);
  for (const [k, v] of Object.entries(data)) out = out.replace(`/*${k}*/null`, embed(v));
  return out;
}
