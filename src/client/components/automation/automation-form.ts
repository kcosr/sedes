import type {
  AutomationPrecheck,
  AutomationSchedule,
} from "../../../shared/protocol/automation.js";
import type {
  AutomationMisfirePolicy,
  AutomationRunMode,
} from "../../../shared/protocol/domain.js";
import { localDateTimeValue } from "../../lib/time.js";
import type { ThreadAutomationDefinition } from "../../types.js";

/**
 * The automation editor's form and its pure conversions to and from the
 * saved definition. Date and time fields hold `datetime-local` values in the
 * viewer's zone.
 */

export type ScheduleKind = AutomationSchedule["kind"];
export type IntervalUnit = "minutes" | "hours" | "days";

export const MAXIMUM_PROMPT_BYTES = 65_536;
export const MAXIMUM_PRECHECK_COMMAND_BYTES = 4_096;
/** A byte counter appears once its field passes this share of the limit. */
export const BYTE_COUNTER_THRESHOLD = 0.8;

export interface AutomationForm {
  readonly prompt: string;
  readonly runMode: AutomationRunMode;
  readonly scheduleKind: ScheduleKind;
  readonly dateTime: string;
  readonly intervalAmount: number;
  readonly intervalUnit: IntervalUnit;
  /** The interval's first run (its `anchorAt`). */
  readonly intervalStart: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly misfirePolicy: AutomationMisfirePolicy;
  readonly precheckEnabled: boolean;
  readonly precheckCommand: string;
  readonly precheckTimeout: number;
  readonly precheckIncludeStdout: boolean;
}

const UNIT_SECONDS: Readonly<Record<IntervalUnit, number>> = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The next whole hour after `now`, as a `datetime-local` value. */
export function nextWholeHour(now: Date): string {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return localDateTimeValue(next);
}

/** A new automation: every day, starting at the next whole hour. */
export function defaultAutomationForm(now: Date): AutomationForm {
  const start = nextWholeHour(now);
  return {
    prompt: "",
    runMode: "same_thread",
    scheduleKind: "interval",
    dateTime: start,
    intervalAmount: 1,
    intervalUnit: "days",
    intervalStart: start,
    cronExpression: "0 9 * * 1-5",
    timeZone: browserTimeZone(),
    misfirePolicy: "coalesce",
    precheckEnabled: false,
    precheckCommand: "",
    precheckTimeout: 30,
    precheckIncludeStdout: false,
  };
}

/** The largest unit that divides the interval evenly. */
function intervalParts(everySeconds: number): {
  readonly amount: number;
  readonly unit: IntervalUnit;
} {
  if (everySeconds % UNIT_SECONDS.days === 0) {
    return { amount: everySeconds / UNIT_SECONDS.days, unit: "days" };
  }
  if (everySeconds % UNIT_SECONDS.hours === 0) {
    return { amount: everySeconds / UNIT_SECONDS.hours, unit: "hours" };
  }
  return { amount: everySeconds / UNIT_SECONDS.minutes, unit: "minutes" };
}

/** The form for a saved definition; fields of the other schedule kinds keep their defaults. */
export function formFromDefinition(
  definition: ThreadAutomationDefinition,
  now: Date,
): AutomationForm {
  const form: AutomationForm = {
    ...defaultAutomationForm(now),
    prompt: definition.prompt,
    runMode: definition.runMode,
    scheduleKind: definition.schedule.kind,
    misfirePolicy: definition.misfirePolicy,
    precheckEnabled: definition.precheck !== null,
    precheckCommand: definition.precheck?.command ?? "",
    precheckTimeout: definition.precheck?.timeoutSeconds ?? 30,
    precheckIncludeStdout: definition.precheck?.includeStdout ?? false,
  };
  const schedule = definition.schedule;
  switch (schedule.kind) {
    case "date_time":
      return { ...form, dateTime: localDateTimeValue(new Date(schedule.runAt)) };
    case "interval": {
      const { amount, unit } = intervalParts(schedule.everySeconds);
      return {
        ...form,
        intervalAmount: amount,
        intervalUnit: unit,
        intervalStart: localDateTimeValue(new Date(schedule.anchorAt)),
      };
    }
    case "cron":
      return {
        ...form,
        cronExpression: schedule.expression,
        timeZone: schedule.timeZone,
      };
  }
}

