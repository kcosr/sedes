import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { opencodeHttpUrlSchema, opencodeModuleConfigurationSchema } from "../../src/shared/protocol/opencode-configuration.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { parseOpenCodeBackendConfiguration } from "../../src/server/backends/opencode/opencode-backend-configuration.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { configurationIdentities, runtimeConfigurationFingerprint } from "../../src/server/configuration-admin/configuration-identities.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { backendLifecycleActions } from "../../src/server/configuration-admin/configuration-backend-lifecycle.js";
import { parseBackendConfiguration } from "../../src/server/config/backend-configuration.js";
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
  it.each(["owned", "external"])("validates the checked-in %s module configuration example", ownership => {
    const value = JSON.parse(readFileSync(new URL(`../../config/opencode-${ownership}.example.json`, import.meta.url), "utf8"));
    expect(opencodeModuleConfigurationSchema.parse(value).connection.ownership).toBe(ownership);
  });
  it.each(["ssh-owned", "ssh-external", "outbound-owned", "outbound-external"])("validates the strict remote Settings example %s", name => {
    const value = JSON.parse(readFileSync(new URL(`../../config/opencode-${name}.example.json`, import.meta.url), "utf8"));
    expect(validateConfigurationDocument(value)).toEqual(value);
  });
  it.each([false, true])("rejects restrictive model policy before runtime admission, external=%s", external => {
    const policies: ConfigurationDocument["backends"][number]["modelPolicy"][] = [
      { type: "allowlist", allowed: [{ modelIds: ["model"] }] },
      { type: "denylist", denied: [{ reasoningEfforts: ["high"] }] }];
    for (const modelPolicy of policies) {
      const document = configuration(external);
      document.backends[0]!.modelPolicy = structuredClone(modelPolicy);
      expect(() => validateConfigurationDocument(document)).toThrow(/configuration or target defaults are invalid/u);
      expect(() => parseOpenCodeBackendConfiguration({ backend: { ...document.backends[0]!, protocolRelease: "2.0.18" },
        connections: document.targets, executionEnvironments: document.executionEnvironments, environment: {} })).toThrow(/restrictive_model_policy/u);
    }
  });
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

  it.each([false, true])("preserves omitted native path overrides without resolving host defaults, external=%s", external => {
    const document = configuration(external), backend = document.backends[0]!;
    if (backend.kind !== "opencode") throw new Error();
    const value = { connection: external ? backend.moduleConfiguration.connection : { ownership: "owned", channel: { type: "process_stdio" } } };
    backend.moduleConfiguration = opencodeModuleConfigurationSchema.parse(value);
    expect(backend.moduleConfiguration).toEqual(value);
    expect(configurationIdentities(document).find(identity => identity.kind === "backend")?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeConfigurationFingerprint(document, "backend", backend.id)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects aliases, embedded passwords, and invalid explicit path overrides", () => {
    const owned = configuration().backends[0]!;
    if (owned.kind !== "opencode" || owned.moduleConfiguration.connection.ownership !== "owned") throw new Error();
    const module = owned.moduleConfiguration;
    for (const nativeStorePath of ["", "relative.db", "/native/../other.db", "/native//db", "/native/db/", "/"]) {
      expect(opencodeModuleConfigurationSchema.safeParse({ ...module, nativeStorePath }).success).toBe(false);
    }
    for (const field of ["executablePath", "workingDirectory"] as const) {
      for (const path of ["", "relative", "/path/../other", "/path//other"]) {
        expect(opencodeModuleConfigurationSchema.safeParse({ connection: { ownership: "owned", channel: { type: "process_stdio", [field]: path } } }).success).toBe(false);
      }
    }
    expect(opencodeModuleConfigurationSchema.safeParse({ configDirectory: "", connection: { ownership: "owned", channel: { type: "process_stdio" } } }).success).toBe(false);
    expect(opencodeModuleConfigurationSchema.safeParse({ ...module, databasePath: module.nativeStorePath }).success).toBe(false);
    const external = configuration(true).backends[0]!;
    if (external.kind !== "opencode" || external.moduleConfiguration.connection.ownership !== "external") throw new Error();
    expect(opencodeModuleConfigurationSchema.safeParse({ ...external.moduleConfiguration,
      connection: { ...external.moduleConfiguration.connection, channel: { ...external.moduleConfiguration.connection.channel, password: "never-store-me" } } }).success).toBe(false);
  });

  it("rejects startup overrides for an external server", () => {
    const external = configuration(true);
    external.backends[0]!.environmentVariables = { execution: {}, startup: { TEST: { kind: "literal", value: "value" } } };
    expect(() => validateConfigurationDocument(external)).toThrow(/cannot receive Sedes startup or execution variables/u);
  });

  it.each(["backend", "environment"])("rejects execution overrides for an external server from %s defaults", source => {
    const document = configuration(true);
    const variables = { startup: {}, execution: { TEST: { kind: "literal" as const, value: "value" } } };
    if (source === "backend") document.backends[0]!.environmentVariables = variables;
    else document.executionEnvironments[0]!.environmentVariables = variables;
    expect(() => validateConfigurationDocument(document)).toThrow(/cannot receive Sedes startup or execution variables/u);
    expect(() => parseOpenCodeBackendConfiguration({ backend: { ...document.backends[0]!, protocolRelease: "2.0.18" },
      connections: document.targets, executionEnvironments: document.executionEnvironments, environment: {} })).toThrow(/opencode_external_environment_unsupported/u);
  });


  it.each([false, true].flatMap(external => ["ssh", "outbound"].map(kind => ({ external, kind }))))("admits $kind external=$external with host-relative paths", ({ external, kind }) => {
    const document = configuration(external);
    const backend = document.backends[0]!;
    if (backend.kind === "opencode" && backend.moduleConfiguration.connection.ownership === "external") {
      backend.moduleConfiguration.connection.channel.authentication.secret = { source: "protected_file", path: "/host-only/opencode-password" };
    }
    document.executionEnvironments = [{ id: environmentId, label: "Remote", workspaceRoots: ["/workspace"], operations: { kind: "none" },
      ...(kind === "ssh" ? { kind: "ssh", hostAlias: "execution-host" } : { kind: "outbound", platform: "linux", pairingId: "20000000-0000-4000-8000-000000000001" }) }];
    expect(validateConfigurationDocument(document)).toEqual(document);
    if (kind === "ssh") {
      const legacy = parseBackendConfiguration({ schemaVersion: 10,
        executionEnvironments: [{ id: "30000000-0000-4000-8000-000000000001", kind: "local", label: "Main" },
          ...document.executionEnvironments.map(environment => ({ ...environment, operations: { kind: "none" } }))],
        backends: document.backends, targets: document.targets, defaultTargetId: document.defaultTargetId });
      expect(legacy.targets[0]?.executionEnvironmentId).toBe(environmentId);
    }
  });

  it.each(["ssh", "outbound"] as const)("rejects unavailable environment-backed passwords on %s hosts before native admission", kind => {
    const document = configuration(true);
    document.executionEnvironments = [{ id: environmentId, label: "Remote", workspaceRoots: ["/workspace"], operations: { kind: "none" },
      ...(kind === "ssh" ? { kind: "ssh", hostAlias: "execution-host" } : { kind: "outbound", platform: "linux", pairingId: "20000000-0000-4000-8000-000000000001" }) }];
    expect(() => validateConfigurationDocument(document)).toThrow("owner-protected password file on the execution host");
    expect(() => parseOpenCodeBackendConfiguration({ backend: { ...document.backends[0]!, protocolRelease: "2.0.18" },
      connections: document.targets, executionEnvironments: document.executionEnvironments, environment: {} })).toThrow("opencode_remote_password_file_required");
  });

  it.each(["darwin", "win32"] as const)("rejects enabled OpenCode on known outbound %s hosts", platform => {
    const document = configuration();
    document.executionEnvironments = [{ id: environmentId, kind: "outbound", platform, label: "Remote",
      pairingId: "20000000-0000-4000-8000-000000000001", workspaceRoots: ["/workspace"], operations: { kind: "none" } }];
    expect(() => validateConfigurationDocument(document)).toThrow("OpenCode requires a Linux execution host");
  });

  it.each([false, true])("preserves remote external variable limits and accepts owned host variables, external=%s", external => {
    const document = configuration(external);
    document.executionEnvironments = [{ id: environmentId, kind: "ssh", hostAlias: "execution-host", label: "Remote", workspaceRoots: ["/workspace"], operations: { kind: "none" },
      environmentVariables: { startup: { HOST_BOOT: { kind: "literal", value: "configured" } }, execution: { HOST_SECRET: { kind: "secret", source: { kind: "protected_file", path: "/host-only/secret" } } } } }];
    if (external) expect(() => validateConfigurationDocument(document)).toThrow("cannot receive Sedes startup or execution variables");
    else expect(validateConfigurationDocument(document)).toEqual(document);
  });

  it.each([false, true])("exposes the complete remote lifecycle and disabled cleanup, external=%s", external => {
    const backend = configuration(external).backends[0]!;
    expect(backendLifecycleActions(backend, true)).toEqual(external ? ["connect", "disconnect", "stop"] : ["connect", "disconnect", "start", "stop", "restart"]);
    backend.enabled = false;
    expect(backendLifecycleActions(backend, true)).toEqual(["disconnect", "stop"]);
    expect(backendLifecycleActions(backend, false)).toEqual(external ? ["disconnect"] : ["stop"]);
  });

  it("reserves an existing backend's execution host independently of its native path", () => {
    const document = configuration(), before = configurationIdentities(document).find(entry => entry.kind === "backend");
    const remoteId = "20000000-0000-4000-8000-000000000001";
    document.executionEnvironments.push({ id: remoteId, kind: "ssh", hostAlias: "execution-host", label: "Remote", workspaceRoots: ["/workspace"], operations: { kind: "none" } });
    document.targets[0]!.executionEnvironmentId = remoteId;
    expect(configurationIdentities(document).find(entry => entry.kind === "backend")).not.toEqual(before);
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

  it("exposes ownership-appropriate lifecycle actions through the production catalog", () => {
    expect(backendLifecycleActions(configuration(true).backends[0], false)).toEqual(["connect", "disconnect"]);
    expect(backendLifecycleActions(configuration().backends[0], false)).toEqual(["connect", "start", "stop", "restart"]);
    expect(compiledBackendModuleCatalog.moduleForBackendKind("opencode")).toBeDefined();
    for (const kind of ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"] as const) {
      expect(compiledBackendModuleCatalog.moduleForBackendKind(kind)).toBeDefined();
      expect(backendLifecycleActions(backendEditors[kind].createBackend(kind), false)).toEqual(["connect", "start", "stop", "restart"]);
    }
  });
});
