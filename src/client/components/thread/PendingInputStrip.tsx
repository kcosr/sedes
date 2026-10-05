import { useEffect, useMemo, useRef, useState } from "react";
import { Forward, Trash2, Undo } from "lucide-react";
import type { QueuedInputSummary } from "../../../shared/index.js";
import {
  useThreadStore,
  type PendingComposerTransfer,
  type ThreadClientStore,
} from "../../stores/ThreadClientStore.js";
import { selectTranscriptSubmissions } from "./submission-presentation.js";

type RowAction = "delete" | "restore" | "steer" | "dismiss";

const STATE_LABELS: Readonly<Record<QueuedInputSummary["state"], string>> = {
  pending: "Queued",
  retry_wait: "Retry scheduled",
  dispatching: "Sending",
  uncertain: "Delivery unconfirmed",
  failed: "Failed",
};

function statusLabel(item: QueuedInputSummary): string | undefined {
  if (item.state === "pending") {
    return item.resolvedDeliveryMode === "steer" ? "Pending steer" : undefined;
  }
  if (
    item.state === "retry_wait" &&
    item.resolvedDeliveryMode === "steer"
  ) {
    return "Steer retry scheduled";
  }
  if (item.state === "dispatching" && item.deliveryMode === "steer") {
    return "Steering";
  }
  if (item.state === "uncertain" && item.deliveryMode === "steer") {
    return "Steer unconfirmed";
  }
  // A proven-unused input (for example, a Steer that Stop withdrew) did not
  // fail; it simply never reached the conversation.
  if (item.state === "failed" && item.failureReason === "not_sent") {
    return "Not sent";
  }
  if (item.state === "failed" && item.resolvedDeliveryMode === "steer") {
    return "Steer failed";
  }
  return STATE_LABELS[item.state];
}

function isSteerRow(item: QueuedInputSummary): boolean {
  return item.resolvedDeliveryMode === "steer" || item.deliveryMode === "steer";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The action failed.";
}

function transferPreview(transfer: PendingComposerTransfer): string {
  const text = transfer.captured.text.trim();
  if (text) return text.slice(0, 240);

  const details: string[] = [];
  if (transfer.captured.selectedSkillId) {
    details.push(
      transfer.capturedPresentation.selectedSkillLabel ?? "Selected skill",
    );
  }
  if (transfer.captured.contextExcerpts.length > 0) {
    details.push(
      `${transfer.captured.contextExcerpts.length} context excerpt${
        transfer.captured.contextExcerpts.length === 1 ? "" : "s"
      }`,
    );
  }
  if (transfer.captured.attachments.length > 0) {
    details.push(
      `${transfer.captured.attachments.length} attachment${
        transfer.captured.attachments.length === 1 ? "" : "s"
      }`,
    );
  }
  if (transfer.captured.taskReferences.length > 0) {
    details.push(
      transfer.captured.taskReferences.length === 1
        ? transfer.captured.taskReferences[0]!.titleSnapshot
        : `${transfer.captured.taskReferences.length} tasks`,
    );
  }
  return (details.join(" · ") || "Pending input").slice(0, 240);
}

