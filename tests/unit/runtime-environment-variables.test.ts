import { codexEnvironmentFingerprintInput } from "../../src/server/backends/codex/runtime/codex-runtime-environment-fingerprint.js";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadEnvironmentResolver, mergeResolvedEnvironment, resolveEnvironmentVariables } from "../../src/server/environment-variables/runtime-environment.js";
import type { BackendModuleRuntimeContext } from "../../src/server/backends/module.js";
import { environmentVariablesResolveOperation } from "../../src/internal/sidecar-protocol/environment-variables-v1.js";
import { withCodexAgentToolCliEnvironment, withCodexExecutionEnvironment } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("execution host environment variables", () => {
  it("resolves literal, empty, missing, and unset bindings without changing host state", async () => {
    const host = Object.freeze({ API_SECRET: "host-secret", DROP: "inherited" });
    const resolved = await resolveEnvironmentVariables({ EMPTY: { kind: "literal", value: "" }, API_KEY: { kind: "secret", source: { kind: "environment", name: "API_SECRET" } }, DROP: { kind: "unset" } }, host);
    expect(resolved).toEqual({ EMPTY: "", API_KEY: "host-secret", DROP: null });
    expect(mergeResolvedEnvironment(host, resolved)).toEqual({ API_SECRET: "host-secret", EMPTY: "", API_KEY: "host-secret" });
    expect(host.DROP).toBe("inherited");
    await expect(resolveEnvironmentVariables({ API_KEY: { kind: "secret", source: { kind: "environment", name: "MISSING" } } }, host)).rejects.toThrow("environment_variable_secret_unavailable");
    expect(mergeResolvedEnvironment({ Path: "old" }, { PATH: null }, "win32")).toEqual({});
  });

  it("protects identity and source authority even when referenced under an ordinary name", async () => {
    await expect(resolveEnvironmentVariables({ ALIAS: { kind: "secret", source: { kind: "environment", name: "SEDES_AGENT_TOOL_SOURCE_CAPABILITY" } } })).rejects.toThrow();
    await expect(resolveEnvironmentVariables({ CLAUDE_CONFIG_DIR: { kind: "literal", value: "/other-account" } })).rejects.toThrow();
    await expect(resolveEnvironmentVariables({ API_KEY: { kind: "secret", source: { kind: "environment", name: "KEY" } } }, { KEY: "bad\0value" })).rejects.toThrow("environment_variable_value_invalid");
  });

  it("loads private owner files, removes one terminal newline, and rejects public files and symlinks", async () => {
    const directory = await mkdtemp(path.join(homedir(), ".sedes-env-test-")); directories.push(directory);
    const filename = path.join(directory, "key");
    await writeFile(filename, "  secret\nvalue  \n", { mode: 0o600 });
    const binding = { KEY: { kind: "secret" as const, source: { kind: "protected_file" as const, path: filename } } };
    expect(await resolveEnvironmentVariables(binding)).toEqual({ KEY: "  secret\nvalue  " });
    await chmod(filename, 0o644);
    await expect(resolveEnvironmentVariables(binding)).rejects.toThrow("environment_variable_secret_file_unavailable");
    await chmod(filename, 0o600);
    const link = path.join(directory, "link"); await symlink(filename, link);
    await expect(resolveEnvironmentVariables({ KEY: { kind: "secret", source: { kind: "protected_file", path: link } } })).rejects.toThrow("environment_variable_secret_file_unavailable");
  });

  it("resolves remote refs only through the admitted host and releases failed leases", async () => {
    const overrides = { TOKEN: { kind: "secret" as const, source: { kind: "environment" as const, name: "PROVIDER_TOKEN" } } };
    const release = vi.fn();
    const call = vi.fn().mockResolvedValue({ values: { TOKEN: "remote-value" } });
    const resolver = createThreadEnvironmentResolver({ executionEnvironmentVariables: (id: string) => { expect(id).toBe("thread-one"); return overrides; }, environmentOperations: { environmentKind: "ssh" }, sidecarRuntime: { acquire: async () => ({ release, channel: { supportsOperation: () => true, call } }) } } as unknown as BackendModuleRuntimeContext);
    expect(await resolver("thread-one")).toEqual({ TOKEN: "remote-value" });
    expect(call).toHaveBeenCalledWith(environmentVariablesResolveOperation, { overrides });
    expect(release).toHaveBeenCalledOnce();
    call.mockRejectedValueOnce(new Error("host-disconnected"));
    await expect(resolver("thread-one")).rejects.toThrow("host-disconnected");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("injects Codex variables without CLI tools and removes inherited values explicitly", () => {
    const config = withCodexAgentToolCliEnvironment(withCodexExecutionEnvironment({ shell_environment_policy: { set: { KEEP: "before", DROP: "before" }, exclude: ["OLD"] } }, { KEEP: "after", DROP: null, EMPTY: "" }), { resolution: { availability: "unavailable", reason: "cli_unavailable" }, applicationThreadId: "thread-one" });
    expect(config.shell_environment_policy).toMatchObject({ set: { KEEP: "after", EMPTY: "" }, exclude: expect.arrayContaining(["OLD", "KEEP", "DROP", "EMPTY"]) });
    expect((config.shell_environment_policy as { set: object }).set).not.toHaveProperty("DROP");
  });
});

it("bounds aggregate resolved secret bytes on local hosts", async () => {
  const source = { kind: "environment" as const, name: "PROVIDER_SECRET" };
  await expect(resolveEnvironmentVariables({ FIRST: { kind: "secret", source }, SECOND: { kind: "secret", source }, THIRD: { kind: "secret", source } }, { PROVIDER_SECRET: "x".repeat(16_000) })).rejects.toThrow("environment_variable_value_limits_exceeded");
});

it("keeps resolved values and generated authority out of Codex idempotency fingerprints", () => {
  const params = { config: { shell_environment_policy: { set: { SECRET: "resolved-secret", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "generated-secret", PATH: "/private/path" }, exclude: ["DROP"] }, model: "model" } };
  const projection = codexEnvironmentFingerprintInput("thread/start", params, "a".repeat(64));
  expect(JSON.stringify(projection)).not.toContain("resolved-secret");
  expect(JSON.stringify(projection)).not.toContain("generated-secret");
  expect(JSON.stringify(projection)).not.toContain("/private/path");
  expect(projection).toMatchObject({ config: { shell_environment_policy: { set: { names: ["PATH", "SECRET", "SEDES_AGENT_TOOL_SOURCE_CAPABILITY"], definitionsFingerprint: "a".repeat(64) }, exclude: ["DROP"] }, model: "model" } });
  expect(params.config.shell_environment_policy.set.SECRET).toBe("resolved-secret");
});
