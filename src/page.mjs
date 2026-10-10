// The web view as one self-contained HTML string: the page, Paper Mono inlined as a
// data URL (web/fonts, SIL OFL 1.1), and, for a written report, the report itself.

import { readFile } from "node:fs/promises";

const PAGE = new URL("../web/index.html", import.meta.url);
const FONT = new URL("../web/fonts/PaperMono-wght.woff2", import.meta.url);

/** report: embed it (written report.html), or null (live view, the page polls). */
export async function renderPage(report = null) {
  const [page, font] = await Promise.all([readFile(PAGE, "utf8"), readFile(FONT)]);
  return page
    .replace("/*FONT*/", `data:font/woff2;base64,${font.toString("base64")}`)
    .replace("/*REPORT*/null", JSON.stringify(report).replace(/</g, "\\u003c"));
}
