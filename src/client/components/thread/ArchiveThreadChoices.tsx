import { useEffect, useRef, useState } from "react";
import type {
  NormalizedApplicationThreadSummary,
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../../shared/index.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Callout } from "@client/components/ui/callout";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { ThreadTaskDisposition } from "./ThreadTaskDisposition.js";
import { ExecutionWorkspaceGitWarnings } from "./ExecutionWorkspaceActions.js";

export interface ArchiveChoiceProps {
  readonly thread: NormalizedApplicationThreadSummary;
  readonly store: ApplicationClientStore;
  readonly descendantCount: number;
  readonly disabled?: boolean;
  readonly onArchived?: (
    choice: "only" | "all",
    archivedThreadIds: readonly string[],
  ) => void;
  readonly onPendingChange?: (pending: boolean) => void;
}

export function useArchiveChoices(
  { thread, store, disabled, onArchived, onPendingChange }: ArchiveChoiceProps,
  initialImpact?: ThreadArchiveImpact,
) {
  const [impact, setImpact] = useState<ThreadArchiveImpact | undefined>(
    initialImpact,
  );
  const [loading, setLoading] = useState(false);
  const impactRequest = useRef<Promise<ThreadArchiveImpact> | undefined>(
    undefined,
  );
  const [pending, setPending] = useState<"only" | "all">();
  const [error, setError] = useState("");
  const [taskDisposition, setTaskDisposition] =
    useState<OpenTaskDisposition>("move_to_project");
  const [executionWorkspaceDisposition, setExecutionWorkspaceDisposition] =
    useState<"keep" | "delete">("keep");

  const openTaskTotal = (choice: "only" | "all"): number => {
    if (!impact) return 0;
    return choice === "all"
      ? impact.openTasks.root.total + impact.openTasks.descendants.total
      : impact.openTasks.root.total;
  };

  const stashedPromptTotal = (choice: "only" | "all"): number => {
    if (!impact) return 0;
    return choice === "all"
      ? impact.stashedPrompts.root + impact.stashedPrompts.descendants
      : impact.stashedPrompts.root;
  };

  const load = async (
    throwOnError = false,
  ): Promise<ThreadArchiveImpact | undefined> => {
    if (disabled || pending) return undefined;
    if (!impactRequest.current) {
      setLoading(true);
      setError("");
      impactRequest.current = store
        .getThreadArchiveImpact(thread.id)
        .then((nextImpact) => {
          setImpact(nextImpact);
          return nextImpact;
        })
        .catch((cause: unknown) => {
          setError(messageFrom(cause));
          throw cause;
        })
        .finally(() => {
          impactRequest.current = undefined;
          setLoading(false);
        });
    }
    try {
      return await impactRequest.current;
    } catch (cause) {
      if (throwOnError) throw cause;
      return undefined;
    }
  };

  const archive = async (choice: "only" | "all") => {
    if (disabled || pending || loading) return;
    if (
      choice === "all" &&
      impact?.executionWorkspace.kind === "isolated" &&
      executionWorkspaceDisposition === "delete"
    ) {
      const cause = new Error(
        "Keep the isolated workspace to archive descendants.",
      );
      setError(cause.message);
      throw cause;
    }
    setPending(choice);
    onPendingChange?.(true);
    setError("");
    try {
      const openTaskDisposition =
        openTaskTotal(choice) > 0 ? taskDisposition : undefined;
      const expectedStashedPromptCount = stashedPromptTotal(choice);
      const taskConfirmation =
        openTaskDisposition === "complete" && impact
          ? {
              expectedOpenTaskSnapshot:
                choice === "all"
                  ? impact.openTasks.familySnapshot
                  : impact.openTasks.root.snapshot,
            }
          : {};
      const archivedThreadIds =
        choice === "all"
          ? await store.archiveThreadFamily(thread, {
              expectedStashedPromptCount,
              ...taskConfirmation,
              executionWorkspaceDisposition: { kind: "keep" },
              ...(openTaskDisposition ? { openTaskDisposition } : {}),
            })
          : await store
              .mutateInventory(thread, "archive", {
                expectedStashedPromptCount,
                ...taskConfirmation,
                ...(openTaskDisposition ? { openTaskDisposition } : {}),
                executionWorkspaceDisposition:
                  impact?.executionWorkspace.kind === "isolated" &&
                  executionWorkspaceDisposition === "delete"
                    ? {
                        kind: "delete" as const,
                        expectedRevision:
                          impact.executionWorkspace.allocationRevision,
                        operationId: crypto.randomUUID(),
                      }
                    : { kind: "keep" as const },
              })
              .then(() => [thread.id]);
      onArchived?.(choice, archivedThreadIds);
    } catch (cause) {
      setError(messageFrom(cause));
      try {
        setImpact(await store.getThreadArchiveImpact(thread.id));
      } catch {
        // Preserve the mutation error; a later menu open performs a fresh read.
      }
      throw cause;
    } finally {
      setPending(undefined);
      onPendingChange?.(false);
    }
  };

  return {
    impact,
    loading,
    pending,
    error,
    load,
    archive,
    taskDisposition,
    setTaskDisposition,
    executionWorkspaceDisposition,
    setExecutionWorkspaceDisposition,
    openTaskTotal,
    stashedPromptTotal,
  };
}

