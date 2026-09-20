import { CronExpressionParser, type CronExpression } from "cron-parser";
import { z } from "zod";
import type { AutomationSchedule } from "./automation-models.js";

export const MIN_AUTOMATION_INTERVAL_SECONDS = 5 * 60;
export const MAX_AUTOMATION_INTERVAL_SECONDS = 365 * 24 * 60 * 60;
export const DEFAULT_AUTOMATION_PREVIEW_COUNT = 5;
export const MAX_AUTOMATION_PREVIEW_COUNT = 32;

const MAX_CRON_EXPRESSION_LENGTH = 240;
const MIN_FREQUENCY_MS = MIN_AUTOMATION_INTERVAL_SECONDS * 1_000;
const TRANSITION_SCAN_STEP_MS = 6 * 60 * 60 * 1_000;
const TRANSITION_WINDOW_MS = 26 * 60 * 60 * 1_000;
const FREQUENCY_SAMPLE_COUNT = 512;
const FREQUENCY_EPOCH_MS = Date.UTC(2024, 0, 1);
const FREQUENCY_TRANSITION_END_MS = Date.UTC(2037, 0, 1);

const epochMillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const cronExpressionShapeSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CRON_EXPRESSION_LENGTH)
  .transform(normalizeCronExpression)
  .superRefine((expression, context) => {
    if (expression.startsWith("@")) {
      context.addIssue({
        code: "custom",
        message: "Cron macro aliases are not supported",
      });
      return;
    }
    if (expression.split(" ").length !== 5) {
      context.addIssue({
        code: "custom",
        message: "Cron expressions must contain exactly five fields",
      });
    }
    if (expression.split(" ").some(containsHashedCronToken)) {
      context.addIssue({
        code: "custom",
        message: "Hashed cron fields are not supported",
      });
    }
  });

const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .superRefine((timeZone, context) => {
    if (!isSupportedIanaTimeZone(timeZone)) {
      context.addIssue({
        code: "custom",
        message: "A supported IANA timezone is required",
      });
    }
  });

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("date_time"),
    runAt: epochMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("interval"),
    anchorAt: epochMillisecondsSchema,
    everySeconds: z
      .number()
      .int()
      .min(MIN_AUTOMATION_INTERVAL_SECONDS)
      .max(MAX_AUTOMATION_INTERVAL_SECONDS),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: cronExpressionShapeSchema,
    timeZone: ianaTimeZoneSchema,
  }),
]);

export type { AutomationSchedule } from "./automation-models.js";
export type DateTimeAutomationSchedule = Extract<
  AutomationSchedule,
  { kind: "date_time" }
>;
export type IntervalAutomationSchedule = Extract<
  AutomationSchedule,
  { kind: "interval" }
>;
export type CronAutomationSchedule = Extract<
  AutomationSchedule,
  { kind: "cron" }
>;

export interface IntervalCoalescingResult {
  /** The newest intended occurrence represented by the coalesced run. */
  scheduledAt: number;
  /** Number of older due occurrences suppressed by this run. */
  coalescedCount: number;
  /** First occurrence strictly after `throughInclusive`. */
  nextRunAt: number;
}

export class AutomationScheduleValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_schedule"
      | "invalid_cron"
      | "cron_too_frequent"
      | "cron_has_no_occurrence",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationScheduleValidationError";
  }
}

interface TimeZoneTransition {
  at: number;
  offsetBeforeMinutes: number;
  offsetAfterMinutes: number;
}

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();
const cronValidationCache = new Set<string>();
const frequencyTransitionsCache = new Map<
  string,
  readonly TimeZoneTransition[]
>();

export class CronScheduleEvaluator {
  validate(expression: string, timeZone: string): string {
    const shaped = z
      .strictObject({
        expression: cronExpressionShapeSchema,
        timeZone: ianaTimeZoneSchema,
      })
      .safeParse({ expression, timeZone });
    if (!shaped.success) {
      throw new AutomationScheduleValidationError(
        "invalid_cron",
        shaped.error.issues[0]?.message ?? "Invalid cron schedule",
      );
    }

    const normalized = shaped.data.expression;
    const cacheKey = `${timeZone}\u0000${normalized}`;
    if (cronValidationCache.has(cacheKey)) return normalized;

    this.#parse(normalized, timeZone, FREQUENCY_EPOCH_MS);
    this.#assertHasOccurrence(normalized, timeZone);
    this.#assertMinimumFrequency(normalized, timeZone);
    cronValidationCache.add(cacheKey);
    return normalized;
  }

