import {
  getDiagnosticCategoryEnabled,
  type ClientDiagnosticCategory,
} from "./settings.js";

type DiagnosticValue = string | number | boolean | null;

const allowedDetailKeys = [
  "action",
  "animationActive",
  "animatedGraphemes",
  "applied",
  "arrivalGapMilliseconds",
  "attemptElapsedMilliseconds",
  "attemptId",
  "batchSize",
  "behavior",
  "bytes",
  "clientHeight",
  "clientWidth",
  "code",
  "connection",
  "cursorAvailable",
  "cursorSource",
  "contentBottom",
  "contentHeight",
  "contentOverflowAnchor",
  "contentTop",
  "deltaX",
  "deltaY",
  "distance",
  "domTextCharacters",
  "duration",
  "durationMilliseconds",
  "eventDataCharacters",
  "eventType",
  "from",
  "handshake",
  "hasActiveTurn",
  "inputType",
  "isComposing",
  "itemCount",
  "itemKind",
  "itemStatus",
  "largestTurnItemCount",
  "mode",
  "naturalBottomDistance",
  "neededSpacerHeight",
  "nextSpacerHeight",
  "pinActive",
  "previousSpacerHeight",
  "readerBottomSide",
  "readerScrolled",
  "reason",
  "refocusEnabled",
  "replayedEventCount",
  "requestId",
  "requestToSnapshotWriteMilliseconds",
  "requestToHeadersMilliseconds",
  "retryable",
  "routeSetupMilliseconds",
  "runState",
  "scheduledDelayMilliseconds",
  "runtimeAcquireMilliseconds",
  "scrollHeight",
  "scrollLeft",
  "scrollTop",
  "scrollWidth",
  "seekTop",
  "snapshotCaptureMilliseconds",
  "snapshotEncodeMilliseconds",
  "snapshotSummaryMilliseconds",
  "snapshotWriteMilliseconds",
  "source",
  "spacerBottom",
  "spacerComputedHeight",
  "spacerHeight",
  "spacerTop",
  "status",
  "textareaFocused",
  "textCharacters",
  "outcome",
  "targetBottom",
  "targetOffsetTop",
  "targetScrollTop",
  "targetTop",
  "to",
  "turnCount",
  "viewportBottom",
  "viewportHeight",
  "viewportOverflowAnchor",
  "viewportOverflowY",
  "viewportScrollBehavior",
  "viewportTop",
  "visualViewportHeight",
  "visualViewportOffsetTop",
  "visualViewportWidth",
  "wasAtLiveEdge",
  "windowInnerHeight",
  "windowInnerWidth",
] as const;

type DiagnosticDetailKey = (typeof allowedDetailKeys)[number];
export type DiagnosticDetails = Readonly<
  Partial<Record<DiagnosticDetailKey, DiagnosticValue>>
>;
const allowedDetails = new Set<string>(allowedDetailKeys);

export type SeekDiagnosticEvent =
  | "content_resize_observed"
  | "optimistic_anchor_unresolved"
  | "reader_scroll_intent"
  | "reader_took_scroll_control"
  | "seek_animation_cancelled"
  | "seek_animation_settled"
  | "seek_animation_started"
  | "seek_pin_engaged"
  | "seek_pin_released"
  | "seek_pin_releasing"
  | "seek_request_consumed"
  | "seek_request_expired"
  | "seek_requested"
  | "seek_spacer_synchronized"
  | "seek_target_missing"
  | "snapshot_committed"
  | "snapshot_painted"
  | "spacer_height_changed"
  | "scroll_to_latest_applied"
  | "scroll_to_latest_requested"
  | "viewport_resize_observer"
  | "viewport_scrolled";
export type SeekDiagnosticDetails = DiagnosticDetails;

