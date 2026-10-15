import type { NormalizedThreadAttention } from "../../../shared/index.js";
import { automationPath } from "../../app/router.js";
import { Button } from "@client/components/ui/button";
import { followLink } from "../settings/SettingsNav.js";
import "./automation-context-notice.css";

type AutomationContext = NonNullable<
  NormalizedThreadAttention["automationContexts"][number]
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
  onDismiss,
}: {
  readonly context: AutomationContext;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const automation = automationPath(context.automationId);
  const failed = context.outcome === "failed";
  const uncertain = context.outcome === "uncertain";
  return (
    <aside
      className="thread-attention automation-context"
      data-tone={failed ? "danger" : uncertain ? "warning" : "neutral"}
    >
      <div className="automation-context-body">
        <div className="automation-context-text">
          <p>
            {uncertain ? `${context.name}: delivery outcome is unknown.` : failed
              ? `${context.name}: this run failed.`
              : `${context.name} triggered this thread.`}
          </p>
          {context.diagnostic && <small>{context.diagnostic.text}</small>}
        </div>
        <div className="automation-context-actions">
          {(
            <Button variant="outline" size="xs" asChild>
              <a href={automation} onClick={(event) => followLink(event, automation)}>
                Open automation
              </a>
            </Button>
          )}
          {!uncertain && <Button variant="outline" size="xs" onClick={onDismiss}>Dismiss</Button>}
        </div>
      </div>
    </aside>
  );
}
