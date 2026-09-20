import { useState } from "react";
import { Minus, MoreVertical, X } from "lucide-react";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { useMediaQuery } from "../app/use-media-query.js";
import type { EnvironmentTintStyle } from "../app/environment-palette.js";
import type { PanelPlacementEdge } from "./layout-tree.js";
import type { WorkspacePanelTenant } from "./registry.js";

/** Matches PanelLayout's narrow layout: exactly one pane is ever on stage. */
const SINGLE_PANE_QUERY = "(max-width: 819px)";

export interface PanelChromeStatus {
  readonly busy?: boolean;
  readonly dirty?: boolean;
  readonly subtitle?: string;
}

export interface PanelChromeControls {
  readonly active?: boolean;
  readonly onCollapse: () => void;
  readonly onClose: (invoker: HTMLElement) => void;
  readonly onDock: (edge: PanelPlacementEdge) => void;
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
            <span>{title}</span>
            {status?.subtitle && (
              <span className="workspace-panel-subtitle">
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
}): React.JSX.Element {
  // Docking places a surface relative to another one, which a single-pane
  // layout has none of. The menu then holds nothing at all unless a tenant
  // contributes items, so it stops being rendered rather than opening empty.
  const [menuOpen, setMenuOpen] = useState(false);
  const docking = !useMediaQuery(SINGLE_PANE_QUERY);
  const hasMenu = docking || Boolean(controls.renderMenuItems);
  return (
    <div className="workspace-panel-actions">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Collapse ${title} panel`}
        title={`Collapse ${title} panel`}
        onClick={controls.onCollapse}
      >
        <Minus size={16} />
      </Button>

      {hasMenu ? (
        <DropdownMenu open={controls.active !== false && menuOpen} onOpenChange={setMenuOpen}>
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
          <DropdownMenuContent
            className="workspace-panel-menu"
            align="end"
            sideOffset={6}
          >
            {docking ? (
              <>
                <DropdownMenuLabel>Dock</DropdownMenuLabel>
                {(["left", "right", "top", "bottom"] as const).map((edge) => (
                  <DropdownMenuItem
                    key={edge}
                    onSelect={() => controls.onDock(edge)}
                  >
                    Dock {edge}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            {controls.renderMenuItems && (
              <>
                {docking ? <DropdownMenuSeparator /> : null}
                {controls.renderMenuItems}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Close ${title} panel`}
        title={`Close ${title} panel`}
        onClick={(event) => controls.onClose(event.currentTarget)}
      >
        <X size={16} />
      </Button>
    </div>
  );
}

export function panelContentId(tenantId: string): string {
  return `workspace-panel-content-${safeId(tenantId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
