import { Repeat } from "lucide-react";
import { useId, useMemo } from "react";
import type { AutomationSchedule } from "../../../shared/protocol/automation.js";
import type { AutomationMisfirePolicy } from "../../../shared/protocol/domain.js";
import { describeSchedule } from "../../automation/automation-text.js";
import { futureTimeLabel, localDateTimeValue } from "../../lib/time.js";
import { SettingsField } from "../settings/SettingsField.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Input } from "@client/components/ui/input";
import { NativeSelect } from "@client/components/ui/native-select";
import { RadioGroup } from "@client/components/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { AutomationChoice } from "./AutomationChoice.js";
import {
  browserTimeZone,
  type AutomationForm,
  type IntervalUnit,
  type ScheduleKind,
} from "./automation-form.js";

type ScheduleFields = Pick<
  AutomationForm,
  | "scheduleKind"
  | "dateTime"
  | "intervalAmount"
  | "intervalUnit"
  | "intervalStart"
  | "cronExpression"
  | "timeZone"
>;

/** Every zone the browser knows, with the current one first when it is not among them. */
function timeZoneOptions(current: string): readonly string[] {
  const known =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [...new Set([current, "UTC", ...known])];
}

/** The schedule's sentence under its fields, with the Repeat glyph. */
function ScheduleSentence({
  schedule,
  now,
}: {
  readonly schedule: AutomationSchedule | undefined;
  readonly now: Date;
}): React.JSX.Element | null {
  return schedule ? (
    <p className="automation-sentence">
      <Repeat aria-hidden="true" />
      {describeSchedule(schedule, now)}
    </p>
  ) : null;
}

/**
 * "When": Once, Every interval (with its first run) or Cron (with its
 * sentence and time zone), then the next runs from the server's preview.
 * Presentation only; the form lives in useAutomationEditor.
 */
export function AutomationScheduleSection({
  id,
  form,
  onChange,
  schedule,
  preview,
  now,
}: {
  readonly id: string;
  readonly form: ScheduleFields;
  readonly onChange: (patch: Partial<ScheduleFields>) => void;
  readonly schedule: AutomationSchedule | undefined;
  readonly preview: {
    readonly occurrences: readonly string[];
    readonly error?: string;
    readonly checking: boolean;
  };
  readonly now: Date;
}): React.JSX.Element {
  const unitId = useId();
  const zones = useMemo(() => timeZoneOptions(form.timeZone), [form.timeZone]);
  return (
    <SettingsSection id={id} title="When" card>
      <SettingsField label="Repeat">
        <SegmentedControl
          className="w-full"
          value={form.scheduleKind}
          onValueChange={(kind) => onChange({ scheduleKind: kind as ScheduleKind })}
        >
          <SegmentedControlItem value="date_time">Once</SegmentedControlItem>
          <SegmentedControlItem value="interval">Every interval</SegmentedControlItem>
          <SegmentedControlItem value="cron">Cron</SegmentedControlItem>
        </SegmentedControl>
      </SettingsField>
      {form.scheduleKind === "date_time" && (
        <SettingsField
          label="Date and time"
          description={`In your time zone, ${browserTimeZone()}.`}
        >
          <Input
            type="datetime-local"
            min={localDateTimeValue(new Date(now.getTime() + 60_000))}
            value={form.dateTime}
            onChange={(event) => onChange({ dateTime: event.target.value })}
          />
        </SettingsField>
      )}
      {form.scheduleKind === "interval" && (
        <>
          <SettingsField label="Every">
            <div className="automation-interval-fields">
              <Input
                type="number"
                min={form.intervalUnit === "minutes" ? 5 : 1}
                max={
                  form.intervalUnit === "minutes"
                    ? 525_600
                    : form.intervalUnit === "hours"
                      ? 8_760
                      : 365
                }
                step={1}
                value={Number.isNaN(form.intervalAmount) ? "" : form.intervalAmount}
                onChange={(event) =>
                  onChange({ intervalAmount: event.target.valueAsNumber })
                }
              />
              <NativeSelect
                id={unitId}
                aria-label="Interval unit"
                value={form.intervalUnit}
                onChange={(event) =>
                  onChange({ intervalUnit: event.target.value as IntervalUnit })
                }
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </NativeSelect>
            </div>
          </SettingsField>
          <SettingsField label="Starting" description="The first run; the interval counts from it.">
            <Input
              type="datetime-local"
              value={form.intervalStart}
              onChange={(event) => onChange({ intervalStart: event.target.value })}
            />
            <ScheduleSentence schedule={schedule} now={now} />
          </SettingsField>
        </>
      )}
      {form.scheduleKind === "cron" && (
        <>
          <SettingsField
            label="Cron expression"
            description="Five fields: minute, hour, day of month, month, weekday."
          >
            <Input
              className="font-mono"
              value={form.cronExpression}
              spellCheck={false}
              autoComplete="off"
              placeholder="0 9 * * 1-5"
              onChange={(event) => onChange({ cronExpression: event.target.value })}
            />
            <ScheduleSentence schedule={schedule} now={now} />
          </SettingsField>
          <SettingsField label="Time zone">
            <NativeSelect
              value={form.timeZone}
              onChange={(event) => onChange({ timeZone: event.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </NativeSelect>
          </SettingsField>
        </>
      )}
      <SettingsField label="Next runs" description="After you save." error={preview.error}>
        <p
          className="automation-next-runs"
          data-checking={preview.checking || undefined}
          aria-live="polite"
        >
          {preview.error
            ? null
            : preview.checking
              ? "Checking schedule…"
              : preview.occurrences
                  .map((occurrence) => futureTimeLabel(occurrence, now))
                  .join(", ")}
        </p>
      </SettingsField>
    </SettingsSection>
  );
}

/**
 * "If Sedes was down": run a recurring schedule's missed occurrences once,
 * or skip them. Presentation only.
 */
export function AutomationMisfireSection({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: AutomationMisfirePolicy;
  readonly onChange: (policy: AutomationMisfirePolicy) => void;
}): React.JSX.Element {
  return (
    <SettingsSection
      id={id}
      title="If Sedes was down"
      description="Recurring schedules only."
      card
    >
      <RadioGroup
        className="automation-choice-list"
        aria-label="If Sedes was down"
        value={value}
        onValueChange={(next) => onChange(next as AutomationMisfirePolicy)}
      >
        <AutomationChoice
          value="coalesce"
          title="Run once when Sedes is back"
          description="Missed runs merge into one."
        />
        <AutomationChoice
          value="skip"
          title="Skip missed runs"
          description="Wait for the next scheduled time."
        />
      </RadioGroup>
    </SettingsSection>
  );
}
