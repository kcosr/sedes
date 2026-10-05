import type { QueuedInputSummary } from "../../shared/protocol/conversation.js";
import { MAXIMUM_DRAFT_BYTES, OVERSIZED_COMPOSER_RESTORE_REASON } from "../../shared/protocol/context-excerpts.js";
import {
  queuedInputPresentationSchema,
  type QueuedInputPresentation,
} from "../../shared/protocol/api.js";
import type { QueuedInputRecord } from "../db/repositories/queued-input-repository.js";
import { presentMessageTaskContext } from "../domain/materialized-task-contexts.js";
import {
  boundDisplayText,
  DEFAULT_PAYLOAD_LIMITS,
  preserveMessageText,
} from "./payload-policy.js";

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

function queuedInputOrigin(item: QueuedInputRecord): QueuedInputSummary["origin"] {
  return item.inputOrigin?.kind === "agent_result"
    ? "agent_result"
    : item.initiatingAgentThreadId !== null
      ? "agent_control"
      : item.initiatingToolClientId !== null
        ? "principal_client_control"
        : item.triggerKind;
}

/** Full application-owned input, including terminal records omitted from the pending queue. */
export function projectQueuedInputPresentation(
  item: QueuedInputRecord,
  threadRevision: number,
  deliveryOperationId: string,
): QueuedInputPresentation {
  const parsed = queuedInputPresentationSchema.safeParse({
    threadId: item.applicationThreadId,
    threadRevision,
    queuedInputId: item.id,
    deliveryOperationId,
    createdAt: new Date(item.createdAt).toISOString(),
    state: item.state,
    resolvedDeliveryMode: item.resolvedDeliveryMode,
    origin: queuedInputOrigin(item),
    ...(item.inputOrigin === null ? {} : { inputOrigin: item.inputOrigin }),
    content: [
      // The queue stores the selected ID, not a display name. Never present an
      // opaque, potentially provider-owned ID as if it were the skill's name.
      ...(item.selectedSkillId === null
        ? []
        : [{ kind: "skill", name: { text: "Selected skill" } }]),
      ...item.attachments.map((attachment) => ({ kind: "attachment", attachment })),
      ...item.taskContexts.map((task) => ({
        kind: "task_context",
        task: presentMessageTaskContext(task),
      })),
      ...item.contextExcerpts.map((excerpt) => ({ kind: "context_excerpt", excerpt })),
      ...(item.text.trim().length === 0
        ? []
        : [{ kind: "text", text: preserveMessageText(item.text) }]),
    ],
  });
  // Invalid retained data is a server fault, not a refusal of the admitted input.
  if (!parsed.success) {
    throw new Error("queued_input_presentation_unpresentable", { cause: parsed.error });
  }
  return parsed.data;
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
    origin: queuedInputOrigin(item),
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
    ...(Buffer.byteLength(item.text, "utf8") > MAXIMUM_DRAFT_BYTES
      ? { restoreUnavailableReason: { text: OVERSIZED_COMPOSER_RESTORE_REASON } }
      : {}),
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
    ...(item.state === "failed" && item.failureReason !== null
      ? { failureReason: item.failureReason }
      : {}),
  }));
}
