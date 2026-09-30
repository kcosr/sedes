import { useEffect, useId, useState } from "react";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
import {
  OperationLoading,
  useOperationContentFocus,
} from "../../operations/OperationOverlay.js";
import { runThreadArchiveCheck } from "../../operations/thread-archive.js";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";
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
import { Label } from "@client/components/ui/label";
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
 * The archive choices: descendants, unfinished work and isolated-workspace
 * handling, with the wording, availability gating and error retry of every
 * archive entry point. Opened with an `initialImpact` after a blocking check
 * (`runThreadArchiveCheck`), or without one, in which case it runs the check
 * itself behind the blocking progress first. Focus returns to
 * `returnFocusRef` because the opening menu row unmounts with its menu.
 */
type ArchiveChoicesDialogProps = ArchiveChoiceProps & {
  readonly initialImpact?: ThreadArchiveImpact;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
};

/**
 * "Archive…" for a menu item or button: `start()` checks the thread behind
 * the blocking progress, archives at once when nothing needs choosing
 * (`archiveNeedsChoices`), and otherwise opens ArchiveChoicesDialog with the
 * checked impact. Render `dialog` once, outside the menu that calls `start`,
 * so it survives the menu closing.
 */
export function useArchiveThreadAction({
  returnFocusRef,
  ...choiceProps
}: ArchiveChoiceProps & {
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): {
  readonly start: () => void;
  readonly dialog: React.ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [initialImpact, setInitialImpact] = useState<ThreadArchiveImpact>();
  const { thread, store, disabled, onArchived, onPendingChange } = choiceProps;
  const start = () => {
    if (disabled) return;
    onPendingChange?.(true);
    void runThreadArchiveCheck({
      thread,
      store,
      onChoices: (impact) => {
        setInitialImpact(impact);
        setOpen(true);
      },
      onArchived: () => onArchived?.("only", [thread.id]),
    }).finally(() => onPendingChange?.(false));
  };
  return {
    start,
    dialog: (
      <ArchiveChoicesDialog
        {...choiceProps}
        open={open}
        initialImpact={initialImpact}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setInitialImpact(undefined);
        }}
        returnFocusRef={returnFocusRef}
      />
    ),
  };
}

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
  const descendantsId = useId();

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
  const contentRef = useOperationContentFocus(checking, !checking);
  const pending = Boolean(choices.pending);

  const archive = () => {
    void choices
      .archive(choice)
      .then(() => onOpenChange(false))
      .catch(() => undefined);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        ref={contentRef}
        size="md"
        mobile={checking ? "card" : undefined}
        layer="blocking"
        showClose={!checking}
        dismissible={!checking && !pending}
        className={checking ? "operation-progress-surface" : undefined}
        // The impact check is a blocking operation (only its Cancel leaves
        // it); the choices are an ordinary form dialog.
        {...(checking
          ? {
              "data-blocking-operation": "true",
              onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
            }
          : {})}
        returnFocusRef={returnFocusRef}
      >
        {checking ? (
          <>
            <DialogTitle className="sr-only">
              Checking thread activity
            </DialogTitle>
            <DialogDescription className="sr-only">
              Checking the thread before showing archive choices.
            </DialogDescription>
            <OperationLoading
              deferred
              message="Checking thread activity…"
              onCancel={() => onOpenChange(false)}
            />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Archive this thread</DialogTitle>
              <DialogDescription>
                {hasDescendants
                  ? "Choose whether this thread's forked descendants should be archived too."
                  : "Archived threads leave the inventory until restored."}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {hasDescendants && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={descendantsId}
                    checked={archiveDescendants}
                    disabled={choices.loading || pending}
                    onCheckedChange={(checked) =>
                      setArchiveDescendants(checked === true)
                    }
                  />
                  <Label htmlFor={descendantsId}>
                    Archive child and descendant forks
                  </Label>
                </div>
              )}
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
              {choices.error ? (
                <DialogAlert
                  id={reasonId}
                  tone="danger"
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void choices.load()}
                    >
                      Retry
                    </Button>
                  }
                >
                  {choices.error}
                </DialogAlert>
              ) : selectedReason ? (
                <p className="archive-choice-note" id={reasonId} role="status">
                  {selectedReason}
                </p>
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
                disabled={Boolean(selectedReason) || pending}
                aria-describedby={selectedReason ? reasonId : undefined}
                onClick={archive}
              >
                {pending ? "Archiving…" : "Archive"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