export function PendingInputStrip({
  store,
  disabled,
  composerInput,
  restoreAvailable,
  restoreUnavailableReason,
  onRestore,
  optimisticTranscriptPresentationVisible,
}: {
  readonly store: ThreadClientStore;
  readonly disabled: boolean;
  readonly composerInput: React.RefObject<HTMLTextAreaElement | null>;
  readonly restoreAvailable: boolean;
  readonly restoreUnavailableReason: string;
  readonly onRestore: (queuedInputId: string) => Promise<void>;
  /** Whether Transcript can currently render client-only submit bubbles. */
  readonly optimisticTranscriptPresentationVisible: boolean;
}): React.JSX.Element | null {
  const state = useThreadStore(store);
  const liveTransfers = useMemo(
    () =>
      state.pendingComposerTransfers
        .filter(
          (transfer) =>
            transfer.authorityState === "client_only" ||
            transfer.authorityState === "queue_owned",
        )
        .sort((a, b) => a.presentationSequence - b.presentationSequence),
    [state.pendingComposerTransfers],
  );
  const authoritativeQueue = useMemo(
    () => [
      ...(state.snapshot?.queue ?? []),
      ...state.pendingQuestionReplies.flatMap((reply) =>
        reply.queuedInput ? [reply.queuedInput] : [],
      ),
    ],
    [state.snapshot?.queue, state.pendingQuestionReplies],
  );
  const sendingQuestionReplies = state.pendingQuestionReplies.filter(
    (reply) => !reply.queuedInput,
  );
  const authoritativeOperationIds = useMemo(
    () =>
      new Set(
        authoritativeQueue.map(
          ({ deliveryOperationId }) => deliveryOperationId,
        ),
      ),
    [authoritativeQueue],
  );
  const materializedUserOperationIds = useMemo(
    () =>
      new Set(
        Object.values(state.snapshot?.itemsById ?? {})
          .filter((item) => item.kind === "user_message")
          .flatMap((item) =>
            item.kind === "user_message" && item.deliveryOperationId
              ? [item.deliveryOperationId]
              : [],
          ),
      ),
    [state.snapshot?.itemsById],
  );
  const pendingSteers = useMemo(() => {
    const composer = liveTransfers
      .filter(
        (transfer) =>
          transfer.presentation === "pending_steer" &&
          !authoritativeOperationIds.has(transfer.operationId) &&
          !materializedUserOperationIds.has(transfer.operationId),
      )
      .map((transfer) => ({
        operationId: transfer.operationId,
        phase: transfer.steerPhase ?? ("sending" as const),
        preview: transferPreview(transfer),
        attachmentCount: transfer.captured.attachments.length,
        taskCount: transfer.captured.taskReferences.length,
        presentationSequence: transfer.presentationSequence,
      }));
    const queued = state.pendingQueuedSteers
      .filter(
        (pending) =>
          !authoritativeQueue.some(
            (item) =>
              item.id === pending.queuedInputId &&
              item.deliveryOperationId === pending.operationId,
          ) &&
          !materializedUserOperationIds.has(pending.operationId),
      )
      .map((pending) => ({
        operationId: pending.operationId,
        phase: pending.phase,
        preview: pending.preview,
        attachmentCount: pending.attachmentCount,
        taskCount: pending.taskCount,
        presentationSequence: pending.presentationSequence,
      }));
    return [...composer, ...queued].sort(
      (left, right) =>
        left.presentationSequence - right.presentationSequence,
    );
  }, [
    authoritativeOperationIds,
    authoritativeQueue,
    liveTransfers,
    materializedUserOperationIds,
    state.pendingQueuedSteers,
  ]);
  const localQueueTransfers = useMemo(
    () =>
      liveTransfers.filter(
        (transfer) =>
          transfer.presentation === "pending_queue" &&
          transfer.authorityState === "client_only" &&
          !authoritativeOperationIds.has(transfer.operationId),
      ),
    [authoritativeOperationIds, liveTransfers],
  );
  const hiddenAuthoritativeOperationIds = useMemo(() => {
    const hidden = new Set<string>();
    if (!optimisticTranscriptPresentationVisible) return hidden;
    for (const submission of selectTranscriptSubmissions(state)) {
      const matching = authoritativeQueue.find(
        (item) => item.deliveryOperationId === submission.operationId,
      );
      if (
        matching &&
        (matching.state === "pending" || matching.state === "dispatching")
      ) {
        hidden.add(submission.operationId);
      }
    }
    return hidden;
  }, [
    authoritativeQueue,
    optimisticTranscriptPresentationVisible,
    state.pendingComposerTransfers,
    state.pendingServerSubmissions,
    state.snapshot,
  ]);
  const queue = useMemo(
    () =>
      [...authoritativeQueue]
        .filter(
          (item) =>
            !hiddenAuthoritativeOperationIds.has(item.deliveryOperationId) &&
            !state.pendingQueuedSteers.some(
              (pending) =>
                pending.queuedInputId === item.id &&
                pending.operationId !== item.deliveryOperationId,
            ) &&
            !materializedUserOperationIds.has(item.deliveryOperationId),
        )
        .sort((a, b) => a.sequence - b.sequence),
    [
      authoritativeQueue,
      hiddenAuthoritativeOperationIds,
      materializedUserOperationIds,
      state.pendingQueuedSteers,
    ],
  );
  // Steers are delivered first-in, first-out, so a Steer card not yet backed
  // by its queue row belongs after the earlier Steer rows already queued and
  // ahead of ordinary queued input that waits for the turn to end.
  const leadingSteerRowCount = useMemo(() => {
    const index = queue.findIndex((item) => !isSteerRow(item));
    return index < 0 ? queue.length : index;
  }, [queue]);
  const steerCapability = state.snapshot?.capabilities.deliveryModes.find(
    ({ id }) => id === "steer",
  );
  const uncertainHead = authoritativeQueue.find((item) => item.state === "uncertain");
  const recoverOperation = state.snapshot?.capabilities.operations.find(
    ({ id }) => id === "recover_uncertain",
  );
  const [reconciling, setReconciling] = useState(false);
  const reconcilingRef = useRef(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  useEffect(() => setRecoveryError(undefined), [uncertainHead?.id]);
  const reconcile = async (): Promise<void> => {
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;
    setReconciling(true);
    setRecoveryError(undefined);
    try {
      await store.recoverUncertain();
    } catch (error) {
      setRecoveryError(errorMessage(error));
    } finally {
      reconcilingRef.current = false;
      setReconciling(false);
    }
  };
  const [pendingActions, setPendingActions] = useState<
    Readonly<Record<string, RowAction>>
  >({});
  const pendingItems = useRef(new Set<string>());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [announcement, setAnnouncement] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  const previousQueue = useRef(queue);
  const focusAfterRemoval = useRef<
    | {
        readonly itemId: string;
        readonly previousIndex: number;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    const existingIds = new Set(queue.map(({ id }) => id));
    setRowErrors((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => existingIds.has(id)),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });

    const requestedFocus = focusAfterRemoval.current;
    if (requestedFocus && !existingIds.has(requestedFocus.itemId)) {
      if (window.matchMedia("(pointer: fine)").matches) {
        const nextItem =
          queue[requestedFocus.previousIndex] ??
          queue[requestedFocus.previousIndex - 1];
        const nextAction = nextItem
          ? rows.current
              .get(nextItem.id)
              ?.querySelector<HTMLButtonElement>(
                ".pending-input-action:not(:disabled)",
              )
          : undefined;
        (nextAction ?? composerInput.current)?.focus();
      }
      focusAfterRemoval.current = undefined;
    }
    previousQueue.current = queue;

  }, [composerInput, queue]);

  const announcementRegion = (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
  );

  if (
    !uncertainHead &&
    pendingSteers.length === 0 &&
    sendingQuestionReplies.length === 0 &&
    queue.length === 0 &&
    localQueueTransfers.length === 0
  ) {
    return announcementRegion;
  }

  const runAction = async (
    item: QueuedInputSummary,
    action: RowAction,
    control: HTMLButtonElement,
  ): Promise<void> => {
    if (pendingItems.current.has(item.id)) return;
    pendingItems.current.add(item.id);
    if (action !== "restore" && document.activeElement === control) {
      focusAfterRemoval.current = {
        itemId: item.id,
        previousIndex: previousQueue.current.findIndex(
          ({ id }) => id === item.id,
        ),
      };
    }
    setPendingActions((current) => ({ ...current, [item.id]: action }));
    setRowErrors((current) => {
      const { [item.id]: _removed, ...remaining } = current;
      return remaining;
    });
    try {
      if (action === "delete") {
        await store.cancelQueuedInput(item.id);
        setAnnouncement(
          `Deleted queued input ${item.sequence}: ${item.preview.text}`,
        );
      } else if (action === "restore") {
        await onRestore(item.id);
        setAnnouncement(
          `Restored queued input ${item.sequence} to the composer: ${item.preview.text}`,
        );
      } else if (action === "steer") {
        await store.steerQueuedInput(item.id);
        setAnnouncement(
          `Steered queued input ${item.sequence} into the active turn: ${item.preview.text}`,
        );
      } else {
        await store.dismissQueueFailure(item.id);
        setAnnouncement(
          item.failureReason === "not_sent"
            ? `Dismissed not-sent input ${item.sequence}: ${item.preview.text}`
            : `Dismissed queued input ${item.sequence} failure: ${item.preview.text}`,
        );
      }
    } catch (error) {
      focusAfterRemoval.current = undefined;
      setRowErrors((current) => ({
        ...current,
        [item.id]: errorMessage(error),
      }));
    } finally {
      pendingItems.current.delete(item.id);
      setPendingActions((current) => {
        const { [item.id]: _removed, ...remaining } = current;
        return remaining;
      });
    }
  };

  const renderPendingSteer = (
    pendingSteer: (typeof pendingSteers)[number],
  ): React.JSX.Element => (
    <li
      className="pending-input-row pending-steer-row"
      data-pending-steer-operation-id={pendingSteer.operationId}
      aria-busy={pendingSteer.phase === "sending"}
      key={`steer:${pendingSteer.operationId}`}
    >
      <span className="pending-input-origin">You</span>
      <span className="pending-input-preview" title={pendingSteer.preview}>
        {pendingSteer.preview}
      </span>
      {pendingSteer.attachmentCount > 0 && (
        <span className="pending-input-attachment-count">
          {pendingSteer.attachmentCount}{" "}
          {pendingSteer.attachmentCount === 1 ? "file" : "files"}
        </span>
      )}
      {pendingSteer.taskCount > 0 && (
        <span className="pending-input-attachment-count">
          {pendingSteer.taskCount}{" "}
          {pendingSteer.taskCount === 1 ? "task" : "tasks"}
        </span>
      )}
      <span
        className="pending-input-state"
        data-state={pendingSteer.phase}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {pendingSteer.phase === "sending"
          ? "Sending steer"
          : pendingSteer.phase === "steering"
            ? "Steering"
            : "Steer unconfirmed"}
      </span>
    </li>
  );

  const renderQueueItem = (item: QueuedInputSummary): React.JSX.Element => {
    // Delete cancels queued work that has not been sent. A failed row was
    // never delivered either, so it offers Restore and Dismiss instead; each
    // failed row is dismissed on its own.
    const userMutable =
      item.origin === "user" &&
      (item.state === "pending" || item.state === "retry_wait");
    const userRestorable =
      userMutable || (item.origin === "user" && item.state === "failed");
    const failed = item.state === "failed";
    const notSent = failed && item.failureReason === "not_sent";
    const pendingAction = pendingActions[item.id];
    const rowPending = pendingAction !== undefined;
    const awaitingProjection = !state.snapshot?.queue.some(
      (projected) => projected.id === item.id,
    );
    const steerUnavailableReason =
      steerCapability?.unavailableReason?.text ??
      "Steer is unavailable right now.";
    const canOfferSteer =
      userMutable && item.isHead && item.resolvedDeliveryMode !== "steer";
    const stateLabel = statusLabel(item);
    const preview =
      item.inputOrigin?.kind === "question_response"
        ? item.inputOrigin.answers
            .map(({ question, answer }) => `${question}: ${answer}`)
            .join(" · ")
        : item.preview.text;
    return (
      <li
        className="pending-input-row"
        data-input-origin={item.origin}
        data-queued-input-id={item.id}
        data-delivery-operation-id={item.deliveryOperationId}
        key={item.id}
        ref={(element) => {
          if (element) rows.current.set(item.id, element);
          else rows.current.delete(item.id);
        }}
        aria-busy={rowPending}
      >
        <span
          className="pending-input-origin"
          title={
            item.inputOrigin?.kind === "question_response"
              ? "Question answered"
              : item.inputOrigin
                ? `${item.inputOrigin.kind === "agent_message" ? "Agent message" : "Agent result"} · ${item.inputOrigin.sourceThreadLabel.text}`
                : undefined
          }
        >
          {item.inputOrigin?.kind === "question_response"
            ? "Question answered"
            : item.origin === "user"
            ? "You"
            : item.origin === "agent_result"
              ? `Agent result · ${item.inputOrigin?.sourceThreadLabel.text ?? "Agent"}`
            : item.origin === "automation"
              ? "Automation"
              : item.origin === "agent_control"
                ? `Agent message · ${item.inputOrigin?.sourceThreadLabel.text ?? "Agent"}`
                : "Tool client"}
        </span>
        <span className="pending-input-preview" title={preview}>
          {preview}
        </span>
        {item.attachmentCount > 0 && (
          <span className="pending-input-attachment-count">
            {item.attachmentCount}{" "}
            {item.attachmentCount === 1 ? "file" : "files"}
          </span>
        )}
        {item.taskCount > 0 && (
          <span className="pending-input-attachment-count">
            {item.taskCount} {item.taskCount === 1 ? "task" : "tasks"}
          </span>
        )}
        {stateLabel && (
          <span
            className="pending-input-state"
            data-state={item.state}
            data-delivery-mode={item.deliveryMode}
            data-failure-reason={failed ? item.failureReason : undefined}
          >
            {stateLabel}
          </span>
        )}
        <span className="pending-input-actions">
          {userMutable && (
            <button
              type="button"
              className="pending-input-action pending-input-delete"
              aria-label={`Delete queued input: ${item.preview.text}`}
              title="Delete queued input"
              disabled={disabled || awaitingProjection || rowPending}
              onClick={(event) =>
                void runAction(item, "delete", event.currentTarget)
              }
            >
              <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          )}
          {userRestorable && (
            <button
              type="button"
              className="pending-input-action pending-input-restore"
              aria-label={`Restore queued input to composer: ${item.preview.text}`}
              title={
                item.restoreUnavailableReason?.text ?? (restoreAvailable ? "Restore to composer" : restoreUnavailableReason)
              }
              disabled={
                disabled || awaitingProjection || rowPending || !restoreAvailable || item.restoreUnavailableReason !== undefined
              }
              onClick={(event) =>
                void runAction(item, "restore", event.currentTarget)
              }
            >
              <Undo size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          )}
          {canOfferSteer && steerCapability && (
            <button
              type="button"
              className="pending-input-action pending-input-steer"
              aria-label={`Steer queued input into active turn: ${item.preview.text}`}
              title={
                steerCapability.available
                  ? "Send this queued input into the active turn"
                  : steerUnavailableReason
              }
              disabled={
                disabled ||
                awaitingProjection ||
                rowPending ||
                !steerCapability.available
              }
              onClick={(event) =>
                void runAction(item, "steer", event.currentTarget)
              }
            >
              <Forward size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          )}
          {failed && (
            <button
              type="button"
              className="pending-input-action pending-input-dismiss"
              aria-label={
                notSent
                  ? `Dismiss not-sent input: ${item.preview.text}`
                  : `Dismiss queued input failure: ${item.preview.text}`
              }
              disabled={disabled || awaitingProjection || rowPending}
              onClick={(event) =>
                void runAction(item, "dismiss", event.currentTarget)
              }
            >
              {pendingAction === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          )}
        </span>
        {canOfferSteer && steerCapability && !steerCapability.available && (
          <span className="pending-input-unavailable">
            {steerUnavailableReason}
          </span>
        )}
        {failed && item.diagnostic && (
          <span className="pending-input-detail">{item.diagnostic.text}</span>
        )}
        {rowErrors[item.id] && (
          <span className="pending-input-error" role="alert">
            {rowErrors[item.id]}
          </span>
        )}
      </li>
    );
  };

  return (
    <section
      className="pending-input-strip"
      aria-label="Pending inputs"
      data-testid="pending-input-strip"
    >
      {uncertainHead && (
        <div className="pending-input-recovery" role="status" data-testid="queue-paused">
          <strong>Queue paused: an earlier delivery needs reconciliation</strong>
          <p>Queued messages cannot dispatch until this is resolved. Your draft and queued messages are preserved.</p>
          <button
            type="button"
            className="pending-input-reconcile"
            disabled={state.connection !== "connected" || !state.authoritative || state.actionPending || reconciling || !recoverOperation?.available}
            title={recoverOperation?.unavailableReason?.text}
            onClick={() => void reconcile()}
          >
            {reconciling ? "Reconciling…" : "Reconcile delivery"}
          </button>
          {recoveryError && <p role="alert">{recoveryError}</p>}
        </div>
      )}
      <ol className="pending-input-list" role="list">
        {sendingQuestionReplies.map((reply) => (
          <li
            className="pending-input-row"
            data-pending-question-reply-id={reply.id}
            aria-busy={!reply.deliveryOperationId}
            key={reply.id}
          >
            <span className="pending-input-origin">Question answered</span>
            <span
              className="pending-input-preview"
              title={reply.answers
                .map(({ question, answer }) => `${question}: ${answer}`)
                .join(" · ")}
            >
              {reply.answers
                .map(({ question, answer }) => `${question}: ${answer}`)
                .join(" · ")}
            </span>
            <span
              className="pending-input-state"
              data-state={reply.deliveryOperationId ? "sent" : "sending"}
              role="status"
              aria-live="polite"
            >
              {reply.deliveryOperationId ? "Sent" : "Sending"}
            </span>
          </li>
        ))}
        {queue.slice(0, leadingSteerRowCount).map(renderQueueItem)}
        {pendingSteers.map(renderPendingSteer)}
        {queue.slice(leadingSteerRowCount).map(renderQueueItem)}
        {localQueueTransfers.map((transfer) => {
          const preview = transferPreview(transfer);
          return (
            <li
              className="pending-input-row"
              data-pending-queue-operation-id={transfer.operationId}
              key={`local:${transfer.operationId}`}
            >
              <span className="pending-input-origin">You</span>
              <span className="pending-input-preview" title={preview}>
                {preview}
              </span>
              {transfer.captured.attachments.length > 0 && (
                <span className="pending-input-attachment-count">
                  {transfer.captured.attachments.length}{" "}
                  {transfer.captured.attachments.length === 1
                    ? "file"
                    : "files"}
                </span>
              )}
              {transfer.captured.taskReferences.length > 0 && (
                <span className="pending-input-attachment-count">
                  {transfer.captured.taskReferences.length}{" "}
                  {transfer.captured.taskReferences.length === 1
                    ? "task"
                    : "tasks"}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {announcementRegion}
    </section>
  );
}
