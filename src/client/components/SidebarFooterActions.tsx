import { useRef, useState } from "react";
import { Archive, Bot, ChartColumnBig, ChevronUp, Settings } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import type { ApiClient } from "../api/ApiClient.js";
import type { ConnectionState } from "../api/EventStreamTransport.js";
import type { NormalizedInstallationAdvisory } from "../../shared/index.js";
import { AdvisoryCenter } from "./AdvisoryCenter.js";
import { ApplicationConnectionStatus } from "./SidebarNavTrigger.js";
import {
  SidebarUsageMenu,
  SidebarUsageSheet,
  SidebarUsageSheetItem,
  useUsageSheetLayout,
} from "./SidebarUsageMenu.js";

export interface SidebarFooterActionsProps {
  readonly onOpenSettings: (trigger: HTMLButtonElement) => void;
  readonly onOpenUsage: () => void;
  readonly onOpenAgents: () => void;
  readonly onOpenArchivedThreads: () => void;
  readonly connection?: ConnectionState;
  readonly api?: ApiClient;
  readonly providerPulseEnabled?: boolean;
  readonly advisories?: readonly NormalizedInstallationAdvisory[];
}

/** Compact navigation and settings controls for the bottom of the sidebar. */
export function SidebarFooterActions({
  onOpenSettings,
  onOpenUsage,
  onOpenAgents,
  onOpenArchivedThreads,
  connection,
  api,
  providerPulseEnabled = false,
  advisories = [],
}: SidebarFooterActionsProps): React.JSX.Element {
  const useSheet = useUsageSheetLayout();
  const [usageSheetOpen, setUsageSheetOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const usageApi = providerPulseEnabled ? api : undefined;
  return (
    <div className="sidebar-footer-actions">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="sidebar-footer-menu-trigger">
            More
            <ChevronUp aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="sidebar-footer-menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <DropdownMenuItem onSelect={onOpenUsage}>
            <ChartColumnBig aria-hidden="true" />
            Usage
          </DropdownMenuItem>
          {usageApi ? (
            useSheet ? (
              <SidebarUsageSheetItem onOpen={() => setUsageSheetOpen(true)} />
            ) : (
              <SidebarUsageMenu api={usageApi} />
            )
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenAgents}>
            <Bot aria-hidden="true" />
            Agents
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenArchivedThreads}>
            <Archive aria-hidden="true" />
            Archived threads
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {connection && (
        <ApplicationConnectionStatus
          connection={connection}
          className="sidebar-footer-connection-status"
        />
      )}

      <AdvisoryCenter
        advisories={advisories}
        fallbackFocusRef={settingsTriggerRef}
      />

      <Button
        ref={settingsTriggerRef}
        variant="ghost"
        size="icon"
        className="sidebar-footer-settings"
        data-testid="settings-trigger"
        aria-label="Settings"
        title="Settings"
        onClick={(event) => onOpenSettings(event.currentTarget)}
      >
        <Settings aria-hidden="true" />
      </Button>
      {usageApi ? (
        <SidebarUsageSheet
          api={usageApi}
          open={usageSheetOpen}
          onOpenChange={setUsageSheetOpen}
        />
      ) : null}
    </div>
  );
}
