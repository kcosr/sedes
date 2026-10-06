import { useCallback } from "react";
import type { NormalizedThreadAttention } from "../../../shared/index.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";
import { Button } from "@client/components/ui/button";

type AutomationContext = NonNullable<
  NormalizedThreadAttention["automationContext"]
>;

/**
 * The thread notice for a run an automation sent here: triggered, or failed
 * (red). The run's kind comes from the source thread's last run when that is
 * still the noticed run; the server records context for scheduled runs, so an
 * undeterminable kind keeps the scheduled wording.
 */
export function AutomationContextNotice({
  context,
  store,
  onDismiss,
}: {
  readonly context: AutomationContext;
  readonly store: Pick<ApplicationClientStore, "subscribe" | "getSnapshot">;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const selectOccurrence = useCallback(
    (state: ApplicationClientState) => {
      const lastRun = state.snapshot?.threads.find(
        ({ id }) => id === context.sourceThreadId,
      )?.automation?.lastRun;
      return lastRun?.id === context.runId ? lastRun.occurrence : undefined;
    },
    [context.runId, context.sourceThreadId],
  );
  const occurrence = useApplicationStoreSelector(store, selectOccurrence);
  const failed = context.outcome === "failed";
  return (
    <aside
      className="thread-attention automation-context"
      data-tone={failed ? "danger" : undefined}
    >
      <div className="thread-attention-text">
        <p>
          {failed
            ? occurrence === "manual"
              ? "This run failed."
              : "This scheduled run failed."
            : "This thread was triggered by an automation."}
        </p>
        {context.diagnostic && <small>{context.diagnostic.text}</small>}
      </div>
      <Button variant="outline" size="xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </aside>
  );
}
