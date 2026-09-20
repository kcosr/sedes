import type {
  BackendModule,
  BackendModuleBackendConfiguration,
  BackendModuleConnectionConfiguration,
  BackendModuleConfigurationInput,
  PreparedBackendModule,
} from "./module.js";
import type { BackendKind, ConnectionKind } from "./contracts.js";
import type {
  BackendConfigurationFile,
  ResolvedBackendConfigurationFile,
} from "../config/backend-configuration.js";

function assertProtocolRelease(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("backend_module_protocol_release_invalid");
  }
}

function uniqueKinds<T extends string>(
  values: readonly T[],
  label: string,
): readonly T[] {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${label}_invalid`);
  }
  return Object.freeze([...values]);
}

export class BackendModuleCatalog {
  readonly #byBackendKind = new Map<BackendKind, BackendModule>();
  readonly #byConnectionKind = new Map<ConnectionKind, BackendModule>();
  readonly #protocolReleaseByBackendKind = new Map<BackendKind, string>();

  constructor(modules: readonly BackendModule[]) {
    for (const module of modules) {
      assertProtocolRelease(module.protocolRelease);
      if (this.#byBackendKind.has(module.backendKind)) {
        throw new Error(
          `Backend kind "${module.backendKind}" is already provided by another module.`,
        );
      }
      const connectionKinds = uniqueKinds(
        module.connectionKinds,
        "backend_module_connection_kinds",
      );
      for (const connectionKind of connectionKinds) {
        if (this.#byConnectionKind.has(connectionKind)) {
          throw new Error(
            `Connection kind "${connectionKind}" is already provided by another module.`,
          );
        }
      }
      this.#byBackendKind.set(module.backendKind, module);
      this.#protocolReleaseByBackendKind.set(
        module.backendKind,
        module.protocolRelease,
      );
      for (const connectionKind of connectionKinds) {
        this.#byConnectionKind.set(connectionKind, module);
      }
    }
  }

  moduleForBackendKind(kind: BackendKind): BackendModule | undefined {
    return this.#byBackendKind.get(kind);
  }

  moduleForConnectionKind(kind: ConnectionKind): BackendModule | undefined {
    return this.#byConnectionKind.get(kind);
  }

  requireModule(kind: BackendKind): BackendModule {
    const module = this.moduleForBackendKind(kind);
    if (!module) {
      throw new Error(`Configured backend kind "${kind}" is not installed.`);
    }
    return module;
  }

  protocolReleaseForBackendKind(kind: BackendKind): string {
    this.requireModule(kind);
    return this.#protocolReleaseByBackendKind.get(kind)!;
  }

  resolveConfiguration(
    configuration: BackendConfigurationFile,
  ): ResolvedBackendConfigurationFile {
    return Object.freeze({
      ...configuration,
      backends: Object.freeze(
        configuration.backends.map((backend) =>
          Object.freeze({
            ...backend,
            protocolRelease: this.protocolReleaseForBackendKind(backend.kind),
          }),
        ),
      ),
    });
  }

  assertCompatible(
    backend: BackendModuleBackendConfiguration,
    connection: BackendModuleConnectionConfiguration,
  ): BackendModule {
    if (connection.backendInstanceId !== backend.id) {
      throw new Error("backend_module_connection_instance_mismatch");
    }
    const backendModule = this.requireModule(backend.kind);
    if (
      backend.protocolRelease !==
      this.protocolReleaseForBackendKind(backend.kind)
    ) {
      throw new Error("backend_module_protocol_release_mismatch");
    }
    const connectionModule = this.moduleForConnectionKind(connection.kind);
    if (connectionModule !== backendModule) {
      throw new Error("backend_module_connection_kind_incompatible");
    }
    return backendModule;
  }

  prepare(input: {
    readonly backends: readonly BackendModuleBackendConfiguration[];
    readonly connections: readonly BackendModuleConnectionConfiguration[];
    readonly executionEnvironments: BackendModuleConfigurationInput["executionEnvironments"];
    readonly environment: BackendModuleConfigurationInput["environment"];
  }): readonly PreparedBackendModule[] {
    const backendIds = new Set(input.backends.map(({ id }) => id));
    const dangling = input.connections.find(
      ({ backendInstanceId }) => !backendIds.has(backendInstanceId),
    );
    if (dangling) {
      throw new Error(
        `Connection "${dangling.id}" references an unknown backend instance.`,
      );
    }
    const prepared: PreparedBackendModule[] = [];
    for (const backend of input.backends) {
      const backendModule = this.requireModule(backend.kind);
      if (
        backend.protocolRelease !==
        this.protocolReleaseForBackendKind(backend.kind)
      ) {
        throw new Error("backend_module_protocol_release_mismatch");
      }
      const connections = input.connections.filter(
        ({ backendInstanceId }) => backendInstanceId === backend.id,
      );
      for (const connection of connections) {
        this.assertCompatible(backend, connection);
      }
      const contribution = backendModule.prepare({
        backend,
        connections,
        executionEnvironments: input.executionEnvironments,
        environment: input.environment,
      });
      if (contribution.backendInstanceId !== backend.id) {
        throw new Error("backend_module_prepared_instance_mismatch");
      }
      prepared.push(contribution);
    }
    return Object.freeze(prepared);
  }
}
