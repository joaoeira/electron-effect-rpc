/**
 * Builds the test app and runs it in real Electron. Exits with Electron's exit
 * code. Run with `bun run test:electron`.
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import electron from "electron";

// Outside Electron, the package's export is the path to the Electron binary.
const electronPath = Schema.decodeUnknownSync(Schema.String)(electron);

const appDir = path.join(import.meta.dir, "app");
const outdir = path.join(import.meta.dir, "build");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const bundles = [
  { entry: "main.ts", target: "node", format: "esm", naming: "main.mjs" },
  { entry: "utility.ts", target: "node", format: "esm", naming: "utility.mjs" },
  // Sandboxed preloads are CommonJS with a restricted `require`.
  { entry: "preload.ts", target: "browser", format: "cjs", naming: "preload.cjs" },
  { entry: "renderer.ts", target: "browser", format: "iife", naming: "renderer.js" },
] as const;

for (const bundle of bundles) {
  const result = await Bun.build({
    entrypoints: [path.join(appDir, bundle.entry)],
    outdir,
    target: bundle.target,
    format: bundle.format,
    naming: bundle.naming,
    external: ["electron"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const size = result.outputs.reduce((total, output) => total + output.size, 0);
  console.log(`built ${bundle.naming} (${(size / 1024).toFixed(1)} KiB)`);
}
copyFileSync(path.join(appDir, "index.html"), path.join(outdir, "index.html"));

const child = spawn(electronPath, [path.join(outdir, "main.mjs")], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
