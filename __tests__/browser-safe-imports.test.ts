import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Guards against regressions where a static import of preload.ts (which
 * eagerly imports the `electron` module) leaks into the main entry point.
 *
 * kit.ts must keep preload loading lazy and synchronous with no module-level
 * preload import/require. Browser-like environments should still be able to
 * import `createIpcKit` without pulling in electron.
 */
describe("browser-safe imports", () => {
  const root = resolve(import.meta.dir, "..");

  it("kit.ts has no static value imports from preload", () => {
    const source = readFileSync(resolve(root, "src/kit.ts"), "utf-8");

    // Match `import ... from "./preload..."` but NOT `import type ... from "./preload..."`
    const staticValueImports = [
      ...source.matchAll(/^import\s+(?!type\s)[^;]*from\s+["']\.\/preload(?:\.[^"']+)?["']/gm),
    ];

    expect(staticValueImports).toHaveLength(0);
  });

  it("kit.ts has no preload dynamic import or require", () => {
    const source = readFileSync(resolve(root, "src/kit.ts"), "utf-8");

    const dynamicImports = [...source.matchAll(/import\(["']\.\/preload(?:\.[^"']+)?["']/g)];
    const cjsRequires = [...source.matchAll(/require\(["']\.\/preload(?:\.[^"']+)?["']/g)];

    expect(dynamicImports).toHaveLength(0);
    expect(cjsRequires).toHaveLength(0);
  });

  it("compiled kit.js has no preload static import, dynamic import, or require", () => {
    const compiled = readFileSync(resolve(root, "dist/kit.js"), "utf-8");

    // ESM static imports
    const esmImports = [
      ...compiled.matchAll(/^import\s+(?!type\s)[^;]*from\s+["']\.\/preload(?:\.[^"']+)?["']/gm),
    ];
    // Dynamic imports
    const dynamicImports = [...compiled.matchAll(/import\(["']\.\/preload(?:\.[^"']+)?["']/g)];
    // CommonJS requires
    const cjsRequires = [...compiled.matchAll(/require\(["']\.\/preload(?:\.[^"']+)?["']/g)];

    expect(esmImports).toHaveLength(0);
    expect(dynamicImports).toHaveLength(0);
    expect(cjsRequires).toHaveLength(0);
  });

  it("index.ts does not re-export from preload", () => {
    const source = readFileSync(resolve(root, "src/index.ts"), "utf-8");

    const preloadReExports = [
      ...source.matchAll(/^export\s+(?!type\s)[^;]*from\s+["']\.\/preload(?:\.[^"']+)?["']/gm),
    ];

    expect(preloadReExports).toHaveLength(0);
  });

  it("kit entry point has no static electron import", () => {
    const source = readFileSync(resolve(root, "src/kit.ts"), "utf-8");
    const compiled = readFileSync(resolve(root, "dist/kit.js"), "utf-8");
    const electronImportPattern = /^import\s+(?!type\s)([^;]*\sfrom\s+)?["']electron["'];?/gm;

    expect([...source.matchAll(electronImportPattern)]).toHaveLength(0);
    expect([...compiled.matchAll(electronImportPattern)]).toHaveLength(0);
  });

  it("preload-bridge has no static electron import", () => {
    const source = readFileSync(resolve(root, "src/preload-bridge.ts"), "utf-8");
    const compiled = readFileSync(resolve(root, "dist/preload-bridge.js"), "utf-8");
    const electronImportPattern = /^import\s+(?!type\s)([^;]*\sfrom\s+)?["']electron["'];?/gm;

    expect([...source.matchAll(electronImportPattern)]).toHaveLength(0);
    expect([...compiled.matchAll(electronImportPattern)]).toHaveLength(0);
  });
});
