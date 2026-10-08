import { useEffect, useState } from "react";
import { ArrowDownToDot } from "lucide-react";
import type {
  OpenTaskDisposition,
  ThreadArchiveImpact,
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
import { messageFrom } from "../../stores/ApplicationClientStore.js";

export function parkNeedsConfirmation(impact: ThreadArchiveImpact): boolean {
  return impact.openTasks.root.total > 0 || impact.stashedPrompts.root > 0;
}

export function ParkImpactDialog({
  open,
  onOpenChange,
  impact,
  loadImpact,
  onPark,
  returnFocusRef,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly impact: ThreadArchiveImpact | undefined;
  readonly loadImpact: () => Promise<ThreadArchiveImpact>;
  readonly onPark: (options: {
    readonly expectedStashedPromptCount: number;
    readonly openTaskDisposition?: OpenTaskDisposition;
    readonly expectedOpenTaskSnapshot?: string;
  }) => Promise<void>;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [currentImpact, setCurrentImpact] = useState<
    ThreadArchiveImpact | undefined
  >(impact);
  const [disposition, setDisposition] =
    useState<OpenTaskDisposition>("move_to_project");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setCurrentImpact(impact);
    setDisposition("move_to_project");
    setError("");
  }, [impact, open]);

  const openTaskCount = currentImpact?.openTasks.root.total ?? 0;
  const stashedPromptCount = currentImpact?.stashedPrompts.root ?? 0;

  const park = () => {
    if (pending || !currentImpact) return;
    setPending(true);
    setError("");
    void onPark({
      expectedStashedPromptCount: currentImpact.stashedPrompts.root,
      ...(openTaskCount > 0 ? { openTaskDisposition: disposition } : {}),
      ...(openTaskCount > 0 && disposition === "complete"
        ? { expectedOpenTaskSnapshot: currentImpact.openTasks.root.snapshot }
        : {}),
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
          <DialogTitle>Park this thread</DialogTitle>
          <DialogDescription>
            Review unfinished work before parking this thread.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {stashedPromptCount > 0 && (
            <DialogAlert
              tone="warning"
              role="note"
              data-testid="park-stashed-prompt-warning"
              title={`${stashedPromptCount} stashed ${stashedPromptCount === 1 ? "prompt" : "prompts"}`}
            >
              {stashedPromptCount === 1 ? "It" : "They"} will remain attached
              to the parked thread.
            </DialogAlert>
          )}
          {currentImpact && (
            <ThreadTaskDisposition
              action="park"
              description={`This thread has ${openTaskCount} open ${openTaskCount === 1 ? "task" : "tasks"}. Choose what should happen before parking.`}
              groups={[
                { label: "This thread", tasks: currentImpact.openTasks.root },
              ]}
              value={disposition}
              onChange={setDisposition}
              disabled={pending}
            />
          )}
          {error && <DialogAlert tone="danger">{error}</DialogAlert>}
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
            onClick={park}
            disabled={pending || !currentImpact}
          >
            <ArrowDownToDot />
            {pending ? "Parking…" : "Park"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
