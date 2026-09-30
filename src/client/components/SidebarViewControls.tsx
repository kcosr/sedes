import { useState } from "react";
import { Tooltip } from "radix-ui";
import {
  Activity,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  FolderTree,
  History,
  Rows3,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemDescription,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { useTouchDensity } from "../app/use-touch-density.js";
import {
  SIDEBAR_MODE_DEFAULTS,
  resolveModePreferences,
  type SidebarDensity,
  type SidebarGroupBy,
  type SidebarShowFilters,
  type SidebarSortBy,
  type SidebarStackBy,
  type SidebarViewPreferences,
} from "../app/sidebar-view-model.js";
import "./sidebar-view-controls.css";

/**
 * Header controls for sidebar views: a quick toggle that flips
 * `project` ⇄ `lastAltGroupBy`, and a View options menu of radio and
 * checkbox rows (a sheet on touch).
 * Fully controlled/presentational — no store imports; the parent owns all
 * preference writes (including flipping sort direction when `onSortChange`
 * reports the already-active sort key).
 */

const GROUP_BY_VIEWS: ReadonlyArray<{
  readonly value: SidebarGroupBy;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { value: "project", label: "Projects", icon: FolderTree },
  { value: "time", label: "Timeline", icon: History },
  { value: "state", label: "State", icon: Activity },
  { value: "none", label: "Flat list", icon: Rows3 },
];

const STACK_BY_OPTIONS: ReadonlyArray<{
  readonly value: SidebarStackBy;
  readonly label: string;
}> = [
  { value: "none", label: "Off" },
  { value: "group", label: "Thread groups" },
  { value: "project", label: "Projects" },
];

const SHOW_FILTERS: ReadonlyArray<{
  readonly key: keyof SidebarShowFilters;
  readonly label: string;
}> = [
  { key: "snoozed", label: "Snoozed" },
  { key: "settled", label: "Settled" },
  { key: "drafts", label: "Drafts" },
];

/** Toggles and sort flips keep the menu open so several can be changed. */
function keepOpen(action?: () => void) {
  return (event: Event) => {
    event.preventDefault();
    action?.();
  };
}

const SORT_OPTIONS: ReadonlyArray<{
  readonly value: SidebarSortBy;
  readonly label: string;
}> = [
  { value: "activity", label: "Activity" },
  { value: "alpha", label: "Alphabetical" },
  { value: "stateChanged", label: "State changed" },
];

function viewOf(groupBy: SidebarGroupBy) {
  const view = GROUP_BY_VIEWS.find(({ value }) => value === groupBy);
  // GROUP_BY_VIEWS covers every SidebarGroupBy; the fallback is unreachable.
  return view ?? GROUP_BY_VIEWS[0]!;
}

export interface SidebarViewControlsProps {
  readonly preferences: SidebarViewPreferences;
  readonly onGroupByChange: (groupBy: SidebarGroupBy) => void;
  readonly onStackByChange: (stackBy: SidebarStackBy) => void;
  /** Parent flips direction when the reported sort key is already active. */
  readonly onSortChange: (sortBy: SidebarSortBy) => void;
  readonly onDensityChange: (density: SidebarDensity) => void;
  readonly onPeekToggle: () => void;
  readonly onPinnedOnlyToggle: () => void;
  readonly onShowToggle: (key: keyof SidebarShowFilters) => void;
  readonly onGroupForksToggle: () => void;
  readonly onBackendIconsToggle: () => void;
  readonly onResetMode: () => void;
  /** Reports the options popover's open state (e.g. to suppress row peeks). */
  readonly onOptionsOpenChange?: (open: boolean) => void;
}

export function SidebarViewControls({
  preferences,
  onGroupByChange,
  onStackByChange,
  onSortChange,
  onDensityChange,
  onPeekToggle,
  onPinnedOnlyToggle,
  onShowToggle,
  onGroupForksToggle,
  onBackendIconsToggle,
  onResetMode,
  onOptionsOpenChange,
}: SidebarViewControlsProps): React.JSX.Element {
  const sheet = useTouchDensity();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const handleOptionsOpenChange = (open: boolean) => {
    setOptionsOpen(open);
    onOptionsOpenChange?.(open);
  };
  const { groupBy, stackBy, show } = preferences;
  const mode = resolveModePreferences(preferences, groupBy);
  const defaults = SIDEBAR_MODE_DEFAULTS[groupBy];
  const flatMode =
    groupBy === "project"
      ? undefined
      : resolveModePreferences(preferences, groupBy);
  const flatDefaults =
    groupBy === "project" ? undefined : SIDEBAR_MODE_DEFAULTS[groupBy];
  const dirty =
    mode.sortBy !== defaults.sortBy ||
    mode.direction !== defaults.direction ||
    (flatMode !== undefined &&
      flatDefaults !== undefined &&
      (flatMode.density !== flatDefaults.density ||
        flatMode.peek !== flatDefaults.peek)) ||
    (flatMode !== undefined && flatMode.pinnedOnly) ||
    !show.snoozed ||
    !show.settled ||
    !show.drafts ||
    stackBy !== "none" ||
    !preferences.showBackendIcons;

  const targetGroupBy: SidebarGroupBy =
    groupBy === "project" ? preferences.lastAltGroupBy : "project";
  const currentView = viewOf(groupBy);
  const targetView = viewOf(targetGroupBy);
  const CurrentIcon = currentView.icon;
  const quickToggleLabel = `Switch to ${targetView.label}`;
  const forksLocked = groupBy !== "project";

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="view-controls-button view-controls-quick-toggle"
            data-testid="view-quick-toggle"
            aria-label={quickToggleLabel}
            aria-pressed={groupBy !== "project"}
            onClick={() => onGroupByChange(targetGroupBy)}
          >
            <CurrentIcon aria-hidden="true" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="lineage-tooltip" sideOffset={6}>
            {quickToggleLabel}
            <Tooltip.Arrow className="lineage-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      {/* Non-modal like the popover it replaced: the sidebar stays usable
          while the menu fades, and a click elsewhere keeps its focus. */}
      <DropdownMenu
        presentation={sheet ? "sheet" : "menu"}
        modal={false}
        open={optionsOpen}
        onOpenChange={handleOptionsOpenChange}
      >
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="view-controls-button"
                data-testid="view-options-trigger"
                aria-label="View options"
              >
                <SlidersHorizontal aria-hidden="true" />
                {dirty && (
                  <span
                    className="view-controls-dirty-dot"
                    data-testid="view-options-dirty-dot"
                    aria-hidden="true"
                  />
                )}
              </Button>
            </DropdownMenuTrigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="lineage-tooltip" sideOffset={6}>
              View options
              <Tooltip.Arrow className="lineage-tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <DropdownMenuContent
          aria-label="View options"
          sheetTitle="View options"
          align="end"
          // As a menu, the sidebar's width: long hints wrap instead of
          // spilling over the chat. The sheet keeps its own width.
          className={sheet ? undefined : "w-60"}
        >
          <DropdownMenuLabel>Group by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Group by"
            value={groupBy}
            onValueChange={(value) =>
              onGroupByChange(value as SidebarGroupBy)
            }
          >
            {GROUP_BY_VIEWS.map(({ value, label }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Stack</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Stack by"
            value={stackBy}
            onValueChange={(value) =>
              onStackByChange(value as SidebarStackBy)
            }
          >
            {STACK_BY_OPTIONS.map(({ value, label }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuRadioGroup aria-label="Sort by" value={mode.sortBy}>
            {SORT_OPTIONS.map(({ value, label }) => {
              const active = mode.sortBy === value;
              // The direction arrow is aria-hidden, so the active row's
              // accessible name carries the direction and the re-select
              // flip affordance for assistive technology.
              const directionWord =
                mode.direction === "desc" ? "descending" : "ascending";
              const Direction =
                mode.direction === "desc"
                  ? ArrowDownWideNarrow
                  : ArrowUpWideNarrow;
              return (
                <DropdownMenuRadioItem
                  key={value}
                  value={value}
                  aria-label={
                    active
                      ? `${label}, ${directionWord} — activate to reverse`
                      : undefined
                  }
                  data-direction={active ? mode.direction : undefined}
                  onSelect={keepOpen(() => onSortChange(value))}
                >
                  {label}
                  {active && (
                    <DropdownMenuShortcut aria-hidden="true">
                      <Direction className="size-3.5" />
                    </DropdownMenuShortcut>
                  )}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>

          {flatMode && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Density</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                aria-label="Density"
                value={flatMode.density}
                onValueChange={(value) =>
                  onDensityChange(value as SidebarDensity)
                }
              >
                <DropdownMenuRadioItem value="compact" onSelect={keepOpen()}>
                  Compact
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="card" onSelect={keepOpen()}>
                  Card
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuCheckboxItem
                checked={flatMode.peek}
                onCheckedChange={() => onPeekToggle()}
                onSelect={keepOpen()}
              >
                Peek details on hover
              </DropdownMenuCheckboxItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          {flatMode && (
            <DropdownMenuCheckboxItem
              checked={flatMode.pinnedOnly}
              onCheckedChange={() => onPinnedOnlyToggle()}
              onSelect={keepOpen()}
            >
              Pinned only
            </DropdownMenuCheckboxItem>
          )}
          {SHOW_FILTERS.map(({ key, label }) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={show[key]}
              onCheckedChange={() => onShowToggle(key)}
              onSelect={keepOpen()}
            >
              {label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuCheckboxItem checked={false} disabled>
            <span className="min-w-0 flex-1">
              Archived{" "}
              <DropdownMenuItemDescription>
                Needs archived threads on the snapshot wire
              </DropdownMenuItemDescription>
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={preferences.groupForks}
            disabled={forksLocked}
            onCheckedChange={() => onGroupForksToggle()}
            onSelect={keepOpen()}
          >
            {forksLocked ? (
              <span className="min-w-0 flex-1">
                Group fork families{" "}
                <DropdownMenuItemDescription>
                  Forks list flat outside Projects
                </DropdownMenuItemDescription>
              </span>
            ) : (
              "Group fork families"
            )}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={preferences.showBackendIcons}
            onCheckedChange={() => onBackendIconsToggle()}
            onSelect={keepOpen()}
          >
            Backend icons
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={keepOpen(() => onResetMode())}>
            Reset this view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Tooltip.Provider>
  );
}
