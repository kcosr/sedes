import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";

type BackgroundWork = NonNullable<NormalizedApplicationThreadSummary["backgroundWork"]>;

/** Provider-neutral count wording shared by thread and inventory presentation. */
export function backgroundWorkCounts(work: BackgroundWork): string {
  return [
    work.agents > 0 && `${work.agents} subagent${work.agents === 1 ? "" : "s"}`,
    work.commands > 0 && `${work.commands} command${work.commands === 1 ? "" : "s"}`,
    work.other > 0 && `${work.other} other task${work.other === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
}

export function backgroundWorkLabel(work: BackgroundWork): string {
  const total = work.agents + work.commands + work.other;
  if (work.agents === 1 && total === 1) return "Waiting for subagent";
  if (work.commands === 1 && total === 1) return "Background command running";
  return `Background work · ${backgroundWorkCounts(work)}`;
}
