import { useCallback } from "react";
import type { NormalizedThreadAttention } from "../../../shared/index.js";
import { automationPath } from "../../app/router.js";
import { findLoadedThread } from "../../automation/loaded-threads.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";
import { Button } from "@client/components/ui/button";
import { followLink } from "../settings/SettingsNav.js";
import "./automation-context-notice.css";

type AutomationContext = NonNullable<
  NormalizedThreadAttention["automationContext"]
>;

/**
 * The thread notice for a run an automation sent here: triggered, or failed
 * (red). The run's kind comes from the source thread's last run when that is
 * still the noticed run; the server records context for scheduled runs, so an
 * undeterminable kind keeps the scheduled wording. While the source thread
 * still has its automation, the notice links to its page. The label sits
 * over the diagnostic; the actions move under the text when it would
 * otherwise be squeezed.
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
  // The source thread can be a fork the sidebar loaded beyond the bootstrap.
  const selectOccurrence = useCallback(
    (state: ApplicationClientState) => {
      const lastRun = findLoadedThread(state, context.sourceThreadId)
        ?.automation?.lastRun;
      return lastRun?.id === context.runId ? lastRun.occurrence : undefined;
    },
    [context.runId, context.sourceThreadId],
  );
  const occurrence = useApplicationStoreSelector(store, selectOccurrence);
  const selectHasAutomation = useCallback(
    (state: ApplicationClientState) =>
      Boolean(findLoadedThread(state, context.sourceThreadId)?.automation),
    [context.sourceThreadId],
  );
  const hasAutomation = useApplicationStoreSelector(store, selectHasAutomation);
  const automation = automationPath(context.sourceThreadId);
  const failed = context.outcome === "failed";
  return (
    <aside
      className="thread-attention automation-context"
      data-tone={failed ? "danger" : "neutral"}
    >
      <div className="automation-context-body">
        <div className="automation-context-text">
          <p>
            {failed
              ? occurrence === "manual"
                ? "This run failed."
                : "This scheduled run failed."
              : "This thread was triggered by an automation."}
          </p>
          {context.diagnostic && <small>{context.diagnostic.text}</small>}
        </div>
        <div className="automation-context-actions">
          {hasAutomation ? (
            <Button variant="outline" size="xs" asChild>
              <a href={automation} onClick={(event) => followLink(event, automation)}>
                Open automation
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </aside>
  );
}
