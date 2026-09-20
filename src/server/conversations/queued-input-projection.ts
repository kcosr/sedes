import type { QueuedInputSummary } from "../../shared/protocol/conversation.js";
import type { QueuedInputRecord } from "../db/repositories/queued-input-repository.js";
import { boundDisplayText, DEFAULT_PAYLOAD_LIMITS } from "./payload-policy.js";

const QUEUE_PREVIEW_LIMITS = {
  ...DEFAULT_PAYLOAD_LIMITS,
  maximumDisplayTextBytes: 240,
};

const projectedQueueStates = new Set<QueuedInputRecord["state"]>([
  "pending",
  "retry_wait",
  "dispatching",
  "uncertain",
  "failed",
]);

function queuedInputPreview(item: QueuedInputRecord) {
  const text = item.text.trim();
  if (text.length > 0) return boundDisplayText(text, QUEUE_PREVIEW_LIMITS);
  const taskCount = item.taskContexts.length;
  if (taskCount > 0) {
    const firstTitle = item.taskContexts[0]!.title.trim();
    const additional = taskCount - 1;
    const suffix =
      additional === 0
        ? ""
        : ` · +${additional} task${additional === 1 ? "" : "s"}`;
    return boundDisplayText(
      firstTitle.length > 0
        ? `${firstTitle}${suffix}`
        : `${taskCount} attached task${taskCount === 1 ? "" : "s"}`,
      QUEUE_PREVIEW_LIMITS,
    );
  }
  const contextCount = item.contextExcerpts.length;
  const contextLabel = `${contextCount} context excerpt${contextCount === 1 ? "" : "s"}`;
  const fallback = item.selectedSkillId
    ? contextCount > 0
      ? `Selected skill · ${contextLabel}`
      : "Selected skill"
    : contextCount > 0
      ? contextLabel
      : "Queued input";
  return boundDisplayText(fallback, QUEUE_PREVIEW_LIMITS);
}

function queuedInputDeliveryMode(
  item: QueuedInputRecord,
): Pick<QueuedInputSummary, "deliveryMode"> | Record<string, never> {
  const requiresDeliveryMode =
    item.state === "dispatching" || item.state === "uncertain";
  if (requiresDeliveryMode && item.deliveryMode === null) {
    throw new Error("queued_input_delivery_mode_missing");
  }
  if (!requiresDeliveryMode && item.deliveryMode !== null) {
    throw new Error("queued_input_delivery_mode_unexpected");
  }
  return item.deliveryMode === null ? {} : { deliveryMode: item.deliveryMode };
}

/** One normalized projection for both snapshots and queue change events. */
export function projectQueuedInputSummaries(
  records: readonly QueuedInputRecord[],
): QueuedInputSummary[] {
  const active = records.filter(
    (item) =>
      projectedQueueStates.has(item.state) &&
      !(item.state === "failed" && item.failureAcknowledgedAt !== null),
  );
  return active.slice(0, 500).map((item, index) => ({
    id: item.id,
    deliveryOperationId:
      item.deliveryMode === "steer"
        ? (item.reconciliationToken ?? item.mutationId)
        : item.mutationId,
    sequence: item.sequence,
    origin:
      item.inputOrigin?.kind === "agent_result"
        ? "agent_result"
        : item.initiatingAgentThreadId !== null
          ? "agent_control"
          : item.initiatingToolClientId !== null
            ? "principal_client_control"
            : item.triggerKind,
    ...(item.inputOrigin === null ? {} : { inputOrigin: item.inputOrigin }),
    ...(item.initiatingAgentThreadId === null
      ? {}
      : { initiatingAgentThreadId: item.initiatingAgentThreadId }),
    ...(item.initiatingToolClientId === null
      ? {}
      : { initiatingToolClientId: item.initiatingToolClientId }),
    isHead: index === 0,
    state: item.state as QueuedInputSummary["state"],
    resolvedDeliveryMode: item.resolvedDeliveryMode,
    attachmentCount: item.attachments.length,
    taskCount: item.taskContexts.length,
    ...(item.requestedDeliveryMode === null
      ? {}
      : {
          requestedDeliveryMode: item.requestedDeliveryMode,
        }),
    ...queuedInputDeliveryMode(item),
    preview: queuedInputPreview(item),
    createdAt: new Date(item.createdAt).toISOString(),
    ...(item.nextAttemptAt === null
      ? {}
      : { nextAttemptAt: new Date(item.nextAttemptAt).toISOString() }),
    ...(item.diagnostic === null
      ? {}
      : { diagnostic: boundDisplayText(item.diagnostic) }),
  }));
}
