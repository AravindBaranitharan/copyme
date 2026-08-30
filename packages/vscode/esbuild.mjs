import * as esbuild from "esbuild";

/**
 * Bundles as a web extension: one file, browser target, no Node built-ins.
 * That keeps it running in desktop VS Code, Cursor and vscode.dev alike, and
 * means the extension host denies it filesystem and process access outright.
 */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/web/extension.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["vscode"],
  sourcemap: true,
  minify: !process.argv.includes("--watch"),
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
