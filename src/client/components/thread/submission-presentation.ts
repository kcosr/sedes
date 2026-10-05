import type {
  PendingComposerTransfer,
  PendingServerSubmission,
  ThreadClientState,
} from "../../stores/ThreadClientStore.js";

/** Delivery presentation stays separate from both composer ownership and history. */
export type TranscriptSubmission =
  | PendingComposerTransfer
  | PendingServerSubmission;

export function isServerSubmission(
  submission: TranscriptSubmission,
): submission is PendingServerSubmission {
  return "kind" in submission && submission.kind === "server";
}

export function isVisibleComposerSubmit(
  transfer: PendingComposerTransfer,
): boolean {
  return (
    transfer.mode === "submit" &&
    transfer.presentation === "transcript" &&
    transfer.authorityState === "client_only"
  );
}

/** One selection rule for transcript bubbles and the queue rows they replace. */
export function selectTranscriptSubmissions(
  state: Pick<
    ThreadClientState,
    "snapshot" | "pendingComposerTransfers" | "pendingServerSubmissions"
  >,
): TranscriptSubmission[] {
  if (
    state.pendingComposerTransfers.length === 0 &&
    state.pendingServerSubmissions.length === 0
  ) {
    return [];
  }
  const materialized = new Set(
    Object.values(state.snapshot?.itemsById ?? {}).flatMap((item) =>
      item.kind === "user_message" && item.deliveryOperationId
        ? [item.deliveryOperationId]
        : [],
    ),
  );
  const composer = state.pendingComposerTransfers.filter(
    (transfer) =>
      isVisibleComposerSubmit(transfer) &&
      !materialized.has(transfer.operationId),
  );
  const localOperations = new Set(composer.map(({ operationId }) => operationId));
  const queueByOperation = new Map(
    state.snapshot?.queue.map((item) => [item.deliveryOperationId, item]),
  );
  const queueById = new Map(
    state.snapshot?.queue.map((item) => [item.id, item]),
  );
  const server = state.pendingServerSubmissions.filter((submission) => {
    if (
      localOperations.has(submission.operationId) ||
      materialized.has(submission.operationId) ||
      (!submission.content && submission.phase !== "unconfirmed")
    ) {
      return false;
    }
    const queued = queueByOperation.get(submission.operationId) ??
      (submission.queuedInputId ? queueById.get(submission.queuedInputId) : undefined);
    // A missing row can be an accepted submission awaiting its provider item.
    // The server-submission tracker, rather than queue absence, owns retirement.
    return (
      !queued ||
      ((!submission.queuedInputId || queued.id === submission.queuedInputId) &&
        queued.deliveryOperationId === submission.operationId &&
        queued.origin === "user" &&
        queued.inputOrigin === undefined &&
        queued.resolvedDeliveryMode === "submit" &&
        (queued.state === "pending" || queued.state === "dispatching"))
    );
  });
  return [...composer, ...server].sort(
    (left, right) => left.presentationSequence - right.presentationSequence,
  );
}
