import { describe, expect, it } from "vitest";
import { configurationDocumentSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { piNativeModuleConfigurationSchema, piNativeConnectionConfigurationSchema, piNativeConnectionDefaultsSchema } from "../../src/shared/protocol/pi-configuration.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { backendLifecycleActions } from "../../src/server/configuration-admin/configuration-backend-lifecycle.js";
import { backendEditors, allowedEnvironments } from "../../src/client/components/execution-settings/backend-editors.js";
import { BACKEND_BRANDS } from "../../src/server/backends/contracts.js";
import { agentToolPresentationPermitsAdapter, nativeAgentToolAdapter } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { presentationOptionsForBackend } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { parsePiNativeBackendConfiguration } from "../../src/server/backends/pi/native/pi-native-backend-configuration.js";

const environmentId = "10000000-0000-4000-8000-000000000001";
function configuration(): ConfigurationDocument {
  return {
    executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: ["/workspace"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: [{ ...backendEditors.pi_native.createBackend("native-pi"), label: "Pi" }, { ...backendEditors.pi.createBackend("sdk-pi"), label: "Pi SDK" }],
    targets: [backendEditors.pi_native.createTarget("native-target", "native-pi", environmentId), backendEditors.pi.createTarget("sdk-target", "sdk-pi", environmentId)],
    defaultTargetId: "native-target", webSearch: null,
  };
}

describe("native Pi administration", () => {
  it("keeps native Pi and Pi SDK distinct while sharing the Pi brand", () => {
    const document = validateConfigurationDocument(configuration());
    expect(document.backends.map(backend => backend.kind)).toEqual(["pi_native", "pi"]);
    expect(document.targets.map(target => target.kind)).toEqual(["pi_rpc", "pi_sdk"]);
    expect(backendEditors.pi_native.label).toBe("Pi");
    expect(backendEditors.pi.label).toBe("Pi SDK");
    expect(BACKEND_BRANDS.pi_native).toBe("pi");
    expect(BACKEND_BRANDS.pi).toBe("pi");
  });

  it("uses a distinct native agent-tool adapter and admits CLI presentation on every topology", () => {
    expect(nativeAgentToolAdapter("pi_native")).toBe("pi_rpc");
    expect(nativeAgentToolAdapter("pi")).toBe("pi_sdk");
    expect(agentToolPresentationPermitsAdapter({ surface: "native", mode: "individual" }, "pi_native", "pi_rpc")).toBe(true);
    expect(agentToolPresentationPermitsAdapter({ surface: "native", mode: "individual" }, "pi_native", "pi_sdk")).toBe(false);
    expect(agentToolPresentationPermitsAdapter({ surface: "native", mode: "individual" }, "pi", "pi_rpc")).toBe(false);
    for (const environment of ["local", "ssh", "outbound"] as const) {
      expect(presentationOptionsForBackend("pi_native", environment)).toEqual([
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ]);
    }
  });

  it("leaves native store and executable resolution on the execution host", () => {
    expect(piNativeModuleConfigurationSchema.parse({})).toEqual({ initializationTimeoutMs: 30_000, projectTrusted: false });
    expect(piNativeConnectionConfigurationSchema.parse({})).toEqual({ defaults: {} });
    const document = configuration();
    const native = document.backends[0]!;
    if (native.kind !== "pi_native") throw new Error("fixture kind");
    native.moduleConfiguration.agentDirectory = "/home/operator/.pi/agent";
    native.moduleConfiguration.sessionDirectory = "/home/operator/.pi/agent/sessions";
    native.moduleConfiguration.projectTrusted = true;
    expect(validateConfigurationDocument(document)).toEqual(document);
  });

  it.each(["ssh", "outbound"] as const)("admits native Pi on %s without the SDK workspace capability bundle", kind => {
    const document = configuration();
    document.backends = document.backends.filter(backend => backend.kind === "pi_native");
    document.targets = document.targets.filter(target => target.kind === "pi_rpc");
    document.executionEnvironments = [{ id: environmentId, label: "Remote", workspaceRoots: ["/workspace"], connectionCompression: true, operations: { kind: "none" },
      ...(kind === "ssh" ? { kind, hostAlias: "build" } : { kind, platform: "linux", pairingId: "20000000-0000-4000-8000-000000000001" }) }];
    expect(validateConfigurationDocument(document)).toEqual(document);
    expect(allowedEnvironments(document.backends[0]!, document.executionEnvironments)).toEqual(document.executionEnvironments);
    expect(backendLifecycleActions(document.backends[0], true)).toEqual(["connect", "disconnect", "start", "stop", "restart"]);
    document.targets[0]!.backendInstanceId = "sdk-pi";
    document.backends = [{ ...backendEditors.pi.createBackend("sdk-pi"), label: "SDK" }];
    document.targets[0] = backendEditors.pi.createTarget("native-target", "sdk-pi", environmentId);
    expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects native/SDK target swaps and unknown settings", () => {
    const document = configuration();
    document.targets[0]!.backendInstanceId = "sdk-pi";
    expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
    for (const value of [{ rpcUrl: "http://localhost" }, { apiKey: "secret" }, { piSdk: true }]) {
      expect(piNativeModuleConfigurationSchema.safeParse(value).success).toBe(false);
    }
    expect(piNativeConnectionConfigurationSchema.safeParse({ defaults: {}, provider: "test" }).success).toBe(false);
  });

  it("does not admit active native Pi on Windows outbound hosts", () => {
    const document = configuration();
    document.backends = document.backends.filter(backend => backend.kind === "pi_native");
    document.targets = document.targets.filter(target => target.kind === "pi_rpc");
    document.executionEnvironments = [{ id: environmentId, label: "Windows", kind: "outbound", platform: "win32", pairingId: "20000000-0000-4000-8000-000000000001", workspaceRoots: ["C:\\workspace"], connectionCompression: true, operations: { kind: "none" } }];
    expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
    expect(allowedEnvironments(document.backends[0]!, document.executionEnvironments)).toEqual([]);
    document.backends[0]!.enabled = false;
    document.targets[0]!.enabled = false;
    document.defaultTargetId = null;
    expect(configurationDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("keeps the configured environment and startup variables when every native target is disabled", () => {
    const document = configuration();
    document.targets[0]!.enabled = false;
    document.defaultTargetId = null;
    document.executionEnvironments[0]!.environmentVariables = { execution: {}, startup: { PI_ENV: { kind: "literal", value: "from-host" } } };
    expect(validateConfigurationDocument(document)).toEqual(document);
    const prepared = parsePiNativeBackendConfiguration({
      backend: { ...document.backends[0]!, protocolRelease: "1.4.0" },
      connections: document.targets.filter(target => target.kind === "pi_rpc"),
      executionEnvironments: document.executionEnvironments, environment: {},
    });
    expect(prepared.executionEnvironmentId).toBe(environmentId);
    expect(prepared.environmentKind).toBe("local");
    expect(prepared.startupEnvironmentVariables).toEqual({ PI_ENV: { kind: "literal", value: "from-host" } });
  });

  it("rejects duplicate, mixed-environment, and incompatible connections during direct preparation", () => {
    const document = configuration();
    const input = { backend: { ...document.backends[0]!, protocolRelease: "1.4.0" },
      connections: [document.targets[0]!], executionEnvironments: document.executionEnvironments, environment: {} };
    expect(() => parsePiNativeBackendConfiguration({ ...input, connections: [input.connections[0]!, input.connections[0]!] })).toThrow("pi_native_connection_invalid");
    expect(() => parsePiNativeBackendConfiguration({ ...input, connections: [document.targets[1]!] })).toThrow("pi_native_connection_invalid");
    expect(() => parsePiNativeBackendConfiguration({ ...input, connections: [input.connections[0]!, { ...input.connections[0]!, id: "other", enabled: false, executionEnvironmentId: "other-environment" }] })).toThrow("pi_native_execution_environment_invalid");
  });

  it.each(["executablePath", "agentDirectory", "sessionDirectory"] as const)("requires a canonical absolute %s", field => {
    for (const value of ["", "pi", "~/pi", "/pi/../other", "/pi//other", "/pi/", "/pi\u0000"]) {
      expect(piNativeModuleConfigurationSchema.safeParse({ [field]: value }).success, value).toBe(false);
    }
    expect(piNativeModuleConfigurationSchema.safeParse({ [field]: "/opt/pi" }).success).toBe(true);
  });

  it("validates timeout bounds, complete model identities, and explicit reasoning levels", () => {
    for (const initializationTimeoutMs of [0, 999, 120_001, 1_000.5]) {
      expect(piNativeModuleConfigurationSchema.safeParse({ initializationTimeoutMs }).success).toBe(false);
    }
    for (const defaults of [{ provider: "p" }, { model: "m" }, { provider: "p", model: "" }, { thinkingLevel: "extreme" }]) {
      expect(piNativeConnectionDefaultsSchema.safeParse(defaults).success).toBe(false);
    }
    expect(piNativeConnectionDefaultsSchema.parse({ provider: "provider", model: "model", thinkingLevel: "max" })).toEqual({ provider: "provider", model: "model", thinkingLevel: "max" });
  });

  it("rejects foreign-platform paths and policy-forbidden explicit selections before provider I/O", () => {
    const document = configuration();
    const native = document.backends[0]!, target = document.targets[0]!;
    if (native.kind !== "pi_native" || target.kind !== "pi_rpc") throw new Error("fixture kind");
    native.moduleConfiguration.agentDirectory = "C:\\Pi";
    expect(() => validateConfigurationDocument(document)).toThrow(/configuration or target defaults are invalid/u);
    delete native.moduleConfiguration.agentDirectory;
    native.modelPolicy = { type: "allowlist", allowed: [{ providerIds: ["allowed"] }] };
    target.moduleConfiguration.defaults = { provider: "forbidden", model: "model", thinkingLevel: "low" };
    expect(() => validateConfigurationDocument(document)).toThrow(/configuration or target defaults are invalid/u);
    delete target.moduleConfiguration.defaults.thinkingLevel;
    expect(() => validateConfigurationDocument(document)).toThrow(/configuration or target defaults are invalid/u);
  });
});
