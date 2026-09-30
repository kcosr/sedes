import { useEffect, useId, useRef, useState } from "react";
import type {
  NotificationEventKind,
  NotificationSettings,
} from "../../shared/protocol/notification.js";
import { ApiError } from "../api/ApiClient.js";
import {
  type NotificationSettingsStore,
  useNotificationSettings,
} from "../stores/NotificationSettingsStore.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { Checkbox } from "@client/components/ui/checkbox";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import { Textarea } from "@client/components/ui/textarea";
import { SaveBar } from "./settings/SaveBar.js";
import {
  SettingsActionRow,
  SettingsField,
  SwitchField,
} from "./settings/SettingsField.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { SettingsSection } from "./settings/SettingsSection.js";

const eventOptions: ReadonlyArray<{
  value: NotificationEventKind;
  label: string;
  description: string;
}> = [
  {
    value: "turn.completed",
    label: "Turn completed",
    description: "An agent finishes a turn successfully.",
  },
  {
    value: "turn.failed",
    label: "Turn failed",
    description: "An agent turn ends with a failure.",
  },
  {
    value: "turn.interrupted",
    label: "Turn interrupted",
    description: "An agent turn is stopped.",
  },
  {
    value: "thread.woke",
    label: "Snooze wake",
    description:
      "A snoozed thread reaches its reminder deadline. Completion wakes use the selected turn event.",
  },
  {
    value: "automation.started",
    label: "Automation started",
    description:
      "An automation's agent run is accepted after its pre-check passes.",
  },
  {
    value: "automation.failed",
    label: "Automation failed before starting",
    description: "An automation fails before its agent run is accepted.",
  },
  {
    value: "approval.requested",
    label: "Approval requested",
    description:
      "An agent or application action needs approval or confirmation.",
  },
  {
    value: "input.requested",
    label: "Input requested",
    description: "An agent needs a blocking answer or other input.",
  },
  {
    value: "question.requested",
    label: "Nonblocking questions",
    description: "An agent asks questions while continuing its work.",
  },
];
const assistantResultPhaseOptions = [
  { value: "provisional", label: "Provisional" },
  { value: "unclassified", label: "Unclassified" },
  { value: "final", label: "Final" },
] as const;
interface Draft {
  settings: NotificationSettings;
  argumentsText: string;
  timeout: string;
}
type TestResult =
  | { readonly tone: "success"; readonly message: string }
  | { readonly tone: "danger"; readonly message: string };

function draftFrom(settings: NotificationSettings): Draft {
  return {
    settings,
    argumentsText: settings.arguments.join("\n"),
    timeout: String(settings.timeoutSeconds),
  };
}

function sortedKey(values: readonly string[]): string {
  return [...values].sort().join(" ");
}

/** Whether the draft differs from the saved settings in anything it can save. */
function draftChanged(draft: Draft, saved: NotificationSettings): boolean {
  const base = draftFrom(saved);
  return (
    draft.settings.enabled !== saved.enabled ||
    draft.settings.scriptPath !== saved.scriptPath ||
    draft.argumentsText !== base.argumentsText ||
    draft.timeout !== base.timeout ||
    sortedKey(draft.settings.events) !== sortedKey(saved.events) ||
    sortedKey(draft.settings.assistantResultPhases) !==
      sortedKey(saved.assistantResultPhases)
  );
}

class TimeoutInputError extends Error {}

