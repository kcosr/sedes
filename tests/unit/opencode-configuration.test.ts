import { describe, expect, it } from "vitest";
import { opencodeHttpUrlSchema, opencodeModuleConfigurationSchema } from "../../src/shared/protocol/opencode-configuration.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { parseOpenCodeBackendConfiguration } from "../../src/server/backends/opencode/opencode-backend-configuration.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { configurationIdentities, runtimeConfigurationFingerprint } from "../../src/server/configuration-admin/configuration-identities.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { backendLifecycleActions } from "../../src/server/configuration-admin/configuration-backend-lifecycle.js";
import { backendEditors } from "../../src/client/components/execution-settings/backend-editors.js";

const environmentId = "10000000-0000-4000-8000-000000000001";
function configuration(external = false): ConfigurationDocument {
  return { executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: ["/workspace"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: [{ id: "opencode-v2", kind: "opencode", label: "OpenCode v2", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      nativeStorePath: "/native/opencode.db", connection: external
        ? { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode", secret: { source: "environment", variable: "SEDES_OPENCODE_PRIMARY_PASSWORD" } } } }
        : { ownership: "owned", channel: { type: "process_stdio", executablePath: "/opt/bin/opencode2", workingDirectory: "/workspace" } },
    } }],
    targets: [{ id: "opencode-target", kind: "opencode_http", label: "OpenCode", backendInstanceId: "opencode-v2", executionEnvironmentId: environmentId, enabled: true,
      moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } } } }],
    defaultTargetId: "opencode-target", webSearch: null };
}

describe("OpenCode v2 operator configuration", () => {
  it.each([false, true])("validates the closed configuration with external=%s", external => {
    const value = validateConfigurationDocument(configuration(external));
    const backend = value.backends[0]!;
    const parsed = parseOpenCodeBackendConfiguration({ backend: { ...backend, protocolRelease: "2.0.18" },
      connections: value.targets, executionEnvironments: value.executionEnvironments, environment: {} });
    expect(parsed.connection.ownership).toBe(external ? "external" : "owned");
    expect(parsed.defaultsByConnectionId.get("opencode-target")).toEqual({ model: { type: "catalogDefault" }, variant: { type: "modelDefault" } });
  });

  it.each(["http://127.0.0.1:4096", "http://127.2.3.4:1/", "http://[::1]:65535"])("accepts explicit loopback endpoint %s", url => {
    expect(opencodeHttpUrlSchema.safeParse(url).success).toBe(true);
  });
  it.each(["http://localhost:4096", "http://127.0.0.1", "https://127.0.0.1:4096", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:4096/api", "http://127.0.0.1:4096?x=1", "http://127.0.0.1:4096#part", "http://user:secret@127.0.0.1:4096", "http://127.00.0.1:4096", "http://127.0.0.256:4096", "http://192.168.1.1:4096", "http://[::ffff:127.0.0.1]:4096"])("rejects unqualified endpoint %s", url => {
    expect(opencodeHttpUrlSchema.safeParse(url).success).toBe(false);
  });

  it("rejects an implicit executable, aliases, embedded passwords, and noncanonical stores", () => {
    const owned = configuration().backends[0]!;
    if (owned.kind !== "opencode" || owned.moduleConfiguration.connection.ownership !== "owned") throw new Error();
    const module = owned.moduleConfiguration;
    for (const nativeStorePath of ["relative.db", "/native/../other.db", "/native//db", "/native/db/", "/"]) {
      expect(opencodeModuleConfigurationSchema.safeParse({ ...module, nativeStorePath }).success).toBe(false);
    }
    expect(opencodeModuleConfigurationSchema.safeParse({ ...module, connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "/workspace" } } }).success).toBe(false);
    expect(opencodeModuleConfigurationSchema.safeParse({ ...module, databasePath: module.nativeStorePath }).success).toBe(false);
    const external = configuration(true).backends[0]!;
    if (external.kind !== "opencode" || external.moduleConfiguration.connection.ownership !== "external") throw new Error();
    expect(opencodeModuleConfigurationSchema.safeParse({ ...external.moduleConfiguration,
      connection: { ...external.moduleConfiguration.connection, channel: { ...external.moduleConfiguration.connection.channel, password: "never-store-me" } } }).success).toBe(false);
  });

  it("rejects startup overrides for an external server and every remote environment", () => {
    const external = configuration(true);
    external.backends[0]!.environmentVariables = { execution: {}, startup: { TEST: { kind: "literal", value: "value" } } };
    expect(() => validateConfigurationDocument(external)).toThrow(/Startup variables/u);
    const remote = { ...configuration(), executionEnvironments: [{ id: environmentId, kind: "ssh", label: "Remote", hostAlias: "host", workspaceRoots: ["/workspace"], operations: { kind: "none" } }] };
    expect(() => validateConfigurationDocument(remote)).toThrow();
  });

  it("reserves native store identity separately from mutable transport settings", () => {
    const value = configuration(true);
    const backend = value.backends[0]!;
    if (backend.kind !== "opencode" || backend.moduleConfiguration.connection.ownership !== "external") throw new Error();
    const before = configurationIdentities(value).find(entry => entry.kind === "backend");
    const runtimeBefore = runtimeConfigurationFingerprint(value, "backend", backend.id);
    backend.moduleConfiguration.connection.channel.url = "http://127.0.0.1:4097";
    expect(configurationIdentities(value).find(entry => entry.kind === "backend")).toEqual(before);
    expect(runtimeConfigurationFingerprint(value, "backend", backend.id)).not.toEqual(runtimeBefore);
    backend.moduleConfiguration.nativeStorePath = "/native/different.db";
    expect(configurationIdentities(value).find(entry => entry.kind === "backend")).not.toEqual(before);
  });

  it("exposes ownership-appropriate lifecycle actions and leaves production registration gated", () => {
    expect(backendLifecycleActions(configuration(true).backends[0], false)).toEqual(["connect", "disconnect"]);
    expect(backendLifecycleActions(configuration().backends[0], false)).toEqual(["connect", "start", "stop", "restart"]);
    expect(compiledBackendModuleCatalog.moduleForBackendKind("opencode")).toBeUndefined();
    for (const kind of ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"] as const) {
      expect(compiledBackendModuleCatalog.moduleForBackendKind(kind)).toBeDefined();
      expect(backendLifecycleActions(backendEditors[kind].createBackend(kind), false)).toEqual(["connect", "start", "stop", "restart"]);
    }
  });
});
