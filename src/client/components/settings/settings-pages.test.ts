// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { settingsPageSlugs, type SettingsPage } from "../../app/settings-route.js";
import {
  availableSettingsPages,
  groupSettingsEntries,
  SETTINGS_AGENTS_LINK,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  type SettingsAvailability,
} from "./settings-pages.js";

const everything: SettingsAvailability = {
  prompts: true,
  notifications: true,
  execution: true,
  projects: true,
  toolClients: true,
  pairedClients: true,
  electronConnection: false,
  serverProfiles: false,
};

const none: SettingsAvailability = {
  prompts: false,
  notifications: false,
  execution: false,
  projects: false,
  toolClients: false,
  pairedClients: false,
  electronConnection: false,
  serverProfiles: false,
};

const ids = (availability: SettingsAvailability): SettingsPage[] =>
  availableSettingsPages(availability).map(({ id }) => id);

describe("settings page registry", () => {
  it("lists every routed settings page exactly once", () => {
    const registered = SETTINGS_PAGES.map(({ id }) => id);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(
      (Object.keys(settingsPageSlugs) as SettingsPage[]).sort(),
    );
  });

  it("gives every entry its own icon, a known group and a one-line description", () => {
    const entries = [...SETTINGS_PAGES, SETTINGS_AGENTS_LINK];
    expect(new Set(entries.map(({ icon }) => icon)).size).toBe(entries.length);
    const groups = SETTINGS_GROUPS.map(({ id }) => id);
    for (const entry of entries) {
      expect(groups).toContain(entry.group);
      expect(entry.description).toMatch(/^\S.*\.$/u);
      expect(entry.description).not.toContain("\n");
      expect(entry.description.length).toBeLessThanOrEqual(48);
    }
  });

  it("shows the device pages and Diagnostics on every client", () => {
    expect(ids(none)).toEqual([
      "general",
      "appearance",
      "mobile",
      "terminal",
      "diagnostics",
    ]);
  });

  it("adds each page only when the client holds its controls", () => {
    expect(ids(everything)).toEqual([
      "general",
      "appearance",
      "mobile",
      "terminal",
      "prompts",
      "notifications",
      "environments",
      "backends",
      "projects",
      "tool_clients",
      "paired_clients",
      "diagnostics",
    ]);
    expect(ids({ ...none, execution: true })).toContain("backends");
    expect(ids({ ...none, execution: true })).not.toContain("projects");
  });

  it("keeps Server to the packaged Android client and Connection to Electron", () => {
    expect(ids({ ...none, serverProfiles: true })).toContain("server");
    expect(ids({ ...none, serverProfiles: true })).not.toContain("connection");
    const electron = ids({ ...none, serverProfiles: true, electronConnection: true });
    expect(electron).toContain("connection");
    expect(electron).not.toContain("server");
  });

  it("groups pages in the fixed group order and drops empty groups", () => {
    const grouped = groupSettingsEntries(availableSettingsPages(none));
    expect(grouped.map(({ id }) => id)).toEqual([
      "preferences",
      "execution",
      "support",
    ]);
    // Execution always offers the Agents workbench page.
    expect(grouped[1]!.entries).toEqual([SETTINGS_AGENTS_LINK]);

    const full = groupSettingsEntries(availableSettingsPages(everything));
    expect(full.map(({ label }) => label)).toEqual([
      "Preferences",
      "Account",
      "Execution",
      "Access",
      "Support",
    ]);
    expect(full[2]!.entries.map(({ id }) => id)).toEqual([
      "environments",
      "backends",
      "projects",
      "agents",
    ]);
    expect(SETTINGS_AGENTS_LINK.href).toBe("/agents");
  });
});
