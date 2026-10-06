import { useEffect, useState } from "react";
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

type Choice = "resume" | "keep_paused";

/**
 * Marks a run whose outcome is unknown as failed. The primary choice also
 * resumes the schedule (the server does both in one request); the
 * secondary keeps the automation paused. Built like ConfirmDialog: a small
 * card with no X, Cancel as the way out, dismissal locked and the pressed
 * action relabelled while it runs, and a failure kept inline.
 */
export function MarkRunFailedDialog({
  open,
  onOpenChange,
  runTime,
  onResolve,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The run's time as the page shows it ("Today 12:00 AM"). */
  readonly runTime: string;
  /** Resolves the run; a rejection keeps the dialog open with its message. */
  readonly onResolve: (resume: boolean) => Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState<Choice>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) setError(undefined);
  }, [open]);

  const resolve = async (choice: Choice) => {
    if (pending) return;
    setPending(choice);
    setError(undefined);
    try {
      await onResolve(choice === "resume");
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        size="sm"
        showClose={false}
        dismissible={!pending}
        aria-busy={pending ? true : undefined}
      >
        <DialogHeader>
          <DialogTitle>Mark the run as failed?</DialogTitle>
          <DialogDescription>
            Sedes stops waiting on the {runTime} run. If the agent did get the
            prompt, its work is in the thread either way.
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <DialogBody>
            <DialogAlert tone="danger">{error}</DialogAlert>
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending !== undefined}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending !== undefined}
            onClick={() => void resolve("keep_paused")}
          >
            {pending === "keep_paused" ? "Marking…" : "Mark failed, keep paused"}
          </Button>
          <Button
            type="button"
            disabled={pending !== undefined}
            onClick={() => void resolve("resume")}
          >
            {pending === "resume" ? "Marking…" : "Mark failed and resume"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
