import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { runBlockingOperation } from "./blocking-operation.js";

/** Direct sidebar archive waits visibly and hands a complete impact to choices. */
export function runThreadArchiveCheck(options: {
  thread: NormalizedApplicationThreadSummary;
  store: ApplicationClientStore;
  onChoices: (impact: ThreadArchiveImpact) => void;
  onArchived: () => void;
}): Promise<void> {
  let archiveStarted = false;
  return runBlockingOperation({
    message: "Checking thread activity…",
    deferProgress: true,
    run: () => options.store.getThreadArchiveImpact(options.thread.id),
    retry: () => !archiveStarted,
    onSuccess: async (impact, context) => {
      if (
        impact.descendantCount > 0 ||
        impact.openTasks.root.total > 0 ||
        impact.pendingQuestions.root > 0 ||
        impact.stashedPrompts.root > 0 ||
        impact.executionWorkspace.kind === "isolated" ||
        !impact.archiveOnly.available
      ) {
        options.onChoices(impact);
        return;
      }
      archiveStarted = true;
      context.setMessage("Archiving thread…");
      await options.store.mutateInventory(options.thread, "archive", {
        expectedStashedPromptCount: impact.stashedPrompts.root,
      });
      if (context.isActive()) options.onArchived();
    },
  });
}
