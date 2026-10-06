import type { AutomationSchedule as ProtocolAutomationSchedule } from "../../shared/protocol/automation.js";
import type { AutomationSchedule } from "./automation-models.js";

const PROMPT_PREVIEW_UNITS = 140;

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
