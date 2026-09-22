import type { UsageSink } from "../usage/contracts.js";
import type {
  AgentToolCliAvailability,
  BackendModuleRuntime,
  BackendNativeStoreLifecycle,
  PreparedBackendModule,
} from "../backends/module.js";
import type { AgentToolSourceCapabilityIssuer } from "../agent-tools/application/database-agent-tool-source-authority.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../backends/contracts.js";
import type { AgentBackendRegistry } from "../backends/registry.js";
import type Database from "better-sqlite3";
import type { BackendAgentToolFacade } from "../agent-tools/adapters/backend-facade.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { StartupResourceStack } from "./startup-resource-stack.js";
import type { ExecutionEnvironmentChannelProvider } from "../execution/environment-channel.js";
import type { EnvironmentOperations } from "../execution/environment-operations.js";
import type { ThreadWorkspaceIsolationResolver } from "../execution/thread-workspace-isolation.js";
import type { OutputArtifactPublisher } from "../output-artifacts/contracts.js";

type NativeStoreClaim = {
  readonly backendInstanceId: string;
  readonly sortKey: string;
};

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Builds the complete native-store lock plan before any lock is acquired.
 *
 * A native namespace belongs to exactly one immutable backend instance. Two
 * connection profiles for that instance may converge on the same namespace,
 * but two backend instances may not claim it: their persistence adapters and
 * runtime ownership would otherwise race over the same provider-native data.
 */
export function planBackendNativeStores(
  preparedModules: readonly PreparedBackendModule[],
): readonly BackendNativeStoreLifecycle[] {
  const claims = new Map<string, NativeStoreClaim>();
  for (const prepared of preparedModules) {
    for (const namespace of prepared.nativeNamespaces) {
      const current = claims.get(namespace.namespaceKey);
      if (!current) {
        claims.set(namespace.namespaceKey, {
          backendInstanceId: prepared.backendInstanceId,
          sortKey: namespace.sortKey,
        });
        continue;
      }
      if (current.backendInstanceId !== prepared.backendInstanceId) {
        throw new Error(
          `backend_native_namespace_reused: backend instances "${current.backendInstanceId}" and "${prepared.backendInstanceId}" resolve to the same provider-native store`,
        );
      }
      if (current.sortKey !== namespace.sortKey) {
        throw new Error("backend_native_store_identity_conflict");
      }
    }
    if (
      prepared.nativeStores.some(
        (store) =>
          !prepared.nativeNamespaces.some(
            (namespace) =>
              namespace.namespaceKey === store.namespaceKey &&
              namespace.sortKey === store.sortKey,
          ),
      )
    ) {
      throw new Error("backend_native_store_claim_missing");
    }
  }
  const stores = new Map<
    string,
    {
      readonly backendInstanceId: string;
      readonly store: BackendNativeStoreLifecycle;
    }
  >();
  for (const prepared of preparedModules) {
    for (const store of prepared.nativeStores) {
      const current = stores.get(store.namespaceKey);
      if (!current) {
        stores.set(store.namespaceKey, {
          backendInstanceId: prepared.backendInstanceId,
          store,
        });
      } else if (
        current.backendInstanceId !== prepared.backendInstanceId ||
        current.store.sortKey !== store.sortKey
      ) {
        throw new Error("backend_native_store_identity_conflict");
      }
    }
  }
  return Object.freeze(
    [...stores.values()]
      .map(({ store }) => store)
      .sort(
        (left, right) =>
          compareOpaque(left.sortKey, right.sortKey) ||
          compareOpaque(left.namespaceKey, right.namespaceKey),
      ),
  );
}

export async function acquireBackendNativeStores(
  stores: readonly BackendNativeStoreLifecycle[],
  resources: StartupResourceStack,
): Promise<void> {
  for (const store of stores) {
    const lease = await store.acquire();
    resources.defer(store.label, () => lease.release());
  }
}

/**
 * Registers ownership before start so a runtime whose start method partially
 * initializes and then rejects is still closed by the outer startup unwind.
 */
export async function startBackendModuleRuntime(
  runtime: BackendModuleRuntime,
  resources: StartupResourceStack,
): Promise<void> {
  resources.defer(
    `backend runtime ${runtime.instance.id}`,
    () => runtime.close(),
    { mode: "ownership_critical" },
  );
  await runtime.start();
}

