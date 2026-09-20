import type { AutomationSchedule } from "../../../shared/protocol/automation";
import type { AutomationMisfirePolicy } from "../../../shared/protocol/domain";
import { automationTimeLabel, localDateTimeValue } from "../../lib/time";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";

export type ScheduleKind = AutomationSchedule["kind"];
export type IntervalUnit = "minutes" | "hours" | "days";

/** "When" section: schedule-kind segmented control, per-kind native inputs,
 * and the next-occurrences preview. Presentation only — all state lives in
 * ThreadAutomationDialog. */
export function AutomationScheduleSection({
  scheduleKind,
  onScheduleKindChange,
  dateTime,
  onDateTimeChange,
  intervalAmount,
  onIntervalAmountChange,
  intervalUnit,
  onIntervalUnitChange,
  cronExpression,
  onCronExpressionChange,
  schedule,
  timeZone,
  preview,
  previewError,
}: {
  scheduleKind: ScheduleKind;
  onScheduleKindChange: (kind: ScheduleKind) => void;
  dateTime: string;
  onDateTimeChange: (value: string) => void;
  intervalAmount: number;
  onIntervalAmountChange: (value: number) => void;
  intervalUnit: IntervalUnit;
  onIntervalUnitChange: (unit: IntervalUnit) => void;
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
  schedule: AutomationSchedule | undefined;
  timeZone: string;
  preview: readonly string[];
  previewError: string;
}): React.JSX.Element {
  return (
    <section className="automation-section">
      <h2 className="automation-section-label">When</h2>
      <div className="automation-section-card padded">
        <div
          className="segmented-control"
          role="group"
          aria-label="Schedule type"
        >
          {([
            ["date_time", "Date & time"],
            ["interval", "Every interval"],
            ["cron", "Cron"],
          ] as const).map(([kind, label]) => (
            <button
              type="button"
              className={scheduleKind === kind ? "selected" : ""}
              aria-pressed={scheduleKind === kind}
              key={kind}
              onClick={() => onScheduleKindChange(kind)}
            >
              {label}
            </button>
          ))}
        </div>
        {scheduleKind === "date_time" && (
          <label className="field">
            <span>Local date and time</span>
            <input
              type="datetime-local"
              min={localDateTimeValue(new Date(Date.now() + 60_000))}
              value={dateTime}
              onChange={(event) => onDateTimeChange(event.target.value)}
            />
          </label>
        )}
        {scheduleKind === "interval" && (
          <div className="interval-fields">
            <label className="field">
              <span>Every</span>
              <input
                type="number"
                min={intervalUnit === "minutes" ? 5 : 1}
                max={
                  intervalUnit === "minutes"
                    ? 525_600
                    : intervalUnit === "hours"
                      ? 8_760
                      : 365
                }
                step={1}
                value={intervalAmount}
                onChange={(event) =>
                  onIntervalAmountChange(event.target.valueAsNumber)
                }
              />
            </label>
            <div className="field">
              <span id="automation-interval-unit-label">Unit</span>
              <Select
                value={intervalUnit}
                onValueChange={(value) =>
                  onIntervalUnitChange(value as IntervalUnit)
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby="automation-interval-unit-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {scheduleKind === "cron" && (
          <>
            <label className="field">
              <span>Five-field cron expression</span>
              <input
                value={cronExpression}
                spellCheck={false}
                placeholder="0 9 * * 1-5"
                onChange={(event) =>
                  onCronExpressionChange(event.target.value)
                }
              />
            </label>
            <p className="schedule-timezone">
              Timezone:{" "}
              {schedule?.kind === "cron" ? schedule.timeZone : timeZone}
            </p>
          </>
        )}
        {previewError ? (
          <p className="notice error" role="alert">{previewError}</p>
        ) : preview.length > 0 ? (
          <div className="schedule-preview" aria-live="polite">
            <strong>Next occurrences</strong>
            <ol>
              {preview.map((occurrence) => (
                <li key={occurrence}>{automationTimeLabel(occurrence)}</li>
              ))}
            </ol>
          </div>
        ) : schedule ? (
          <p className="schedule-timezone" role="status">
            Checking schedule…
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** "After downtime" misfire-policy section. Presentation only. */
export function AutomationMisfireSection({
  misfirePolicy,
  onMisfirePolicyChange,
}: {
  misfirePolicy: AutomationMisfirePolicy;
  onMisfirePolicyChange: (policy: AutomationMisfirePolicy) => void;
}): React.JSX.Element {
  return (
    <section className="automation-section">
      <h2 className="automation-section-label">After downtime</h2>
      <div className="automation-section-card">
        <RadioGroup
          className="automation-option-group"
          aria-label="After downtime"
          value={misfirePolicy}
          onValueChange={(value) =>
            onMisfirePolicyChange(value as AutomationMisfirePolicy)
          }
        >
          <label
            className={`automation-option-row ${misfirePolicy === "coalesce" ? "selected" : ""}`}
          >
            <RadioGroupItem value="coalesce" />
            <span>
              <strong>Run once when the server returns</strong>
              <small>
                Coalesce missed recurring occurrences into one invocation.
              </small>
            </span>
          </label>
          <label
            className={`automation-option-row ${misfirePolicy === "skip" ? "selected" : ""}`}
          >
            <RadioGroupItem value="skip" />
            <span>
              <strong>Skip missed occurrences</strong>
              <small>Resume at the next future occurrence.</small>
            </span>
          </label>
        </RadioGroup>
      </div>
    </section>
  );
}
