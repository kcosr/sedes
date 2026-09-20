import { randomUUID } from "node:crypto";
import type { BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../../module.js";
import type { CodexRuntimeConfiguration } from "./codex-runtime-host-registry.js";
import { CodexSidecarRuntimeConnection } from "./codex-sidecar-runtime.js";
import { CodexRuntimeReceiptStore } from "./codex-runtime-receipt-store.js";

/** Controls a retained provider without requiring an application runtime or
 * native subscription. Every call reacquires only an existing sidecar and
 * repeats both configuration and incarnation checks before taking authority. */
export async function recoverCodexRuntimeAdministration(input: {
  context: BackendRuntimeRecoveryContext;
  configuration: CodexRuntimeConfiguration;
}): Promise<BackendRuntimeAdministration | undefined> {
  const { context, configuration } = input;
  const executionEnvironmentIds = new Set(context.connections.map(connection => connection.executionEnvironmentId));
  const executionEnvironmentId = [...executionEnvironmentIds][0];
  if (executionEnvironmentIds.size !== 1 || !executionEnvironmentId) throw new Error("codex_runtime_configuration_scope_denied");
  const scope = { ...context.scope, executionEnvironmentId, backendInstanceId: context.instance.id };
  const receipts = new CodexRuntimeReceiptStore(context.database);
  const inspectExisting = async <T>(run: (
    connection: CodexSidecarRuntimeConnection,
    runtimeId: string | undefined,
    controllerId: string,
  ) => Promise<T>): Promise<T> => {
    const lease = await context.sidecarRuntime.acquireRecovery();
    const connection = new CodexSidecarRuntimeConnection(lease.channel);
    try {
      const runtimeId = await connection.lookup(configuration);
      if (runtimeId) {
        const authority = { scope, runtimeId, controllerId: String(lease.controllerEpoch) };
        receipts.reconcileRecordedApplicationState(authority);
        for (const reference of await connection.recoverOutcomes(authority)) {
          let outcome;
          try { outcome = await connection.recoverOutcome(authority, reference.operationId); }
          catch (error) {
            // An attached module may have durably recorded and acknowledged
            // this outcome after the snapshot. Confirm absence with the same
            // authenticated owner; carrier failures still reject recovery.
            const remaining = await connection.recoverOutcomes(authority);
            if (remaining.some(value => value.operationId === reference.operationId)) throw error;
            continue;
          }
          if (outcome.status === "pending") continue;
          receipts.recordOutcome(authority, outcome);
          await connection.acknowledgeRecoveredOutcome(authority, outcome.operationId);
        }
      }
      return await run(connection, runtimeId, String(lease.controllerEpoch));
    } finally {
      connection.close();
      lease.release();
    }
  };
  const runtimeId = await inspectExisting(async (_connection, runtimeId) => runtimeId);
  if (!runtimeId) return undefined;
  const assertIncarnation = (current: string | undefined) => {
    if (current !== runtimeId) throw new Error("codex_runtime_administration_incarnation_changed");
  };
  const stop: BackendRuntimeAdministration["stop"] = async ({ expectedRevision, force }) => {
    await inspectExisting(async (connection, current, controllerId) => {
      // The authenticated owner can positively confirm that this exact runtime
      // is already gone. An unavailable transport never enters this branch.
      if (!current) return;
      assertIncarnation(current);
      const authority = { scope, runtimeId, controllerId };
      const retirementOperationId = randomUUID();
      await connection.stop(authority, expectedRevision, force);
      if (receipts.pending(authority).length === 0) receipts.compactRetiredRuntime(authority, {
        disposition: "confirmed_retired", runtimeId, retirementOperationId, retiredAt: Date.now(),
      });
    });
  };
  return {
    inspect: async () => await inspectExisting(async (connection, current, controllerId) => {
      assertIncarnation(current);
      return await connection.inspect({ scope, runtimeId, controllerId });
    }),
    stop,
    // Recovery has no launch authority. Application composition explicitly
    // applies the desired runtime after positively retiring this incarnation.
    restart: stop,
  };
}
