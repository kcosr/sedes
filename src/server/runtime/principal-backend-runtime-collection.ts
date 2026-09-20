import type {
  BackendModuleRuntime,
  BackendModuleRuntimeContext,
  BackendNativeStoreLease,
  PreparedBackendModule,
} from "../backends/module.js";
import {
  AgentBackendRegistry,
  type BackendDriverFactory,
} from "../backends/registry.js";
import { SavedAgentBackendAdapterRegistry } from "../backends/saved-agent-adapter-registry.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  planBackendNativeStores,
  type StartedBackendModuleRuntimes,
} from "./backend-module-startup.js";

export interface BackendRuntimePlan {
  readonly prepared: PreparedBackendModule;
  readonly context: BackendModuleRuntimeContext;
}

/** The caller fences all admissions and retires all borrowers for this exact runtime.
 * It must hold that fence until change settles, and must not invoke change if
 * active work or uncertain ownership prevents retirement. */
export interface BackendRuntimeRetirementAuthority {
  run<T>(runtime: BackendModuleRuntime, change: () => Promise<T>): Promise<T>;
}

export type BackendRuntimeApplyResult =
  | { readonly status: "applied"; readonly runtime: BackendModuleRuntime }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly cleanupPending: boolean;
    };

type Entry = {
  readonly prepared: PreparedBackendModule;
  readonly leases: BackendNativeStoreLease[];
  runtime?: BackendModuleRuntime;
  factory?: BackendDriverFactory;
};

/** A live projection: consumers retain the map itself across reconciliation. */
class RuntimeContributionMap<K extends keyof BackendModuleRuntime>
  implements ReadonlyMap<string, BackendModuleRuntime[K]>
{
  constructor(
    readonly source: ReadonlyMap<string, BackendModuleRuntime>,
    readonly key: K,
  ) {}
  get size(): number {
    return this.source.size;
  }
  get(id: string): BackendModuleRuntime[K] | undefined {
    return this.source.get(id)?.[this.key];
  }
  has(id: string): boolean {
    return this.source.has(id);
  }
  *entries(): MapIterator<[string, BackendModuleRuntime[K]]> {
    for (const [id, runtime] of this.source) yield [id, runtime[this.key]];
  }
  *keys(): MapIterator<string> {
    yield* this.source.keys();
  }
  *values(): MapIterator<BackendModuleRuntime[K]> {
    for (const runtime of this.source.values()) yield runtime[this.key];
  }
  [Symbol.iterator](): MapIterator<[string, BackendModuleRuntime[K]]> {
    return this.entries();
  }
  forEach(
    callback: (
      value: BackendModuleRuntime[K],
      key: string,
      map: ReadonlyMap<string, BackendModuleRuntime[K]>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, value] of this) callback.call(thisArg, value, id, this);
  }
}

/**
 * One principal's mutable runtime composition. Each backend owns its native
 * namespaces and leases independently. Failed startup never tears down peers;
 * unproven cleanup keeps its namespace claim and blocks a replacement.
 *
 * prepare() remains backend-owned and side-effect-free. The caller supplies
 * validated database configuration and environment authorities, and owns the
 * admission fence; this collection does not guess whether a session is idle.
 */
