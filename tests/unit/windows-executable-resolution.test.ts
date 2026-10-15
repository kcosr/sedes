import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const scope = {
  tenantId: "native-executable-tenant",
  principalId: "native-executable-principal",
  backendInstanceId: "native-executable-backend",
  executionEnvironmentId: "native-executable-environment",
};
function providerFor(requestScope: typeof scope, environment: Record<string, string>) {
  return new LocalEnvironmentChannelProvider({
    scope: requestScope,
    executionEnvironmentId: requestScope.executionEnvironmentId,
    environment,
  });
}

it.skipIf(process.platform !== "win32")(
  "resolves native Windows executables without admitting package-manager shell wrappers",
  async () => {
    const wrappers = await mkdtemp(
      path.join(os.homedir(), ".sedes-executable-wrappers-"),
    );
    onTestFinished(() => rm(wrappers, { recursive: true, force: true }));
    await writeFile(path.join(wrappers, "node"), "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(wrappers, "node.cmd"), "@echo off\r\nexit /b 0\r\n");
    const provider = providerFor(scope, {
      PATH: [wrappers, path.dirname(process.execPath)].join(path.delimiter),
      PATHEXT: ".CMD;.EXE",
    });
    const expected = {
      kind: "executable",
      canonicalPath: await realpath(process.execPath),
    };
    await expect(
      provider.resolveOwnedProcessExecutable(scope, { commandName: "node" }),
    ).resolves.toEqual(expected);
    await expect(
      provider.resolveOwnedProcessExecutable(scope, { commandName: "node.exe" }),
    ).resolves.toEqual(expected);
    await expect(
      providerFor(scope, { PATH: wrappers }).resolveOwnedProcessExecutable(scope, { commandName: "node" }),
    ).rejects.toThrow("environment_channel_executable_unavailable");
    await expect(
      provider.resolveOwnedProcessExecutable(scope, {
        commandName: "node",
        configuredPath: path.join(wrappers, "missing.exe"),
      }),
    ).rejects.toThrow();
    await expect(
      provider.resolveOwnedProcessExecutable(
        { ...scope, principalId: "other" },
        { commandName: "node" },
      ),
    ).rejects.toThrow("execution_environment_channel_unavailable");
  },
);
