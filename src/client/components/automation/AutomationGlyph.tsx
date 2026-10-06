import {
  Archive,
  CirclePause,
  Moon,
  Repeat,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Tone } from "@client/components/ui/tone";
import { cn } from "@client/lib/utils";
import type { AutomationGlyphKind } from "../../automation/automation-health.js";
import "./automation-glyph.css";

export type AutomationGlyphSize = "sidebar" | "list" | "header";

const ICONS: Readonly<Record<Exclude<AutomationGlyphKind, "spinner">, LucideIcon>> = {
  triangle: TriangleAlert,
  archive: Archive,
  // The sidebar's snooze glyph, so a snoozed anchor reads the same everywhere.
  snoozed: Moon,
  repeat: Repeat,
  pause: CirclePause,
};

const ICON_SIZES: Readonly<
  Record<AutomationGlyphSize, { readonly size: number; readonly strokeWidth: number }>
> = {
  sidebar: { size: 14, strokeWidth: 2 },
  list: { size: 16, strokeWidth: 2 },
  header: { size: 18, strokeWidth: 1.8 },
};

/**
 * One automation health glyph (see `automationHealth`): Repeat, CirclePause,
 * the attention triangle, the sending spinner, Archive or the snooze moon.
 * Rendered bare, without a wrapper, so it drops into existing glyph slots.
 * Tone colors only the states that carry meaning (danger, warning, info);
 * neutral and success (Active) inherit the surface's quiet glyph color.
 * Decorative unless `label` names it.
 */
export function AutomationGlyph({
  glyph,
  tone = "neutral",
  size = "sidebar",
  label,
  className,
}: {
  readonly glyph: AutomationGlyphKind;
  readonly tone?: Tone;
  readonly size?: AutomationGlyphSize;
  readonly label?: string;
  readonly className?: string;
}): React.JSX.Element {
  const shared = {
    className: cn(
      "automation-glyph",
      glyph === "spinner" && "comet-spinner",
      className,
    ),
    "data-automation-glyph": glyph,
    "data-size": size,
    "data-tone": tone === "neutral" || tone === "success" ? undefined : tone,
    ...(label
      ? { role: "img", "aria-label": label }
      : { "aria-hidden": true as const }),
  };
  if (glyph === "spinner") return <span {...shared} />;
  const Icon = ICONS[glyph];
  return <Icon {...ICON_SIZES[size]} {...shared} />;
}
