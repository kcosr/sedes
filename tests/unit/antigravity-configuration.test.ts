import { describe, expect, it } from "vitest";
import { allowedEnvironments, backendEditors } from "../../src/client/components/execution-settings/backend-editors.js";
import { antigravityConnectionConfigurationSchema, antigravityModuleConfigurationSchema } from "../../src/shared/protocol/antigravity-configuration.js";
import { configurationDocumentSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { ANTIGRAVITY_PROTOCOL_RELEASE } from "../../src/server/backends/antigravity/release-profile.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { planBackendNativeStores } from "../../src/server/runtime/backend-module-startup.js";

const environmentId = "10000000-0000-4000-8000-000000000001";
const pairingId = "20000000-0000-4000-8000-000000000001";

function configuration(kind: "local" | "ssh" | "outbound" = "local"): ConfigurationDocument {
  const base = { id: environmentId, label: "Host", workspaceRoots: ["/workspace"] };
  const remote = { ...base, connectionCompression: true, operations: { kind: "none" as const } };
  return {
    executionEnvironments: [
      kind === "local" ? { ...base, kind, workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }
        : kind === "ssh" ? { ...remote, kind, hostAlias: "build" }
          : { ...remote, kind, platform: "darwin", pairingId },
    ],
    backends: [{ ...backendEditors.antigravity.createBackend("ag"), label: "Antigravity" }],
    targets: [backendEditors.antigravity.createTarget("ag-default", "ag", environmentId)],
    defaultTargetId: "ag-default", webSearch: null,
  };
}

describe("Antigravity administration", () => {
  it.each(["local", "ssh", "outbound"] as const)("registers a strict owned target on %s", kind => {
    const document = configuration(kind);
    expect(validateConfigurationDocument(document)).toEqual(document);
    const backend = document.backends[0]!;
    const target = document.targets[0]!;
    expect(allowedEnvironments(backend, document.executionEnvironments)).toEqual(document.executionEnvironments);
    const module = compiledBackendModuleCatalog.moduleForBackendKind(backend.kind)!;
    expect(module.protocolRelease).toBe(ANTIGRAVITY_PROTOCOL_RELEASE);
    expect(module.connectionKinds).toEqual(["antigravity_acp"]);
    expect(module.remoteRuntimeCapabilities).toMatchObject([{ capabilityId: "antigravity_runtime" }]);
    const prepared = module.prepare({ backend: { ...backend, protocolRelease: module.protocolRelease },
      connections: [target], executionEnvironments: document.executionEnvironments, environment: {} });
    expect(prepared.nativeNamespaces).toHaveLength(1);
    expect(prepared.nativeStores).toEqual([]);
  });

  it("denies target mismatches and Windows outbound admission", () => {
    const document = configuration("outbound");
    document.executionEnvironments = [{ id: environmentId, label: "Windows", kind: "outbound", platform: "win32", pairingId,
      workspaceRoots: ["C:\\workspace"], connectionCompression: false, operations: { kind: "none" } }];
    expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
    expect(allowedEnvironments(document.backends[0]!, document.executionEnvironments)).toEqual([]);
    document.executionEnvironments = configuration("ssh").executionEnvironments;
    document.targets = [backendEditors.pi.createTarget("ag-default", "ag", environmentId)];
    expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("validates exact native references and rejects unsupported model policy dimensions", () => {
    expect(antigravityModuleConfigurationSchema.parse({})).toEqual({ initializationTimeoutMs: 30_000 });
    expect(antigravityConnectionConfigurationSchema.parse({})).toEqual({ defaults: {} });
    for (const invalid of [{ executablePath: "agy" }, { geminiDirectory: "/a/../b" },
      { initializationTimeoutMs: 999 }, { authToken: "credential" }, { applicationDataDirectory: "other" }]) {
      expect(antigravityModuleConfigurationSchema.safeParse(invalid).success).toBe(false);
    }
    expect(antigravityConnectionConfigurationSchema.safeParse({ defaults: { modelId: "model\n" } }).success).toBe(false);
    const document = configuration();
    document.backends[0]!.modelPolicy = { type: "allowlist", allowed: [{ providerIds: ["forged"] }] };
    expect(() => validateConfigurationDocument(document)).toThrow(/configuration or target defaults are invalid/);
  });

  it("prevents two backend instances from sharing the same native namespace", () => {
    const document = configuration();
    const backend = document.backends[0]!;
    const target = document.targets[0]!;
    const module = compiledBackendModuleCatalog.moduleForBackendKind("antigravity")!;
    const input = { backend: { ...backend, protocolRelease: module.protocolRelease },
      connections: [target], executionEnvironments: document.executionEnvironments, environment: {} };
    expect(() => planBackendNativeStores([
      module.prepare(input),
      module.prepare({ ...input, backend: { ...input.backend, id: "ag-alias" },
        connections: [{ ...target, id: "ag-alias-default", backendInstanceId: "ag-alias" }] }),
    ])).toThrow("backend_native_namespace_reused");
  });
});
