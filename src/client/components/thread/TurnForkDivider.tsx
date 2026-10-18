import { TurnBookmarkAction, type TurnBookmarkActionProps } from "./TurnBookmarkAction.js";
import { TurnSpeakAction } from "./TurnSpeakAction.js";
import { TurnUsageAction } from "./TurnUsageAction.js";
import { runThreadFork } from "../../operations/thread-creation.js";
import { Check, Copy, LoaderCircle, RotateCcw, Split, X } from "lucide-react";
import type {
  ConversationTurn,
  TurnForkCapability,
} from "../../../shared/index.js";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ThreadClientStore,
  TurnForkAttempt,
} from "../../stores/ThreadClientStore.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { matchesTouchDensity } from "../../app/use-touch-density.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { openThreadRoute } from "../../workspace-panels/thread-panel-navigation.js";

function completionLabel(
  turn: Pick<ConversationTurn, "completedAt"> & {
    readonly status: Exclude<ConversationTurn["status"], "in_progress">;
  },
  turnNumber?: number,
): {
  readonly short: string;
  readonly full: string;
} {
  if (!turn.completedAt) {
    if (turnNumber === undefined) {
      const status =
        turn.status === "interrupted"
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

interface ForkConfirmation {
  readonly store: ThreadClientStore;
  readonly sourceTurnId: string;
  readonly expectedTurnRevision: number;
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
  bookmark,
}: {
  readonly turn: ConversationTurn;
  readonly turnNumber?: number;
  readonly capability: TurnForkCapability | undefined;
  readonly attempt: TurnForkAttempt | undefined;
  readonly connected: boolean;
  readonly authoritative: boolean;
  readonly store: ThreadClientStore;
  readonly copyText?: string;
  readonly bookmark?: TurnBookmarkActionProps;
}): React.JSX.Element | null {
  // Hooks stay above the eligibility returns: a live turn completing must not
  // change the hook count between renders.
  const chatVisible = useContext(ChatViewVisibilityContext);
  const [usageOpen, setUsageOpen] = useState(false);
  const [forkConfirmation, setForkConfirmation] = useState<ForkConfirmation>();
  const pendingConfirmation = useRef<ForkConfirmation | undefined>(undefined);
  const clearForkConfirmation = () => {
    pendingConfirmation.current = undefined;
    setForkConfirmation(undefined);
  };
  // A confirmation belongs to the exact boundary that was tapped. Navigation
  // or refreshed history must never silently retarget it to another thread/turn.
  const confirmationMatches = chatVisible && forkConfirmation !== undefined &&
    forkConfirmation.store === store &&
    forkConfirmation.sourceTurnId === turn.id &&
    turn.status === "completed" &&
    capability?.sourceTurnId === forkConfirmation.sourceTurnId &&
    capability.expectedTurnRevision === forkConfirmation.expectedTurnRevision;
  useEffect(() => {
    if (forkConfirmation && !confirmationMatches) clearForkConfirmation();
  }, [forkConfirmation, confirmationMatches]);
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
    () => status === "in_progress"
      ? undefined
      : completionLabel({ completedAt, status }, turnNumber),
    [completedAt, status, turnNumber],
  );

  if (!time && !bookmark) return null;

  const throughput = turn.throughput
    ? (turn.throughput.outputTokens / (turn.throughput.requestDurationMs / 1000)).toFixed(1)
    : undefined;
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
  const forkBlocked = unavailable || pending || recoveryLocked || requestLocked;
  const actionLabel = pending
    ? "Creating fork…"
    : `Fork from here, ${time?.short}`;

  const activate = (restart = false, explicitRecoveryRetry = false) => {
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
    });
  };

  const requestFork = () => {
    if (!chatVisible || forkBlocked) return;
    if (matchesTouchDensity()) {
      const confirmation = {
        store,
        sourceTurnId: capability!.sourceTurnId,
        expectedTurnRevision: capability!.expectedTurnRevision,
      };
      pendingConfirmation.current = confirmation;
      setForkConfirmation(confirmation);
    } else {
      activate(false);
    }
  };

  return (
    <footer
      className="turn-fork-footer"
      data-active={usageOpen || pending || Boolean(attempt) || bookmark?.bookmarked || bookmark?.pending ? "true" : undefined}
      data-testid={`turn-fork-${turn.id}`}
    >
      {throughput !== undefined && (
        <>
          <span
            className="turn-throughput"
            title="Output tokens per second, including reasoning and request latency. Excludes tool waits. This measurement is not saved."
            aria-hidden="true"
          >
            {throughput} tok/s
          </span>
          <span className="sr-only">{throughput} tokens per second</span>
        </>
      )}
      <div className="turn-fork-controls">
        {time && <time
          className="turn-fork-time"
          dateTime={turn.completedAt}
          title={time.full}
        >
          {time.short}
        </time>}
        {bookmark && <TurnBookmarkAction {...bookmark} />}
        {time && copyText && (
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
        {time && <>
          <TurnSpeakAction store={store} turnId={turn.id} copyText={copyText} />
          <TurnUsageAction cache={store.usage} turn={turn} onOpenChange={setUsageOpen} />
        </>}
        {turn.status === "completed" && <button
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
          onClick={requestFork}
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
        </button>}
      </div>
      {turn.status === "completed" && <span id={`turn-fork-description-${turn.id}`} className="sr-only">
        {unavailableReason ??
          `Creates a new thread that includes this completed turn (${time?.full}) and excludes every later turn.`}
      </span>}
      {turn.status === "completed" && attempt && attempt.phase !== "pending" && (
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
              onClick={() => activate(false, true)}
            >
              <RotateCcw size={14} aria-hidden="true" /> Retry same fork
            </Button>
          )}
          {attempt.phase === "recovery_required" && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => openThreadRoute(attempt.childThreadId)}
            >
              Open recovery thread
            </Button>
          )}
          {attempt.phase === "aborted" && attempt.restartable && (
            <Button
              variant="outline"
              size="xs"
              disabled={unavailable}
              title={unavailable ? unavailableReason : undefined}
              onClick={() => activate(true)}
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
      {confirmationMatches && <ConfirmDialog
        open
        onOpenChange={(open) => { if (!open) clearForkConfirmation(); }}
        title="Fork from this point?"
        description="Creates a new thread through this response, keeping this conversation."
        confirmLabel="Fork"
        confirmDisabled={forkBlocked}
        blockers={unavailableReason ? [unavailableReason] : []}
        onConfirm={() => {
          // Consume synchronously, before opening the existing operation
          // overlay, so repeated confirmation cannot create another request.
          if (pendingConfirmation.current !== forkConfirmation || forkBlocked) return;
          clearForkConfirmation();
          activate(false);
        }}
      />}
    </footer>
  );
}, (previous, next) => {
  const { bookmark: before, ...beforeFooter } = previous;
  const { bookmark: after, ...afterFooter } = next;
  // Streaming replaces the preview map; unchanged completed footers keep their
  // memo boundary even when their equivalent bookmark props are reconstructed.
  return Object.keys(beforeFooter).length === Object.keys(afterFooter).length &&
    Object.keys(beforeFooter).every(key => Object.is(
      beforeFooter[key as keyof typeof beforeFooter],
      afterFooter[key as keyof typeof afterFooter],
    )) && (before === after || Boolean(before && after &&
      before.turnId === after.turnId && before.store === after.store &&
      before.bookmarked === after.bookmarked && before.disabled === after.disabled &&
      before.pending === after.pending &&
      before.preview.userPreview === after.preview.userPreview &&
      before.preview.assistantPreview === after.preview.assistantPreview &&
      before.preview.responseState === after.preview.responseState));
});
