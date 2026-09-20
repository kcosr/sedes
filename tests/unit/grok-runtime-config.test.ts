import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GrokRuntimeVersionCache,
  grokRuntimePlatformSupported,
  resolveGrokWorkspaceRuntimeConfiguration,
} from "../../src/server/backends/grok/grok-runtime-config.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const scope = Object.freeze({ tenantId: "tenant", principalId: "principal" });
const executionEnvironmentId = "10000000-0000-4000-8000-000000000001";
const executablePath = fileURLToPath(
  new URL("../fixtures/grok/fake-grok-version.mjs", import.meta.url),
);
const hangingExecutablePath = fileURLToPath(
  new URL("../fixtures/grok/fake-grok-version-hang.mjs", import.meta.url),
);

describe("Grok workspace runtime configuration scaffold", () => {
  it("admits the reviewed native Linux and macOS runtime platforms only", () => {
    expect(grokRuntimePlatformSupported("linux", "x64")).toBe(true);
    expect(grokRuntimePlatformSupported("darwin", "arm64")).toBe(true);
    expect(grokRuntimePlatformSupported("darwin", "x64")).toBe(true);

    expect(grokRuntimePlatformSupported("linux", "arm64")).toBe(false);
    expect(grokRuntimePlatformSupported("win32", "x64")).toBe(false);
    expect(grokRuntimePlatformSupported("win32", "arm64")).toBe(false);
  });

  it("resolves exact environment scope and admits a compatible executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-grok-runtime-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: {
        PATH: process.env.PATH,
        HOME: "/home/operator",
        GROK_HOME: "/home/operator/.grok-custom",
        XAI_API_KEY: "must-not-leak",
        SEDES_ADMIN_TOKEN: "must-not-leak",
        GROK_PLUGIN_PATH: "/must/not/leak",
      },
    });
    const resolved = await resolveGrokWorkspaceRuntimeConfiguration({
      scope,
      backendInstanceId: "grok-primary",
      executionEnvironmentId,
      executablePath,
      canonicalWorkspace: workspace,
      startupEnvironmentVariables: { CUSTOM_START: { kind: "literal", value: "startup" }, REMOVED: { kind: "literal", value: "before" } },
      executionEnvironment: { CUSTOM_EXECUTION: "session", REMOVED: null },
      environmentChannel: channels,
      environment: {
        PATH: process.env.PATH,
        HOME: "/home/operator",
        GROK_HOME: "/home/operator/.grok-custom",
        XAI_API_KEY: "must-not-leak",
        SEDES_ADMIN_TOKEN: "must-not-leak",
        GROK_PLUGIN_PATH: "/must/not/leak",
      },
    });
    expect(resolved.executable).toMatchObject({
      path: executablePath,
      version: "1.0.4",
      build: "d846eb93d9",
      compatibilityRelease: "1.x",
      newerThanTested: false,
      assessment: {
        observedVersion: "1.0.4",
        minimumVersion: "1.0.4",
        testedThroughVersion: "1.0.4",
        newerThanTested: false,
      },
    });
    expect(resolved.workspace).toBe(workspace);
    expect(resolved.environment.HOME).toBe("/home/operator");
    expect(resolved.environment.GROK_HOME).toBe("/home/operator/.grok-custom");
    expect(resolved.environment.XAI_API_KEY).toBeUndefined();
    expect(resolved.environment.CUSTOM_START).toBe("startup");
    expect(resolved.environment.CUSTOM_EXECUTION).toBe("session");
    expect(resolved.environment).not.toHaveProperty("REMOVED");
  });

  it("resolves an omitted executable from the target environment PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-grok-path-"));
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await symlink(executablePath, path.join(bin, "grok"));
    const searchPath = [bin, path.dirname(process.execPath), process.env.PATH]
      .filter((entry): entry is string => entry !== undefined)
      .join(path.delimiter);
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: { PATH: searchPath },
    });

    const resolved = await resolveGrokWorkspaceRuntimeConfiguration({
      scope,
      backendInstanceId: "grok-primary",
      executionEnvironmentId,
      canonicalWorkspace: workspace,
      environmentChannel: channels,
      environment: { PATH: searchPath },
    });

    expect(resolved.executable.path).toBe(await realpath(executablePath));
    expect(resolved.process.executable.canonicalPath).toBe(
      await realpath(executablePath),
    );
  });

  it("rejects a channel from another principal before process preparation", async () => {
    const channels = new LocalEnvironmentChannelProvider({
      scope: { tenantId: "tenant", principalId: "other" },
      executionEnvironmentId,
    });
    await expect(
      resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId: "grok-primary",
        executionEnvironmentId,
        executablePath,
        canonicalWorkspace: "/tmp",
        environmentChannel: channels,
        environment: {},
      }),
    ).rejects.toThrow("grok_runtime_scope_invalid");
  });

  it("keeps the actively awaited probe deadline referenced and cleans up a hung child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-grok-timeout-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: { PATH: process.env.PATH },
    });
    const startedAt = Date.now();
    await expect(
      resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId: "grok-primary",
        executionEnvironmentId,
        executablePath: hangingExecutablePath,
        canonicalWorkspace: workspace,
        environmentChannel: channels,
        environment: { PATH: process.env.PATH },
        versionProbeTimeoutMilliseconds: 25,
      }),
    ).rejects.toThrow("grok_runtime_version_probe_timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("shares one successful version probe across workspace resolutions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-grok-cache-"));
    const firstWorkspace = path.join(root, "first");
    const secondWorkspace = path.join(root, "second");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: { PATH: process.env.PATH },
    });
    const versionCache = new GrokRuntimeVersionCache();
    const open = async (canonicalWorkspace: string) =>
      await resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId: "grok-primary",
        executionEnvironmentId,
        executablePath,
        canonicalWorkspace,
        environmentChannel: channels,
        environment: { PATH: process.env.PATH },
        versionCache,
      });
    const [first, second] = await Promise.all([
      open(firstWorkspace),
      open(secondWorkspace),
    ]);
    expect(first.executable).toBe(second.executable);
  });

  it("reprobes when an executable is replaced in place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-grok-replace-"));
    const firstWorkspace = path.join(root, "first");
    const secondWorkspace = path.join(root, "second");
    const replacement = path.join(root, "grok");
    await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
    await writeVersionExecutable(replacement, "1.0.4", "d846eb93d9");
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: { PATH: process.env.PATH },
    });
    const versionCache = new GrokRuntimeVersionCache();
    const open = async (canonicalWorkspace: string) =>
      await resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId: "grok-primary",
        executionEnvironmentId,
        executablePath: replacement,
        canonicalWorkspace,
        environmentChannel: channels,
        environment: { PATH: process.env.PATH },
        versionCache,
      });
    const first = await open(firstWorkspace);
    await writeVersionExecutable(replacement, "1.3.0", "abcdef123456");
    const second = await open(secondWorkspace);
    expect(second.executable).not.toBe(first.executable);
    expect(second.executable).toMatchObject({
      version: "1.3.0",
      build: "abcdef123456",
      newerThanTested: true,
      assessment: {
        observedVersion: "1.3.0",
        minimumVersion: "1.0.4",
        testedThroughVersion: "1.0.4",
        newerThanTested: true,
      },
    });
    await writeVersionExecutable(replacement, "1.0.3", "abcdef123456");
    await expect(open(secondWorkspace)).rejects.toThrow(
      "grok_runtime_version_incompatible",
    );
  });
});

async function writeVersionExecutable(
  executable: string,
  version: string,
  build: string,
): Promise<void> {
  await writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ currentVersion: ${JSON.stringify(`${version} (${build})`)} }) + "\\n");\n`,
  );
  await chmod(executable, 0o755);
}
