import { useEffect, useState } from "react";
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
import { Checkbox } from "@client/components/ui/checkbox";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import { Textarea } from "@client/components/ui/textarea";

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
function draftFrom(settings: NotificationSettings): Draft {
  return {
    settings,
    argumentsText: settings.arguments.join("\n"),
    timeout: String(settings.timeoutSeconds),
  };
}
export function NotificationSettingsPage({
  store,
}: {
  readonly store: NotificationSettingsStore;
}): React.JSX.Element {
  const state = useNotificationSettings(store);
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    void store.refresh();
  }, [store]);
  useEffect(() => {
    if (state.settings && !draft) setDraft(draftFrom(state.settings));
  }, [draft, state.settings]);
  const patch = (change: Partial<NotificationSettings>) => {
    setNotice("");
    setDraft((value) =>
      value ? { ...value, settings: { ...value.settings, ...change } } : value,
    );
  };
  const scriptInput = () => {
    if (!draft) throw new Error("Notification settings are still loading.");
    const timeoutSeconds = Number(draft.timeout);
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > 300
    )
      throw new Error(
        "Timeout must be a whole number between 1 and 300 seconds.",
      );
    return {
      scriptPath: draft.settings.scriptPath.trim(),
      arguments:
        draft.argumentsText === "" ? [] : draft.argumentsText.split("\n"),
      timeoutSeconds,
    };
  };
  const save = async () => {
    if (!draft) return;
    setError("");
    setNotice("");
    try {
      const result = await store.save({
        ...scriptInput(),
        enabled: draft.settings.enabled,
        events: draft.settings.events,
        assistantResultPhases: draft.settings.assistantResultPhases,
        expectedRevision: draft.settings.revision,
      });
      setDraft(draftFrom(result));
      setNotice("Notification settings saved.");
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "conflict"
          ? "Notification settings changed in another session. Reload saved settings and review them before saving again."
          : errorMessage(cause),
      );
    }
  };
  const test = async () => {
    setError("");
    setNotice("");
    setTesting(true);
    try {
      const result = await store.test(scriptInput());
      if (result.success)
        setNotice("Test notification script completed successfully.");
      else
        setError(
          [
            result.error ??
              (result.timedOut
                ? "Test notification script timed out."
                : `Test notification script failed (exit ${result.exitCode ?? "unknown"}).`),
            result.stderr,
          ]
            .filter(Boolean)
            .join("\n"),
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTesting(false);
    }
  };
  if (!draft)
    return (
      <div className="settings-general-page">
        <h3 className="settings-page-title">Notifications</h3>
        {state.error ? (
          <>
            <p role="alert">{state.error}</p>
            <Button onClick={() => void store.refresh()}>Retry</Button>
          </>
        ) : (
          <p role="status">Loading notification settings…</p>
        )}
      </div>
    );
  const pending = state.pending || testing;
  const changedElsewhere =
    state.settings && state.settings.revision !== draft.settings.revision;
  return (
    <div className="settings-general-page notification-settings-page">
      <h3 className="settings-page-title">Notifications</h3>
      <p className="settings-row-description">
        Run a script on the Sedes server when selected events occur. Settings
        apply across your clients.
      </p>
      {state.settings?.silenced ? (
        <p className="notification-silenced-status" role="status">
          Notifications silenced. Use the bell in the navigation bar to resume.
          Resuming sends only new events.
        </p>
      ) : null}
      <div className="settings-row">
        <Label htmlFor="notifications-enabled">Enable notifications</Label>
        <Checkbox
          id="notifications-enabled"
          checked={draft.settings.enabled}
          disabled={pending}
          onCheckedChange={(checked) => patch({ enabled: checked === true })}
        />
      </div>
      <fieldset className="notification-settings-fields" disabled={pending}>
        <legend>Delivery</legend>
        <Label htmlFor="notification-script">Server script path</Label>
        <Input
          id="notification-script"
          value={draft.settings.scriptPath}
          placeholder="/usr/local/bin/sedes-notify"
          onChange={(event) => patch({ scriptPath: event.target.value })}
        />
        <Label htmlFor="notification-arguments">Arguments (one per line)</Label>
        <Textarea
          id="notification-arguments"
          rows={3}
          value={draft.argumentsText}
          onChange={(event) => {
            setNotice("");
            setDraft({ ...draft, argumentsText: event.target.value });
          }}
          aria-describedby="notification-arguments-help"
        />
        <p
          id="notification-arguments-help"
          className="settings-row-description"
        >
          Each line is one literal argument. Do not add shell quotes. Event
          details arrive as JSON on standard input.
        </p>
        <Label htmlFor="notification-timeout">Timeout (seconds)</Label>
        <Input
          id="notification-timeout"
          type="number"
          min={1}
          max={300}
          step={1}
          value={draft.timeout}
          onChange={(event) => {
            setNotice("");
            setDraft({ ...draft, timeout: event.target.value });
          }}
        />
      </fieldset>
      <fieldset className="notification-settings-fields" disabled={pending}>
        <legend>Events</legend>
        {eventOptions.map((option) => (
          <div className="settings-row notification-event" key={option.value}>
            <div className="notification-event-heading">
              <div className="settings-row-text">
                <Label htmlFor={`notification-${option.value}`}>
                  {option.label}
                </Label>
                <p className="settings-row-description">{option.description}</p>
              </div>
              <Checkbox
                id={`notification-${option.value}`}
                checked={draft.settings.events.includes(option.value)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  patch({
                    events:
                      checked === true
                        ? [...draft.settings.events, option.value]
                        : draft.settings.events.filter(
                            (value) => value !== option.value,
                          ),
                  })
                }
              />
            </div>
            {option.value === "turn.completed" ? (
              <div className="notification-event-option">
                <span className="notification-result-label" id="notification-response-text-label">
                  Response text
                </span>
                <div
                  className="notification-result-phases"
                  role="group"
                  aria-labelledby="notification-response-text-label"
                >
                  {assistantResultPhaseOptions.map(({ value, label }) => (
                    <div className="notification-result-phase" key={value}>
                      <Checkbox
                        id={`notification-assistant-${value}`}
                        checked={draft.settings.assistantResultPhases.includes(
                          value,
                        )}
                        disabled={
                          pending ||
                          !draft.settings.events.includes("turn.completed")
                        }
                        onCheckedChange={(checked) =>
                          patch({
                            assistantResultPhases: assistantResultPhaseOptions
                              .map((option) => option.value)
                              .filter((phase) =>
                                phase === value
                                  ? checked === true
                                  : draft.settings.assistantResultPhases.includes(
                                      phase,
                                    ),
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
          </div>
        ))}
      </fieldset>
      {changedElsewhere ? (
        <p role="status">
          Saved settings changed. Reload them before saving to avoid overwriting
          another change.
        </p>
      ) : null}
      <div className="notification-settings-actions">
        <Button
          disabled={pending || Boolean(changedElsewhere)}
          onClick={() => void save()}
        >
          Save notifications
        </Button>
        <Button
          variant="outline"
          disabled={pending || !draft.settings.scriptPath.trim()}
          onClick={() => void test()}
        >
          {testing ? "Testing…" : "Send test notification"}
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={async () => {
            await store.refresh();
            const latest = store.getSnapshot().settings;
            if (latest) {
              setDraft(draftFrom(latest));
              setError("");
              setNotice("");
            }
          }}
        >
          Reload saved settings
        </Button>
      </div>
      <p className="settings-row-description">
        The test uses the values above without saving and runs even when
        notifications are disabled or silenced. It sends sample metadata only,
        without assistant response text.
      </p>
      {error ? (
        <p role="alert" className="notification-test-error">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Could not update notification settings.";
}