export function ArchiveExecutionWorkspaceDisposition({
  choices,
  includeDescendants,
}: {
  readonly choices: ReturnType<typeof useArchiveChoices>;
  readonly includeDescendants: boolean;
}): React.JSX.Element | null {
  const workspace = choices.impact?.executionWorkspace;
  const deleteEligible =
    workspace?.kind === "isolated" &&
    ["ready", "retained", "provisioning_failed", "deletion_failed"].includes(
      workspace.state,
    );
  useEffect(() => {
    if (includeDescendants || !deleteEligible) {
      choices.setExecutionWorkspaceDisposition("keep");
    }
  }, [
    choices.setExecutionWorkspaceDisposition,
    deleteEligible,
    includeDescendants,
  ]);
  if (
    workspace?.kind !== "isolated" ||
    workspace.state === "deleted" ||
    workspace.state === "deleting"
  ) {
    return null;
  }
  return (
    <div
      className="archive-workspace-disposition"
      data-testid="archive-workspace-disposition"
    >
      <p className="archive-task-disposition-label">Isolated workspace</p>
      <SegmentedControl
        aria-label="Isolated workspace handling"
        size="sm"
        className="w-full"
        value={choices.executionWorkspaceDisposition}
        onValueChange={(value) =>
          choices.setExecutionWorkspaceDisposition(value as "keep" | "delete")
        }
      >
        <SegmentedControlItem
          value="keep"
          title="Retain the isolated workspace after archiving"
          disabled={Boolean(choices.pending)}
        >
          Keep
        </SegmentedControlItem>
        <SegmentedControlItem
          value="delete"
          title={
            includeDescendants
              ? "Delete is available when archiving only this thread"
              : !deleteEligible
                ? "Delete is unavailable while the isolated workspace is provisioning"
                : "Permanently delete the isolated workspace"
          }
          disabled={
            includeDescendants || !deleteEligible || Boolean(choices.pending)
          }
        >
          Delete
        </SegmentedControlItem>
      </SegmentedControl>
      {workspace.state === "deletion_failed" && (
        <Callout tone="danger" role="alert">
          The previous deletion failed. You can keep the workspace or retry
          deletion while archiving only this thread.
        </Callout>
      )}
      {workspace.state === "provisioning_failed" && (
        <Callout tone="danger" role="alert">
          Provisioning failed. You can keep or delete the incomplete workspace.
        </Callout>
      )}
      {includeDescendants && (
        <p className="archive-choice-note" role="status">
          Archive only this thread to delete its isolated workspace.
        </p>
      )}
      {!includeDescendants &&
        choices.executionWorkspaceDisposition === "delete" && (
          <ExecutionWorkspaceGitWarnings workspace={workspace} />
        )}
    </div>
  );
}

