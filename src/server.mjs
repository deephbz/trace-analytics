// Live view: a loopback server that rebuilds the report from the session files on
// each request, so the page covers new calls as pi writes them. A rebuild reads
// every session file in the window; MIN_AGE_MS keeps polling tabs from repeating it.

import { createServer } from "node:http";
import { renderPage } from "./page.mjs";

const MIN_AGE_MS = 5_000;

/** build(): Promise<report>. Serves "/" (the page) and "/report.json" (a fresh report). */
export async function serve(build, { port = 0 } = {}) {
  let last = null;
  let pending = null;
  const fresh = () => {
    if (last && Date.now() - last.at < MIN_AGE_MS) return Promise.resolve(last.body);
    pending ??= build().then(
      (rep) => ((last = { at: Date.now(), body: JSON.stringify(rep) }), (pending = null), last.body),
      (e) => ((pending = null), Promise.reject(e)),
    );
    return pending;
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    try {
      if (path === "/") return send(res, "text/html; charset=utf-8", await renderPage());
      if (path === "/report.json") return send(res, "application/json", await fresh());
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e?.stack ?? e));
    }
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

function send(res, type, data) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(data);
}