  nextOccurrence(
    expression: string,
    timeZone: string,
    afterExclusive: number,
  ): number | null {
    assertEpochMilliseconds(afterExclusive, "afterExclusive");
    const normalized = this.validate(expression, timeZone);
    return this.#nextValidated(normalized, timeZone, afterExclusive);
  }

  preview(
    expression: string,
    timeZone: string,
    afterExclusive: number,
    count = DEFAULT_AUTOMATION_PREVIEW_COUNT,
  ): number[] {
    assertPreviewCount(count);
    const normalized = this.validate(expression, timeZone);
    const occurrences: number[] = [];
    let cursor = afterExclusive;
    while (occurrences.length < count) {
      const next = this.#nextValidated(normalized, timeZone, cursor);
      if (next === null) break;
      occurrences.push(next);
      cursor = next;
    }
    return occurrences;
  }

  #parse(
    expression: string,
    timeZone: string,
    currentDate: number,
  ): CronExpression {
    try {
      return CronExpressionParser.parse(expression, {
        currentDate,
        tz: timeZone,
      });
    } catch (error) {
      throw new AutomationScheduleValidationError(
        "invalid_cron",
        "The cron expression is invalid",
        { cause: error },
      );
    }
  }

  #assertHasOccurrence(expression: string, timeZone: string): void {
    const parsed = this.#parse(expression, timeZone, FREQUENCY_EPOCH_MS);
    try {
      parsed.next();
    } catch (error) {
      throw new AutomationScheduleValidationError(
        "cron_has_no_occurrence",
        "The cron expression does not produce a future occurrence",
        { cause: error },
      );
    }
  }

  #assertMinimumFrequency(expression: string, timeZone: string): void {
    let previous: number | null = null;
    let cursor = FREQUENCY_EPOCH_MS;
    for (let index = 0; index < FREQUENCY_SAMPLE_COUNT; index += 1) {
      const next = this.#nextWithoutValidation(expression, timeZone, cursor);
      if (next === null) break;
      if (previous !== null && next - previous < MIN_FREQUENCY_MS) {
        throwTooFrequent();
      }
      previous = next;
      cursor = next;
    }

    const transitions = getFrequencyTransitions(timeZone);
    for (const transition of transitions) {
      const windowStart = transition.at - TRANSITION_WINDOW_MS;
      const windowEnd = transition.at + TRANSITION_WINDOW_MS;
      let windowCursor = windowStart;
      let windowPrevious: number | null = null;
      for (let index = 0; index < 1_024; index += 1) {
        const next = this.#nextWithoutValidation(
          expression,
          timeZone,
          windowCursor,
        );
        if (next === null || next > windowEnd) break;
        if (
          windowPrevious !== null &&
          next - windowPrevious < MIN_FREQUENCY_MS
        ) {
          throwTooFrequent();
        }
        windowPrevious = next;
        windowCursor = next;
      }
    }
  }

  #nextValidated(
    expression: string,
    timeZone: string,
    afterExclusive: number,
  ): number | null {
    return this.#nextWithoutValidation(expression, timeZone, afterExclusive);
  }

  #nextWithoutValidation(
    expression: string,
    timeZone: string,
    afterExclusive: number,
  ): number | null {
    const parsed = this.#parse(expression, timeZone, afterExclusive);
    let libraryCandidate: number | null = null;
    try {
      for (let attempts = 0; attempts < 16; attempts += 1) {
        const candidate = parsed.next();
        if (parsed.includesDate(candidate)) {
          libraryCandidate = candidate.getTime();
          break;
        }
      }
    } catch {
      return null;
    }
    if (libraryCandidate === null) return null;

    const transitions = findTimeZoneTransitions(
      timeZone,
      afterExclusive,
      libraryCandidate,
    );
    let correctedCandidate = libraryCandidate;
    for (const transition of transitions) {
      const from = Math.max(
        nextWholeMinute(afterExclusive),
        transition.at - TRANSITION_WINDOW_MS,
      );
      const through = Math.min(
        libraryCandidate - 1,
        transition.at + TRANSITION_WINDOW_MS,
      );
      for (let instant = from; instant <= through; instant += 60_000) {
        if (
          parsed.includesDate(new Date(instant)) &&
          !isLaterRepeatedWallTime(instant, transition)
        ) {
          correctedCandidate = Math.min(correctedCandidate, instant);
          break;
        }
      }
    }
    return correctedCandidate;
  }
}

