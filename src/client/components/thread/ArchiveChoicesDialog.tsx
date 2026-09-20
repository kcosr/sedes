import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
import { X } from "lucide-react";
import {
  OperationLoading,
  useOperationContentFocus,
} from "../../operations/OperationOverlay.js";
import { Button } from "@client/components/ui/button";
import {
  ArchiveStashedPromptWarning,
  ArchiveQuestionWarning,
  ArchiveTaskDisposition,
  ArchiveExecutionWorkspaceDisposition,
  unavailableReason,
  useArchiveChoices,
  type ArchiveChoiceProps,
} from "./ArchiveThreadChoices.js";

/**
 * Mobile presentation of the archive choices: small screens cannot place the
 * dropdown/submenu flyouts reliably, so the same choices (wording, availability
 * gating, error retry) surface as a modal dialog instead. Follows the
 * SnoozeDialog shape: controlled Radix dialog with explicit focus restoration
 * because the trigger lives inside a popover that unmounts.
 */
type ArchiveChoicesDialogProps = ArchiveChoiceProps & {
  readonly initialImpact?: ThreadArchiveImpact;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
};

export function ArchiveChoicesDialog(
  props: ArchiveChoicesDialogProps,
): React.JSX.Element | null {
  // Each opening owns a fresh impact check, including after a canceled request.
  return props.open ? <OpenArchiveChoicesDialog {...props} /> : null;
}

function OpenArchiveChoicesDialog({
  open,
  onOpenChange,
  returnFocusRef,
  initialImpact,
  ...choiceProps
}: ArchiveChoicesDialogProps): React.JSX.Element {
  const choices = useArchiveChoices(choiceProps, initialImpact);
  const allReason = unavailableReason(
    choices.impact,
    "all",
    choices.loading,
    choices.error,
  );
  const onlyReason = unavailableReason(
    choices.impact,
    "only",
    choices.loading,
    choices.error,
  );
  const reasonId = `archive-dialog-unavailable-${choiceProps.thread.id}`;
  const displayedDescendantCount =
    choices.impact?.descendantCount ?? choiceProps.descendantCount;
  const hasDescendants = displayedDescendantCount > 0;
  const [archiveDescendants, setArchiveDescendants] = useState(false);

  useEffect(() => {
    if (open) {
      setArchiveDescendants(false);
      choices.setExecutionWorkspaceDisposition("keep");
      if (!initialImpact) void choices.load();
    }
    // load reads the latest hook state each render; only (re)load on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choice = hasDescendants && archiveDescendants ? "all" : "only";
  const selectedReason = choice === "all" ? allReason : onlyReason;

  const checking = !choices.impact && !choices.error;
  const contentRef = useOperationContentFocus(checking);

  const archive = () => {
    void choices
      .archive(choice)
      .then(() => onOpenChange(false))
      .catch(() => undefined);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay operation-overlay-backdrop"
          data-testid="dialog-overlay"
        />
        <Dialog.Content
          ref={contentRef}
          className={
            checking
              ? "operation-overlay-content"
              : "dialog-card operation-confirmation"
          }
          data-blocking-operation="true"
          onKeyDown={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          aria-describedby="archive-choices-description"
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {checking ? (
            <>
              <Dialog.Title className="sr-only">
                Checking thread activity
              </Dialog.Title>
              <Dialog.Description
                id="archive-choices-description"
                className="sr-only"
              >
                Checking the thread before showing archive choices.
              </Dialog.Description>
              <OperationLoading
                deferred
                message="Checking thread activity…"
                onCancel={() => onOpenChange(false)}
              />
            </>
          ) : (
            <>
              <Dialog.Title>Archive this thread</Dialog.Title>
              <Dialog.Description id="archive-choices-description">
                {hasDescendants
                  ? "Choose whether this thread's forked descendants should be archived too."
                  : "Archived threads leave the inventory until restored."}
              </Dialog.Description>
              <Dialog.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="dialog-close"
                  aria-label="Close"
                  disabled={Boolean(choices.pending)}
                >
                  <X size={18} strokeWidth={1.8} />
                </Button>
              </Dialog.Close>
              <ArchiveQuestionWarning choices={choices} scope={choice} />
              <ArchiveStashedPromptWarning choices={choices} scope={choice} />
              <ArchiveTaskDisposition
                choices={choices}
                includeDescendants={choice === "all"}
              />
              <ArchiveExecutionWorkspaceDisposition
                choices={choices}
                includeDescendants={choice === "all"}
              />
              {hasDescendants && (
                <label className="archive-descendants-choice">
                  <input
                    type="checkbox"
                    checked={archiveDescendants}
                    disabled={choices.loading || Boolean(choices.pending)}
                    onChange={(event) =>
                      setArchiveDescendants(event.target.checked)
                    }
                  />
                  Archive child and descendant forks
                </label>
              )}
              {(choices.error || selectedReason) && (
                <p
                  className="menu-error"
                  id={reasonId}
                  role={choices.error ? "alert" : "status"}
                >
                  {choices.error || selectedReason}
                  {choices.error && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="archive-menu-retry"
                        onClick={() => void choices.load()}
                      >
                        Retry
                      </button>
                    </>
                  )}
                </p>
              )}
              <div className="dialog-actions">
                <Dialog.Close asChild>
                  <Button variant="ghost" disabled={Boolean(choices.pending)}>
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  variant="destructive"
                  disabled={Boolean(selectedReason) || Boolean(choices.pending)}
                  aria-describedby={selectedReason ? reasonId : undefined}
                  onClick={archive}
                >
                  {choices.pending ? "Archiving…" : "Archive"}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
