import {
  Files,
  ListChecks,
  MessageSquare,
  NotepadText,
  Terminal as TerminalIcon,
} from "lucide-react";
import { BackendBrandIcon } from "../components/brand-icons.js";
import type { PanelKind, RegionId } from "./regions.js";

/** Each panel kind's name, as the toolbar, menus and announcements say it. */
export const PANEL_TITLES: Readonly<Record<PanelKind, string>> = Object.freeze({
  chat: "Chat",
  files: "Files",
  workpads: "Workpads",
  tasks: "Tasks",
  terminals: "Terminals",
});

/** A region's name in Move to and the place menu. */
export const REGION_TITLES: Readonly<Record<RegionId, string>> = Object.freeze({
  middle: "Middle",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
});

/** Where a shown panel is, as the panels menu says it: "On the right". */
export const REGION_PHRASES: Readonly<Record<RegionId, string>> = Object.freeze({
  middle: "In the middle",
  left: "On the left",
  right: "On the right",
  top: "At the top",
  bottom: "At the bottom",
});

export type BackendBrand = React.ComponentProps<typeof BackendBrandIcon>["brand"];

/** A panel kind's glyph; Chat shows the thread's backend brand when known. */
export function PanelGlyph({
  kind,
  brand,
  size,
  strokeWidth,
}: {
  readonly kind: PanelKind;
  readonly brand?: BackendBrand;
  readonly size: number;
  readonly strokeWidth?: number;
}): React.JSX.Element {
  const props = { size, strokeWidth, "aria-hidden": true } as const;
  if (kind === "files") return <Files {...props} />;
  if (kind === "workpads") return <NotepadText {...props} />;
  if (kind === "tasks") return <ListChecks {...props} />;
  if (kind === "terminals") return <TerminalIcon {...props} />;
  if (brand !== undefined)
    return <BackendBrandIcon brand={brand} size={size} aria-hidden="true" />;
  return <MessageSquare {...props} />;
}

/** Joins panel names for an announcement: "Files and Tasks". */
export function joinPanelTitles(kinds: readonly PanelKind[]): string {
  const titles = kinds.map((kind) => PANEL_TITLES[kind]);
  if (titles.length <= 2) return titles.join(" and ");
  return `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}
