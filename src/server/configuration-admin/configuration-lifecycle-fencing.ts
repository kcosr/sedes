import type { SidecarManagementReceipt } from "../../internal/sidecar-protocol/service-management-v1.js";
import type {
  ConfigurationLifecycleRequest,
  ConfigurationLifecycleResult,
} from "../../shared/protocol/configuration-admin.js";

export interface PendingConfigurationLifecycle {
  readonly request: ConfigurationLifecycleRequest;
  readonly result: ConfigurationLifecycleResult;
}

/** The caller supplies an owner resolved within the current principal's environment. */
export interface LifecycleReceiptManagement {
  inspectServiceReceipt(mutationId: string): Promise<SidecarManagementReceipt | undefined>;
  withdrawServiceReceipt(mutationId: string, expectedServiceIncarnation: string): Promise<SidecarManagementReceipt | undefined>;
  /** Undefined proves the service retired or its target lifetime ended.
   * Unreachable or uncertain ownership must reject instead. */
  inspectService(): Promise<{ readonly serviceIncarnation: string } | undefined>;
}

export type LifecycleStopFenceResult = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/**
 * Explicit Stop may replace an unknown command, but cannot cancel an admitted
 * remote operation. Invoke under the configuration execution lock, after the
 * service has excluded any still-running main-side command for this resource.
 * Pending receipts and the management owner must come from the same scope.
 */
export async function fencePriorLifecycleForStop(input: {
  readonly request: ConfigurationLifecycleRequest;
  readonly pending: readonly PendingConfigurationLifecycle[];
  /** False only when this resource has no remote executor, never merely
   * because its configured remote owner is unavailable. */
  readonly priorHasRemoteExecutor: boolean;
  readonly management?: LifecycleReceiptManagement;
  readonly recover: (entry: PendingConfigurationLifecycle) => Promise<ConfigurationLifecycleResult | undefined>;
  readonly complete: (entry: PendingConfigurationLifecycle, result: ConfigurationLifecycleResult) => void | Promise<void>;
}): Promise<LifecycleStopFenceResult> {
  if (input.request.action !== "stop") return { allowed: true };
  const previous = input.pending.filter(entry => entry.request.mutationId !== input.request.mutationId &&
    entry.request.resourceKind === input.request.resourceKind && entry.request.resourceId === input.request.resourceId &&
    (entry.result.state === "pending" || entry.result.state === "unknown"));
  for (const entry of previous) {
    const blocked = (message: string): LifecycleStopFenceResult => ({ allowed: false, message });
    const complete = async (result: ConfigurationLifecycleResult) => {
      // A new Stop already changed the live preference/revision. Retiring the
      // older receipt must preserve its original admission, not overwrite Stop.
      await input.complete(entry, { ...result, mutationId: entry.request.mutationId, runtime: {
        ...result.runtime,
        resourceKind: entry.result.runtime.resourceKind, resourceId: entry.result.runtime.resourceId,
        desiredRevision: entry.result.runtime.desiredRevision, preference: entry.result.runtime.preference,
      } });
    };
    const settle = async (state: "rejected" | "unavailable", message: string) => complete({
      ...entry.result, state, runtime: { ...entry.result.runtime, applyState: state, lastError: message },
    });
    const recover = async (): Promise<boolean> => {
      let recovered: ConfigurationLifecycleResult | undefined;
      try { recovered = await input.recover(entry); } catch { return false; }
      if (!recovered || recovered.state === "pending" || recovered.state === "unknown") return false;
      await complete(recovered);
      return true;
    };
    if (!input.priorHasRemoteExecutor) {
      if (await recover()) continue;
      // The caller already excluded a running main-side execution. With no
      // remote executor, no old command can race a fresh cleanup attempt.
      await settle("unavailable", "The previous local command's outcome was not confirmed. It was superseded by explicit Stop.");
      continue;
    }
    if (entry.request.resourceKind !== "environment" || !["stop", "restart", "upgrade"].includes(entry.request.action)) {
      if (await recover()) continue;
      return blocked(entry.request.resourceKind === "backend"
        ? "The previous backend command is still unconfirmed. Refresh its result, or stop its execution environment to end the owning sidecar."
        : "The previous connection command is still unconfirmed. Refresh its result before stopping the environment.");
    }
    const management = input.management;
    if (!management || entry.request.expectedIncarnation === null) {
      return blocked("The previous sidecar command cannot be fenced until its execution host is reachable. Reconnect the host and refresh its result.");
    }
    let receipt: SidecarManagementReceipt | undefined;
    try {
      receipt = await management.inspectServiceReceipt(entry.request.mutationId);
      if (receipt && (receipt.mutationId !== entry.request.mutationId || receipt.serviceIncarnation !== entry.request.expectedIncarnation)) {
        return blocked("The previous sidecar command's receipt could not be verified. Refresh its result before stopping.");
      }
      if (!receipt || receipt.state === "accepted") {
        const service = await management.inspectService();
        if (service && service.serviceIncarnation !== entry.request.expectedIncarnation) {
          // A new exclusive owner fences commands addressed to the retired
          // incarnation, even if its final receipt was lost during shutdown.
          await settle("unavailable", "The previous command's sidecar has been replaced. Its final outcome was not confirmed; Stop now targets the current sidecar.");
          continue;
        }
        if (!service) {
          if (await recover()) continue;
          // The management carrier proves retirement independently of the
          // receipt ledger. A crash after shutdown can leave accepted behind.
          await settle("unavailable", "The previous command's sidecar is no longer present. Its final outcome was not confirmed before Stop.");
          continue;
        }
        if (!receipt) {
          // Atomic withdrawal either prevents late admission or returns the
          // operation that won the race. It never cancels admitted execution.
          receipt = await management.withdrawServiceReceipt(entry.request.mutationId, entry.request.expectedIncarnation);
        }
      }
    } catch {
      return blocked("The previous sidecar command could not be fenced. Restore host management access and refresh its result before stopping.");
    }
    if (!receipt || receipt.mutationId !== entry.request.mutationId || receipt.serviceIncarnation !== entry.request.expectedIncarnation) {
      return blocked("The previous sidecar command's receipt could not be verified. Refresh its result before stopping.");
    }
    if (receipt.state === "accepted") {
      return blocked("The sidecar is still finishing the previous command. Refresh its result, then stop the environment when that command finishes.");
    }
    // All remaining receipt states are terminal. Recovery can improve the
    // recorded outcome, but an unavailable probe cannot resurrect execution.
    if (await recover()) continue;
    if (receipt.state === "completed") {
      await settle("unavailable", "The previous sidecar command finished, but its requested end state was not confirmed before Stop.");
    } else {
      await settle("rejected", receipt.state === "withdrawn"
        ? "The previous sidecar command was withdrawn before admission so Stop could proceed."
        : "The previous sidecar command ended without completing its requested state. Stop may now proceed.");
    }
  }
  return { allowed: true };
}
