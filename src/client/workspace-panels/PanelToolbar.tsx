import { useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useTouchDensity } from "../app/use-touch-density.js";
import { SidebarNavTrigger } from "../components/SidebarNavTrigger.js";
import { WorkbenchPanelToggle } from "../components/WorkbenchPanelToggle.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuValue,
} from "../components/ui/dropdown-menu.js";
import type { PanelChromeStatus } from "./PanelChrome.js";
import {
  PANEL_TITLES,
  PanelGlyph,
  REGION_TITLES,
  type BackendBrand,
} from "./panel-kinds.js";
import {
  REGION_IDS,
  type PanelKind,
  type PanelLoadState,
  type RegionId,
} from "./regions.js";

/** One panel kind in the workbench bar: its quick button and menu row. */
export interface PanelToolbarEntry {
  readonly kind: PanelKind;
  readonly state: PanelLoadState;
  /** False when the quick button cannot hide it: Chat in front on a phone. */
  readonly hideable?: boolean;
  /** The row's state: "On the right", "Loaded, hidden"; none when closed. */
  readonly stateLabel?: string;
  /** The region the panel opens in, checked in its place menu. */
  readonly placement: RegionId;
  readonly badge?: { readonly count: number; readonly label: string };
  /** The ID of the element the quick button shows, when stable. */
  readonly controls?: string;
  readonly status?: PanelChromeStatus;
}

/**
 * The workbench bar: navigation, a quick button for every loaded panel in
 * the fixed order, and ▾, the launcher for every panel. A row opens its
 * panel in its place; the row's trailing place button opens it in a chosen
 * region instead, which becomes its place.
 */
export function PanelToolbar({
  active,
  entries,
  brand,
  places,
  triggerRef,
  onToggle,
  onOpen,
  onReset,
}: {
  readonly active: boolean;
  /** Every available panel kind, in the fixed order. */
  readonly entries: readonly PanelToolbarEntry[];
  readonly brand?: BackendBrand;
  /** Whether rows offer their place menu; phones have no regions. */
  readonly places: boolean;
  readonly triggerRef: React.Ref<HTMLButtonElement>;
  readonly onToggle: (kind: PanelKind, invoker: HTMLButtonElement) => void;
  /**
   * Opens a panel in its place, or in `region`. True when focus moves into
   * the panel, so the menu does not take it back to ▾.
   */
  readonly onOpen: (kind: PanelKind, region: RegionId | undefined) => boolean;
  readonly onReset: () => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const focusMoved = useRef(false);
  const sheet = useTouchDensity();
  const open = (kind: PanelKind, region?: RegionId) => {
    focusMoved.current = onOpen(kind, region);
  };
  return (
    <div className="workspace-workbench-bar" data-testid="workspace-workbench-bar">
      <SidebarNavTrigger />
      <div className="workspace-workbench-actions">
        <div
          className="workspace-workbench-toggles"
          role="group"
          aria-label="Loaded panels"
        >
          {entries
            .filter(({ state }) => state !== "closed")
            .map((entry) => (
              <WorkbenchPanelToggle
                key={entry.kind}
                title={PANEL_TITLES[entry.kind]}
                icon={
                  <PanelGlyph kind={entry.kind} brand={brand} size={20} strokeWidth={1.8} />
                }
                visible={entry.state === "visible"}
                hideable={entry.hideable ?? true}
                onToggle={(invoker) => onToggle(entry.kind, invoker)}
                badge={entry.badge}
                controls={entry.controls}
                className={`${entry.kind}-panel-toggle`}
                testId={`${entry.kind}-panel-toggle`}
              />
            ))}
        </div>
        <DropdownMenu
          presentation={sheet ? "sheet" : "menu"}
          open={active && menuOpen}
          onOpenChange={setMenuOpen}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="icon-sm"
              className="workspace-panel-open-trigger"
              aria-label="Panels"
              title="Panels"
            >
              <ChevronDown size={13} aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-[min(280px,calc(100vw-16px))]"
            align="end"
            sheetTitle="Panels"
            onCloseAutoFocus={(event) => {
              if (!focusMoved.current) return;
              focusMoved.current = false;
              event.preventDefault();
            }}
          >
            <DropdownMenuLabel>Panels</DropdownMenuLabel>
            {entries.map((entry) => (
              <PanelMenuRow
                key={entry.kind}
                entry={entry}
                brand={brand}
                places={places}
                onOpen={open}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              <RotateCcw aria-hidden="true" />
              Reset layout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function PanelMenuRow({
  entry,
  brand,
  places,
  onOpen,
}: {
  readonly entry: PanelToolbarEntry;
  readonly brand?: BackendBrand;
  readonly places: boolean;
  readonly onOpen: (kind: PanelKind, region?: RegionId) => void;
}): React.JSX.Element {
  const title = PANEL_TITLES[entry.kind];
  const [placesOpen, setPlacesOpen] = useState(false);
  // The place menu opens beside the panel, usually on its left, across this
  // row's label: the label keeps it open rather than taking the highlight.
  const keepPlacesOpen = (event: React.PointerEvent) => {
    if (placesOpen) event.preventDefault();
  };
  const row = (
    <DropdownMenuItem
      data-panel-row={entry.kind}
      data-panel-state={entry.state}
      aria-label={[
        title,
        entry.stateLabel,
        entry.status?.dirty ? "unsaved changes" : undefined,
      ]
        .filter(Boolean)
        .join(", ")}
      onPointerMove={keepPlacesOpen}
      onPointerLeave={keepPlacesOpen}
      onSelect={() => onOpen(entry.kind)}
    >
      <PanelGlyph kind={entry.kind} brand={brand} size={16} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {entry.status?.dirty ? (
        <span className="workspace-panel-dirty" aria-label="Unsaved changes" />
      ) : null}
      {entry.status?.busy ? (
        <span className="comet-spinner workspace-panel-spinner" aria-label="Busy" />
      ) : null}
      {entry.stateLabel ? (
        <DropdownMenuValue>{entry.stateLabel}</DropdownMenuValue>
      ) : null}
    </DropdownMenuItem>
  );
  if (!places) return row;
  return (
    // A row opens its panel in place; its trailing button chooses the place.
    <DropdownMenuGroup
      aria-label={title}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-0.5"
    >
      {row}
      <DropdownMenuSub open={placesOpen} onOpenChange={setPlacesOpen}>
        <DropdownMenuSubTrigger
          // A square trailing button: its chevron alone, centered.
          className="workspace-panel-place-trigger w-(--menu-row-height) justify-center px-0 [&>svg]:mx-0"
          aria-label={`Choose where to open ${title}`}
          title={`Choose where to open ${title}`}
          textValue={`Open ${title} in`}
        />
        {/* Beside the whole menu, clear of the rows it would cover. */}
        <DropdownMenuSubContent besideParent>
          <DropdownMenuLabel>Open {title} in</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label={`Open ${title} in`}
            value={entry.placement}
          >
            {REGION_IDS.map((region) => (
              <DropdownMenuRadioItem
                key={region}
                value={region}
                // The current place opens there too, so it is not a value change.
                onSelect={() => onOpen(entry.kind, region)}
              >
                {REGION_TITLES[region]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
  );
}