/**
 * The instant a `datetime-local` value names. While the value still shows
 * the saved instant, the saved one is kept, so an untouched field does not
 * lose its seconds.
 */
function instantFrom(local: string, saved: string | undefined): string | undefined {
  if (saved !== undefined && local === localDateTimeValue(new Date(saved))) {
    return saved;
  }
  const date = new Date(local);
  return local && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** The schedule the form describes; undefined while a field is incomplete. */
export function scheduleFromForm(
  form: AutomationForm,
  saved?: AutomationSchedule,
): AutomationSchedule | undefined {
  switch (form.scheduleKind) {
    case "date_time": {
      const runAt = instantFrom(
        form.dateTime,
        saved?.kind === "date_time" ? saved.runAt : undefined,
      );
      return runAt ? { kind: "date_time", runAt } : undefined;
    }
    case "interval": {
      const everySeconds = form.intervalAmount * UNIT_SECONDS[form.intervalUnit];
      const anchorAt = instantFrom(
        form.intervalStart,
        saved?.kind === "interval" ? saved.anchorAt : undefined,
      );
      return Number.isSafeInteger(everySeconds) && everySeconds > 0 && anchorAt
        ? { kind: "interval", anchorAt, everySeconds }
        : undefined;
    }
    case "cron": {
      const expression = form.cronExpression.trim();
      return expression && form.timeZone
        ? { kind: "cron", expression, timeZone: form.timeZone }
        : undefined;
    }
  }
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Whether a whole number of seconds is a valid precheck timeout. */
export function validPrecheckTimeout(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60;
}

/**
 * The precheck the form describes: null when it is off, and also null with
 * `valid: false` while an enabled precheck is incomplete or too long.
 */
export function precheckFromForm(form: AutomationForm): {
  readonly precheck: AutomationPrecheck | null;
  readonly valid: boolean;
} {
  if (!form.precheckEnabled) return { precheck: null, valid: true };
  const command = form.precheckCommand.trim();
  const valid =
    command.length > 0 &&
    utf8Bytes(command) <= MAXIMUM_PRECHECK_COMMAND_BYTES &&
    validPrecheckTimeout(form.precheckTimeout);
  return valid
    ? {
        precheck: {
          command,
          timeoutSeconds: form.precheckTimeout,
          includeStdout: form.precheckIncludeStdout,
        },
        valid,
      }
    : { precheck: null, valid };
}

/** Recurring schedules have a misfire policy; a one-shot does not use it. */
export function isRecurring(kind: ScheduleKind): boolean {
  return kind !== "date_time";
}

/**
 * The fields that decide what would be saved: those of the chosen schedule
 * kind, the misfire policy only for recurring schedules, and the precheck's
 * fields only while it is on. The prompt is compared as saved (trimmed).
 */
function effectiveFields(form: AutomationForm): readonly unknown[] {
  const schedule =
    form.scheduleKind === "date_time"
      ? [form.dateTime]
      : form.scheduleKind === "interval"
        ? [form.intervalAmount, form.intervalUnit, form.intervalStart]
        : [form.cronExpression.trim(), form.timeZone];
  return [
    form.prompt.trim(),
    form.runMode,
    form.scheduleKind,
    ...schedule,
    isRecurring(form.scheduleKind) ? form.misfirePolicy : undefined,
    form.precheckEnabled,
    ...(form.precheckEnabled
      ? [form.precheckCommand.trim(), form.precheckTimeout, form.precheckIncludeStdout]
      : []),
  ];
}

/** Whether two forms would save the same automation. */
export function sameAutomationForm(left: AutomationForm, right: AutomationForm): boolean {
  const leftFields = effectiveFields(left);
  const rightFields = effectiveFields(right);
  return (
    leftFields.length === rightFields.length &&
    leftFields.every((field, index) => Object.is(field, rightFields[index]))
  );
}
