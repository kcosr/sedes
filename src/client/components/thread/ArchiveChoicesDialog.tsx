import { useId, useState } from "react";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
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
 * archive entry point. It opens with the impact that
 * `useArchiveThreadAction`'s blocking check (`runThreadArchiveCheck`) found,
 * and refreshes it after a failed archive or on Retry. Focus returns to
 * `returnFocusRef` because the opening menu row unmounts with its menu.
 */
type ArchiveChoicesDialogProps = ArchiveChoiceProps & {
  readonly initialImpact: ThreadArchiveImpact;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
};

/**
 * The one archive flow, for every "Archive" menu item and button: `start()`
 * checks the thread behind the blocking progress, archives at once when
 * nothing needs choosing (`archiveNeedsChoices`), and otherwise opens
 * ArchiveChoicesDialog with the checked impact. Render `dialog` once, outside
 * the menu that calls `start`, so it survives the menu closing; `open`
 * reports the choices dialog to surfaces that track their open overlays.
 */
export function useArchiveThreadAction({
  returnFocusRef,
  ...choiceProps
}: ArchiveChoiceProps & {
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): {
  readonly start: () => void;
  readonly open: boolean;
  readonly dialog: React.ReactNode;
} {
  // The checked impact; the choices dialog is open while one is held.
  const [impact, setImpact] = useState<ThreadArchiveImpact>();
  const { thread, store, disabled, onArchived, onPendingChange } = choiceProps;
  const start = () => {
    if (disabled) return;
    onPendingChange?.(true);
    void runThreadArchiveCheck({
      thread,
      store,
      onChoices: setImpact,
      onArchived: () => onArchived?.("only", [thread.id]),
    }).finally(() => onPendingChange?.(false));
  };
  return {
    start,
    open: impact !== undefined,
    dialog: impact && (
      <ArchiveChoicesDialog
        {...choiceProps}
        initialImpact={impact}
        onOpenChange={(next) => {
          if (!next) setImpact(undefined);
        }}
        returnFocusRef={returnFocusRef}
      />
    ),
  };
}

/** Mounted per opening, so each starts from its impact and default choices. */
export function ArchiveChoicesDialog({
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

  const choice = hasDescendants && archiveDescendants ? "all" : "only";
  const selectedReason = choice === "all" ? allReason : onlyReason;
  const pending = Boolean(choices.pending);

  const archive = () => {
    void choices
      .archive(choice)
      .then(() => onOpenChange(false))
      .catch(() => undefined);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        size="md"
        // Above the sidebar drawer and the sheets it can be opened from.
        layer="blocking"
        dismissible={!pending}
        returnFocusRef={returnFocusRef}
      >
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
      </DialogContent>
    </Dialog>
  );
}
