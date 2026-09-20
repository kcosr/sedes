import type { BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../../module.js";
import { claudePersistentConfigurationSchema, type ClaudePersistentConfiguration } from "./claude-persistent-runtime-wire.js";
import { ClaudeSidecarRuntimeConnection, claudePersistentRuntimeOperations } from "./claude-sidecar-runtime.js";

/** Recovery has no launch authority. Every control reacquires an existing
 * service and fences its exact retained provider incarnation and configuration. */
export async function recoverClaudeRuntimeAdministration(input: {
  context: BackendRuntimeRecoveryContext;
  configuration: ClaudePersistentConfiguration;
}): Promise<BackendRuntimeAdministration | undefined> {
  const { context } = input;
  const configuration = claudePersistentConfigurationSchema.parse(input.configuration);
  if (configuration.tenantId !== context.scope.tenantId || configuration.principalId !== context.scope.principalId ||
    configuration.backendInstanceId !== context.instance.id || context.instance.tenantId !== context.scope.tenantId ||
    context.instance.kind !== "claude_agent_sdk" || context.connections.length === 0 || context.connections.some(connection =>
      connection.kind !== "claude_agent_sdk" || connection.tenantId !== context.scope.tenantId ||
      connection.ownerPrincipalId !== context.scope.principalId || connection.backendInstanceId !== context.instance.id ||
      connection.executionEnvironmentId !== configuration.executionEnvironmentId)) {
    throw new Error("claude_persistent_configuration_scope_denied");
  }
  const withExisting = async <T>(run: (
    connection: ClaudeSidecarRuntimeConnection, runtimeId: string | undefined, controllerEpoch: number,
  ) => Promise<T>, initialDiscovery = false): Promise<T> => {
    const lease = await context.sidecarRuntime.acquireRecovery();
    const connection = new ClaudeSidecarRuntimeConnection(lease.channel);
    try {
      // Keep liveness and inventory checks synchronous: a closed or pre-hello
      // channel cannot establish absence even when every operation is false.
      lease.channel.assertReady();
      const supported = claudePersistentRuntimeOperations.map(operation => lease.channel.supportsOperation(operation));
      // An admitted daemon with no Claude host proves initial absence (for
      // example on Windows). A partial contract or lost capability cannot
      // prove retirement of an already recovered provider incarnation.
      if (initialDiscovery && supported.every(value => !value)) {
        return await run(connection, undefined, lease.controllerEpoch);
      }
      if (!supported.every(Boolean)) {
        throw new Error("claude_remote_runtime_unsupported");
      }
      const runtimeId = await connection.lookup(configuration, lease.controllerEpoch);
      return await run(connection, runtimeId, lease.controllerEpoch);
    } finally { connection.close(); lease.release(); }
  };
  const runtimeId = await withExisting(async (_connection, id) => id, true);
  if (!runtimeId) return undefined;
  const assertIncarnation = (current: string | undefined) => {
    if (current !== runtimeId) throw new Error("claude_persistent_administration_incarnation_changed");
  };
  const stop: BackendRuntimeAdministration["stop"] = async ({ expectedRevision, force }) => {
    await withExisting(async (connection, current, controllerEpoch) => {
      // Only positive absence from the authenticated owner proves retirement.
      if (!current) return;
      assertIncarnation(current);
      await connection.stop({ configuration, runtimeId, controllerEpoch, expectedRevision, force });
    });
  };
  return {
    inspect: async () => await withExisting(async (connection, current, controllerEpoch) => {
      assertIncarnation(current);
      return await connection.inspect({ configuration, runtimeId, controllerEpoch });
    }),
    stop,
    // Application composition applies the desired replacement only after
    // this exact old runtime has positively completed cleanup.
    restart: stop,
  };
}
