import type { AutomationRunMode } from "../../../shared/protocol/domain.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Callout } from "@client/components/ui/callout";
import { RadioGroup } from "@client/components/ui/radio-group";
import { AutomationChoice } from "./AutomationChoice.js";

/**
 * "Run in": this thread, or a new fork for each run. The fork option stays
 * visible and is disabled with its reason when the thread cannot fork.
 * Presentation only; the form lives in useAutomationEditor.
 */
export function AutomationRunModeSection({
  id,
  value,
  onChange,
  canCloneOnRun,
  forkDraftOnly,
}: {
  readonly id: string;
  readonly value: AutomationRunMode;
  readonly onChange: (mode: AutomationRunMode) => void;
  readonly canCloneOnRun: boolean;
  readonly forkDraftOnly?: boolean;
}): React.JSX.Element {
  const cloneUnavailable = value === "clone" && !canCloneOnRun;
  return (
    <SettingsSection id={id} title="Run in" card>
      <RadioGroup
        className="automation-choice-list"
        aria-label="Run in"
        aria-invalid={cloneUnavailable || undefined}
        value={value}
        onValueChange={(next) => onChange(next as AutomationRunMode)}
      >
        <AutomationChoice
          value="same_thread"
          title="This thread"
          description="Each run adds the prompt to this conversation."
        />
        <AutomationChoice
          value="clone"
          title="Fork"
          disabled={!canCloneOnRun}
          description={
            canCloneOnRun
              ? "Each run creates a separate child from this source: its settings while unstarted, or its latest completed turn after it starts."
              : "Not available for this thread: forking needs a completed turn and a backend that can fork."
          }
        />
      </RadioGroup>
      {forkDraftOnly && value === "clone" ? <Callout tone="warning">This backend can copy an unstarted source. After this source starts, Fork runs will fail because the backend cannot fork conversations.</Callout> : null}
      {cloneUnavailable ? (
        <Callout tone="danger" role="alert">
          This thread can't fork now. Choose This thread before saving.
        </Callout>
      ) : null}
    </SettingsSection>
  );
}
