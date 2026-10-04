import {
  Activity,
  Bell,
  Bot,
  Boxes,
  Cable,
  Folder,
  KeyRound,
  MessageSquareText,
  Mic,
  MonitorSmartphone,
  Network,
  Server,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  SunMoon,
  type LucideIcon,
} from "lucide-react";
import type { SettingsPage } from "../../app/settings-route.js";

/** The settings nav and the compact list group pages in this order. */
export const SETTINGS_GROUPS = [
  { id: "preferences", label: "Preferences" },
  { id: "account", label: "Account" },
  { id: "execution", label: "Execution" },
  { id: "access", label: "Access" },
  { id: "support", label: "Support" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * What this client can show. Each flag is true when the client holds the
 * controls a page needs; the registry turns them into page availability.
 */
export interface SettingsAvailability {
  readonly prompts: boolean;
  readonly notifications: boolean;
  readonly voice: boolean;
  readonly execution: boolean;
  readonly projects: boolean;
  /** Saved Agents: the client can reach the principal's Agent presets. */
  readonly agents: boolean;
  readonly toolClients: boolean;
  readonly pairedClients: boolean;
  /** The Electron desktop app's connection profiles. */
  readonly electronConnection: boolean;
  /** The packaged Android client's server profiles. */
  readonly serverProfiles: boolean;
}

export interface SettingsPageEntry {
  readonly id: SettingsPage;
  readonly label: string;
  /** One line, shown in the compact list. */
  readonly description: string;
  readonly icon: LucideIcon;
  readonly group: SettingsGroupId;
  readonly available: (availability: SettingsAvailability) => boolean;
}

const always = (): boolean => true;

/** Every settings page, in nav order within its group. */
export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  {
    id: "general",
    label: "General",
    description: "Sidebar, panels, history and the composer.",
    icon: SlidersHorizontal,
    group: "preferences",
    available: always,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, environment colors and motion.",
    icon: SunMoon,
    group: "preferences",
    available: always,
  },
  {
    id: "mobile",
    label: "Mobile",
    description: "Composer focus and history on phones.",
    icon: Smartphone,
    group: "preferences",
    available: always,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Cursor, text size and scrollback.",
    icon: SquareTerminal,
    group: "preferences",
    available: always,
  },
  { id: "voice", label: "Voice", description: "Android speech, microphone and follow-up.", icon: Mic,
    group: "preferences", available: ({ voice }) => voice },
  {
    id: "prompts",
    label: "Prompts",
    description: "Reusable prompts for the composer.",
    icon: MessageSquareText,
    group: "account",
    available: ({ prompts }) => prompts,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Alerts when agents finish or need you.",
    icon: Bell,
    group: "account",
    available: ({ notifications }) => notifications,
  },
  {
    id: "environments",
    label: "Environments",
    description: "Where agents run and what they can reach.",
    icon: Network,
    group: "execution",
    available: ({ execution }) => execution,
  },
  {
    id: "backends",
    label: "Backends",
    description: "Model providers in each environment.",
    icon: Boxes,
    group: "execution",
    available: ({ execution }) => execution,
  },
  {
    id: "projects",
    label: "Projects",
    description: "Remembered project directories.",
    icon: Folder,
    group: "execution",
    available: ({ projects }) => projects,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Saved presets for new threads.",
    icon: Bot,
    group: "execution",
    available: ({ agents }) => agents,
  },
  {
    id: "tool_clients",
    label: "Tool clients",
    description: "Credentials for external CLI clients.",
    icon: KeyRound,
    group: "access",
    available: ({ toolClients }) => toolClients,
  },
  {
    id: "paired_clients",
    label: "Paired clients",
    description: "Devices paired with this server.",
    icon: MonitorSmartphone,
    group: "access",
    available: ({ pairedClients }) => pairedClients,
  },
  {
    id: "connection",
    label: "Connection",
    description: "The server this app connects to.",
    icon: Cable,
    group: "access",
    available: ({ electronConnection }) => electronConnection,
  },
  {
    id: "server",
    label: "Server",
    description: "Sedes servers this device can connect to.",
    icon: Server,
    group: "access",
    available: ({ serverProfiles, electronConnection }) =>
      serverProfiles && !electronConnection,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Traces for bug reports, and the version.",
    icon: Activity,
    group: "support",
    available: always,
  },
];

export function availableSettingsPages(
  availability: SettingsAvailability,
): SettingsPageEntry[] {
  return SETTINGS_PAGES.filter((entry) => entry.available(availability));
}

export interface SettingsNavGroup {
  readonly id: SettingsGroupId;
  readonly label: string;
  readonly entries: readonly SettingsPageEntry[];
}

/** Available pages by group, skipping empty groups. */
export function groupSettingsEntries(
  pages: readonly SettingsPageEntry[],
): SettingsNavGroup[] {
  return SETTINGS_GROUPS.flatMap(({ id, label }) => {
    const members = pages.filter((entry) => entry.group === id);
    return members.length > 0 ? [{ id, label, entries: members }] : [];
  });
}