export interface StartedBackendModuleRuntimes {
  readonly runtimes: ReadonlyMap<string, BackendModuleRuntime>;
  readonly threadPersistence: ReadonlyMap<
    string,
    BackendModuleRuntime["threadPersistence"]
  >;
  readonly bindingDetails: ReadonlyMap<
    string,
    BackendModuleRuntime["bindingDetails"]
  >;
  readonly presentation: ReadonlyMap<
    string,
    BackendModuleRuntime["presentation"]
  >;
  readonly actionPersistence: ReadonlyMap<
    string,
    BackendModuleRuntime["actionPersistence"]
  >;
  readonly discoveryPersistence: ReadonlyMap<
    string,
    BackendModuleRuntime["discoveryPersistence"]
  >;
  readonly savedAgents: ReadonlyMap<
    string,
    BackendModuleRuntime["savedAgents"]
  >;
}

/**
 * Creates exactly one runtime per enabled principal/backend instance and gives
 * it every profile in that scope. The runtime is therefore free to multiplex
 * all logical conversations over one shared daemon/client.
 */
export async function initializeBackendModuleRuntimes(input: {
  readonly usage: UsageSink;
  readonly preparedModules: readonly PreparedBackendModule[];
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly instances: readonly AgentBackendInstance[];
  readonly connections: readonly AgentConnectionProfile[];
  readonly environmentChannels: ReadonlyMap<
    string,
    ExecutionEnvironmentChannelProvider
  >;
  readonly environmentOperations: ReadonlyMap<string, EnvironmentOperations>;
  readonly workspaceIsolations?: ReadonlyMap<
    string,
    ThreadWorkspaceIsolationResolver
  >;
  readonly toolProvenanceKey: Uint8Array;
  readonly agentTools: BackendAgentToolFacade;
  readonly outputArtifacts: OutputArtifactPublisher;
  readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly agentToolCli: ReadonlyMap<string, AgentToolCliAvailability>;
  readonly registry: AgentBackendRegistry;
  readonly resources: StartupResourceStack;
}): Promise<StartedBackendModuleRuntimes> {
  const instances = new Map(
    input.instances.map((instance) => [instance.id, instance]),
  );
  const preparedInstanceIds = new Set(
    input.preparedModules.map(({ backendInstanceId }) => backendInstanceId),
  );
  if (
    instances.size !== input.instances.length ||
    preparedInstanceIds.size !== input.preparedModules.length ||
    input.preparedModules.length !== input.instances.length ||
    input.connections.some(
      (connection) =>
        connection.tenantId !== input.scope.tenantId ||
        connection.ownerPrincipalId !== input.scope.principalId ||
        !instances.has(connection.backendInstanceId),
    )
  ) {
    throw new Error("backend_runtime_instance_plan_invalid");
  }
  const validatedPlans: Array<{
    readonly instance: AgentBackendInstance;
    readonly prepared: PreparedBackendModule;
    readonly connections: readonly AgentConnectionProfile[];
    readonly environmentChannel: ExecutionEnvironmentChannelProvider;
    readonly environmentOperations: EnvironmentOperations;
    readonly workspaceIsolation?: ThreadWorkspaceIsolationResolver;
    readonly agentToolCli: AgentToolCliAvailability;
  }> = [];

  // Validate the entire enabled-instance plan before creating or starting any
  // runtime. Startup may then proceed concurrently without allowing a later
  // structural error to leave an earlier runtime running.
  for (const prepared of input.preparedModules) {
    const instance = instances.get(prepared.backendInstanceId);
    if (!instance) throw new Error("backend_runtime_instance_missing");
    if (!instance.enabled) continue;
    const runtimeConnections = input.connections.filter(
      ({ backendInstanceId }) => backendInstanceId === instance.id,
    );
    const environmentIds = new Set(
      runtimeConnections
        .filter(({ enabled }) => enabled)
        .map(({ executionEnvironmentId }) => executionEnvironmentId),
    );
    if (environmentIds.size !== 1) {
      throw new Error("backend_runtime_execution_environment_invalid");
    }
    const executionEnvironmentId = [...environmentIds][0]!;
    const environmentChannel = input.environmentChannels.get(
      executionEnvironmentId,
    );
    const agentToolCli = input.agentToolCli.get(executionEnvironmentId);
    const environmentOperations = input.environmentOperations.get(
      executionEnvironmentId,
    );
    const workspaceIsolation = input.workspaceIsolations?.get(instance.id);
    if (
      !environmentChannel ||
      !environmentOperations ||
      environmentOperations.environmentId !== executionEnvironmentId ||
      environmentChannel.executionEnvironmentId !== executionEnvironmentId ||
      environmentChannel.scope.tenantId !== input.scope.tenantId ||
      environmentChannel.scope.principalId !== input.scope.principalId
    ) {
      throw new Error("backend_runtime_environment_channel_missing");
    }
    if (!agentToolCli) {
      throw new Error("backend_runtime_agent_tool_cli_missing");
    }
    validatedPlans.push({
      instance,
      prepared,
      connections: runtimeConnections,
      environmentChannel,
      environmentOperations,
      ...(workspaceIsolation ? { workspaceIsolation } : {}),
      agentToolCli,
    });
  }

  const runtimePlans: Array<{
    readonly instance: AgentBackendInstance;
    readonly runtime: BackendModuleRuntime;
  }> = [];
  for (const plan of validatedPlans) {
    const runtime = plan.prepared.createRuntime({
      usage: input.usage,
      database: input.database,
      scope: input.scope,
      instance: plan.instance,
      connections: plan.connections,
      environmentChannel: plan.environmentChannel,
      environmentOperations: plan.environmentOperations,
      ...(plan.workspaceIsolation
        ? { workspaceIsolation: plan.workspaceIsolation }
        : {}),
      toolProvenanceKey: input.toolProvenanceKey,
      agentTools: input.agentTools,
      outputArtifacts: input.outputArtifacts,
      agentToolSourceCapabilities: input.agentToolSourceCapabilities,
      agentToolCli: plan.agentToolCli,
    });
    // A later createRuntime may throw after earlier factories allocated local
    // resources, so ownership is established immediately and in plan order.
    input.resources.defer(
      `backend runtime ${runtime.instance.id}`,
      () => runtime.close(),
      { mode: "ownership_critical" },
    );
    runtimePlans.push({
      instance: plan.instance,
      runtime,
    });
  }

  // Promise.allSettled ensures a fast failure cannot begin unwind while a peer
  // is still acquiring resources in its own start method.
  const startup = await Promise.allSettled(
    runtimePlans.map(({ runtime }) =>
      Promise.resolve().then(() => runtime.start()),
    ),
  );
  const startupFailures = startup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (startupFailures.length === 1) throw startupFailures[0];
  if (startupFailures.length > 1) {
    throw new AggregateError(
      startupFailures,
      "Multiple backend module runtimes failed to start.",
    );
  }

  const runtimes = new Map<string, BackendModuleRuntime>();
  const threadPersistence = new Map<
    string,
    BackendModuleRuntime["threadPersistence"]
  >();
  const bindingDetails = new Map<
    string,
    BackendModuleRuntime["bindingDetails"]
  >();
  const presentation = new Map<string, BackendModuleRuntime["presentation"]>();
  const actionPersistence = new Map<
    string,
    BackendModuleRuntime["actionPersistence"]
  >();
  const discoveryPersistence = new Map<
    string,
    BackendModuleRuntime["discoveryPersistence"]
  >();
  const savedAgents = new Map<string, BackendModuleRuntime["savedAgents"]>();

  // Runtime publication is deliberately delayed until every enabled runtime
  // has started successfully, then performed in the stable prepared order.
  for (const { instance, runtime } of runtimePlans) {
    input.registry.register(runtime.driverFactory);
    runtimes.set(instance.id, runtime);
    threadPersistence.set(instance.id, runtime.threadPersistence);
    bindingDetails.set(instance.id, runtime.bindingDetails);
    presentation.set(instance.id, runtime.presentation);
    actionPersistence.set(instance.id, runtime.actionPersistence);
    discoveryPersistence.set(instance.id, runtime.discoveryPersistence);
    savedAgents.set(instance.id, runtime.savedAgents);
  }
  return {
    runtimes,
    threadPersistence,
    bindingDetails,
    presentation,
    actionPersistence,
    discoveryPersistence,
    savedAgents,
  };
}
