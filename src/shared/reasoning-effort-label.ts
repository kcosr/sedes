const labels: ReadonlyMap<string, string> = new Map([
  ["off", "Off"],
  ["none", "None"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["ultra", "Ultra"],
  ["max", "Maximum"],
]);

/** Display text only. The caller retains the exact ID for selection and mutation. */
export function reasoningEffortLabel(id: string, fallback?: (id: string) => string): string {
  return labels.get(id) ?? fallback?.(id) ?? id;
}
