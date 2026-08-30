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
import { createHash } from "node:crypto";
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

const css = await readFile(join(here, "styles.css"), "utf8");
const crypto = await readFile(join(here, "../protocol/src/crypto.js"), "utf8");
const lattice = await readFile(join(here, "lattice.js"), "utf8");

const app = (await readFile(join(here, "app.js"), "utf8"))
  .replace('const DEFAULT_RELAY = "http://localhost:8787"; // rewritten by build.mjs',
           `const DEFAULT_RELAY = ${JSON.stringify(relay)};`);

if (!app.includes(`const DEFAULT_RELAY = ${JSON.stringify(relay)}`)) {
  throw new Error("Could not set the relay URL — app.js has drifted from build.mjs.");
}

/**
 * Stamp every asset reference with a hash of the content.
 *
 * The page and its stylesheet are cached independently, so without this a
 * browser will happily pair new markup with an old stylesheet and render
 * something that matches neither. A changed hash is a different URL, which no
 * cache can satisfy from what it already holds.
 */
const stamp = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);
const vCss = stamp(css);
const vCrypto = stamp(crypto);
const vLattice = stamp(lattice);
const appOut = app
  .replace('from "../protocol/src/crypto.js"', `from "./vendor/crypto.js?v=${vCrypto}"`)
  .replace('from "./lattice.js"', `from "./lattice.js?v=${vLattice}"`);
const vApp = stamp(appOut);

const html = (await readFile(join(here, "index.html"), "utf8"))
  .replace('href="styles.css"', `href="styles.css?v=${vCss}"`)
  .replace('src="app.js"', `src="app.js?v=${vApp}"`);

await writeFile(join(out, "index.html"), html);
await writeFile(join(out, "styles.css"), css);
await writeFile(join(out, "vendor/crypto.js"), crypto);
await writeFile(join(out, "lattice.js"), lattice);
await writeFile(join(out, "app.js"), appOut);

// The page itself must never be cached, or it would keep pointing at old hashes.
await writeFile(join(out, "_headers"), [
  "/",
  "  Cache-Control: no-cache",
  "/index.html",
  "  Cache-Control: no-cache",
  "",
].join("\n"));

console.log(`\n  Built packages/web/dist  →  relay ${relay}`);
console.log(`  assets  css ${vCss}  app ${vApp}  crypto ${vCrypto}  lattice ${vLattice}\n`);
