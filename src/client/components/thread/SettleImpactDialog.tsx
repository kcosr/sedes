import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { ArrowDownToDot, X } from "lucide-react";
import type {
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../../shared/index.js";
import { Button } from "@client/components/ui/button";
import { SegmentedControl } from "../tasks/SegmentedControl.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";

export function settleNeedsConfirmation(impact: ThreadArchiveImpact): boolean {
  return (
    impact.openTasks.root.total > 0 || impact.stashedPrompts.root > 0
  );
}

export function SettleImpactDialog({
  open,
  onOpenChange,
  impact,
  loadImpact,
  onSettle,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly impact: ThreadArchiveImpact | undefined;
  readonly loadImpact: () => Promise<ThreadArchiveImpact>;
  readonly onSettle: (options: {
    readonly expectedStashedPromptCount: number;
    readonly openTaskDisposition?: OpenTaskDisposition;
  }) => Promise<void>;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [currentImpact, setCurrentImpact] =
    useState<ThreadArchiveImpact | undefined>(impact);
  const [disposition, setDisposition] = useState<OpenTaskDisposition>(
    "move_to_workspace",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setCurrentImpact(impact);
    setDisposition("move_to_workspace");
    setError("");
  }, [impact, open]);

  const openTaskCount = currentImpact?.openTasks.root.total ?? 0;
  const stashedPromptCount = currentImpact?.stashedPrompts.root ?? 0;

  const settle = () => {
    if (pending || !currentImpact) return;
    setPending(true);
    setError("");
    void onSettle({
      expectedStashedPromptCount: currentImpact.stashedPrompts.root,
      ...(openTaskCount > 0 ? { openTaskDisposition: disposition } : {}),
    })
      .then(() => onOpenChange(false))
      .catch(async (cause: unknown) => {
        setError(messageFrom(cause));
        try {
          setCurrentImpact(await loadImpact());
        } catch {
          // Keep the mutation error visible. Reopening performs a fresh check.
        }
      })
      .finally(() => setPending(false));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay over-drawer" />
        <Dialog.Content
          className="dialog-card over-drawer"
          aria-describedby="settle-impact-description"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <Dialog.Title>Settle this thread</Dialog.Title>
          <Dialog.Description id="settle-impact-description">
            Review unfinished work before settling this thread.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dialog-close"
              aria-label="Close"
            >
              <X size={18} strokeWidth={1.8} />
            </Button>
          </Dialog.Close>
          {stashedPromptCount > 0 && (
            <div
              className="archive-stashed-prompt-warning"
              data-testid="settle-stashed-prompt-warning"
              role="note"
            >
              <strong>
                {stashedPromptCount} stashed{" "}
                {stashedPromptCount === 1 ? "prompt" : "prompts"}
              </strong>
              <span>
                {stashedPromptCount === 1 ? "It" : "They"} will remain attached
                to the settled thread.
              </span>
            </div>
          )}
          {openTaskCount > 0 && (
            <div className="archive-task-disposition">
              <span className="archive-task-disposition-label">
                This thread has {openTaskCount} open{" "}
                {openTaskCount === 1 ? "task" : "tasks"}. Choose what should
                happen before settling.
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
                    title: "Move open tasks to the thread's project",
                    disabled: pending,
                  },
                  {
                    value: "move_to_global",
                    label: "To global",
                    title: "Move open tasks to the global list",
                    disabled: pending,
                  },
                  {
                    value: "keep",
                    label: "Keep",
                    title: "Leave open tasks with the settled thread",
                    disabled: pending,
                  },
                ]}
              />
            </div>
          )}
          {error && (
            <p className="menu-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={settle} disabled={pending || !currentImpact}>
              <ArrowDownToDot size={18} strokeWidth={1.8} />
              {pending ? "Settling…" : "Settle"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
