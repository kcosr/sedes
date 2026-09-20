import type { AutomationPrecheckTestResult } from "../../types";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";

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
  return (
    <section className="automation-section">
      <h2 className="automation-section-label">Precheck</h2>
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
            <label className="field">
              <span>Shell command</span>
              <textarea
                className="precheck-command"
                aria-label="Precheck shell command"
                spellCheck={false}
                maxLength={4_096}
                value={command}
                placeholder="test -f .ready"
                onChange={(event) => onCommandChange(event.target.value)}
              />
              <small>
                Runs in this thread’s workspace through the configured
                execution environment.
              </small>
              <small>
                {commandBytes.toLocaleString()} / 4,096 UTF-8 bytes
              </small>
              {commandBytes > maximumPrecheckCommandBytes && (
                <small className="notice error" role="alert">
                  Command must be at most 4,096 UTF-8 bytes.
                </small>
              )}
            </label>
            <div className="precheck-options">
              <label className="field">
                <span>Timeout in seconds</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={timeoutSeconds}
                  onChange={(event) =>
                    onTimeoutSecondsChange(event.target.valueAsNumber)
                  }
                />
              </label>
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
              className="precheck-test-button"
              disabled={!canTest || testing}
              onClick={onTest}
            >
              {testing ? "Testing…" : "Test precheck"}
            </Button>
            {result && <PrecheckTestResult result={result} />}
          </div>
        )}
      </div>
    </section>
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
