import { describe, expect, it, vi } from "vitest";
import type {
  BackendKind,
  ConnectionKind,
} from "../../src/server/backends/contracts.js";
import type {
  BackendModule,
  BackendModuleConfigurationInput,
  PreparedBackendModule,
} from "../../src/server/backends/module.js";
import { BackendModuleCatalog } from "../../src/server/backends/module-catalog.js";
import { parseBackendConfiguration } from "../../src/server/config/backend-configuration.js";

function fakeModule(
  backend: BackendKind,
  connection: ConnectionKind,
  onPrepare?: (input: BackendModuleConfigurationInput) => PreparedBackendModule,
): BackendModule {
  const module: BackendModule = {
    backendKind: backend,
    connectionKinds: [connection],
    protocolRelease: "v1",
    prepare(input) {
      return (
        onPrepare?.(input) ?? {
          backendInstanceId: input.backend.id,
          module,
          nativeNamespaces: [],
          nativeStores: [],
          createRuntime() {
            throw new Error("not used");
          },
        }
      );
    },
  };
  return module;
}

describe("BackendModuleCatalog", () => {
  it("snapshots code-owned releases without mutating operator configuration", () => {
    const module = fakeModule("pi", "pi_sdk");
    const catalog = new BackendModuleCatalog([module]);
    (module as { protocolRelease: string }).protocolRelease = "mutated-v2";
    const operatorConfiguration = parseBackendConfiguration({
      schemaVersion: 10,
      executionEnvironments: [
        {
          id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
          kind: "local",
          label: "Local",
        },
      ],
      backends: [
        {
          id: "pi-primary",
          kind: "pi",
          label: "Pi",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
      ],
      targets: [
        {
          id: "pi-local",
          kind: "pi_sdk",
          label: "Pi",
          backendInstanceId: "pi-primary",
          executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
          enabled: true,
        },
      ],
      defaultTargetId: "pi-local",
    });

    const resolved = catalog.resolveConfiguration(operatorConfiguration);

    expect(operatorConfiguration.backends[0]).not.toHaveProperty(
      "protocolRelease",
    );
    expect(resolved.backends[0]?.protocolRelease).toBe("v1");
    expect(catalog.protocolReleaseForBackendKind("pi")).toBe("v1");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.backends)).toBe(true);
    expect(Object.isFrozen(resolved.backends[0])).toBe(true);
  });

  it("owns each compiled backend and connection discriminant exactly once", () => {
    const alpha = fakeModule("pi", "pi_sdk");
    const beta = fakeModule("codex_app_server", "codex_app_server");
    const catalog = new BackendModuleCatalog([alpha, beta]);

    expect(catalog.moduleForBackendKind(alpha.backendKind)).toBe(alpha);
    expect(catalog.moduleForConnectionKind(beta.connectionKinds[0]!)).toBe(
      beta,
    );
    expect(
      () =>
        new BackendModuleCatalog([
          alpha,
          fakeModule(alpha.backendKind, "codex_app_server"),
        ]),
    ).toThrow(/already provided/i);
    expect(
      () =>
        new BackendModuleCatalog([
          alpha,
          fakeModule("codex_app_server", alpha.connectionKinds[0]!),
        ]),
    ).toThrow(/already provided/i);
  });

  it("validates every configured pairing before preparing modules", () => {
    const alphaPrepare = vi.fn(
      (_input: BackendModuleConfigurationInput): PreparedBackendModule =>
        ({
          backendInstanceId: _input.backend.id,
          module: alpha,
          nativeNamespaces: [],
          nativeStores: [],
          createRuntime() {
            throw new Error("not used");
          },
        }) as PreparedBackendModule,
    );
    const alpha = fakeModule("pi", "pi_sdk", alphaPrepare);
    const beta = fakeModule("codex_app_server", "codex_app_server");
    const catalog = new BackendModuleCatalog([alpha, beta]);
    const configuredBackend = {
      id: "alpha-1",
      kind: alpha.backendKind,
      protocolRelease: "v1",
      enabled: true,
      modelPolicy: { type: "catalog" } as const,
    };

    expect(() =>
      catalog.prepare({
        backends: [configuredBackend],
        connections: [
          {
            id: "wrong-kind",
            kind: beta.connectionKinds[0]!,
            backendInstanceId: configuredBackend.id,
            executionEnvironmentId: "environment-one",
            enabled: true,
          },
        ],
        executionEnvironments: [{ id: "environment-one", kind: "local" }],
        environment: {},
      }),
    ).toThrow(/incompatible/i);
    expect(alphaPrepare).not.toHaveBeenCalled();
  });

  it("fails closed for uninstalled modules and dangling connections", () => {
    const alpha = fakeModule("pi", "pi_sdk");
    const catalog = new BackendModuleCatalog([alpha]);

    expect(() => catalog.requireModule("missing" as BackendKind)).toThrow(
      /not installed/i,
    );
    expect(() =>
      catalog.prepare({
        backends: [],
        connections: [
          {
            id: "dangling",
            kind: alpha.connectionKinds[0]!,
            backendInstanceId: "missing",
            executionEnvironmentId: "environment-one",
            enabled: true,
          },
        ],
        executionEnvironments: [{ id: "environment-one", kind: "local" }],
        environment: {},
      }),
    ).toThrow(/unknown backend/i);
  });

  it("rejects a module contribution for a different backend instance", () => {
    const alpha = fakeModule("pi", "pi_sdk", (input) => ({
      backendInstanceId: `${input.backend.id}-wrong`,
      module: alpha,
      nativeNamespaces: [],
      nativeStores: [],
      createRuntime() {
        throw new Error("not used");
      },
    }));
    const catalog = new BackendModuleCatalog([alpha]);

    expect(() =>
      catalog.prepare({
        backends: [
          {
            id: "alpha-1",
            kind: "pi",
            protocolRelease: "v1",
            enabled: true,
            modelPolicy: { type: "catalog" },
          },
        ],
        connections: [],
        executionEnvironments: [],
        environment: {},
      }),
    ).toThrow("backend_module_prepared_instance_mismatch");
  });

  it("prepares two configured module instances without merging their state", () => {
    const prepare = vi.fn(
      (input: BackendModuleConfigurationInput): PreparedBackendModule =>
        ({
          backendInstanceId: input.backend.id,
          module: alpha,
          nativeNamespaces: [],
          nativeStores: [],
          createRuntime() {
            throw new Error(input.backend.id);
          },
        }) as PreparedBackendModule,
    );
    const alpha = fakeModule("pi", "pi_sdk", prepare);
    const catalog = new BackendModuleCatalog([alpha]);
    const prepared = catalog.prepare({
      backends: [
        {
          id: "alpha-1",
          kind: alpha.backendKind,
          protocolRelease: "v1",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
        {
          id: "alpha-2",
          kind: alpha.backendKind,
          protocolRelease: "v1",
          enabled: true,
          modelPolicy: { type: "catalog" },
        },
      ],
      connections: [],
      executionEnvironments: [],
      environment: {},
    });

    expect(prepared).toHaveLength(2);
    expect(prepare.mock.calls.map(([input]) => input.backend.id)).toEqual([
      "alpha-1",
      "alpha-2",
    ]);
  });

  it("prepares one shared instance runtime contribution for all of its profiles", () => {
    const prepare = vi.fn(
      (input: BackendModuleConfigurationInput): PreparedBackendModule =>
        ({
          backendInstanceId: input.backend.id,
          module: alpha,
          nativeNamespaces: [],
          nativeStores: [],
          createRuntime() {
            throw new Error("not used");
          },
        }) as PreparedBackendModule,
    );
    const alpha = fakeModule("pi", "pi_sdk", prepare);
    const catalog = new BackendModuleCatalog([alpha]);
    const backend = {
      id: "shared-daemon",
      kind: alpha.backendKind,
      protocolRelease: "v1",
      enabled: true,
      modelPolicy: { type: "catalog" } as const,
    };
    const connections = ["primary", "alternate"].map((id) => ({
      id,
      kind: alpha.connectionKinds[0]!,
      backendInstanceId: backend.id,
      executionEnvironmentId: "environment-one",
      enabled: true,
    }));

    catalog.prepare({
      backends: [backend],
      connections,
      executionEnvironments: [{ id: "environment-one", kind: "local" }],
      environment: {},
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0].connections).toEqual(connections);
  });
});
