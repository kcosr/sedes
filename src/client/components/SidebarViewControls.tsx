import { useState } from "react";
import { Tooltip } from "radix-ui";
import {
  Activity,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Check,
  FolderTree,
  History,
  Layers3,
  Rows3,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@client/components/ui/popover";
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
 * `project` ⇄ `lastAltGroupBy`, and a view-options popover of menu rows.
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
  readonly icon: LucideIcon;
}> = [
  { value: "none", label: "Off", icon: Rows3 },
  { value: "group", label: "Thread groups", icon: Layers3 },
  { value: "project", label: "Projects", icon: FolderTree },
];

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

      <Popover open={optionsOpen} onOpenChange={handleOptionsOpenChange}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <PopoverTrigger asChild>
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
            </PopoverTrigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="lineage-tooltip" sideOffset={6}>
              View options
              <Tooltip.Arrow className="lineage-tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <PopoverContent
          className="view-controls-popover"
          aria-label="View options"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          <div
            className="view-controls-section"
            role="radiogroup"
            aria-label="Group by"
          >
            <div className="view-controls-section-label">Group by</div>
            {GROUP_BY_VIEWS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={groupBy === value}
                className="view-controls-row"
                onClick={() => {
                  onGroupByChange(value);
                  handleOptionsOpenChange(false);
                }}
              >
                <span className="view-controls-row-icon">
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="view-controls-row-label">{label}</span>
                {groupBy === value && (
                  <Check
                    size={14}
                    className="view-controls-row-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>

          <div
            className="view-controls-section"
            role="radiogroup"
            aria-label="Stack by"
          >
            <div className="view-controls-section-label">Stack</div>
            {STACK_BY_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={stackBy === value}
                className="view-controls-row"
                onClick={() => {
                  onStackByChange(value);
                  handleOptionsOpenChange(false);
                }}
              >
                <span className="view-controls-row-icon">
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="view-controls-row-label">{label}</span>
                {stackBy === value && (
                  <Check
                    size={14}
                    className="view-controls-row-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>

          <div
            className="view-controls-section"
            role="radiogroup"
            aria-label="Sort by"
          >
            <div className="view-controls-section-label">Sort</div>
            {SORT_OPTIONS.map(({ value, label }) => {
              const active = mode.sortBy === value;
              // The direction arrow is aria-hidden, so the active row's
              // accessible name must carry the direction and the re-select
              // flip affordance for assistive technology.
              const directionWord =
                mode.direction === "desc" ? "descending" : "ascending";
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={
                    active
                      ? `${label}, ${directionWord} — activate to reverse`
                      : undefined
                  }
                  className="view-controls-row"
                  data-direction={active ? mode.direction : undefined}
                  onClick={() => onSortChange(value)}
                >
                  <span className="view-controls-row-label">{label}</span>
                  {active &&
                    (mode.direction === "desc" ? (
                      <ArrowDownWideNarrow
                        size={14}
                        className="view-controls-row-check"
                        aria-hidden="true"
                      />
                    ) : (
                      <ArrowUpWideNarrow
                        size={14}
                        className="view-controls-row-check"
                        aria-hidden="true"
                      />
                    ))}
                </button>
              );
            })}
          </div>

          {flatMode && (
            <div className="view-controls-section">
              <div className="view-controls-section-label">Density</div>
              <div
                className="view-controls-segment"
                role="radiogroup"
                aria-label="Density"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={flatMode.density === "compact"}
                  className="view-controls-segment-option"
                  onClick={() => onDensityChange("compact")}
                >
                  Compact
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={flatMode.density === "card"}
                  className="view-controls-segment-option"
                  onClick={() => onDensityChange("card")}
                >
                  Card
                </button>
              </div>
              <button
                type="button"
                role="checkbox"
                aria-checked={flatMode.peek}
                className="view-controls-row"
                onClick={() => onPeekToggle()}
              >
                <span className="view-controls-row-label">
                  Peek details on hover
                </span>
                {flatMode.peek && (
                  <Check
                    size={14}
                    className="view-controls-row-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          )}

          <div className="view-controls-section">
            <div className="view-controls-section-label">Show</div>
            {flatMode && (
              <button
                type="button"
                role="checkbox"
                aria-checked={flatMode.pinnedOnly}
                className="view-controls-row"
                onClick={onPinnedOnlyToggle}
              >
                <span className="view-controls-row-label">Pinned only</span>
                {flatMode.pinnedOnly && (
                  <Check
                    size={14}
                    className="view-controls-row-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            )}
            <button
              type="button"
              role="checkbox"
              aria-checked={show.snoozed}
              className="view-controls-row"
              onClick={() => onShowToggle("snoozed")}
            >
              <span className="view-controls-row-label">Snoozed</span>
              {show.snoozed && (
                <Check
                  size={14}
                  className="view-controls-row-check"
                  aria-hidden="true"
                />
              )}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={show.settled}
              className="view-controls-row"
              onClick={() => onShowToggle("settled")}
            >
              <span className="view-controls-row-label">Settled</span>
              {show.settled && (
                <Check
                  size={14}
                  className="view-controls-row-check"
                  aria-hidden="true"
                />
              )}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={show.drafts}
              className="view-controls-row"
              onClick={() => onShowToggle("drafts")}
            >
              <span className="view-controls-row-label">Drafts</span>
              {show.drafts && (
                <Check
                  size={14}
                  className="view-controls-row-check"
                  aria-hidden="true"
                />
              )}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={false}
              className="view-controls-row"
              disabled
            >
              <span className="view-controls-row-label">
                Archived
                <span className="view-controls-hint">
                  Needs archived threads on the snapshot wire
                </span>
              </span>
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={preferences.groupForks}
              className="view-controls-row"
              disabled={forksLocked}
              onClick={() => onGroupForksToggle()}
            >
              <span className="view-controls-row-label">
                Group fork families
                {forksLocked && (
                  <span className="view-controls-hint">
                    Forks list flat outside Projects
                  </span>
                )}
              </span>
              {preferences.groupForks && (
                <Check
                  size={14}
                  className="view-controls-row-check"
                  aria-hidden="true"
                />
              )}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={preferences.showBackendIcons}
              className="view-controls-row"
              onClick={() => onBackendIconsToggle()}
            >
              <span className="view-controls-row-label">Backend icons</span>
              {preferences.showBackendIcons && (
                <Check
                  size={14}
                  className="view-controls-row-check"
                  aria-hidden="true"
                />
              )}
            </button>
          </div>

          <div className="view-controls-section">
            <button
              type="button"
              className="view-controls-row view-controls-reset"
              onClick={() => onResetMode()}
            >
              <span className="view-controls-row-label">Reset this view</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </Tooltip.Provider>
  );
}
