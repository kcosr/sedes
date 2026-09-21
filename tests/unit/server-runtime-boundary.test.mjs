import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRuntimeManifest, discoverJavaScriptPackages, discoverRuntimePackages } from "../../scripts/check-server-runtime.mjs";

describe("server runtime dependency boundary", () => {
  it("finds side effects, reexports, dynamic imports, requires, and package resolutions without reading comments or strings", () => {
    const source = `
      import "side-effect";
      export { thing } from "@scope/library/subpath";
      export * from "exports";
      await import("dynamic");
      require("commonjs");
      require.resolve("resolved/package.json");
      import.meta.resolve("meta-resolved");
      import "node:fs";
      import "fs";
      import "./local.js";
      // import "false-comment";
      const example = 'import "false-string"';
    `;
    expect(discoverJavaScriptPackages(source, "server/example.js")).toEqual([
      "@scope/library", "commonjs", "dynamic", "exports", "meta-resolved", "resolved", "side-effect",
    ]);
  });

  it("fails closed for unreviewed computed imports and requires", () => {
    for (const expression of ["import(name)", "require(name)", "require.resolve(name)", "import.meta.resolve(name)"]) {
      expect(() => discoverJavaScriptPackages(expression, "server/example.js")).toThrow("computed_import_unreviewed");
    }
  });

  it("requires the pinned Pi package anchor and image utility for its computed import", () => {
    const source = `const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
      const moduleUrl = new URL("./utils/image-process.js", packageEntry);
      await import(moduleUrl.href);`;
    const filename = "server/backends/pi/pi-remote-image-processing.js";
    expect(discoverJavaScriptPackages(source, filename)).toEqual(["@earendil-works/pi-coding-agent"]);
    expect(() => discoverJavaScriptPackages(source, "server/elsewhere.js")).toThrow("computed_import_unreviewed");
    expect(() => discoverJavaScriptPackages(source.replace("image-process.js", "other.js"), filename)).toThrow("computed_import_unreviewed");
    expect(() => discoverJavaScriptPackages(source.replace("@earendil-works/pi-coding-agent", "other-package"), filename)).toThrow("computed_import_unreviewed");
  });

  it("checks server, CLI, shared, and internal source including workers while erasing type-only imports", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-boundary-"));
    try {
      for (const name of ["server/workers", "cli", "shared", "internal", "client"]) await mkdir(path.join(directory, name), { recursive: true });
      await writeFile(path.join(directory, "server/workers/worker.ts"), 'import type { T } from "types-only"; import "worker-runtime";');
      await writeFile(path.join(directory, "cli/cli.ts"), 'await import("cli-runtime");');
      await writeFile(path.join(directory, "shared/common.ts"), 'export * from "shared-runtime";');
      await writeFile(path.join(directory, "internal/protocol.ts"), 'import "internal-runtime";');
      await writeFile(path.join(directory, "client/browser.ts"), 'import "browser-only";');
      await writeFile(path.join(directory, "server/example.test.ts"), 'import "test-only";');
      expect(Object.keys(await discoverRuntimePackages(directory, { typescript: true }))).toEqual(["cli-runtime", "internal-runtime", "shared-runtime", "worker-runtime"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  const fixture = () => ({
    rootManifest: { version: "1.0.0", dependencies: { runtime: "1.2.3" } },
    runtimeManifest: { name: "@sedes/server-runtime", version: "1.0.0", engines: { node: ">=24.18.0" }, dependencies: { runtime: "1.2.3" } },
    lock: { name: "@sedes/server-runtime", version: "1.0.0", lockfileVersion: 3, packages: {
      "": { name: "@sedes/server-runtime", version: "1.0.0", dependencies: { runtime: "1.2.3" } }, "node_modules/runtime": { version: "1.2.3" },
    } },
    discovered: { runtime: ["server/worker.js"] },
  });

  it("requires complete minimal pinned dependencies and matching lockfile", () => {
    expect(() => assertRuntimeManifest(fixture())).not.toThrow();
    const missing = fixture(); missing.discovered.newPackage = ["server/worker.js"];
    expect(() => assertRuntimeManifest(missing)).toThrow("missing=newPackage");
    const unused = fixture(); unused.discovered = {};
    expect(() => assertRuntimeManifest(unused)).toThrow("unused=runtime");
    const drift = fixture(); drift.rootManifest.dependencies.runtime = "1.2.4";
    expect(() => assertRuntimeManifest(drift)).toThrow("dependency_version_drift:runtime");
    const stale = fixture(); stale.lock.packages[""].dependencies.runtime = "1.2.2";
    expect(() => assertRuntimeManifest(stale)).toThrow("lock_dependencies_drift");
  });
});
