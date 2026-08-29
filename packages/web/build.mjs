/**
 * Builds a self-contained folder for Cloudflare Pages.
 *
 * Pages uploads a single directory, but the client imports the protocol from a
 * sibling package. This copies it in and rewrites the one import, so the source
 * tree stays a monorepo while the deployed artefact stays flat.
 *
 *     RELAY_URL=https://copyme-relay.example.in node packages/web/build.mjs
 */
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const relay = process.env.RELAY_URL?.replace(/\/+$/, "");

if (!relay) {
  console.error("\n  Set RELAY_URL so the built client knows where to talk.\n" +
                "  RELAY_URL=https://copyme-relay.your-domain node packages/web/build.mjs\n");
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "vendor"), { recursive: true });

await copyFile(join(here, "index.html"), join(out, "index.html"));
await copyFile(join(here, "styles.css"), join(out, "styles.css"));
await copyFile(join(here, "../protocol/src/crypto.js"), join(out, "vendor/crypto.js"));

const app = (await readFile(join(here, "app.js"), "utf8"))
  .replace('from "../protocol/src/crypto.js"', 'from "./vendor/crypto.js"')
  .replace('const DEFAULT_RELAY = "http://localhost:8787"; // rewritten by build.mjs',
           `const DEFAULT_RELAY = ${JSON.stringify(relay)};`);

if (!app.includes(`const DEFAULT_RELAY = ${JSON.stringify(relay)}`)) {
  throw new Error("Could not set the relay URL — app.js has drifted from build.mjs.");
}
await writeFile(join(out, "app.js"), app);

console.log(`\n  Built packages/web/dist  →  relay ${relay}\n`);