export type ThreadLoadDiagnosticEvent =
  | "thread_open_requested"
  | "store_start_requested"
  | "retained_store_reused"
  | "thread_store_cached"
  | "thread_store_evicted"
  | "event_source_created"
  | "response_headers_received"
  | "snapshot_received"
  | "snapshot_json_parsed"
  | "server_snapshot_timing_received"
  | "server_handshake_timing_received"
  | "server_replay_outcome_received"
  | "resume_cursor_cleared"
  | "resume_handshake_completed"
  | "thread_stream_suspended"
  | "snapshot_store_applied"
  | "snapshot_store_ignored"
  | "snapshot_store_rejected"
  | "react_snapshot_committed"
  | "paint_frame_completed"
  | "stream_live"
  | "stream_reconnecting"
  | "stream_disconnected"
  | "thread_load_failed"
  | "protocol_error";

export type StreamingDiagnosticEvent =
  | "animation_frame_delayed"
  | "sse_item_received"
  | "stream_batch_applied"
  | "stream_batch_scheduled"
  | "stream_batch_timer_fired"
  | "text_committed";

export type DiagnosticEntry = {
  readonly sequence: number;
  readonly wallTime: string;
  readonly elapsedMilliseconds: number;
  readonly category: ClientDiagnosticCategory;
  readonly event: string;
  readonly details: Readonly<Record<string, DiagnosticValue>>;
};

const maximumEntries = 1_200;
const entries: DiagnosticEntry[] = [];
let sequence = 0;

function recordDiagnostic(
  category: ClientDiagnosticCategory,
  event: string,
  details: DiagnosticDetails = {},
): void {
  try {
    if (!getDiagnosticCategoryEnabled(category)) return;
  } catch {
    return;
  }
  const sanitizedDetails = Object.fromEntries(
    Object.entries(details)
      .filter(
        ([key, value]) =>
          allowedDetails.has(key) &&
          (value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value))),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 160) : value,
      ]),
  ) as Record<DiagnosticDetailKey, DiagnosticValue>;
  const entry: DiagnosticEntry = Object.freeze({
    sequence: ++sequence,
    wallTime: new Date().toISOString(),
    elapsedMilliseconds: Math.round(performance.now() * 10) / 10,
    category,
    event,
    details: Object.freeze(sanitizedDetails),
  });
  entries.push(entry);
  if (entries.length > maximumEntries) entries.shift();
  // High-frequency streaming, input, and seek samples stay in the copy buffer:
  // console forwarding can perturb the timing they are intended to measure.
  if (category === "thread_load") {
    try {
      console.debug(
        `[diagnostics #${entry.sequence}] ${category}:${event}`,
        entry,
      );
    } catch {
      // The bounded copy buffer remains usable when console forwarding fails.
    }
  }
}

export function recordSeekDiagnostic(
  event: SeekDiagnosticEvent,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic("seek", event, details);
}

export function recordThreadLoadCategoryDiagnostic(
  event: ThreadLoadDiagnosticEvent,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic("thread_load", event, details);
}

export function recordStreamingDiagnostic(
  event: StreamingDiagnosticEvent,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic("streaming", event, details);
}

export function recordComposerInputDiagnostic(
  event:
    | "focus"
    | "blur"
    | "beforeinput"
    | "input"
    | "compositionstart"
    | "compositionupdate"
    | "compositionend"
    | "send_pointerdown"
    | "send_click"
    | "send_captured"
    | "send_cleared"
    | "send_refocus"
    | "change_accepted"
    | "composition_update_discarded",
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic("composer_input", event, details);
}

export function clearDiagnostics(): void {
  entries.length = 0;
  sequence = 0;
}

export function readDiagnostics(): readonly DiagnosticEntry[] {
  return entries.map((entry) => ({
    ...entry,
    details: { ...entry.details },
  }));
}

export function exportDiagnostics(): string {
  return JSON.stringify(
    {
      format: "sedes-client-diagnostics-v1",
      capturedAt: new Date().toISOString(),
      enabledCategories: (
        ["thread_load", "seek", "streaming", "composer_input"] as const
      ).filter(getDiagnosticCategoryEnabled),
      browser: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      },
      reducedMotion:
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      entries: readDiagnostics(),
    },
    null,
    2,
  );
}

export async function copyDiagnostics(): Promise<void> {
  await navigator.clipboard.writeText(exportDiagnostics());
}
