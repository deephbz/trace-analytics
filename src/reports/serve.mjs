// Live view: a loopback server for one study's page.
//
// routes: { "/path": [contentType, (result) => body | Promise<body>] }. The server builds
// the result on demand and reuses it for MIN_AGE_MS, so polling tabs do not repeat a
// rebuild; a request that needs no result (a static page) does not build one.

import { execFile } from "node:child_process";
import { createServer } from "node:http";

const MIN_AGE_MS = 5_000;

/** build(): Promise<result>. A route's function takes the result when it declares a parameter. */
export async function serve(build, routes, { port = 0 } = {}) {
  let last = null;
  let pending = null;
  const fresh = () => {
    if (last && Date.now() - last.at < MIN_AGE_MS) return Promise.resolve(last.result);
    pending ??= build().then(
      (result) => ((last = { at: Date.now(), result }), (pending = null), result),
      (e) => ((pending = null), Promise.reject(e)),
    );
    return pending;
  };
  const server = createServer(async (req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    if (!route) return void res.writeHead(404).end();
    try {
      const [type, body] = route;
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(await body(body.length ? await fresh() : undefined));
    } catch (e) {
      res.writeHead(500).end(String(e?.stack ?? e));
    }
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

export function openUrl(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}
