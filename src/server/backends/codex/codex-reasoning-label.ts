import { reasoningEffortLabel } from "../../../shared/reasoning-effort-label.js";

export function reasoningLabel(value: string): string {
  return reasoningEffortLabel(value, (effort) =>
    effort
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" "),
  );
}
