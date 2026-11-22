import type { BackendModuleRuntimeContext, BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../module.js";
import { AntigravityError, type AntigravityInspection, type AntigravityPort, type AntigravityRuntimeConfiguration } from "./port.js";
import { AntigravityRemotePort } from "./sidecar/remote-port.js";
import { antigravityRuntimeOperations } from "./sidecar/wire.js";

type Context = Pick<BackendModuleRuntimeContext, "database" | "scope" | "instance">;

export function antigravityAdministration(
  context: Context,
  executionEnvironmentId: string,
  port: AntigravityPort,
): BackendRuntimeAdministration {
  const stop: BackendRuntimeAdministration["stop"] = request => port.stop(request);
  return {
    inspect: async () => projectInspection(context, executionEnvironmentId, await port.inspect()),
    stop,
    restart: stop,
  };
}

/** Recover only the matching retained host; never ensure or start a replacement. */
export async function recoverAntigravityAdministration(
  context: BackendRuntimeRecoveryContext,
  configuration: AntigravityRuntimeConfiguration,
): Promise<BackendRuntimeAdministration | undefined> {
  let retained: { runtimeId: string; serviceIncarnation: string } | undefined;
  const withRetained = async <T>(
    run: (port: AntigravityRemotePort | undefined, inspection: AntigravityInspection | undefined) => Promise<T>,
  ): Promise<T> => {
    const lease = await context.sidecarRuntime.acquireRecovery();
    let port: AntigravityRemotePort | undefined;
    try {
      lease.channel.assertReady();
      if (retained && retained.serviceIncarnation !== lease.serviceIncarnation) throw incarnationChanged();
      const operations = antigravityRuntimeOperations.map(operation => lease.channel.supportsOperation(operation));
      if (!retained && operations.every(supported => !supported)) return await run(undefined, undefined);
      if (!operations.every(Boolean)) throw new AntigravityError("antigravity_remote_unsupported");
      port = new AntigravityRemotePort({
        configuration, existingOnly: true,
        sidecarRuntime: {
          acquire: async () => { throw new AntigravityError("antigravity_recovery_launch_denied"); },
          acquireExisting: async () => ({ ...lease, release() {} }),
        },
      });
      let inspection: AntigravityInspection | undefined;
      try { inspection = await port.inspect(); }
      catch (error) {
        if (!(error instanceof AntigravityError && error.code === "antigravity_retained_runtime_missing" &&
            error.delivery === "not_sent")) throw error;
      }
      if (inspection) {
        if (retained && inspection.runtimeId !== retained.runtimeId) throw incarnationChanged();
        retained ??= { runtimeId: inspection.runtimeId, serviceIncarnation: lease.serviceIncarnation };
      }
      return await run(port, inspection);
    } finally {
      try { await port?.close(); } finally { lease.release(); }
    }
  };
  if (!await withRetained(async (_port, inspection) => inspection !== undefined)) return undefined;
  const stop: BackendRuntimeAdministration["stop"] = request => withRetained(async (port, inspection) => {
    // Same service positively reports the runtime absent after retirement.
    if (!inspection || !port) return;
    await port.stop(request);
  });
  return {
    inspect: () => withRetained(async (_port, inspection) => {
      if (!inspection) throw incarnationChanged();
      return projectInspection(context, configuration.executionEnvironmentId, inspection);
    }),
    stop,
    restart: stop,
  };
}

function projectInspection(context: Context, executionEnvironmentId: string, result: AntigravityInspection) {
  const findThread = context.database.prepare(`
    SELECT application_thread_id AS id FROM conversation_bindings
    WHERE tenant_id = ? AND owner_principal_id = ? AND backend_instance_id = ?
      AND execution_environment_id = ? AND backend_conversation_id = ?
  `);
  const retainedThreadIds = result.retainedSessions.flatMap(session => {
    const row = findThread.get(context.scope.tenantId, context.scope.principalId, context.instance.id,
      executionEnvironmentId, session.sessionId) as { id: string } | undefined;
    return row ? [row.id] : [];
  });
  return { state: result.state, incarnation: result.runtimeId, revision: result.revision,
    blockers: result.blockers, retainedThreadIds: [...new Set(retainedThreadIds)] };
}

function incarnationChanged(): AntigravityError {
  return new AntigravityError("antigravity_administration_incarnation_changed", "sent_outcome_unknown");
}
