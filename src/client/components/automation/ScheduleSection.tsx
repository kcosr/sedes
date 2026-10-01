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
import { Callout } from "@client/components/ui/callout";
import { DialogSection } from "@client/components/ui/dialog";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";

export type ScheduleKind = AutomationSchedule["kind"];
export type IntervalUnit = "minutes" | "hours" | "days";

/** "When" section: schedule-kind segmented control, per-kind fields, and
 * the next-occurrences preview. Presentation only — all state lives in
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
    <DialogSection title="When">
      <div className="automation-section-card padded">
        <SegmentedControl
          aria-label="Schedule type"
          className="w-full"
          value={scheduleKind}
          onValueChange={(kind) => onScheduleKindChange(kind as ScheduleKind)}
        >
          <SegmentedControlItem value="date_time">Date & time</SegmentedControlItem>
          <SegmentedControlItem value="interval">Every interval</SegmentedControlItem>
          <SegmentedControlItem value="cron">Cron</SegmentedControlItem>
        </SegmentedControl>
        {scheduleKind === "date_time" && (
          <Field label="Local date and time">
            <Input
              type="datetime-local"
              min={localDateTimeValue(new Date(Date.now() + 60_000))}
              value={dateTime}
              onChange={(event) => onDateTimeChange(event.target.value)}
            />
          </Field>
        )}
        {scheduleKind === "interval" && (
          <div className="interval-fields">
            <Field label="Every">
              <Input
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
            </Field>
            <Field label="Unit">
              <Select
                value={intervalUnit}
                onValueChange={(value) =>
                  onIntervalUnitChange(value as IntervalUnit)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
        {scheduleKind === "cron" && (
          <Field
            label="Five-field cron expression"
            description={`Timezone: ${schedule?.kind === "cron" ? schedule.timeZone : timeZone}`}
          >
            <Input
              className="font-mono"
              value={cronExpression}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
              onChange={(event) => onCronExpressionChange(event.target.value)}
            />
          </Field>
        )}
        {previewError ? (
          <Callout tone="danger" role="alert">
            {previewError}
          </Callout>
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
          <p className="automation-help" role="status">
            Checking schedule…
          </p>
        ) : null}
      </div>
    </DialogSection>
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
    <DialogSection title="After downtime">
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
    </DialogSection>
  );
}
