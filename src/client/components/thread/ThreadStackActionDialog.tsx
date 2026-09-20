import * as Dialog from "@radix-ui/react-dialog";
import { Archive, ArrowDownToDot, ArrowUpFromDot, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MAXIMUM_BULK_INVENTORY_OPEN_TASKS } from "../../../shared/index.js";
import type {
  BulkInventoryAction,
  BulkInventoryImpact,
  OpenTaskDisposition,
} from "../../../shared/index.js";
import { Button } from "../ui/button.js";
import { SegmentedControl } from "../tasks/SegmentedControl.js";

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
  const [disposition, setDisposition] = useState<OpenTaskDisposition>(
    "move_to_workspace",
  );
  useEffect(() => {
    if (open) setDisposition("move_to_workspace");
  }, [open, action]);

  const affectedCount = impact?.affectedCount ?? 0;
  const blockerCount = impact?.blockers.total ?? 0;
  const actionLabel = action ? capitalize(action) : "Update";
  const actionPresent = action ? presentParticiple(action) : "Updating";
  const unavailable =
    !impact || !impact.available || affectedCount === 0 || blockerCount > 0;
  const descriptionId = "thread-stack-action-description";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay over-drawer" />
        <Dialog.Content
          className="dialog-card over-drawer"
          aria-describedby={descriptionId}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Dialog.Title>
            {actionLabel} threads in {label}
          </Dialog.Title>
          <Dialog.Description id={descriptionId}>
            {loading || !impact
              ? "Checking the current stack impact…"
              : `${actionLabel} ${affectedCount} ${affectedCount === 1 ? "thread" : "threads"}.`}
          </Dialog.Description>
          <Dialog.Close asChild>
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

          {impact && action === "archive" && impact.pendingQuestionCount > 0 ? (
            <div className="archive-stashed-prompt-warning" role="note">
              <strong>
                {impact.pendingQuestionCount} unanswered{" "}
                {impact.pendingQuestionCount === 1 ? "question" : "questions"}
              </strong>
              <span>
                Questions remain attached to archived threads and will be
                available when you unarchive them.
              </span>
            </div>
          ) : null}

          {impact && impact.stashedPromptCount > 0 ? (
            <div className="archive-stashed-prompt-warning" role="note">
              <strong>
                {impact.stashedPromptCount} stashed{" "}
                {impact.stashedPromptCount === 1 ? "prompt" : "prompts"}
              </strong>
              <span>They remain attached to their threads.</span>
            </div>
          ) : null}

          {impact && impact.openTasks.total > 0 && action !== "unsettle" ? (
            <div className="archive-task-disposition">
              <span className="archive-task-disposition-label">
                The affected threads have {impact.openTasks.total} open{" "}
                {impact.openTasks.total === 1 ? "task" : "tasks"}. Choose what
                should happen before {actionPresent.toLocaleLowerCase()}.
              </span>
              <SegmentedControl
                ariaLabel="Open task handling"
                size="small"
                value={disposition}
                onChange={(value) =>
                  setDisposition(value as OpenTaskDisposition)
                }
                options={[
                  {
                    value: "move_to_workspace",
                    label: "To project",
                    title: "Move each task to its thread's project",
                    disabled: pending || requestLocked,
                  },
                  {
                    value: "move_to_global",
                    label: "To global",
                    title: "Move open tasks to the global list",
                    disabled: pending || requestLocked,
                  },
                  {
                    value: "keep",
                    label: "Keep",
                    title: "Leave open tasks with their threads",
                    disabled: pending || requestLocked,
                  },
                ]}
              />
            </div>
          ) : null}

          {impact &&
          impact.openTasks.total > MAXIMUM_BULK_INVENTORY_OPEN_TASKS ? (
            <p className="menu-error" role="alert">
              This stack has too many open tasks for one bulk action. Reduce it
              to {MAXIMUM_BULK_INVENTORY_OPEN_TASKS.toLocaleString()} or fewer
              and refresh the impact.
            </p>
          ) : null}

          {impact && blockerCount > 0 ? (
            <div className="thread-stack-blockers" role="status">
              <strong>
                {blockerCount} blocked {blockerCount === 1 ? "thread" : "threads"}
              </strong>
              <ul>
                {impact.blockers.items.map((blocker) => (
                  <li key={blocker.threadId}>
                    {threadTitleFor(blocker.threadId) ?? blocker.threadId}: {" "}
                    {blocker.reason}
                  </li>
                ))}
              </ul>
              {impact.blockers.omitted > 0 ? (
                <span>And {impact.blockers.omitted} more.</span>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="menu-error" role="alert">
              {error}{" "}
              {!pending ? (
                <button
                  type="button"
                  className="archive-menu-retry"
                  onClick={onReload}
                >
                  Refresh impact
                </button>
              ) : null}
            </p>
          ) : null}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant={action === "archive" ? "destructive" : "default"}
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
                <ArrowDownToDot size={18} strokeWidth={1.8} />
              ) : action === "unsettle" ? (
                <ArrowUpFromDot size={18} strokeWidth={1.8} />
              ) : (
                <Archive size={18} strokeWidth={1.8} />
              )}
              {pending ? `${actionPresent}…` : actionLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function capitalize(action: BulkInventoryAction): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function presentParticiple(action: BulkInventoryAction): string {
  if (action === "archive") return "Archiving";
  if (action === "settle") return "Settling";
  return "Unsettling";
}
