import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type {
  ThreadForceResetBlockerSummary,
  ThreadForceResetImpact,
} from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";

const blockerLabels: Record<
  ThreadForceResetBlockerSummary["kind"],
  readonly [singular: string, plural: string]
> = {
  pending_interaction: [
    "pending approval or question",
    "pending approvals or questions",
  ],
  completion_callback: [
    "registered agent callback",
    "registered agent callbacks",
  ],
  queued_input: ["queued input", "queued inputs"],
  conversation_operation: ["conversation operation", "conversation operations"],
  provider_feature_operation: [
    "provider-feature operation",
    "provider-feature operations",
  ],
  thread_creation_state: ["thread creation state", "thread creation states"],
  creation_attempt: ["thread creation attempt", "thread creation attempts"],
  fork_origin: ["fork operation", "fork operations"],
  automation_run: ["automation run", "automation runs"],
  conversation_runtime: ["conversation runtime", "conversation runtimes"],
};

function countLabel(count: number, singular: string, plural: string): string | undefined {
  return count === 0 ? undefined : `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** Replacing a runtime can end the background work it owns. */
function backgroundSummary(
  activity: ThreadForceResetImpact["backgroundActivity"],
): React.JSX.Element | null {
  const counts = [
    countLabel(activity.agents, "background agent", "background agents"),
    countLabel(activity.commands, "background command", "background commands"),
    countLabel(activity.other, "other background task", "other background tasks"),
  ].filter((label): label is string => label !== undefined);
  if (counts.length === 0 && activity.unknownThreads === 0) return null;
  return (
    <p data-testid="force-reset-background">
      {counts.length > 0
        ? `Running in the affected conversations: ${counts.join(", ")}. Replacing their runtimes may stop this work.`
        : null}
      {counts.length > 0 && activity.unknownThreads > 0 ? " " : null}
      {activity.unknownThreads > 0
        ? `Background work is unknown in ${activity.unknownThreads === 1 ? "one conversation" : `${activity.unknownThreads.toLocaleString()} conversations`}.`
        : null}
    </p>
  );
}

export function ForceResetDialog({
  open,
  onOpenChange,
  loadImpact,
  onForceReset,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadImpact: () => Promise<ThreadForceResetImpact>;
  readonly onForceReset: (
    impact: ThreadForceResetImpact,
    mutationId: string,
  ) => Promise<void>;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [preview, setPreview] = useState<{
    readonly impact: ThreadForceResetImpact;
    readonly mutationId: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    readonly operation: "load" | "reset";
    readonly message: string;
  }>();
  const loadGeneration = useRef(0);
  const loadInFlight = useRef(false);
  const resetInFlight = useRef(false);

  const load = () => {
    if (loadInFlight.current || resetInFlight.current) return;
    const generation = ++loadGeneration.current;
    loadInFlight.current = true;
    setLoading(true);
    setPreview(undefined);
    setError(undefined);
    void loadImpact()
      .then((nextImpact) => {
        if (generation === loadGeneration.current) {
          setPreview({
            impact: nextImpact,
            mutationId: crypto.randomUUID(),
          });
        }
      })
      .catch((reason: unknown) => {
        if (generation !== loadGeneration.current) return;
        setError({
          operation: "load",
          message:
            reason instanceof Error
              ? reason.message
              : "The unresolved work could not be checked.",
        });
      })
      .finally(() => {
        if (generation !== loadGeneration.current) return;
        loadInFlight.current = false;
        setLoading(false);
      });
  };

  useEffect(() => {
    if (open) {
      load();
      return;
    }
    ++loadGeneration.current;
    loadInFlight.current = false;
    setPreview(undefined);
    setLoading(false);
    setError(undefined);
    // load uses refs to enforce single-flight and intentionally restarts only
    // when the controlled dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reset = async () => {
    if (!preview?.impact.resettable || resetInFlight.current) return;
    resetInFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onForceReset(preview.impact, preview.mutationId);
      onOpenChange(false);
    } catch (reason) {
      setError({
        operation: "reset",
        message:
          reason instanceof Error
            ? reason.message
            : "Sedes state could not be force reset.",
      });
    } finally {
      resetInFlight.current = false;
      setPending(false);
    }
  };

  const impact = preview?.impact;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay over-drawer"
          data-testid="dialog-overlay"
        />
        <Dialog.Content
          className="dialog-card force-reset-dialog over-drawer"
          aria-describedby="force-reset-description"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Dialog.Title>Force reset Sedes state?</Dialog.Title>
          <Dialog.Description id="force-reset-description">
            Sedes will abandon the unresolved state listed here and replace the
            exact loaded conversation runtime without waiting for provider
            reconciliation. This does not undo provider operations: provider
            work may already have happened, may continue or reappear, and a
            native fork orphan may remain.
          </Dialog.Description>
          <Dialog.Close asChild disabled={pending}>
            <Button
              variant="ghost"
              size="icon"
              className="dialog-close"
              aria-label="Close"
              disabled={pending}
            >
              <X size={18} strokeWidth={1.8} />
            </Button>
          </Dialog.Close>

          {loading && <p role="status">Checking unresolved Sedes work…</p>}

          {impact && (
            <div className="force-reset-impact">
              {impact.blockers.length > 0 ? (
                <>
                  <h3>Sedes will reset</h3>
                  <ul>
                    {impact.blockers.map((blocker) => {
                      const label = blockerLabels[blocker.kind];
                      return (
                        <li key={blocker.kind}>
                          {`${blocker.count.toLocaleString()} ${
                            blocker.count === 1 ? label[0] : label[1]
                          }`}
                        </li>
                      );
                    })}
                  </ul>
                  <p>
                    {impact.affectedThreadIds.length === 1
                      ? "This affects this thread."
                      : `This affects ${impact.affectedThreadIds.length.toLocaleString()} related threads.`}
                  </p>
                  {backgroundSummary(impact.backgroundActivity)}
                </>
              ) : (
                <p role="status">No unresolved Sedes work was found.</p>
              )}
              {impact.warnings.length > 0 && (
                <div className="force-reset-warnings">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <ul>
                    {impact.warnings.map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="notice error" role="alert">
              {error.message}{" "}
              {!pending && (
                <>
                  <button
                    type="button"
                    className="archive-menu-retry"
                    onClick={error.operation === "load" ? load : reset}
                    disabled={loading}
                  >
                    {error.operation === "load" ? "Retry" : "Retry reset"}
                  </button>
                  {error.operation === "reset" && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="archive-menu-retry"
                        onClick={load}
                        disabled={loading}
                      >
                        Refresh preview
                      </button>
                    </>
                  )}
                </>
              )}
            </p>
          )}

          <div className="dialog-actions">
            <Dialog.Close asChild disabled={pending}>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              disabled={loading || pending || !impact?.resettable}
              onClick={() => void reset()}
            >
              {pending ? "Force resetting…" : "Force reset"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
