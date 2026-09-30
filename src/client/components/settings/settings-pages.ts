import {
  Activity,
  Bell,
  Bot,
  Boxes,
  Cable,
  Folder,
  KeyRound,
  MessageSquareText,
  MonitorSmartphone,
  Network,
  Server,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  SunMoon,
  type LucideIcon,
} from "lucide-react";
import { agentsPath } from "../../app/router.js";
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
  readonly execution: boolean;
  readonly projects: boolean;
  readonly toolClients: boolean;
  readonly pairedClients: boolean;
  /** The Electron desktop app's connection profiles. */
  readonly electronConnection: boolean;
  /** The packaged Android client's server profiles. */
  readonly serverProfiles: boolean;
}

interface SettingsEntryBase {
  readonly label: string;
  /** One line, shown in the compact list. */
  readonly description: string;
  readonly icon: LucideIcon;
  readonly group: SettingsGroupId;
}

export interface SettingsPageEntry extends SettingsEntryBase {
  readonly kind: "page";
  readonly id: SettingsPage;
  readonly available: (availability: SettingsAvailability) => boolean;
}

/** A related Workbench page listed beside the settings pages. */
export interface SettingsLinkEntry extends SettingsEntryBase {
  readonly kind: "link";
  readonly id: string;
  readonly href: string;
}

export type SettingsEntry = SettingsPageEntry | SettingsLinkEntry;

const always = (): boolean => true;

/** Every settings page, in nav order within its group. */
export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  {
    kind: "page",
    id: "general",
    label: "General",
    description: "Sidebar, panels, history and the composer.",
    icon: SlidersHorizontal,
    group: "preferences",
    available: always,
  },
  {
    kind: "page",
    id: "appearance",
    label: "Appearance",
    description: "Theme, environment colors and motion.",
    icon: SunMoon,
    group: "preferences",
    available: always,
  },
  {
    kind: "page",
    id: "mobile",
    label: "Mobile",
    description: "Composer focus and history on phones.",
    icon: Smartphone,
    group: "preferences",
    available: always,
  },
  {
    kind: "page",
    id: "terminal",
    label: "Terminal",
    description: "Cursor, text size and scrollback.",
    icon: SquareTerminal,
    group: "preferences",
    available: always,
  },
  {
    kind: "page",
    id: "prompts",
    label: "Prompts",
    description: "Reusable prompts for the composer.",
    icon: MessageSquareText,
    group: "account",
    available: ({ prompts }) => prompts,
  },
  {
    kind: "page",
    id: "notifications",
    label: "Notifications",
    description: "Alerts when agents finish or need you.",
    icon: Bell,
    group: "account",
    available: ({ notifications }) => notifications,
  },
  {
    kind: "page",
    id: "environments",
    label: "Environments",
    description: "Where agents run and what they can reach.",
    icon: Network,
    group: "execution",
    available: ({ execution }) => execution,
  },
  {
    kind: "page",
    id: "backends",
    label: "Backends",
    description: "Model providers in each environment.",
    icon: Boxes,
    group: "execution",
    available: ({ execution }) => execution,
  },
  {
    kind: "page",
    id: "projects",
    label: "Projects",
    description: "Remembered project directories.",
    icon: Folder,
    group: "execution",
    available: ({ projects }) => projects,
  },
  {
    kind: "page",
    id: "tool_clients",
    label: "Tool clients",
    description: "Credentials for external CLI clients.",
    icon: KeyRound,
    group: "access",
    available: ({ toolClients }) => toolClients,
  },
  {
    kind: "page",
    id: "paired_clients",
    label: "Paired clients",
    description: "Devices paired with this server.",
    icon: MonitorSmartphone,
    group: "access",
    available: ({ pairedClients }) => pairedClients,
  },
  {
    kind: "page",
    id: "connection",
    label: "Connection",
    description: "The server this app connects to.",
    icon: Cable,
    group: "access",
    available: ({ electronConnection }) => electronConnection,
  },
  {
    kind: "page",
    id: "server",
    label: "Server",
    description: "Sedes servers this device can connect to.",
    icon: Server,
    group: "access",
    available: ({ serverProfiles, electronConnection }) =>
      serverProfiles && !electronConnection,
  },
  {
    kind: "page",
    id: "diagnostics",
    label: "Diagnostics",
    description: "Traces for bug reports, and the version.",
    icon: Activity,
    group: "support",
    available: always,
  },
];

/** Agents are a Workbench page; Execution links to them. */
export const SETTINGS_AGENTS_LINK: SettingsLinkEntry = {
  kind: "link",
  id: "agents",
  label: "Agents",
  description: "Saved presets for new threads.",
  icon: Bot,
  group: "execution",
  href: agentsPath(),
};

export function availableSettingsPages(
  availability: SettingsAvailability,
): SettingsPageEntry[] {
  return SETTINGS_PAGES.filter((entry) => entry.available(availability));
}

export interface SettingsNavGroup {
  readonly id: SettingsGroupId;
  readonly label: string;
  readonly entries: readonly SettingsEntry[];
}

/** Available pages (and the Agents link) by group, skipping empty groups. */
export function groupSettingsEntries(
  pages: readonly SettingsPageEntry[],
): SettingsNavGroup[] {
  const entries: SettingsEntry[] = [...pages, SETTINGS_AGENTS_LINK];
  return SETTINGS_GROUPS.flatMap(({ id, label }) => {
    const members = entries.filter((entry) => entry.group === id);
    return members.length > 0 ? [{ id, label, entries: members }] : [];
  });
}
