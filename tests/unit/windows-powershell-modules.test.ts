import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { windowsStagingPrivacy } from "../../src/server/composer-attachments/windows-staging-privacy.js";
import { spawnWindowsOwnedProcess } from "../../src/server/execution/windows-owned-process.js";
import { windowsSidecarPlatform } from "../../src/server/sidecar/sidecar-windows-platform.js";
import { assertTrustedWindowsSearchPath } from "../../src/server/workspace-tools/trusted-search-windows.js";

it.skipIf(process.platform !== "win32")(
  "uses built-in Windows PowerShell modules despite inherited incompatible modules",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-win-modules-"));
    onTestFinished(async () => {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    });
    for (const [name, exports] of [
      ["Microsoft.PowerShell.Security", ["Get-Acl"]],
      ["Microsoft.PowerShell.Utility", ["Add-Type", "ConvertTo-Json"]],
    ] as const) {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(
        path.join(directory, `${name}.psd1`),
        `@{ RootModule = '${name}.psm1'; ModuleVersion = '1.0.0'; FunctionsToExport = @(${exports.map(value => `'${value}'`).join(",")}) }\n`,
      );
      await writeFile(
        path.join(directory, `${name}.psm1`),
        exports.map(value => `function ${value} { throw 'inherited_module_loaded' }`).join("\n"),
      );
    }
    vi.stubEnv("PSModulePath", root);

    await expect(
      assertTrustedWindowsSearchPath(path.join(process.env.SystemRoot!, "System32", "where.exe")),
    ).resolves.toBeUndefined();
    await expect(windowsSidecarPlatform.readTargetLifetime()).resolves.toMatchObject({
      bootId: expect.stringMatching(/^windows-/u),
      pidNamespace: "windows",
    });
    const storage = path.join(root, "private");
    await windowsStagingPrivacy(storage, "ensure-directory", { rootDirectory: storage });
    await windowsStagingPrivacy(storage, "assert-directory");

    const owned = await spawnWindowsOwnedProcess({
      executable: process.execPath,
      arguments: ["-e", 'process.stdout.write(JSON.stringify({ready:true,modulePath:process.env.PSModulePath}))'],
      cwd: root,
      environment: { PSModulePath: "provider-owned-module-path" },
      signal: new AbortController().signal,
    });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of owned.child.stdout) chunks.push(Buffer.from(chunk));
      await expect(owned.closed).resolves.toMatchObject({ exitCode: 0 });
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
        ready: true,
        modulePath: "provider-owned-module-path",
      });
    } finally {
      await owned.close(5_000);
    }
  },
  30_000,
);
