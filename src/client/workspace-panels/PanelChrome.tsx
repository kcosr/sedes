import { useState } from "react";
import { Maximize2, Minimize2, MoreVertical, X } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { useMediaQuery } from "../app/use-media-query.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import type { EnvironmentTintStyle } from "../app/environment-palette.js";
import { REGION_IDS, isEdgeRegion, regionAxis, type RegionId } from "./regions.js";
import { REGION_TITLES } from "./panel-kinds.js";
import type { WorkspacePanelTenant } from "./registry.js";

/** Matches PanelLayout's narrow layout: exactly one pane is ever on stage. */
const SINGLE_PANE_QUERY = "(max-width: 819px)";

export interface PanelChromeStatus {
  readonly busy?: boolean;
  readonly dirty?: boolean;
  readonly subtitle?: string;
}

/**
 * Where the panel sits on the desktop stage, and the header's controls for
 * it: Maximize or Restore, ⋯ → Move to, and for an edge region the Full
 * height or Full width toggle. Phones have no regions, so the header leaves
 * these out there.
 */
export interface PanelRegionControls {
  readonly region: RegionId;
  readonly maximized: boolean;
  /** Edge regions only: whether the region takes its shared corners. */
  readonly extended?: boolean;
  readonly onMaximize: () => void;
  readonly onRestore: () => void;
  readonly onMove: (region: RegionId) => void;
  readonly onExtend: (on: boolean) => void;
}

export interface PanelChromeControls {
  readonly active?: boolean;
  /**
   * ✕: closes (unloads) the panel; with `closeAction: "hide"` it hides it.
   * Without it there is no ✕, as for Chat on phones, which is their home.
   */
  readonly onClose?: (invoker: HTMLElement) => void;
  /** Chat's ✕ hides it and keeps it loaded; every other panel's closes. */
  readonly closeAction?: "close" | "hide";
  readonly region?: PanelRegionControls;
  /** The tenant's own ⋯ items, after Move to. */
  readonly renderMenuItems?: React.ReactNode;
}

export interface PanelChromeProps {
  readonly tenant?: Pick<WorkspacePanelTenant, "id" | "title" | "icon">;
  readonly panelTitle?: string;
  readonly leading?: React.ReactNode;
  readonly panelActions?: React.ReactNode;
  readonly status?: PanelChromeStatus;
  readonly controls?: PanelChromeControls;
  readonly className?: string;
  readonly environmentTintStyle?: EnvironmentTintStyle;
}

/** One shared chrome row for every top-level panel surface. */
export function PanelChrome({
  tenant,
  panelTitle,
  leading,
  panelActions,
  status,
  controls,
  className,
  environmentTintStyle,
}: PanelChromeProps): React.JSX.Element {
  const Icon = tenant?.icon;
  const title = panelTitle ?? tenant?.title ?? "Panel";

  return (
    <header
      className={`workspace-panel-chrome${className ? ` ${className}` : ""}`}
      aria-label={`${title} panel header`}
      data-environment-tint={environmentTintStyle ? "true" : undefined}
      style={environmentTintStyle}
    >
      <div className="workspace-panel-heading">
        {leading ?? (
          <div className="workspace-panel-title">
            {Icon && <Icon size={16} />}
            <span className="workspace-panel-name">{title}</span>
            {status?.subtitle && (
              <span className="workspace-panel-subtitle" title={status.subtitle}>
                {status.subtitle}
              </span>
            )}
            {status?.dirty && (
              <span
                className="workspace-panel-dirty"
                aria-label="Unsaved changes"
              />
            )}
            {status?.busy && (
              <span
                className="comet-spinner workspace-panel-spinner"
                aria-label="Busy"
              />
            )}
          </div>
        )}
      </div>

      {panelActions && (
        <div className="workspace-panel-specific-actions">
          {panelActions}
        </div>
      )}

      {controls && <PanelChromeActions title={title} controls={controls} />}
    </header>
  );
}

function PanelChromeActions({
  title,
  controls,
}: {
  readonly title: string;
  readonly controls: PanelChromeControls;
}): React.JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false);
  // Regions place a surface beside others, which a single-pane layout has
  // none of. The menu then holds nothing at all unless a tenant contributes
  // items, so it stops being rendered rather than opening empty.
  const singlePane = useMediaQuery(SINGLE_PANE_QUERY);
  const region = singlePane ? undefined : controls.region;
  const hasMenu = region !== undefined || Boolean(controls.renderMenuItems);
  // A tenant's own items (with Move to, or nested choices of their own) are
  // a sheet under touch density; Move to alone stays a menu.
  const sheet = useTouchDensity() && Boolean(controls.renderMenuItems);
  const closeVerb = controls.closeAction === "hide" ? "Hide" : "Close";
  const onClose = controls.onClose;
  if (!region && !hasMenu && !onClose) return null;
  return (
    <div className="workspace-panel-actions">
      {region ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${region.maximized ? "Restore" : "Maximize"} ${title} panel`}
          title={`${region.maximized ? "Restore" : "Maximize"} ${title} panel`}
          data-maximized={region.maximized || undefined}
          onClick={region.maximized ? region.onRestore : region.onMaximize}
        >
          {region.maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
      ) : null}

      {hasMenu ? (
        <DropdownMenu
          presentation={sheet ? "sheet" : "menu"}
          open={controls.active !== false && menuOpen}
          onOpenChange={setMenuOpen}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${title} panel actions`}
              title={`${title} panel actions`}
            >
              <MoreVertical size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sheetTitle={`${title} panel`}>
            {region ? <PanelRegionMenuItems region={region} /> : null}
            {controls.renderMenuItems && (
              <>
                {region ? <DropdownMenuSeparator /> : null}
                {controls.renderMenuItems}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {onClose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${closeVerb} ${title} panel`}
          title={`${closeVerb} ${title} panel`}
          onClick={(event) => onClose(event.currentTarget)}
        >
          <X size={16} />
        </Button>
      ) : null}
    </div>
  );
}

/** ⋯ → Move to (the current region checked), and Full height or width. */
function PanelRegionMenuItems({
  region,
}: {
  readonly region: PanelRegionControls;
}): React.JSX.Element {
  const edge = isEdgeRegion(region.region) ? region.region : undefined;
  return (
    <>
      <DropdownMenuLabel>Move to</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Move to"
        value={region.region}
        onValueChange={(value) => {
          // Choosing the current region changes nothing.
          const target = REGION_IDS.find((candidate) => candidate === value);
          if (target && target !== region.region) region.onMove(target);
        }}
      >
        {REGION_IDS.map((candidate) => (
          <DropdownMenuRadioItem key={candidate} value={candidate}>
            {REGION_TITLES[candidate]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {edge ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={region.extended === true}
            onCheckedChange={(checked) => region.onExtend(checked === true)}
          >
            {regionAxis(edge) === "width" ? "Full height" : "Full width"}
          </DropdownMenuCheckboxItem>
        </>
      ) : null}
    </>
  );
}

export function panelContentId(tenantId: string): string {
  return `workspace-panel-content-${safeId(tenantId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
