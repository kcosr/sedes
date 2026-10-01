import { useEffect, useRef, useState } from "react";
import type {
  ThreadForceResetBlockerSummary,
  ThreadForceResetImpact,
} from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from "@client/components/ui/dialog";

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

function runtimeDescription(
  runtime: NonNullable<ThreadForceResetImpact["affectedThreads"][number]["runtime"]>,
): string {
  const activity = runtime.backgroundActivity;
  const background =
    activity?.state === "unknown"
      ? "background work unknown"
      : activity && activity.agents + activity.commands + activity.other > 0
        ? `${activity.agents + activity.commands + activity.other} background ${
            activity.agents + activity.commands + activity.other === 1 ? "task" : "tasks"
          }`
        : undefined;
  const active = runtime.runState !== "idle" && runtime.runState !== "failed";
  const state = active ? `${runtime.runState.replaceAll("_", " ")}` : "loaded";
  return active || background
    ? `Runtime ${state}${background ? `, ${background}` : ""}; resetting stops this work.`
    : "Loaded runtime will be replaced.";
}

function countLabel(count: number, singular: string, plural: string): string | undefined {
  return count === 0 ? undefined : `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** Totals of the background work the affected loaded runtimes report. */
function backgroundSummary(
  threads: ThreadForceResetImpact["affectedThreads"],
): React.JSX.Element | null {
  const total = { agents: 0, commands: 0, other: 0, unknownThreads: 0 };
  for (const { runtime } of threads) {
    const activity = runtime?.backgroundActivity;
    if (!activity) continue;
    total.agents += activity.agents;
    total.commands += activity.commands;
    total.other += activity.other;
    if (activity.state === "unknown") total.unknownThreads++;
  }
  const counts = [
    countLabel(total.agents, "background agent", "background agents"),
    countLabel(total.commands, "background command", "background commands"),
    countLabel(total.other, "other background task", "other background tasks"),
  ].filter((label): label is string => label !== undefined);
  if (counts.length === 0 && total.unknownThreads === 0) return null;
  return (
    <p className="force-reset-status" data-testid="force-reset-background">
      {counts.length > 0
        ? `Running in the affected conversations: ${counts.join(", ")}. Replacing their runtimes may stop this work.`
        : null}
      {counts.length > 0 && total.unknownThreads > 0 ? " " : null}
      {total.unknownThreads > 0
        ? `Background work is unknown in ${total.unknownThreads === 1 ? "one conversation" : `${total.unknownThreads.toLocaleString()} conversations`}.`
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="md"
        mobile="card"
        layer="over-dialog"
        showClose={false}
        dismissible={!pending}
        aria-busy={pending || undefined}
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>Force reset Sedes state?</DialogTitle>
          <DialogDescription>
            Sedes abandons the unresolved state below and replaces the loaded
            conversation runtime without waiting for provider reconciliation.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading && (
            <p role="status" className="force-reset-status">
              Checking unresolved Sedes work…
            </p>
          )}

          {impact &&
            (impact.blockers.length > 0 ? (
              <>
                <DialogSection title="Sedes will reset">
                  <ul className="force-reset-list">
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
                </DialogSection>
                <DialogSection
                  title={
                    impact.affectedThreads.length === 1
                      ? "Affected thread"
                      : `Affected threads (${impact.affectedThreads.length.toLocaleString()})`
                  }
                >
                  <ul className="force-reset-list force-reset-threads">
                    {impact.affectedThreads.map((thread) => (
                      <li key={thread.threadId}>
                        <span>{thread.title}</span>
                        {thread.runtime && (
                          <small>{runtimeDescription(thread.runtime)}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                  {backgroundSummary(impact.affectedThreads)}
                </DialogSection>
              </>
            ) : (
              <p role="status" className="force-reset-status">
                No unresolved Sedes work was found.
              </p>
            ))}

          {impact && (
            <DialogAlert
              tone="warning"
              title="Provider operations are not undone"
            >
              <p className="m-0">
                Provider work may already have happened, may continue or
                reappear, and a native fork orphan may remain.
              </p>
              {impact.warnings.length > 0 && (
                <ul className="force-reset-list force-reset-warnings">
                  {impact.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              )}
            </DialogAlert>
          )}

          {error && (
            <DialogAlert
              tone="danger"
              action={
                pending ? undefined : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={error.operation === "load" ? load : reset}
                      disabled={loading}
                    >
                      {error.operation === "load" ? "Retry" : "Retry reset"}
                    </Button>
                    {error.operation === "reset" && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={load}
                        disabled={loading}
                      >
                        Refresh preview
                      </Button>
                    )}
                  </>
                )
              }
            >
              {error.message}
            </DialogAlert>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={loading || pending || !impact?.resettable}
            onClick={() => void reset()}
          >
            {pending ? "Force resetting…" : "Force reset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
