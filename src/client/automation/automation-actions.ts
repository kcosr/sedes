import type {
  AutomationHealth,
  AutomationHealthThread,
  SummaryAutomation,
} from "./automation-health.js";

/**
 * Which of an automation's actions can run now, and why not, for every
 * surface that offers them (the Automations list's row menu and the
 * automation page). The reasons follow the server's rules: a run in flight
 * or an unknown outcome blocks starting another and changing the
 * definition; an archived anchor cannot run, be enabled or be edited, but
 * its schedule can still be paused; a snoozed anchor cannot run by hand.
 */

export interface AutomationActionAvailability {
  readonly available: boolean;
  /** Why it is off, as an instruction: "Resolve the unknown run first". */
  readonly reason?: string;
  /** The same in a word or two, for a menu row's trailing hint. */
  readonly hint?: string;
}

export interface AutomationActionAvailabilities {
  readonly runNow: AutomationActionAvailability;
  /** Pause while enabled, Enable while paused. */
  readonly toggle: AutomationActionAvailability & {
    readonly action: "pause" | "enable";
  };
  readonly edit: AutomationActionAvailability;
  readonly remove: AutomationActionAvailability;
}

/** The capability's verdict, when the surface has read it (the page does). */
export interface AutomationActionCapability {
  readonly available: boolean;
  readonly unavailableReason?: string;
}

interface Blocker {
  readonly reason: string;
  readonly hint: string;
}

const AVAILABLE: AutomationActionAvailability = { available: true };

function availability(blocker: Blocker | undefined): AutomationActionAvailability {
  return blocker ? { available: false, ...blocker } : AVAILABLE;
}

export function automationActionAvailability(
  thread: Pick<AutomationHealthThread, "inventoryState"> & {
    readonly automation: SummaryAutomation;
  },
  health: AutomationHealth,
  capability?: AutomationActionCapability,
): AutomationActionAvailabilities {
  const unknown: Blocker | undefined =
    health.kind === "unknown"
      ? { reason: "Resolve the unknown run first", hint: health.label }
      : undefined;
  const inFlight: Blocker | undefined =
    health.kind === "sending"
      ? { reason: "Wait for the current run to finish", hint: health.label }
      : undefined;
  const archived: Blocker | undefined =
    thread.inventoryState === "archived"
      ? { reason: "Restore the thread first", hint: "Thread archived" }
      : undefined;
  const snoozed: Blocker | undefined =
    thread.inventoryState === "snoozed"
      ? { reason: "Unsnooze the thread first", hint: "Snoozed" }
      : undefined;
  const unavailable: Blocker | undefined =
    capability?.available === false
      ? {
          reason:
            capability.unavailableReason ??
            "Automation is unavailable for this thread",
          hint: "Unavailable",
        }
      : undefined;
  const enable = thread.automation.status === "paused";
  return {
    runNow: availability(unknown ?? inFlight ?? archived ?? snoozed ?? unavailable),
    toggle: {
      action: enable ? "enable" : "pause",
      // Pausing only stops the schedule, so a suspended anchor allows it.
      ...availability(
        unknown ?? inFlight ?? (enable ? (archived ?? unavailable) : undefined),
      ),
    },
    edit: availability(unknown ?? archived ?? unavailable),
    remove: availability(unknown ?? inFlight),
  };
}

/**
 * What marking an automation's uncertain last run as failed can do, as the
 * server resolves it: the scheduled run of a one-time automation ends that
 * automation (`ends`); otherwise the automation stays, paused, and can be
 * resumed in the same step (`choose`), unless it is a one-time automation
 * whose time has passed, which has no future run to resume to
 * (`stays_paused`). Undefined while the last run is not uncertain.
 */
export type UncertainRunResolution = "ends" | "choose" | "stays_paused";

export function uncertainRunResolution(
  automation: Pick<SummaryAutomation, "schedule" | "lastRun">,
  now: Date | number,
): UncertainRunResolution | undefined {
  const lastRun = automation.lastRun;
  if (lastRun?.state !== "uncertain") return undefined;
  const schedule = automation.schedule;
  if (schedule.kind !== "date_time") return "choose";
  if (lastRun.occurrence === "scheduled") return "ends";
  const at = typeof now === "number" ? now : now.getTime();
  return Date.parse(schedule.runAt) > at ? "choose" : "stays_paused";
}