export class PrincipalBackendRuntimeCollection
  implements StartedBackendModuleRuntimes
{
  readonly #runtimes = new Map<string, BackendModuleRuntime>();
  readonly #entries = new Map<string, Entry>();
  readonly #failures = new Map<
    string,
    Extract<BackendRuntimeApplyResult, { status: "failed" }>
  >();
  readonly runtimes: ReadonlyMap<string, BackendModuleRuntime> = this.#runtimes;
  readonly failures: ReadonlyMap<
    string,
    Extract<BackendRuntimeApplyResult, { status: "failed" }>
  > = this.#failures;
  readonly threadPersistence = new RuntimeContributionMap(
    this.#runtimes,
    "threadPersistence",
  );
  readonly bindingDetails = new RuntimeContributionMap(
    this.#runtimes,
    "bindingDetails",
  );
  readonly presentation = new RuntimeContributionMap(
    this.#runtimes,
    "presentation",
  );
  readonly actionPersistence = new RuntimeContributionMap(
    this.#runtimes,
    "actionPersistence",
  );
  readonly discoveryPersistence = new RuntimeContributionMap(
    this.#runtimes,
    "discoveryPersistence",
  );
  readonly discovery = new RuntimeContributionMap(this.#runtimes, "discovery");
  readonly savedAgents = new RuntimeContributionMap(
    this.#runtimes,
    "savedAgents",
  );
  readonly automationExecutionPolicy = new RuntimeContributionMap(
    this.#runtimes,
    "automationExecutionPolicy",
  );
  readonly managedProviderTerminals = new RuntimeContributionMap(
    this.#runtimes,
    "managedProviderTerminals",
  );
  readonly installationAdvisories = new RuntimeContributionMap(
    this.#runtimes,
    "installationAdvisories",
  );
  readonly savedAgentAdapters = new SavedAgentBackendAdapterRegistry([]);
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    readonly input: {
      readonly scope: RequestScope;
      readonly registry: AgentBackendRegistry;
      readonly desiredInstanceRevision: (backendInstanceId: string) => number | undefined;
    },
  ) {}

  apply(
    plan: BackendRuntimePlan,
    retirement: BackendRuntimeRetirementAuthority,
  ): Promise<BackendRuntimeApplyResult> {
    return this.#serialize(async () => {
      this.#assertOpen();
      this.#validatePlan(plan);
      const id = plan.context.instance.id;
      // Validate claims before disturbing the old healthy runtime.
      planBackendNativeStores([
        ...[...this.#entries]
          .filter(([key]) => key !== id)
          .map(([, entry]) => entry.prepared),
        plan.prepared,
      ]);
      const existing = this.#entries.get(id);
      if (existing && !this.#runtimes.has(id)) {
        throw new Error("backend_runtime_cleanup_pending");
      }
      const change = async (): Promise<BackendRuntimeApplyResult> => {
        if (existing) {
          this.#withdraw(id, existing);
          try {
            await this.#cleanup(existing);
          } catch (error) {
            return this.#failure(id, error, true);
          }
          this.#entries.delete(id);
        }
        return await this.#start(plan);
      };
      return existing?.runtime
        ? await this.#retire(existing.runtime, retirement, change)
        : await change();
    });
  }

  remove(
    backendInstanceId: string,
    retirement: BackendRuntimeRetirementAuthority,
  ): Promise<void> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const entry = this.#entries.get(backendInstanceId);
      if (!entry) {
        this.#failures.delete(backendInstanceId);
        return;
      }
      const change = async () => {
        this.#withdraw(backendInstanceId, entry);
        try {
          await this.#cleanup(entry);
        } catch (error) {
          this.#failure(backendInstanceId, error, true);
          throw error;
        }
        this.#entries.delete(backendInstanceId);
        this.#failures.delete(backendInstanceId);
      };
      if (entry.runtime) await this.#retire(entry.runtime, retirement, change);
      else await change();
    });
  }

  /** Shutdown caller has already stopped admission. Failed cleanup is retained
   * and can be retried; native leases are never released before runtime close. */
  close(): Promise<void> {
    return this.#serialize(async () => {
      this.#closed = true;
      const errors: unknown[] = [];
      for (const [id, entry] of [...this.#entries].reverse()) {
        this.#withdraw(id, entry);
        try {
          await this.#cleanup(entry);
          this.#entries.delete(id);
          this.#failures.delete(id);
        } catch (error) {
          this.#failure(id, error, true);
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Backend runtime cleanup remains unconfirmed.",
        );
    });
  }

  async #start(plan: BackendRuntimePlan): Promise<BackendRuntimeApplyResult> {
    const { prepared, context } = plan;
    const id = context.instance.id;
    const entry: Entry = { prepared, leases: [] };
    this.#entries.set(id, entry);
    try {
      for (const store of planBackendNativeStores([prepared]))
        entry.leases.push(await store.acquire());
      const runtime = prepared.createRuntime(context);
      entry.runtime = runtime; // Own even a malformed or partially started runtime.
      if (
        !sameScope(runtime.scope, this.input.scope) ||
        runtime.instance.id !== id ||
        runtime.instance.tenantId !== context.instance.tenantId ||
        runtime.instance.kind !== context.instance.kind ||
        runtime.instance.configurationRevision !==
          context.instance.configurationRevision ||
        runtime.instance.protocolRelease !== context.instance.protocolRelease ||
        !sameScope(runtime.driverFactory.scope, this.input.scope) ||
        runtime.driverFactory.instance !== runtime.instance
      )
        throw new Error("backend_runtime_identity_invalid");
      await runtime.start();
      const registrations = [
        ...[...this.savedAgents].map(([backendInstanceId, adapter]) => ({
          backendInstanceId,
          adapter,
        })),
        { backendInstanceId: id, adapter: runtime.savedAgents },
      ];
      // Validate adapter contracts before registering any contribution.
      new SavedAgentBackendAdapterRegistry(registrations);
      const factory: BackendDriverFactory = {
        scope: runtime.driverFactory.scope,
        instance: runtime.driverFactory.instance,
        connectionKinds: runtime.driverFactory.connectionKinds,
        supportsConversationCreation:
          runtime.driverFactory.supportsConversationCreation,
        ...(runtime.driverFactory.creationIdentity
          ? { creationIdentity: runtime.driverFactory.creationIdentity }
          : {}),
        create: (connection) => {
          const expected = context.connections.find(
            ({ id: profileId }) => profileId === connection.id,
          );
          if (!expected || !sameConnection(expected, connection) ||
            this.input.desiredInstanceRevision(id) !== context.instance.configurationRevision)
            throw new DomainError("runtime_unavailable", "Configuration change pending for this backend.", true);
          return runtime.driverFactory.create(connection);
        },
      };
      this.input.registry.register(factory);
      entry.factory = factory;
      this.#runtimes.set(id, runtime);
      this.savedAgentAdapters.replaceAll(registrations);
      this.#failures.delete(id);
      return { status: "applied", runtime };
    } catch (error) {
      this.#withdraw(id, entry);
      try {
        await this.#cleanup(entry);
      } catch (cleanupError) {
        return this.#failure(
          id,
          new AggregateError(
            [error, cleanupError],
            "Backend startup failed and cleanup remains unconfirmed.",
          ),
          true,
        );
      }
      this.#entries.delete(id);
      return this.#failure(id, error, false);
    }
  }

  #withdraw(id: string, entry: Entry): void {
    if (entry.factory) {
      this.input.registry.unregister(this.input.scope, id, entry.factory);
      delete entry.factory;
    }
    this.#runtimes.delete(id);
    this.savedAgentAdapters.replaceAll(
      [...this.savedAgents].map(([backendInstanceId, adapter]) => ({
        backendInstanceId,
        adapter,
      })),
    );
  }

  async #cleanup(entry: Entry): Promise<void> {
    if (entry.runtime) {
      await entry.runtime.close();
      delete entry.runtime;
    }
    while (entry.leases.length) {
      await entry.leases[entry.leases.length - 1]!.release();
      entry.leases.pop();
    }
  }

  #failure(
    id: string,
    error: unknown,
    cleanupPending: boolean,
  ): Extract<BackendRuntimeApplyResult, { status: "failed" }> {
    const result = { status: "failed", error, cleanupPending } as const;
    this.#failures.set(id, result);
    return result;
  }

  #validatePlan({ prepared, context }: BackendRuntimePlan): void {
    const { instance, connections, environmentChannel, environmentOperations } =
      context;
    if (
      !sameScope(context.scope, this.input.scope) ||
      instance.tenantId !== this.input.scope.tenantId ||
      !instance.enabled ||
      prepared.backendInstanceId !== instance.id ||
      prepared.module.backendKind !== instance.kind ||
      prepared.module.protocolRelease !== instance.protocolRelease
    ) {
      throw new Error("backend_runtime_instance_plan_invalid");
    }
    if (
      new Set(connections.map(({ id }) => id)).size !== connections.length ||
      connections.some(
        (connection) =>
          connection.tenantId !== this.input.scope.tenantId ||
          connection.ownerPrincipalId !== this.input.scope.principalId ||
          connection.backendInstanceId !== instance.id,
      )
    )
      throw new Error("backend_runtime_instance_plan_invalid");
    const environments = new Set(
      connections
        .filter(({ enabled }) => enabled)
        .map(({ executionEnvironmentId }) => executionEnvironmentId),
    );
    if (environments.size !== 1)
      throw new Error("backend_runtime_execution_environment_invalid");
    const [id] = environments;
    if (
      !sameScope(environmentChannel.scope, this.input.scope) ||
      environmentChannel.executionEnvironmentId !== id ||
      environmentOperations.environmentId !== id
    ) {
      throw new Error("backend_runtime_environment_channel_missing");
    }
    if (!context.agentToolCli)
      throw new Error("backend_runtime_agent_tool_cli_missing");
  }

  async #retire<T>(
    runtime: BackendModuleRuntime,
    authority: BackendRuntimeRetirementAuthority,
    change: () => Promise<T>,
  ): Promise<T> {
    let invoked = false;
    let finished = false;
    const result = await authority
      .run(runtime, async () => {
        if (invoked || finished)
          throw new Error("backend_runtime_retirement_reused");
        invoked = true;
        return await change();
      })
      .finally(() => {
        finished = true;
      });
    if (!invoked) throw new Error("backend_runtime_retirement_not_performed");
    return result;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("backend_runtime_collection_closed");
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function sameConnection(
  left: BackendModuleRuntimeContext["connections"][number],
  right: BackendModuleRuntimeContext["connections"][number],
): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.templateId === right.templateId &&
    left.backendInstanceId === right.backendInstanceId &&
    left.executionEnvironmentId === right.executionEnvironmentId &&
    left.configurationRevision === right.configurationRevision &&
    left.enabled === right.enabled &&
    left.kind === right.kind &&
    left.label === right.label
  );
}
