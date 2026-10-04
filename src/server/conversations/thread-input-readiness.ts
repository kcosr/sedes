import type { ThreadApplicationPresentation } from "./thread-application-service.js";

/** Shared by composer capabilities and non-attaching voice readiness. */
export function initialThreadSettingsReady(presentation: Pick<ThreadApplicationPresentation, "settingDescriptors" | "settings">): boolean {
  return presentation.settingDescriptors
    .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
    .every((descriptor) => {
      const value = presentation.settings.values.find(({ id }) => id === descriptor.id)?.desiredValue;
      return typeof value === "string" && descriptor.options.some(option => option.available && option.value === value);
    });
}