export function NotificationSettingsPage({
  store,
}: {
  readonly store: NotificationSettingsStore;
}): React.JSX.Element {
  const state = useNotificationSettings(store);
  const [draft, setDraft] = useState<Draft>();
  const [saveError, setSaveError] = useState("");
  const [timeoutError, setTimeoutError] = useState("");
  const [savedAt, setSavedAt] = useState<number>();
  const [testResult, setTestResult] = useState<TestResult>();
  const [testing, setTesting] = useState(false);
  const timeoutInput = useRef<HTMLInputElement>(null);
  const phasesLabel = useId();
  useEffect(() => {
    void store.refresh();
  }, [store]);
  useEffect(() => {
    if (state.settings && !draft) setDraft(draftFrom(state.settings));
  }, [draft, state.settings]);
  const edit = (next: (value: Draft) => Draft) => {
    setSaveError("");
    setTestResult(undefined);
    setDraft((value) => (value ? next(value) : value));
  };
  const patch = (change: Partial<NotificationSettings>) =>
    edit((value) => ({ ...value, settings: { ...value.settings, ...change } }));
  const scriptInput = () => {
    if (!draft) throw new Error("Notification settings are still loading.");
    const timeoutSeconds = Number(draft.timeout);
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 300
    )
      throw new TimeoutInputError(
        "Timeout must be a whole number between 1 and 300 seconds.",
      );
    return {
      scriptPath: draft.settings.scriptPath.trim(),
      arguments:
        draft.argumentsText === "" ? [] : draft.argumentsText.split("\n"),
      timeoutSeconds,
    };
  };
  const invalidTimeout = (cause: unknown): boolean => {
    if (!(cause instanceof TimeoutInputError)) return false;
    setTimeoutError(cause.message);
    timeoutInput.current?.focus();
    return true;
  };
  const reload = async () => {
    await store.refresh();
    const latest = store.getSnapshot().settings;
    if (!latest) return;
    setDraft(draftFrom(latest));
    setSaveError("");
    setTimeoutError("");
    setTestResult(undefined);
  };
  const save = async () => {
    if (!draft) return;
    setSaveError("");
    setTestResult(undefined);
    try {
      const result = await store.save({
        ...scriptInput(),
        enabled: draft.settings.enabled,
        events: draft.settings.events,
        assistantResultPhases: draft.settings.assistantResultPhases,
        expectedRevision: draft.settings.revision,
      });
      setDraft(draftFrom(result));
      setSavedAt(Date.now());
    } catch (cause) {
      if (invalidTimeout(cause)) return;
      setSaveError(
        cause instanceof ApiError && cause.code === "conflict"
          ? "Notification settings changed in another session. Reload saved settings and review them before saving again."
          : errorMessage(cause),
      );
    }
  };
  const test = async () => {
    setTestResult(undefined);
    setTesting(true);
    try {
      const result = await store.test(scriptInput());
      setTestResult(
        result.success
          ? {
              tone: "success",
              message: "Test notification script completed successfully.",
            }
          : {
              tone: "danger",
              message: [
                result.error ??
                  (result.timedOut
                    ? "Test notification script timed out."
                    : `Test notification script failed (exit ${result.exitCode ?? "unknown"}).`),
                result.stderr,
              ]
                .filter(Boolean)
                .join("\n"),
            },
      );
    } catch (cause) {
      if (!invalidTimeout(cause)) {
        setTestResult({ tone: "danger", message: errorMessage(cause) });
      }
    } finally {
      setTesting(false);
    }
  };
  const description =
    "Run a script on the Sedes server when selected events occur. Settings apply across your clients.";
  if (!draft)
    return (
      <SettingsPage title="Notifications" description={description}>
        {state.error ? (
          <Callout
            tone="danger"
            role="alert"
            action={
              <Button variant="outline" size="sm" onClick={() => void store.refresh()}>
                Retry
              </Button>
            }
          >
            {state.error}
          </Callout>
        ) : (
          <p className="settings-loading" role="status">
            Loading notification settings…
          </p>
        )}
      </SettingsPage>
    );
  const pending = state.pending || testing;
  const saved = state.settings;
  const changedElsewhere = saved && saved.revision !== draft.settings.revision;
  const dirty = Boolean(saved && draftChanged(draft, saved));
  return (
    <SettingsPage title="Notifications" description={description}>
      {state.settings?.silenced ? (
        <Callout tone="info" role="status" title="Notifications silenced">
          Use the bell in the navigation bar to resume. Resuming sends only new
          events.
        </Callout>
      ) : null}
      {changedElsewhere ? (
        <Callout
          tone="warning"
          role="status"
          title="Saved settings changed"
          action={
            <Button variant="outline" size="sm" disabled={pending} onClick={() => void reload()}>
              Reload saved settings
            </Button>
          }
        >
          Reload them before saving to avoid overwriting another change.
        </Callout>
      ) : null}
      <SettingsSection title="Delivery" card>
        <SwitchField
          id="notifications-enabled"
          label="Enable notifications"
          description="Run the script below for the selected events."
          checked={draft.settings.enabled}
          disabled={pending}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
        <SettingsField id="notification-script" label="Server script path">
          <Input
            value={draft.settings.scriptPath}
            placeholder="/usr/local/bin/sedes-notify"
            disabled={pending}
            spellCheck={false}
            onChange={(event) => patch({ scriptPath: event.target.value })}
          />
        </SettingsField>
        <SettingsField
          id="notification-arguments"
          label="Arguments (one per line)"
          description="Each line is one literal argument. Do not add shell quotes. Event details arrive as JSON on standard input."
        >
          <Textarea
            rows={3}
            value={draft.argumentsText}
            disabled={pending}
            spellCheck={false}
            onChange={(event) => {
              const argumentsText = event.target.value;
              edit((value) => ({ ...value, argumentsText }));
            }}
          />
        </SettingsField>
        <SettingsField
          id="notification-timeout"
          label="Timeout (seconds)"
          description="Between 1 and 300 seconds."
          error={timeoutError || undefined}
        >
          <Input
            ref={timeoutInput}
            type="number"
            min={1}
            max={300}
            step={1}
            value={draft.timeout}
            disabled={pending}
            onChange={(event) => {
              const timeout = event.target.value;
              setTimeoutError("");
              edit((value) => ({ ...value, timeout }));
            }}
          />
        </SettingsField>
        <SettingsActionRow
          title="Test the script"
          description="Runs the values above without saving, even when notifications are disabled or silenced. It sends sample metadata only, without assistant response text."
          actions={
            <Button
              variant="outline"
              disabled={pending || !draft.settings.scriptPath.trim()}
              onClick={() => void test()}
            >
              {testing ? "Testing…" : "Send test notification"}
            </Button>
          }
        />
        {testResult ? (
          <Callout
            tone={testResult.tone}
            role={testResult.tone === "danger" ? "alert" : "status"}
            className="notification-test-result"
          >
            {testResult.message}
          </Callout>
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Events"
        description="The events that run the script."
        card
      >
        {eventOptions.map((option) => {
          const selected = draft.settings.events.includes(option.value);
          return (
            <SwitchField
              key={option.value}
              id={`notification-${option.value}`}
              label={option.label}
              description={option.description}
              checked={selected}
              disabled={pending}
              onCheckedChange={(checked) =>
                patch({
                  events: checked
                    ? [...draft.settings.events, option.value]
                    : draft.settings.events.filter(
                        (value) => value !== option.value,
                      ),
                })
              }
            >
              {option.value === "turn.completed" ? (
                <div
                  className="settings-choice-group"
                  role="group"
                  aria-labelledby={phasesLabel}
                >
                  <span id={phasesLabel} className="settings-choice-group-label">
                    Response text
                  </span>
                  <div className="settings-choice-group-options">
                    {assistantResultPhaseOptions.map(({ value, label }) => (
                      <div className="settings-choice" key={value}>
                        <Checkbox
                          id={`notification-assistant-${value}`}
                          checked={draft.settings.assistantResultPhases.includes(value)}
                          disabled={pending || !selected}
                          onCheckedChange={(checked) =>
                            patch({
                              assistantResultPhases: assistantResultPhaseOptions
                                .map((phase) => phase.value)
                                .filter((phase) =>
                                  phase === value
                                    ? checked === true
                                    : draft.settings.assistantResultPhases.includes(phase),
                                ),
                            })
                          }
                        />
                        <Label htmlFor={`notification-assistant-${value}`}>
                          {label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </SwitchField>
          );
        })}
      </SettingsSection>
      <SaveBar
        dirty={dirty}
        saving={state.pending && !testing}
        savedAt={savedAt}
        error={saveError || undefined}
        saveLabel="Save notifications"
        saveDisabled={Boolean(changedElsewhere) || testing}
        onCancel={() => {
          if (!saved) return;
          setDraft(draftFrom(saved));
          setSaveError("");
          setTimeoutError("");
          setTestResult(undefined);
        }}
        onSave={() => void save()}
      />
    </SettingsPage>
  );
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Could not update notification settings.";
}
