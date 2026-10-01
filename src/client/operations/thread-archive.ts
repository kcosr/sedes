import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { runBlockingOperation } from "./blocking-operation.js";

/**
 * Whether archiving needs the choices dialog: descendants, unfinished work
 * (open tasks, stashed prompts, unanswered questions), an isolated workspace,
 * or an unavailable plain archive. Otherwise "Archive" archives at once.
 */
export function archiveNeedsChoices(impact: ThreadArchiveImpact): boolean {
  return (
    impact.descendantCount > 0 ||
    impact.openTasks.root.total > 0 ||
    impact.pendingQuestions.root > 0 ||
    impact.stashedPrompts.root > 0 ||
    impact.executionWorkspace.kind === "isolated" ||
    !impact.archiveOnly.available
  );
}

/** Dismissing progress leaves the check, required choices, and archive running. */
export async function runThreadArchiveCheck(options: {
  thread: NormalizedApplicationThreadSummary;
  store: ApplicationClientStore;
  onChoices: (impact: ThreadArchiveImpact) => void;
  onArchived: () => void;
  onDismissedError: (error: unknown) => void;
}): Promise<void> {
  let archiveStarted = false;
  let work: Promise<boolean> | undefined;
  await runBlockingOperation({
    message: "Archiving thread…",
    deferProgress: true,
    onDismissedError: options.onDismissedError,
    run: () => {
      work = (async () => {
        const impact = await options.store.getThreadArchiveImpact(options.thread.id);
        if (archiveNeedsChoices(impact)) {
          options.onChoices(impact);
          return false;
        }
        archiveStarted = true;
        await options.store.mutateInventory(options.thread, "archive", {
          expectedStashedPromptCount: impact.stashedPrompts.root,
        });
        return true;
      })();
      return work;
    },
    retry: () => !archiveStarted,
    onSuccess: (archived) => {
      if (archived) options.onArchived();
    },
  });
  // Prevent another archive from starting while dismissed work is still pending.
  // The operation runner reports failures, including those after dismissal.
  await work?.catch(() => undefined);
}
