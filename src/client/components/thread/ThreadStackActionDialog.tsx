import { Archive, ArrowDownToDot, ArrowUpFromDot } from "lucide-react";
import { useEffect, useState } from "react";
import { MAXIMUM_BULK_INVENTORY_OPEN_TASKS } from "../../../shared/index.js";
import type {
  BulkInventoryAction,
  BulkInventoryImpact,
  OpenTaskDisposition,
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
  DialogTitle,
} from "@client/components/ui/dialog";
import { ThreadTaskDisposition } from "./ThreadTaskDisposition.js";
import {
  inventoryActionLabel,
  inventoryActionProgress,
} from "./inventory-action-labels.js";

export function ThreadStackActionDialog({
  open,
  onOpenChange,
  label,
  action,
  impact,
  loading,
  pending,
  requestLocked,
  error,
  onReload,
  onConfirm,
  threadTitleFor,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly action: BulkInventoryAction | undefined;
  readonly impact: BulkInventoryImpact | undefined;
  readonly loading: boolean;
  readonly pending: boolean;
  /** A first delivery attempt freezes task choices and the mutation id. */
  readonly requestLocked: boolean;
  readonly error: string;
  readonly onReload: () => void;
  readonly onConfirm: (options: {
    readonly openTaskDisposition?: OpenTaskDisposition;
  }) => void;
  readonly threadTitleFor: (threadId: string) => string | undefined;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [disposition, setDisposition] =
    useState<OpenTaskDisposition>("move_to_project");
  useEffect(() => {
    if (open) setDisposition("move_to_project");
  }, [open, action]);

  const affectedCount = impact?.affectedCount ?? 0;
  const blockerCount = impact?.blockers.total ?? 0;
  const actionLabel = action ? inventoryActionLabel(action) : "Update";
  const actionPresent = action ? inventoryActionProgress(action) : "Updating";
  const unavailable =
    !impact || !impact.available || affectedCount === 0 || blockerCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        size="md"
        layer="over-dialog"
        dismissible={!pending}
        returnFocusRef={returnFocusRef}
      >
        <DialogHeader>
          <DialogTitle>
            {actionLabel} threads in {label}
          </DialogTitle>
          <DialogDescription>
            {loading || !impact
              ? "Checking the current stack impact…"
              : `${actionLabel} ${affectedCount} ${affectedCount === 1 ? "thread" : "threads"}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {impact && action === "archive" && impact.pendingQuestionCount > 0 ? (
            <DialogAlert
              tone="warning"
              role="note"
              title={`${impact.pendingQuestionCount} unanswered ${impact.pendingQuestionCount === 1 ? "question" : "questions"}`}
            >
              Questions remain attached to archived threads and will be
              available when you unarchive them.
            </DialogAlert>
          ) : null}

          {impact && impact.stashedPromptCount > 0 ? (
            <DialogAlert
              tone="warning"
              role="note"
              title={`${impact.stashedPromptCount} stashed ${impact.stashedPromptCount === 1 ? "prompt" : "prompts"}`}
            >
              They remain attached to their threads.
            </DialogAlert>
          ) : null}

          {impact && action && action !== "unsettle" ? (
            <ThreadTaskDisposition
              action={action === "settle" ? "park" : "archive"}
              description={`The affected threads have ${impact.openTasks.total} open ${impact.openTasks.total === 1 ? "task" : "tasks"}. Choose what should happen before ${actionPresent.toLocaleLowerCase()}.`}
              groups={[
                {
                  label: "Affected threads",
                  tasks: impact.openTasks,
                  showOwningThread: true,
                },
              ]}
              value={disposition}
              onChange={setDisposition}
              disabled={loading || pending || requestLocked}
              threadTitleFor={threadTitleFor}
            />
          ) : null}

          {impact &&
          impact.openTasks.total > MAXIMUM_BULK_INVENTORY_OPEN_TASKS ? (
            <DialogAlert tone="danger">
              This stack has too many open tasks for one bulk action. Reduce it
              to {MAXIMUM_BULK_INVENTORY_OPEN_TASKS.toLocaleString()} or fewer
              and refresh the impact.
            </DialogAlert>
          ) : null}

          {impact && blockerCount > 0 ? (
            <DialogAlert
              tone="warning"
              role="status"
              title={`${blockerCount} blocked ${blockerCount === 1 ? "thread" : "threads"}`}
            >
              <ul className="thread-stack-blockers">
                {impact.blockers.items.map((blocker) => (
                  <li key={blocker.threadId}>
                    {threadTitleFor(blocker.threadId) ?? blocker.threadId}:{" "}
                    {blocker.reason}
                  </li>
                ))}
              </ul>
              {impact.blockers.omitted > 0 ? (
                <p className="m-0">And {impact.blockers.omitted} more.</p>
              ) : null}
            </DialogAlert>
          ) : null}

          {error ? (
            <DialogAlert
              tone="danger"
              action={
                pending ? undefined : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onReload}
                  >
                    Refresh impact
                  </Button>
                )
              }
            >
              {error}
            </DialogAlert>
          ) : null}
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
            disabled={loading || pending || unavailable}
            onClick={() =>
              onConfirm({
                ...(impact &&
                action !== "unsettle" &&
                impact.openTasks.total > 0
                  ? { openTaskDisposition: disposition }
                  : {}),
              })
            }
          >
            {action === "settle" ? (
              <ArrowDownToDot />
            ) : action === "unsettle" ? (
              <ArrowUpFromDot />
            ) : (
              <Archive />
            )}
            {pending ? `${actionPresent}…` : actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