export class AutomationScheduleEvaluator {
  constructor(readonly cron = new CronScheduleEvaluator()) {}

  validate(schedule: unknown): AutomationSchedule {
    const shaped = automationScheduleSchema.safeParse(schedule);
    if (!shaped.success) {
      throw new AutomationScheduleValidationError(
        "invalid_schedule",
        shaped.error.issues[0]?.message ?? "Invalid automation schedule",
      );
    }
    if (shaped.data.kind !== "cron") return shaped.data;
    return {
      ...shaped.data,
      expression: this.cron.validate(
        shaped.data.expression,
        shaped.data.timeZone,
      ),
    };
  }

  nextOccurrence(schedule: unknown, afterExclusive: number): number | null {
    assertEpochMilliseconds(afterExclusive, "afterExclusive");
    const validated = this.validate(schedule);
    switch (validated.kind) {
      case "date_time":
        return validated.runAt > afterExclusive ? validated.runAt : null;
      case "interval":
        return nextIntervalOccurrence(validated, afterExclusive);
      case "cron":
        return this.cron.nextOccurrence(
          validated.expression,
          validated.timeZone,
          afterExclusive,
        );
    }
  }

  preview(
    schedule: unknown,
    afterExclusive: number,
    count = DEFAULT_AUTOMATION_PREVIEW_COUNT,
  ): number[] {
    assertEpochMilliseconds(afterExclusive, "afterExclusive");
    assertPreviewCount(count);
    const validated = this.validate(schedule);
    if (validated.kind === "cron") {
      return this.cron.preview(
        validated.expression,
        validated.timeZone,
        afterExclusive,
        count,
      );
    }

    const occurrences: number[] = [];
    let cursor = afterExclusive;
    while (occurrences.length < count) {
      const next =
        validated.kind === "date_time"
          ? validated.runAt > cursor
            ? validated.runAt
            : null
          : nextIntervalOccurrence(validated, cursor);
      if (next === null) break;
      occurrences.push(next);
      cursor = next;
    }
    return occurrences;
  }
}

export function coalesceIntervalOccurrences(
  schedule: IntervalAutomationSchedule,
  afterExclusive: number,
  throughInclusive: number,
): IntervalCoalescingResult | null {
  assertEpochMilliseconds(afterExclusive, "afterExclusive");
  assertEpochMilliseconds(throughInclusive, "throughInclusive");
  if (throughInclusive <= afterExclusive) return null;

  const validated = automationScheduleSchema.parse(schedule);
  if (validated.kind !== "interval") {
    throw new AutomationScheduleValidationError(
      "invalid_schedule",
      "Interval coalescing requires an interval schedule",
    );
  }
  const firstDueAt = nextIntervalOccurrence(validated, afterExclusive);
  if (firstDueAt === null || firstDueAt > throughInclusive) return null;

  const intervalMs = validated.everySeconds * 1_000;
  const additionalDue = Math.floor(
    (throughInclusive - firstDueAt) / intervalMs,
  );
  const scheduledAt = firstDueAt + additionalDue * intervalMs;
  const nextRunAt = scheduledAt + intervalMs;
  if (!Number.isSafeInteger(nextRunAt)) {
    throw new AutomationScheduleValidationError(
      "invalid_schedule",
      "The interval occurrence exceeds the supported timestamp range",
    );
  }
  return {
    scheduledAt,
    coalescedCount: additionalDue,
    nextRunAt,
  };
}

function nextIntervalOccurrence(
  schedule: IntervalAutomationSchedule,
  afterExclusive: number,
): number | null {
  if (afterExclusive < schedule.anchorAt) return schedule.anchorAt;
  const intervalMs = schedule.everySeconds * 1_000;
  const elapsed = afterExclusive - schedule.anchorAt;
  const steps = Math.floor(elapsed / intervalMs) + 1;
  const next = schedule.anchorAt + steps * intervalMs;
  return Number.isSafeInteger(next) ? next : null;
}

