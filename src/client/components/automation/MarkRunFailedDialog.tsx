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
 * Marks a run whose outcome is unknown as failed. For a recurring schedule
 * the primary choice also resumes the schedule (the server does both in one
 * request) and the secondary keeps it paused. A one-time automation has
 * nothing to resume: marking its run failed ends it, so it has one action.
 * Built like ConfirmDialog: a card with no X, Cancel as the way out,
 * dismissal locked and the pressed action relabelled while it runs, and a
 * failure kept inline.
 */
export function MarkRunFailedDialog({
  open,
  onOpenChange,
  runTime,
  oneTime,
  onResolve,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The run's time inside a sentence ("today at 12:00 AM"). */
  readonly runTime: string;
  /** The automation runs once (a date and time schedule). */
  readonly oneTime: boolean;
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
      {/* Two ways to confirm need the md width; a card on phones, like ConfirmDialog. */}
      <DialogContent
        size={oneTime ? "sm" : "md"}
        mobile="card"
        showClose={false}
        dismissible={!pending}
        aria-busy={pending ? true : undefined}
      >
        <DialogHeader>
          <DialogTitle>Mark the run as failed?</DialogTitle>
          <DialogDescription>
            Sedes stops waiting on the run from {runTime}
            {oneTime ? ", and this one-time automation ends" : null}. If the
            agent did get the prompt, its work is in the thread either way.
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
          {oneTime ? (
            <Button
              type="button"
              disabled={pending !== undefined}
              onClick={() => void resolve("keep_paused")}
            >
              {pending ? "Marking…" : "Mark failed"}
            </Button>
          ) : (
            <>
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
