import type { AutomationRunMode } from "../../../shared/protocol/domain";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";

/** "Run mode" section: anchor-thread note plus the same-thread / clone
 * choice. Presentation only — state lives in ThreadAutomationDialog. */
export function AutomationRunModeSection({
  threadTitle,
  runMode,
  onRunModeChange,
  canCloneOnRun,
}: {
  threadTitle: string;
  runMode: AutomationRunMode;
  onRunModeChange: (mode: AutomationRunMode) => void;
  canCloneOnRun: boolean;
}): React.JSX.Element {
  return (
    <section className="automation-section">
      <h2 className="automation-section-label">Run mode</h2>
      <div className="automation-section-card">
        <p className="automation-fixed-thread">
          This automation belongs to <strong>{threadTitle}</strong>.
        </p>
        <RadioGroup
          className="automation-option-group"
          aria-label="Run mode"
          value={runMode}
          onValueChange={(value) => onRunModeChange(value as AutomationRunMode)}
        >
          <label
            className={`automation-option-row ${runMode === "same_thread" ? "selected" : ""}`}
          >
            <RadioGroupItem value="same_thread" />
            <span>
              <strong>Continue in this thread</strong>
              <small>
                Each occurrence adds the prompt to the anchor conversation.
              </small>
            </span>
          </label>
          {(canCloneOnRun || runMode === "clone") && (
            <label
              className={`automation-option-row ${runMode === "clone" ? "selected" : ""}`}
            >
              <RadioGroupItem value="clone" disabled={!canCloneOnRun} />
              <span>
                <strong>Start a new cloned thread for each run</strong>
                <small>
                  {canCloneOnRun
                    ? "Native history is cloned through its latest completed point. An empty Draft creates a fresh child."
                    : "Clone mode is no longer available for this thread. Choose Continue in this thread before saving."}
                </small>
              </span>
            </label>
          )}
        </RadioGroup>
      </div>
    </section>
  );
}
