import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { AutomationPrecheckTestResult } from "../../types.js";
import { SettingsActionRow, SettingsField, SwitchField } from "../settings/SettingsField.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Button } from "@client/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@client/components/ui/collapsible";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";
import {
  BYTE_COUNTER_THRESHOLD,
  MAXIMUM_PRECHECK_COMMAND_BYTES,
  type AutomationForm,
} from "./automation-form.js";

type PrecheckFields = Pick<
  AutomationForm,
  "precheckEnabled" | "precheckCommand" | "precheckTimeout" | "precheckIncludeStdout"
>;

/**
 * "Precheck": a disclosure whose summary names the command (or None) and
 * opens the switch, command, timeout, output option and a test. The
 * precheck gates every run, manual ones included. Presentation only; the
 * form and the test call live in useAutomationEditor.
 */
export function AutomationPrecheckSection({
  id,
  form,
  onChange,
  commandBytes,
  commandError,
  timeoutError,
  test,
}: {
  readonly id: string;
  readonly form: PrecheckFields;
  readonly onChange: (patch: Partial<PrecheckFields>) => void;
  readonly commandBytes: number;
  readonly commandError?: string;
  readonly timeoutError?: string;
  readonly test: {
    readonly canTest: boolean;
    readonly testing: boolean;
    readonly result?: AutomationPrecheckTestResult;
    readonly run: () => void;
  };
}): React.JSX.Element {
  // Open from the start when something in it needs attention.
  const [open, setOpen] = useState(Boolean(commandError || timeoutError));
  const command = form.precheckCommand.trim();
  const enabled = form.precheckEnabled && command.length > 0;
  return (
    <SettingsSection id={id} title="Precheck" card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="automation-disclosure">
          <span className="automation-disclosure-text">
            <span className="automation-disclosure-title">Before each run</span>
            <span className="automation-disclosure-summary">
              {enabled ? (
                <>
                  <code className="automation-code">{command}</code>
                  {` · ${form.precheckTimeout} s · ${
                    form.precheckIncludeStdout ? "output added to prompt" : "output not added"
                  }`}
                </>
              ) : (
                "None. A shell command can decide whether each run goes ahead."
              )}
            </span>
          </span>
          {open ? null : (
            <span className="automation-disclosure-action" aria-hidden="true">
              {enabled ? "Edit" : "Add"}
            </span>
          )}
          <ChevronRight aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="automation-disclosure-content">
          <SwitchField
            label="Run a precheck"
            description="Runs in this thread's workspace before every run, manual runs included. Exit 0 runs the agent; any other exit skips the run."
            checked={form.precheckEnabled}
            onCheckedChange={(precheckEnabled) => onChange({ precheckEnabled })}
          />
          {form.precheckEnabled ? (
            <>
              <SettingsField
                layout="stacked"
                label="Shell command"
                description={
                  commandBytes > MAXIMUM_PRECHECK_COMMAND_BYTES * BYTE_COUNTER_THRESHOLD
                    ? `${commandBytes.toLocaleString()} / ${MAXIMUM_PRECHECK_COMMAND_BYTES.toLocaleString()} UTF-8 bytes`
                    : undefined
                }
                error={commandError}
              >
                <Textarea
                  className="automation-precheck-command"
                  spellCheck={false}
                  value={form.precheckCommand}
                  placeholder="test -f .ready"
                  onChange={(event) => onChange({ precheckCommand: event.target.value })}
                />
              </SettingsField>
              <SettingsField label="Timeout" description="Seconds, from 1 to 60." error={timeoutError}>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={Number.isNaN(form.precheckTimeout) ? "" : form.precheckTimeout}
                  onChange={(event) =>
                    onChange({ precheckTimeout: event.target.valueAsNumber })
                  }
                />
              </SettingsField>
              <SwitchField
                label="Add output to the prompt"
                description="Only when the command exits 0."
                checked={form.precheckIncludeStdout}
                onCheckedChange={(precheckIncludeStdout) => onChange({ precheckIncludeStdout })}
              />
              <SettingsActionRow
                title="Test"
                description={
                  test.canTest
                    ? "Runs the command once now and says what a run would do. Nothing is sent to the agent."
                    : "Write the prompt and the command first."
                }
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!test.canTest || test.testing}
                    onClick={test.run}
                  >
                    {test.testing ? "Testing…" : "Test precheck"}
                  </Button>
                }
              />
              {test.result ? <PrecheckTestResult result={test.result} /> : null}
            </>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </SettingsSection>
  );
}

function PrecheckTestResult({
  result,
}: {
  readonly result: AutomationPrecheckTestResult;
}): React.JSX.Element {
  return (
    <div className="automation-precheck-result" role="status">
      <p className="automation-precheck-result-title">
        {result.decision === "invoke"
          ? "Would run the agent"
          : result.decision === "skip"
            ? "Would skip this run"
            : "The precheck failed"}
      </p>
      <p>
        {result.exitCode === undefined ? "No exit code" : `Exit ${result.exitCode}`}
        {` · ${result.durationMilliseconds} ms · `}
        {result.stdoutWillBeIncluded
          ? `Output added to prompt (${result.effectivePromptBytes.toLocaleString()} bytes in all)`
          : "Output not added to prompt"}
      </p>
      {result.stdoutPreview ? (
        <details>
          <summary>Output{result.stdoutTruncated ? " (truncated)" : ""}</summary>
          <pre>{result.stdoutPreview}</pre>
        </details>
      ) : null}
      {result.stderrPreview ? (
        <details>
          <summary>Errors{result.stderrTruncated ? " (truncated)" : ""}</summary>
          <pre>{result.stderrPreview}</pre>
        </details>
      ) : null}
      {result.diagnosticCode ? (
        <code className="automation-code">{result.diagnosticCode}</code>
      ) : null}
    </div>
  );
}