export function ArchiveQuestionWarning({
  choices,
  scope,
}: {
  readonly choices: ReturnType<typeof useArchiveChoices>;
  readonly scope: "only" | "all" | "choice-neutral";
}) {
  const questions = choices.impact?.pendingQuestions;
  if (!questions) return null;
  const count = questions.root + (scope === "only" ? 0 : questions.descendants);
  if (count === 0) return null;
  return (
    <Callout
      tone="warning"
      role="note"
      title={`${count} unanswered ${count === 1 ? "question" : "questions"}`}
    >
      {scope === "choice-neutral" && questions.descendants > 0
        ? `${questions.root} on this thread; ${questions.descendants} on descendants. `
        : ""}
      Questions remain attached to archived threads and will be available when
      you unarchive them.
    </Callout>
  );
}

export function ArchiveStashedPromptWarning({
  choices,
  scope,
}: {
  readonly choices: ReturnType<typeof useArchiveChoices>;
  readonly scope: "only" | "all" | "choice-neutral";
}) {
  const impact = choices.impact;
  if (!impact) return null;
  const includeDescendants = scope !== "only";
  const count =
    impact.stashedPrompts.root +
    (includeDescendants ? impact.stashedPrompts.descendants : 0);
  if (count === 0) return null;
  if (scope === "choice-neutral") {
    const locations = [
      impact.stashedPrompts.root > 0
        ? `${impact.stashedPrompts.root} on this thread`
        : undefined,
      impact.stashedPrompts.descendants > 0
        ? `${impact.stashedPrompts.descendants} on descendants`
        : undefined,
    ].filter((location): location is string => location !== undefined);
    return (
      <Callout
        tone="warning"
        role="note"
        data-testid="archive-stashed-prompt-warning"
        title={`${count} stashed ${count === 1 ? "prompt" : "prompts"} in this thread family`}
      >
        {locations.join("; ")}. {count === 1 ? "It" : "They"} will remain
        attached to whichever threads you archive.
      </Callout>
    );
  }
  const descendantNote =
    includeDescendants && impact.stashedPrompts.descendants > 0
      ? `, including ${impact.stashedPrompts.descendants} on descendants`
      : "";
  return (
    <Callout
      tone="warning"
      role="note"
      data-testid="archive-stashed-prompt-warning"
      title={`${count} stashed ${count === 1 ? "prompt" : "prompts"}${descendantNote}`}
    >
      {count === 1 ? "It" : "They"} will remain attached to the archived
      {includeDescendants ? " threads" : " thread"}.
    </Callout>
  );
}

export function ArchiveTaskDisposition({
  choices,
  includeDescendants,
}: {
  readonly choices: ReturnType<typeof useArchiveChoices>;
  readonly includeDescendants: boolean;
}) {
  const impact = choices.impact;
  if (!impact) return null;
  const total =
    impact.openTasks.root.total +
    (includeDescendants ? impact.openTasks.descendants.total : 0);
  const descendantNote =
    includeDescendants && impact.openTasks.descendants.total > 0
      ? ` (${impact.openTasks.descendants.total} on descendants)`
      : "";
  return (
    <ThreadTaskDisposition
      action="archive"
      description={`${total} open ${total === 1 ? "task" : "tasks"}${descendantNote}`}
      groups={[
        { label: "This thread", tasks: impact.openTasks.root },
        ...(includeDescendants
          ? [
              {
                label: "Descendants",
                tasks: impact.openTasks.descendants,
                showOwningThread: true,
              },
            ]
          : []),
      ]}
      value={choices.taskDisposition}
      onChange={choices.setTaskDisposition}
      disabled={Boolean(choices.pending) || choices.loading}
    />
  );
}

export function unavailableReason(
  impact: ThreadArchiveImpact | undefined,
  choice: "only" | "all",
  loading: boolean,
  error: string,
): string | undefined {
  if (loading || !impact) {
    return error
      ? "Thread activity could not be checked."
      : "Checking thread activity…";
  }
  const availability =
    choice === "only" ? impact.archiveOnly : impact.archiveAll;
  return availability.available ? undefined : availability.unavailableReason;
}
