export type PanelPresentation = "single" | "split";

/** Applies the keyboard-only temporary override without changing the setting. */
export function resolvePanelPresentation(
  preference: PanelPresentation,
  shiftKey: boolean,
): PanelPresentation {
  if (!shiftKey) return preference;
  return preference === "single" ? "split" : "single";
}
