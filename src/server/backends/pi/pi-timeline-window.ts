/**
 * Pi timeline window selection: the newest whole-turn snapshot window and the
 * contiguous history pages before it, bounded by Pi's per-turn item policy
 * and the backend aggregate wire contract.
 */
import {
  backendConversationSnapshotSchema,
  backendHistoryPageSchema,
  type BackendConversationSnapshot,
  type BackendItem,
} from "../../../shared/protocol/backend.js";
import { serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import {
  BackendError,
  type BackendHistoryPage,
  type EstablishedBackendProjection,
} from "../contracts.js";

const targetPiTimelinePayloadBytes = 256 * 1_024;
const maximumPiItemsPerTurn = 1_000;
const maximumPiSnapshotOrPageBytes = 4 * 1_024 * 1_024;

/** Pi's only image items are the children of viewed images. */
function isPiViewedImageChild(item: BackendItem | undefined): boolean {
  return item?.semanticKind === "image" && item.origin.kind === "viewed";
}

/**
 * The snapshot without viewed-image children. Window selection and Pi's
 * per-turn item bound measure this, so a child never changes which turns are
 * transferred and never fails a transfer.
 */
function withoutPiViewedImageChildren(
  snapshot: BackendConversationSnapshot,
): BackendConversationSnapshot {
  const entries = Object.entries(snapshot.itemsById);
  if (!entries.some(([, item]) => isPiViewedImageChild(item))) {
    return snapshot;
  }
  return {
    ...snapshot,
    itemsById: Object.fromEntries(
      entries.filter(([, item]) => !isPiViewedImageChild(item)),
    ),
    turnsById: Object.fromEntries(
      Object.entries(snapshot.turnsById).map(([turnId, turn]) => [
        turnId,
        {
          ...turn,
          orderedBackendItemIds: turn.orderedBackendItemIds.filter(
            (itemId) => !isPiViewedImageChild(snapshot.itemsById[itemId]),
          ),
        },
      ]),
    ),
  };
}

/**
 * Selects the newest contiguous whole-turn window that satisfies both Pi's
 * count policy and the backend aggregate wire contract.
 *
 * Viewed-image children are excluded from every measurement. Each pairs with
 * a counted viewed item, so a selected turn carries at most twice Pi's item
 * bound, far below the shared per-turn limit. The children are returned with
 * their turns unless they would exceed the byte ceiling, in which case the
 * rows are returned without them.
 */
export function selectPiSnapshotWindow(
  snapshot: BackendConversationSnapshot,
  maximumTurns: number,
  conversationId: string,
): BackendConversationSnapshot {
  const end = snapshot.orderedBackendTurnIds.length;
  if (end === 0) {
    return backendConversationSnapshotSchema.parse(
      snapshotPayload(snapshot, []),
    );
  }
  const measured = withoutPiViewedImageChildren(snapshot);
  const earliestByCount = Math.max(0, end - maximumTurns);
  const bytesFrom = (source: BackendConversationSnapshot, start: number) => {
    const candidateIds = source.orderedBackendTurnIds.slice(start, end);
    const candidate = snapshotPayload(source, candidateIds);
    const historyCandidate = historyPagePayload(
      source,
      conversationId,
      start,
      end,
    );
    return Math.max(
      serializedUtf8Bytes(candidate),
      serializedUtf8Bytes(historyCandidate),
    );
  };
  const bytesAt = (start: number) => bytesFrom(measured, start);
  const newestBytes = bytesAt(end - 1);
  if (newestBytes > maximumPiSnapshotOrPageBytes) {
    throw oversizedTurn();
  }
  const start =
    newestBytes > targetPiTimelinePayloadBytes
      ? end - 1
      : earliestStartWithinBytes(
          earliestByCount,
          end - 1,
          targetPiTimelinePayloadBytes,
          bytesAt,
        );
  const selectedIds = snapshot.orderedBackendTurnIds.slice(start, end);
  assertTransferablePiTurns(measured, selectedIds);
  const source =
    measured === snapshot ||
    bytesFrom(snapshot, start) > maximumPiSnapshotOrPageBytes
      ? measured
      : snapshot;
  return backendConversationSnapshotSchema.parse(
    snapshotPayload(source, selectedIds),
  );
}

/**
 * Selects one authoritative Pi projection seed and the exact private boundary
 * immediately before it. The cursor is derived from the complete persisted
 * branch projection, never from the already-trimmed in-memory suffix.
 */
export function selectPiProjectionWindow(
  snapshot: BackendConversationSnapshot,
  maximumTurns: number,
  conversationId: string,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly history: EstablishedBackendProjection["history"];
} {
  const selected = selectPiSnapshotWindow(
    snapshot,
    maximumTurns,
    conversationId,
  );
  const start =
    selected.orderedBackendTurnIds.length === 0
      ? 0
      : snapshot.orderedBackendTurnIds.indexOf(
          selected.orderedBackendTurnIds[0]!,
        );
  if (start < 0) {
    throw new Error("pi_projection_window_boundary_missing");
  }
  return {
    snapshot: selected,
    history: {
      operational: true,
      ...(start > 0
        ? {
            previousCursor: `pi-history:${encodeURIComponent(conversationId)}:${start}`,
          }
        : {}),
    },
  };
}

function earliestStartWithinBytes(
  earliest: number,
  latest: number,
  maximumBytes: number,
  bytesAt: (start: number) => number,
): number {
  let lower = earliest;
  let upper = latest;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (bytesAt(middle) <= maximumBytes) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }
  return lower;
}

