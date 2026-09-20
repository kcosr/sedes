import { runThreadFork } from "../../operations/thread-creation.js";
import { Check, Copy, LoaderCircle, RotateCcw, Split, X } from "lucide-react";
import type {
  ConversationTurn,
  TurnForkCapability,
} from "../../../shared/index.js";
import { memo, useEffect, useMemo, useState } from "react";
import type {
  ThreadClientStore,
  TurnForkAttempt,
} from "../../stores/ThreadClientStore.js";
import { Button } from "../ui/button.js";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../../workspace-panels/thread-panel-navigation.js";
import type { PanelPresentation } from "../../workspace-panels/panel-presentation.js";

function completionLabel(
  turn: Pick<ConversationTurn, "completedAt" | "status">,
  turnNumber?: number,
): {
  readonly short: string;
  readonly full: string;
} {
  if (!turn.completedAt) {
    if (turnNumber === undefined) {
      const status =
        turn.status === "in_progress"
          ? "Current turn"
          : turn.status === "interrupted"
            ? "Interrupted turn"
            : turn.status === "failed"
              ? "Failed turn"
              : "Completed turn";
      return { short: status, full: status.toLocaleLowerCase() };
    }
    return {
      short: `Turn ${turnNumber}`,
      full: `turn ${turnNumber}`,
    };
  }
  const completed = new Date(turn.completedAt);
  return {
    short: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(completed),
    full: new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "long",
    }).format(completed),
  };
}

function attemptMessage(attempt: TurnForkAttempt): string {
  if (attempt.phase === "pending") return "Creating fork…";
  return attempt.diagnostic;
}

// Streaming item updates preserve completed-turn, capability, attempt, and
// store references. Avoid reformatting every completed boundary (including
// constructing two Intl formatters) when only a message elsewhere changed.
export const TurnForkDivider = memo(function TurnForkDivider({
  turn,
  turnNumber,
  capability,
  attempt,
  connected,
  authoritative,
  store,
  copyText,
}: {
  readonly turn: ConversationTurn;
  readonly turnNumber?: number;
  readonly capability: TurnForkCapability | undefined;
  readonly attempt: TurnForkAttempt | undefined;
  readonly connected: boolean;
  readonly authoritative: boolean;
  readonly store: ThreadClientStore;
  readonly copyText?: string;
}): React.JSX.Element | null {
  // Hooks stay above the eligibility returns: a live turn completing must not
  // change the hook count between renders.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => {
    if (copyState === "idle") return undefined;
    const timer = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  // Application updates can change fork authority for every completed turn.
  // Their timestamps still need formatting only when the label inputs change.
  const { completedAt, status } = turn;
  const time = useMemo(
    () => status === "completed"
      ? completionLabel({ completedAt, status }, turnNumber)
      : undefined,
    [completedAt, status, turnNumber],
  );

  // Completed-turn time and copy controls are useful independently from fork
  // eligibility. Keep incomplete turns visually quiet while leaving the fork
  // action itself under the normalized exact-turn capability authority.
  if (!time) {
    return null;
  }

  const copyResponse = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const unavailableReason =
    attempt?.phase === "request_failed" && !attempt.retryable
      ? attempt.diagnostic
      : !connected || !authoritative
        ? "Wait for the thread to reconnect and receive authoritative history."
        : (capability?.unavailableReason?.text ??
          (!capability
            ? "Fork availability for this turn is not known."
            : undefined));
  const unavailable =
    Boolean(unavailableReason) || capability?.available !== true;
  const pending = attempt?.phase === "pending";
  const recoveryLocked = attempt?.phase === "recovery_required";
  const requestLocked =
    attempt?.phase === "request_failed" && !attempt.retryable;
  const actionLabel = pending
    ? "Creating fork…"
    : `Fork from here, ${time.short}`;

  const activate = (
    presentation: PanelPresentation,
    restart = false,
    explicitRecoveryRetry = false,
  ) => {
    if (
      unavailable ||
      pending ||
      requestLocked ||
      (recoveryLocked && !explicitRecoveryRetry)
    )
      return;
    void runThreadFork({
      fork: (shouldRestart) => store.forkTurn(capability!, { restart: shouldRestart }),
      restart,
      presentation,
    });
  };

  return (
    <footer
      className="turn-fork-footer"
      data-active={pending || Boolean(attempt) ? "true" : undefined}
      data-testid={`turn-fork-${turn.id}`}
    >
      <div className="turn-fork-controls">
        <time
          className="turn-fork-time"
          dateTime={turn.completedAt}
          title={time.full}
        >
          {time.short}
        </time>
        {copyText && (
          <>
            <button
              type="button"
              className="turn-fork-action"
              aria-label={
                copyState === "copied"
                  ? "Response copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy response"
              }
              title={copyState === "failed" ? "Copy failed" : "Copy response"}
              onClick={() => void copyResponse()}
            >
              {copyState === "copied" ? (
                <Check size={16} aria-hidden="true" />
              ) : copyState === "failed" ? (
                <X size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
            </button>
            <span className="sr-only" role="status">
              {copyState === "copied"
                ? "Response copied."
                : copyState === "failed"
                  ? "Copying the response failed."
                  : ""}
            </span>
          </>
        )}
        <button
          type="button"
          className="turn-fork-action"
          aria-label={actionLabel}
          aria-disabled={
            unavailable || pending || recoveryLocked || requestLocked
          }
          aria-describedby={`turn-fork-description-${turn.id}`}
          title={
            unavailableReason ?? "Fork from here — includes this completed turn"
          }
          onClick={(event) => activate(pointerPanelPresentation(event), false)}
        >
          {pending ? (
            <LoaderCircle
              className="turn-fork-spinner"
              size={16}
              aria-hidden="true"
            />
          ) : (
            <Split className="fork-split-icon" size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <span id={`turn-fork-description-${turn.id}`} className="sr-only">
        {unavailableReason ??
          `Creates a new thread that includes this completed turn (${time.full}) and excludes every later turn.`}
      </span>
      {attempt && attempt.phase !== "pending" && (
        <div
          className={`turn-fork-feedback ${attempt.phase}`}
          role={attempt.phase === "request_failed" ? "alert" : "status"}
        >
          <span>{attemptMessage(attempt)}</span>
          {((attempt.phase === "request_failed" && attempt.retryable) ||
            (attempt.phase === "recovery_required" && attempt.retryable)) && (
            <Button
              variant="outline"
              size="xs"
              disabled={unavailable}
              title={unavailable ? unavailableReason : undefined}
              onClick={(event) =>
                activate(pointerPanelPresentation(event), false, true)
              }
            >
              <RotateCcw size={14} aria-hidden="true" /> Retry same fork
            </Button>
          )}
          {attempt.phase === "recovery_required" && (
            <Button
              variant="outline"
              size="xs"
              onClick={(event) =>
                openThreadRoute(
                  attempt.childThreadId,
                  pointerPanelPresentation(event),
                )
              }
            >
              Open recovery thread
            </Button>
          )}
          {attempt.phase === "aborted" && (
            <Button
              variant="outline"
              size="xs"
              disabled={unavailable}
              title={unavailable ? unavailableReason : undefined}
              onClick={(event) =>
                activate(pointerPanelPresentation(event), true)
              }
            >
              <Split className="fork-split-icon" size={14} aria-hidden="true" />{" "}
              Start a new fork
            </Button>
          )}
          {(attempt.phase === "aborted" ||
            (attempt.phase === "request_failed" && !attempt.retryable)) && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss fork status"
              onClick={() => store.clearForkAttempt(turn.id)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </footer>
  );
});
