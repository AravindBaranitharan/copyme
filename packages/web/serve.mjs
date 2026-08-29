/**
 * Zero-dependency static server for local testing.
 *
 * Serves the repository root so the web client can import the protocol module
 * directly, with no build step between you and a running app.
 *
 *     node packages/web/serve.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "../../.."));
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);

  // Redirect rather than serving the app at "/", so the page's relative
  // references to styles.css, app.js and the protocol module all resolve.
  if (path === "/" || path === "/packages/web") {
    res.writeHead(302, { Location: "/packages/web/" }).end();
    return;
  }
  const target = path.endsWith("/") ? path + "index.html" : path;

  const file = normalize(join(root, target));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(
      `\n  Port ${port} is already serving something — very likely this server,\n` +
      `  started earlier. Open http://localhost:${port} and carry on.\n\n` +
      `  To use a different port:  PORT=5174 node packages/web/serve.mjs\n`,
    );
    process.exit(0);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`\n  CopyMe web client  →  http://localhost:${port}\n`);
});