function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/gu, " ");
}

function containsHashedCronToken(field: string): boolean {
  return /(?:^|[^A-Za-z])H(?:$|[^A-Za-z])/u.test(field);
}

function isSupportedIanaTimeZone(timeZone: string): boolean {
  if (/^(?:[+-]\d|GMT[+-])/iu.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function assertEpochMilliseconds(value: number, name: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new AutomationScheduleValidationError(
      "invalid_schedule",
      `${name} must be non-negative epoch milliseconds`,
    );
  }
}

function assertPreviewCount(count: number): void {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_AUTOMATION_PREVIEW_COUNT
  ) {
    throw new AutomationScheduleValidationError(
      "invalid_schedule",
      `Preview count must be between 1 and ${MAX_AUTOMATION_PREVIEW_COUNT}`,
    );
  }
}

function throwTooFrequent(): never {
  throw new AutomationScheduleValidationError(
    "cron_too_frequent",
    "Cron schedules must be at least five minutes apart",
  );
}

function nextWholeMinute(afterExclusive: number): number {
  return Math.floor(afterExclusive / 60_000) * 60_000 + 60_000;
}

function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    });
    offsetFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getTimeZoneOffsetMinutes(timeZone: string, instant: number): number {
  const value = getOffsetFormatter(timeZone)
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  if (value === "GMT" || value === "UTC") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(value ?? "");
  if (!match) {
    throw new AutomationScheduleValidationError(
      "invalid_cron",
      "The timezone offset could not be evaluated",
    );
  }
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function findTimeZoneTransitions(
  timeZone: string,
  fromExclusive: number,
  throughInclusive: number,
): TimeZoneTransition[] {
  if (throughInclusive <= fromExclusive) return [];
  const transitions: TimeZoneTransition[] = [];
  let cursor = fromExclusive;
  let priorOffset = getTimeZoneOffsetMinutes(timeZone, cursor);
  while (cursor < throughInclusive) {
    const next = Math.min(cursor + TRANSITION_SCAN_STEP_MS, throughInclusive);
    const nextOffset = getTimeZoneOffsetMinutes(timeZone, next);
    if (nextOffset !== priorOffset) {
      const transitionAt = locateTransitionMinute(
        timeZone,
        cursor,
        next,
        priorOffset,
      );
      transitions.push({
        at: transitionAt,
        offsetBeforeMinutes: priorOffset,
        offsetAfterMinutes: nextOffset,
      });
    }
    cursor = next;
    priorOffset = nextOffset;
  }
  return transitions;
}

function getFrequencyTransitions(
  timeZone: string,
): readonly TimeZoneTransition[] {
  let transitions = frequencyTransitionsCache.get(timeZone);
  if (!transitions) {
    transitions = findTimeZoneTransitions(
      timeZone,
      FREQUENCY_EPOCH_MS,
      FREQUENCY_TRANSITION_END_MS,
    );
    frequencyTransitionsCache.set(timeZone, transitions);
  }
  return transitions;
}

function locateTransitionMinute(
  timeZone: string,
  lowerInclusive: number,
  upperInclusive: number,
  offsetBefore: number,
): number {
  let lower = Math.floor(lowerInclusive / 60_000) * 60_000;
  let upper = Math.ceil(upperInclusive / 60_000) * 60_000;
  while (upper - lower > 60_000) {
    const middle =
      Math.floor((lower + Math.floor((upper - lower) / 2)) / 60_000) * 60_000;
    if (getTimeZoneOffsetMinutes(timeZone, middle) === offsetBefore) {
      lower = middle;
    } else {
      upper = middle;
    }
  }
  return upper;
}

function isLaterRepeatedWallTime(
  instant: number,
  transition: TimeZoneTransition,
): boolean {
  if (transition.offsetAfterMinutes >= transition.offsetBeforeMinutes) {
    return false;
  }
  const repeatedDurationMs =
    (transition.offsetBeforeMinutes - transition.offsetAfterMinutes) * 60_000;
  return (
    instant >= transition.at &&
    instant < transition.at + repeatedDurationMs
  );
}
