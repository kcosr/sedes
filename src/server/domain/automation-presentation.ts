import type { AutomationSchedule as ProtocolAutomationSchedule } from "../../shared/protocol/automation.js";
import type { AutomationSchedule } from "./automation-models.js";

const PROMPT_PREVIEW_UNITS = 140;
const THREAD_TITLE_MAXIMUM_UNITS = 240;

/**
 * Prompt characters a summary reader loads to derive the preview, so a
 * projection never materializes complete 64 KiB prompts. Prompts are stored
 * trimmed, so a longer prompt always has more visible text after this prefix.
 */
export const AUTOMATION_PROMPT_PREVIEW_SOURCE_CHARACTERS = 2_048;

export function presentAutomationSchedule(
  schedule: AutomationSchedule,
): ProtocolAutomationSchedule {
  switch (schedule.kind) {
    case "date_time":
      return { kind: schedule.kind, runAt: iso(schedule.runAt) };
    case "interval":
      return {
        kind: schedule.kind,
        anchorAt: iso(schedule.anchorAt),
        everySeconds: schedule.everySeconds,
      };
    case "cron":
      return {
        kind: schedule.kind,
        expression: schedule.expression,
        timeZone: schedule.timeZone,
      };
  }
}

/**
 * The opening of a prompt with whitespace runs collapsed: at most 140 UTF-16
 * units without splitting a code point, plus "…" when more text follows.
 * `source` may be a bounded prefix of the prompt; `sourceTruncated` reports
 * that the stored prompt continues past it.
 */
export function automationPromptPreview(
  source: string,
  sourceTruncated = false,
): string {
  const collapsed = source.replace(/\s+/gu, " ").trim();
  const preview = takeUnits(collapsed, PROMPT_PREVIEW_UNITS);
  return preview.length < collapsed.length || sourceTruncated
    ? `${preview.trimEnd()}…`
    : preview;
}

/**
 * Title suffix for a clone run's result thread: the run time as
 * "Oct 6, 3:15 AM", in the cron schedule's zone or otherwise UTC (labelled).
 */
export function automationCloneTitleSuffix(
  runAt: number,
  schedule: AutomationSchedule,
): string {
  const timeZone = schedule.kind === "cron" ? schedule.timeZone : "UTC";
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  })
    .format(runAt)
    // ICU separates the day period with a narrow no-break space.
    .replace(/\s/gu, " ");
  return ` · ${formatted}${schedule.kind === "cron" ? "" : " UTC"}`;
}

/** Appends a clone run suffix, shortening the anchor title to stay a valid title. */
export function automationCloneThreadTitle(
  anchorTitle: string,
  suffix: string,
): string {
  const available = THREAD_TITLE_MAXIMUM_UNITS - suffix.length;
  if (anchorTitle.length <= available) return `${anchorTitle}${suffix}`;
  return `${takeUnits(anchorTitle, available - 1).trimEnd()}…${suffix}`;
}

function takeUnits(value: string, units: number): string {
  let taken = "";
  for (const character of value) {
    if (taken.length + character.length > units) break;
    taken += character;
  }
  return taken;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
