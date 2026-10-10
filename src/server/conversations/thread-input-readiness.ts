import type { ThreadApplicationPresentation } from "./thread-application-service.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import { MAXIMUM_ACTIVE_QUEUED_INPUTS } from "../db/repositories/queued-input-repository.js";

/** Shared by composer capabilities and non-attaching voice readiness. */
export function initialThreadSettingsReady(presentation: Pick<ThreadApplicationPresentation, "settingDescriptors" | "settings">): boolean {
  return presentation.settingDescriptors
    .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
    .every((descriptor) => {
      const value = presentation.settings.values.find(({ id }) => id === descriptor.id)?.desiredValue;
      return typeof value === "string" && descriptor.options.some(option => option.available && option.value === value);
    });
}

/** The shared Submit/Queue capability policy, independent of provider attachment. */
export function threadInputDeliveryAvailability(input: {
  readonly backingState: string;
  readonly inventoryState: string;
  readonly available: boolean;
  readonly interactive: boolean;
  readonly settingsReady: boolean;
  readonly exclusivePendingSteer: boolean;
  readonly runState: ThreadRunState;
  readonly submitSupported: boolean;
  readonly queuedInputCount: number;
}): { readonly submit: boolean; readonly queue: boolean } {
  const writable = input.interactive && input.available &&
    input.inventoryState !== "archived" && input.inventoryState !== "snoozed" &&
    input.settingsReady && !input.exclusivePendingSteer;
  const bound = input.backingState === "bound";
  return {
    submit: writable && (input.backingState === "unbound" ||
      bound && (input.runState === "idle" || input.runState === "failed") && input.submitSupported),
    queue: writable && bound && input.submitSupported &&
      ["starting", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(input.runState) &&
      input.queuedInputCount < MAXIMUM_ACTIVE_QUEUED_INPUTS,
  };
}

/** Direct input can queue during work, but cannot race runtime transitions. */
export function directInputRuntimeReady(input: { readonly settled: boolean; readonly runState: ThreadRunState }): boolean {
  return input.settled || ["running", "waiting_for_input", "waiting_for_approval"].includes(input.runState);
}
