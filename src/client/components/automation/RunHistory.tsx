import { automationTimeLabel } from "../../lib/time";
import type { ThreadAutomationRun } from "../../types";
import { Button } from "@client/components/ui/button";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../../workspace-panels/thread-panel-navigation.js";

/** Run-history rail: task-list-row language — status dot, kind, quiet state
 * word, trailing time, meta lines below. Presentation only. */
export function AutomationRunHistory({
  history,
  saving,
  onResolveRun,
}: {
  history: readonly ThreadAutomationRun[];
  saving: boolean;
  onResolveRun: (runId: string) => void;
}): React.JSX.Element {
  return (
    <aside className="automation-history" aria-live="polite">
      <h2 className="automation-section-label">Run history</h2>
      <div className="automation-section-card automation-history-card">
        {history.length === 0 ? (
          <p className="automation-history-empty">No runs yet.</p>
        ) : (
          history.map((run) => (
            <article
              key={run.id}
              className="automation-run"
              data-state={run.state}
            >
              <span className="automation-run-dot" aria-hidden="true" />
              <div className="automation-run-body">
                <div className="automation-run-head">
                  <strong>
                    {run.occurrence === "manual" ? "Run now" : "Scheduled"}
                  </strong>
                  <span className="automation-run-state">
                    {run.state.replace("_", " ")}
                  </span>
                  <span className="automation-run-time">
                    {automationTimeLabel(run.scheduledFor)}
                  </span>
                </div>
                {run.resultThreadId && (
                  <Button
                    variant="link"
                    size="sm"
                    className="automation-run-action"
                    onClick={(event) =>
                      openThreadRoute(
                        run.resultThreadId!,
                        pointerPanelPresentation(event),
                      )
                    }
                  >
                    Open result thread
                  </Button>
                )}
                {run.state === "uncertain" && (
                  <Button
                    variant="link"
                    size="sm"
                    className="automation-run-action"
                    disabled={saving}
                    onClick={() => onResolveRun(run.id)}
                  >
                    Resolve as failed
                  </Button>
                )}
                {run.precheck && (
                  <small className="automation-run-precheck">
                    Precheck {run.precheck.status}
                    {run.precheck.exitCode === undefined
                      ? ""
                      : ` · exit ${run.precheck.exitCode}`}
                    {` · ${run.precheck.durationMilliseconds} ms`}
                    {run.precheck.stdoutIncluded ? " · stdout included" : ""}
                  </small>
                )}
                {run.diagnostic && <small>{run.diagnostic}</small>}
              </div>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
