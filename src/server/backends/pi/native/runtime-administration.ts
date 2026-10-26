import type { BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../../module.js";
import { PiNativeError, type PiNativeInspection, type PiNativeRuntimeConfiguration } from "./port.js";
import { PI_RPC_VERSION } from "./rpc/pi-rpc-wire.js";
import { PiNativeRemotePort } from "./sidecar/remote-port.js";
import { piNativeConfigurationSchema, piNativeRuntimeOperations } from "./sidecar/wire.js";
import { stopPiNativeRuntime } from "./runtime-control.js";

/** Desired paths may have changed. Recovery addresses the retained scoped
 * backend owner and never ensures a host or launches a native process. */
export async function recoverPiNativeRuntimeAdministration(input: {
  readonly context: BackendRuntimeRecoveryContext;
  readonly configuration: PiNativeRuntimeConfiguration;
}): Promise<BackendRuntimeAdministration | undefined> {
  const { context } = input;
  const configuration = piNativeConfigurationSchema.parse(input.configuration);
  if (configuration.tenantId !== context.scope.tenantId || configuration.principalId !== context.scope.principalId ||
      configuration.backendInstanceId !== context.instance.id || context.instance.tenantId !== context.scope.tenantId ||
      context.instance.kind !== "pi_native" || context.instance.protocolRelease !== PI_RPC_VERSION || !context.connections.length ||
      new Set(context.connections.map(connection => connection.id)).size !== context.connections.length ||
      new Set(context.connections.map(connection => connection.templateId)).size !== context.connections.length ||
      context.connections.some(connection => connection.kind !== "pi_rpc" || connection.tenantId !== context.scope.tenantId ||
        connection.ownerPrincipalId !== context.scope.principalId || connection.backendInstanceId !== context.instance.id ||
        connection.executionEnvironmentId !== configuration.executionEnvironmentId)) throw new PiNativeError("pi_native_configuration_scope_denied");

  let retained: { readonly serviceIncarnation: string; readonly runtimeId: string } | undefined;
  const withExisting = async <T>(run: (port: PiNativeRemotePort | undefined, inspection: PiNativeInspection | undefined) => Promise<T>, initial = false): Promise<T> => {
    const lease = await context.sidecarRuntime.acquireRecovery();
    let port: PiNativeRemotePort | undefined;
    try {
      // A disconnected or pre-hello peer cannot prove that a capability or
      // provider is absent. Check authenticated readiness before inventory.
      lease.channel.assertReady();
      if (retained && retained.serviceIncarnation !== lease.serviceIncarnation) throw changed();
      const supported = piNativeRuntimeOperations.map(operation => lease.channel.supportsOperation(operation));
      if (initial && supported.every(value => !value)) return await run(undefined, undefined);
      if (!supported.every(Boolean)) throw new PiNativeError("pi_native_remote_runtime_unsupported");
      port = new PiNativeRemotePort({ configuration, existingOnly: true, sidecarRuntime: {
        acquire: async () => { throw new PiNativeError("pi_native_recovery_launch_denied"); },
        acquireExisting: async () => ({ ...lease, release() {} }),
      } });
      let inspection: PiNativeInspection | undefined;
      try { inspection = await port.inspect(); }
      catch (error) {
        if (!(error instanceof PiNativeError && error.code === "pi_native_retained_runtime_missing" && error.delivery === "not_sent")) throw error;
      }
      if (inspection) {
        if (retained && retained.runtimeId !== inspection.runtimeId) throw changed();
        retained ??= { serviceIncarnation: lease.serviceIncarnation, runtimeId: inspection.runtimeId };
      }
      return await run(port, inspection);
    } finally { await port?.close(); lease.release(); }
  };
  const initial = await withExisting(async (_port, inspection) => inspection, true);
  if (!initial) return undefined;
  const stop: BackendRuntimeAdministration["stop"] = request => withExisting(async (port, inspection) => {
    if (!inspection) return; // Same authenticated owner positively reports retirement.
    await stopPiNativeRuntime(port!, request);
  });
  return {
    inspect: () => withExisting(async (_port, inspection) => {
      if (!inspection) throw changed();
      const find = context.database.prepare(`SELECT application_thread_id AS applicationThreadId FROM conversation_bindings
        WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ?
          AND backend_conversation_id = ? AND execution_environment_id = ?`);
      return { state: inspection.state, incarnation: inspection.runtimeId, revision: inspection.revision, blockers: inspection.blockers,
        retainedThreadIds: [...new Set(inspection.retainedSessions.flatMap(session => {
          const binding = find.get(context.scope.tenantId, context.scope.principalId, context.instance.id,
            session.sessionId, configuration.executionEnvironmentId) as { applicationThreadId: string } | undefined;
          return binding ? [binding.applicationThreadId] : [];
        }))] };
    }),
    stop,
    restart: stop,
  };
}

function changed(): PiNativeError { return new PiNativeError("pi_native_administration_incarnation_changed", "sent_outcome_unknown"); }
