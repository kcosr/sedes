import { prepareCached } from "../../db/prepared-statements.js";
import { ConversationCreationRepository } from "../../db/repositories/conversation-creation-repository.js";
import type { AntigravityThreadPersistence } from "./thread-persistence.js";
import { ConversationOperationRepository } from "../../db/repositories/conversation-operation-repository.js";
import { SubmissionCompletionRepository } from "../../db/repositories/submission-completion-repository.js";
import type { BackendModuleRuntimeContext, BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../module.js";
import { AntigravityError, type AntigravityInspection, type AntigravityPort, type AntigravityRuntimeConfiguration } from "./port.js";
import { AntigravityRemotePort } from "./sidecar/remote-port.js";
import { antigravityRuntimeOperations } from "./sidecar/wire.js";

type Context = Pick<BackendModuleRuntimeContext, "database" | "scope" | "instance">;

export function antigravityAdministration(
  context: Context,
  executionEnvironmentId: string,
  bindings: Pick<AntigravityThreadPersistence, "getBindingDetail">,
  port: Pick<AntigravityPort, "inspect" | "stop" | "attachExisting" | "outcome" | "acknowledgeCreation" | "acknowledgeOperation">,
): BackendRuntimeAdministration {
  const stop: BackendRuntimeAdministration["stop"] = request => port.stop(request);
  return {
    inspect: async () => projectInspection(context, executionEnvironmentId, await port.inspect()),
    reconcileForUpgrade: async signal => {
      let inspection;
      try { inspection = await port.inspect(signal); }
      catch (error) {
        if (error instanceof AntigravityError && error.code === "antigravity_retained_runtime_missing" && error.delivery === "not_sent") return;
        throw error;
      }
      if (!inspection.blockers.includes("unsettled_outcome")) return;
      const creations = new ConversationCreationRepository(context.database);
      const completions = new SubmissionCompletionRepository(context.database);
      const operations = new ConversationOperationRepository(context.database);
      const acceptedControl = prepareCached(context.database, `
        SELECT 1 FROM mutation_receipts WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND mutation_id = ?
          AND operation_kind IN ('conversation_interrupt', 'conversation_settings', 'conversation_interaction_response')
          AND result_code = 'accepted'
      `);
      for (const session of inspection.retainedSessions) {
        signal.throwIfAborted();
        const threadId = boundThread(context, executionEnvironmentId, session);
        if (!threadId || !bindings.getBindingDetail(context.scope, threadId)) continue;
        const attachment = await port.attachExisting({ sessionId: session.sessionId, cwd: session.cwd }, signal);
        if (!attachment || attachment.sessionId !== session.sessionId || attachment.cwd !== session.cwd ||
            attachment.handleId !== session.handleId || attachment.generation !== session.generation) continue;
        if (attachment.createdByOperationId) {
          const creation = creations.findByMutationId(context.scope, attachment.createdByOperationId);
          if (creation?.phase === "bound" && creation.applicationThreadId === threadId && creation.backendInstanceId === context.instance.id &&
              creation.executionEnvironmentId === executionEnvironmentId && creation.provisionalBackendConversationId === session.sessionId) {
            signal.throwIfAborted();
            await port.acknowledgeCreation({ sessionId: session.sessionId, cwd: session.cwd, operationId: attachment.createdByOperationId }, signal);
          }
        }
        for (const operationId of attachment.retainedOperationIds) {
          signal.throwIfAborted();
          const abandoned = operations.isOperationAbandoned(context.scope, threadId, operationId);
          if (!abandoned) {
            const completion = completions.find(context.scope, threadId, operationId);
            const delivered = completion?.backendCorrelation === operationId && completion.completionOutcome !== null;
            if (!delivered && !acceptedControl.get(context.scope.tenantId, context.scope.principalId, threadId, operationId)) continue;
          }
          const operation = { handleId: session.handleId, operationId };
          const outcome = await port.outcome(operation, signal);
          // An accepted control or finalized submission already has its result on main.
          // Explicit abandonment releases even an unknown delivery once its callback ends.
          if (outcome.status === "pending" || (!abandoned && outcome.status !== "completed")) continue;
          signal.throwIfAborted();
          await port.acknowledgeOperation(operation, signal);
        }
      }
    },
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
        configuration, existingOnly: true, confirmNativeOwner: context.confirmNativeOwner,
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
        context.confirmNativeOwner?.(null, configuration.backendInstanceId);
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

function boundThread(context: Context, executionEnvironmentId: string, session: AntigravityInspection["retainedSessions"][number]) {
  const row = prepareCached(context.database, `
    SELECT b.application_thread_id AS id FROM conversation_bindings b
    JOIN application_threads t ON t.id = b.application_thread_id AND t.tenant_id = b.tenant_id
      AND t.owner_principal_id = b.owner_principal_id
    JOIN workspaces w ON w.id = t.workspace_id AND w.tenant_id = t.tenant_id AND w.owner_principal_id = t.owner_principal_id
    WHERE b.tenant_id = ? AND b.owner_principal_id = ? AND b.backend_instance_id = ?
      AND b.execution_environment_id = ? AND b.backend_conversation_id = ? AND w.canonical_path = ?
  `).get(context.scope.tenantId, context.scope.principalId, context.instance.id,
    executionEnvironmentId, session.sessionId, session.cwd) as { id: string } | undefined;
  return row?.id;
}

function projectInspection(context: Context, executionEnvironmentId: string, result: AntigravityInspection) {
  const retainedThreadIds = result.retainedSessions.flatMap(session => boundThread(context, executionEnvironmentId, session) ?? []);
  return { state: result.state, incarnation: result.runtimeId, revision: result.revision,
    blockers: result.blockers, retainedThreadIds: [...new Set(retainedThreadIds)] };
}

function incarnationChanged(): AntigravityError {
  return new AntigravityError("antigravity_administration_incarnation_changed", "sent_outcome_unknown");
}
