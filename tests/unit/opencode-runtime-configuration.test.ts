import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { admitOpenCodeRuntimeConfiguration, resolveOpenCodeRuntimeInput, type OpenCodeRuntimeConfiguration } from "../../src/server/backends/opencode/opencode-runtime-configuration.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";

const scope = { tenantId: "tenant", principalId: "principal" }, executionEnvironmentId = "host";
const configuration: OpenCodeRuntimeConfiguration = {
  instance: { id: "backend", tenantId: scope.tenantId, kind: "opencode", label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" },
  connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "opencode_http", backendInstanceId: "backend", executionEnvironmentId, label: "OpenCode", enabled: true, configurationRevision: 1 }],
  nativeStorePath: "/host/opencode.db", configDirectory: "/host/config",
  connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/host/bin/opencode2", workingDirectory: "/host/workspace" } },
};
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function input(config = configuration) {
  const discard = vi.fn(), resolveSecret = vi.fn(async () => ({ value: "execution-host-password", discard }));
  const environmentChannel = { scope, executionEnvironmentId, resolveSecret } as unknown as ExecutionEnvironmentChannelProvider;
  return { configuration: config, scope, executionEnvironmentId, hostIncarnation: "host-incarnation", environmentChannel,
    environment: { HOST_VALUE: "host-value", KEEP: "frozen", REMOVE: "remove" }, resolveSecret, discard };
}

describe("OpenCode execution-host configuration", () => {
  it("resolves startup definitions against a copied host baseline and protected host file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-oc-config-")); directories.push(directory);
    const filename = path.join(directory, "secret"); await writeFile(filename, "host-file-value\n", { mode: 0o600 });
    vi.stubEnv("HOST_VALUE", "main-process-value");
    const f = input({ ...configuration, startupEnvironmentVariables: {
      FROM_ENV: { kind: "secret", source: { kind: "environment", name: "HOST_VALUE" } },
      FROM_FILE: { kind: "secret", source: { kind: "protected_file", path: filename } },
      LITERAL: { kind: "literal", value: "literal" }, REMOVE: { kind: "unset" },
    } });
    const pending = resolveOpenCodeRuntimeInput(f); f.environment.HOST_VALUE = "changed-after-call";
    const result = await pending;
    expect(result.environment).toEqual({ HOST_VALUE: "host-value", KEEP: "frozen", FROM_ENV: "host-value", FROM_FILE: "host-file-value", LITERAL: "literal" });
    expect(result.nativeStorePath).toBe("/host/opencode.db"); expect(result.hostIncarnation).toBe("host-incarnation");
    expect(f.resolveSecret).not.toHaveBeenCalled();
  });

  it("defers external credentials to the exact execution channel and discards its handles", async () => {
    const secret = { source: "environment" as const, variable: "SEDES_OPENCODE_SERVER_PASSWORD" };
    const f = input({ ...configuration, connection: { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096",
      authentication: { type: "basic", username: "opencode", secret } } } });
    const result = await resolveOpenCodeRuntimeInput(f);
    expect(f.resolveSecret).not.toHaveBeenCalled();
    expect(result.connection).toEqual({ ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096" } });
    expect(JSON.stringify(result)).not.toContain("execution-host-password");
    await expect(result.externalPassword!()).resolves.toBe("execution-host-password");
    expect(f.resolveSecret).toHaveBeenCalledWith({ ...scope, backendInstanceId: "backend", executionEnvironmentId }, secret, 1, expect.any(AbortSignal), "http_basic_password");
    await result.externalPassword!(); expect(f.discard).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign authority and duplicate profiles before resolving host secrets", async () => {
    for (const changed of [
      { ...configuration, instance: { ...configuration.instance, tenantId: "other" } },
      { ...configuration, connections: [{ ...configuration.connections[0]!, ownerPrincipalId: "other" }] },
      { ...configuration, connections: [{ ...configuration.connections[0]!, executionEnvironmentId: "other" }] },
      { ...configuration, connections: [configuration.connections[0]!, configuration.connections[0]!] },
    ]) {
      const f = input(changed); await expect(resolveOpenCodeRuntimeInput(f)).rejects.toThrow("scope_denied");
      expect(f.resolveSecret).not.toHaveBeenCalled();
    }
    const f = input();
    await expect(resolveOpenCodeRuntimeInput({ ...f, environmentChannel: { ...f.environmentChannel, scope: { ...scope, principalId: "other" } } })).rejects.toThrow("scope_denied");
  });

  it("rejects noncanonical host paths, unknown fields and external variable injection", () => {
    for (const nativeStorePath of ["relative", "C:\\native.db", "/host/../native.db"]) {
      expect(() => admitOpenCodeRuntimeConfiguration({ ...configuration, nativeStorePath }, scope, executionEnvironmentId)).toThrow("configuration_invalid");
    }
    expect(() => admitOpenCodeRuntimeConfiguration({ ...configuration, password: "inline" }, scope, executionEnvironmentId)).toThrow("configuration_invalid");
    expect(() => admitOpenCodeRuntimeConfiguration({ ...configuration,
      startupEnvironmentVariables: { VALUE: { kind: "secret", source: { kind: "protected_file", path: "/missing/secret" } } },
      connection: { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096",
        authentication: { type: "basic", username: "opencode", secret: { source: "protected_file", path: "/missing/password" } } } },
    }, scope, executionEnvironmentId)).toThrow("external_environment_unsupported");
  });
});
