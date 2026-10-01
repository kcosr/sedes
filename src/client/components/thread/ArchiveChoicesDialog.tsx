import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ThreadArchiveImpact } from "../../../shared/index.js";
import { getThreadArchiveOperations } from "../../operations/thread-archive.js";
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
 * the shared archive workflow found,
 * and refreshes it after a failed archive or on Retry. Focus returns to
 * `returnFocusRef` because the opening menu row unmounts with its menu.
 */
type ArchiveChoicesDialogProps = ArchiveChoiceProps & {
  readonly initialImpact: ThreadArchiveImpact;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
};

/** Every entry point starts the same connection-scoped archive workflow. */
export function useArchiveThreadAction({
  returnFocusRef,
  ...choiceProps
}: ArchiveChoiceProps & {
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): {
  readonly start: () => void;
  readonly open: boolean;
} {
  const { thread, store, disabled } = choiceProps;
  const operations = getThreadArchiveOperations(store);
  const state = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const current = useRef(choiceProps);
  current.current = choiceProps;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const stillHere = () => mounted.current && current.current.thread.id === thread.id
    && current.current.store === store;
  return {
    start: () => {
      if (disabled) return;
      void operations.start({
        thread,
        returnFocusRef,
        onPendingChange: (pending) => {
          if (stillHere()) current.current.onPendingChange?.(pending);
        },
        onArchived: (choice, ids) => {
          // Archiving can remove its own row before the HTTP response. The
          // operation owner controls dismissal; row unmount is not dismissal.
          if (current.current.thread.id === thread.id && current.current.store === store) {
            current.current.onArchived?.(choice, ids);
          }
        },
      });
    },
    open: state.some((operation) => operation.thread.id === thread.id && operation.result),
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
            <strong>{choiceProps.thread.title.text}</strong>{". "}
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
            disabled={Boolean(selectedReason) || pending || choiceProps.disabled}
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