function snapshotPayload(
  snapshot: BackendConversationSnapshot,
  orderedBackendTurnIds: readonly string[],
): BackendConversationSnapshot {
  const selected = new Set(orderedBackendTurnIds);
  return {
    runState: snapshot.runState,
    orderedBackendTurnIds: [...orderedBackendTurnIds],
    turnsById: Object.fromEntries(
      orderedBackendTurnIds.map((id) => [id, snapshot.turnsById[id]!]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById).filter(([, item]) =>
        selected.has(item.backendTurnId),
      ),
    ),
    ...(snapshot.activeBackendTurnId &&
    selected.has(snapshot.activeBackendTurnId)
      ? { activeBackendTurnId: snapshot.activeBackendTurnId }
      : {}),
  };
}

function oversizedTurn(): BackendError {
  return new BackendError({
    category: "internal",
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage:
      "A Pi turn is too large to transfer as one complete timeline unit.",
    backendCode: "pi_turn_payload_too_large",
  });
}

function assertTransferablePiTurns(
  snapshot: BackendConversationSnapshot,
  turnIds: readonly string[],
): void {
  if (
    turnIds.some(
      (turnId) =>
        (snapshot.turnsById[turnId]?.orderedBackendItemIds.length ?? 0) >
        maximumPiItemsPerTurn,
    )
  ) {
    throw oversizedTurn();
  }
}

function historyPagePayload(
  snapshot: BackendConversationSnapshot,
  conversationId: string,
  start: number,
  before: number,
): BackendHistoryPage {
  const ids = snapshot.orderedBackendTurnIds.slice(start, before);
  const included = new Set(ids);
  return {
    orderedBackendTurnIds: ids,
    turnsById: Object.fromEntries(
      ids.map((id) => [id, snapshot.turnsById[id]!]),
    ),
    itemsById: Object.fromEntries(
      Object.entries(snapshot.itemsById).filter(([, item]) =>
        included.has(item.backendTurnId),
      ),
    ),
    ...(start > 0
      ? {
          previousCursor: `pi-history:${encodeURIComponent(conversationId)}:${start}`,
        }
      : {}),
  };
}

/**
 * Selects the contiguous page ending exactly at `before`. The returned cursor
 * names the actual first omitted turn, including when bytes truncate a page
 * before its requested count.
 */
export function selectPiHistoryPage(
  snapshot: BackendConversationSnapshot,
  conversationId: string,
  before: number,
  maximumTurns: number,
): BackendHistoryPage {
  if (before === 0) {
    return backendHistoryPageSchema.parse({
      orderedBackendTurnIds: [],
      turnsById: {},
      itemsById: {},
    });
  }
  // Measured without viewed-image children, as for the snapshot window.
  const measured = withoutPiViewedImageChildren(snapshot);
  const earliestByCount = Math.max(0, before - maximumTurns);
  const bytesAt = (start: number) =>
    serializedUtf8Bytes(
      historyPagePayload(measured, conversationId, start, before),
    );
  const newestBytes = bytesAt(before - 1);
  if (newestBytes > maximumPiSnapshotOrPageBytes) {
    throw oversizedTurn();
  }
  const start =
    newestBytes > targetPiTimelinePayloadBytes
      ? before - 1
      : earliestStartWithinBytes(
          earliestByCount,
          before - 1,
          targetPiTimelinePayloadBytes,
          bytesAt,
        );
  const selectedIds = snapshot.orderedBackendTurnIds.slice(start, before);
  assertTransferablePiTurns(measured, selectedIds);
  const page = historyPagePayload(snapshot, conversationId, start, before);
  return backendHistoryPageSchema.parse(
    measured === snapshot ||
      serializedUtf8Bytes(page) <= maximumPiSnapshotOrPageBytes
      ? page
      : historyPagePayload(measured, conversationId, start, before),
  );
}
