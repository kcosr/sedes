import type { AutomationPrecheckTestResult } from "../../types";
import { useId } from "react";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";
import { DialogSection } from "@client/components/ui/dialog";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import { Textarea } from "@client/components/ui/textarea";
import { AutomationFieldError } from "./AutomationFieldError";

const maximumPrecheckCommandBytes = 4_096;

/** "Precheck" section: gate toggle, shell command, timeout/stdout options,
 * and the test affordance. Presentation only — state and the test call live
 * in ThreadAutomationDialog. */
export function AutomationPrecheckSection({
  enabled,
  onEnabledChange,
  command,
  onCommandChange,
  commandBytes,
  timeoutSeconds,
  onTimeoutSecondsChange,
  includeStdout,
  onIncludeStdoutChange,
  canTest,
  testing,
  result,
  onTest,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  command: string;
  onCommandChange: (command: string) => void;
  commandBytes: number;
  timeoutSeconds: number;
  onTimeoutSecondsChange: (seconds: number) => void;
  includeStdout: boolean;
  onIncludeStdoutChange: (include: boolean) => void;
  canTest: boolean;
  testing: boolean;
  result: AutomationPrecheckTestResult | undefined;
  onTest: () => void;
}): React.JSX.Element {
  const commandId = useId();
  const commandHelpId = useId();
  const commandErrorId = useId();
  const commandTooLong = commandBytes > maximumPrecheckCommandBytes;
  return (
    <DialogSection title="Precheck">
      <div className="automation-section-card">
        <label className="automation-option-row">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => onEnabledChange(checked === true)}
          />
          <span>
            <strong>Gate each scheduled run with a shell command</strong>
            <small>
              Exit 0 invokes the agent. Any other exit code skips that occurrence.
            </small>
          </span>
        </label>
        {enabled && (
          <div className="precheck-fields">
            <div className="grid gap-1.5">
              <Label htmlFor={commandId}>Shell command</Label>
              <Textarea
                id={commandId}
                className="precheck-command"
                aria-label="Precheck shell command"
                aria-describedby={`${commandHelpId}${commandTooLong ? ` ${commandErrorId}` : ""}`}
                aria-invalid={commandTooLong || undefined}
                spellCheck={false}
                maxLength={4_096}
                value={command}
                placeholder="test -f .ready"
                onChange={(event) => onCommandChange(event.target.value)}
              />
              <p id={commandHelpId} className="automation-help">
                Runs in this thread’s workspace through the configured
                execution environment.{" "}
                <span className="tabular-nums">
                  {commandBytes.toLocaleString()} / 4,096 UTF-8 bytes
                </span>
              </p>
              {commandTooLong && (
                <AutomationFieldError id={commandErrorId}>
                  Command must be at most 4,096 UTF-8 bytes.
                </AutomationFieldError>
              )}
            </div>
            <div className="precheck-options">
              <Field label="Timeout in seconds">
                <Input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={timeoutSeconds}
                  onChange={(event) =>
                    onTimeoutSecondsChange(event.target.valueAsNumber)
                  }
                />
              </Field>
              <label className="automation-suboption">
                <Checkbox
                  checked={includeStdout}
                  onCheckedChange={(checked) =>
                    onIncludeStdoutChange(checked === true)
                  }
                />
                <span>
                  <strong>Add stdout to the agent prompt</strong>
                  <small>
                    Output is included only when the command exits 0.
                  </small>
                </span>
              </label>
            </div>
            <Button
              variant="outline"
              className="justify-self-start"
              disabled={!canTest || testing}
              onClick={onTest}
            >
              {testing ? "Testing…" : "Test precheck"}
            </Button>
            {result && <PrecheckTestResult result={result} />}
          </div>
        )}
      </div>
    </DialogSection>
  );
}

function PrecheckTestResult({
  result,
}: {
  result: AutomationPrecheckTestResult;
}): React.JSX.Element {
  return (
    <div
      className={`precheck-test-result ${result.decision}`}
      role="status"
    >
      <strong>
        {result.decision === "invoke"
          ? "Would invoke the agent"
          : result.decision === "skip"
            ? "Would skip this run"
            : "Precheck failed"}
      </strong>
      <span>
        {result.exitCode === undefined
          ? "No exit code"
          : `Exit ${result.exitCode}`}
        {" · "}
        {result.durationMilliseconds} ms
      </span>
      <span>
        {result.stdoutWillBeIncluded
          ? `Stdout will be added to the prompt (${result.effectivePromptBytes.toLocaleString()} effective bytes).`
          : "Stdout will not be added to the prompt."}
      </span>
      {result.stdoutPreview && (
        <details>
          <summary>
            Stdout{result.stdoutTruncated ? " (truncated)" : ""}
          </summary>
          <pre>{result.stdoutPreview}</pre>
        </details>
      )}
      {result.stderrPreview && (
        <details>
          <summary>
            Stderr{result.stderrTruncated ? " (truncated)" : ""}
          </summary>
          <pre>{result.stderrPreview}</pre>
        </details>
      )}
      {result.diagnosticCode && <code>{result.diagnosticCode}</code>}
    </div>
  );
}
