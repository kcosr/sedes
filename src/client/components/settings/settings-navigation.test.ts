// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installSettingsPageReselectListener,
  readLastSettingsPage,
  rememberSettingsPage,
  requestSettingsPageReselect,
  settingsLandingRedirect,
  settingsNavInSidebar,
} from "./settings-navigation.js";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("settings nav visibility", () => {
  it("is in the sidebar only at the desktop breakpoint with the sidebar expanded", () => {
    expect(settingsNavInSidebar({ mobileLayout: false, sidebarCollapsed: false })).toBe(true);
    expect(settingsNavInSidebar({ mobileLayout: false, sidebarCollapsed: true })).toBe(false);
    expect(settingsNavInSidebar({ mobileLayout: true, sidebarCollapsed: false })).toBe(false);
    expect(settingsNavInSidebar({ mobileLayout: true, sidebarCollapsed: true })).toBe(false);
  });
});

describe("the /settings landing", () => {
  const available = ["general", "appearance", "notifications", "diagnostics"] as const;

  it("is the grouped list when the nav is not in the sidebar", () => {
    expect(settingsLandingRedirect({ navInSidebar: false, lastPage: "appearance", available })).toBeUndefined();
  });

  it("opens the last page shown when the sidebar nav is visible", () => {
    expect(settingsLandingRedirect({ navInSidebar: true, lastPage: "notifications", available })).toBe("notifications");
  });

  it("opens General when there is no usable last page", () => {
    expect(settingsLandingRedirect({ navInSidebar: true, lastPage: undefined, available })).toBe("general");
    // A page this client no longer offers never becomes the landing.
    expect(settingsLandingRedirect({ navInSidebar: true, lastPage: "server", available })).toBe("general");
  });
});

describe("last settings page persistence", () => {
  it("remembers the last page for this tab", () => {
    expect(readLastSettingsPage()).toBeUndefined();
    rememberSettingsPage("terminal");
    expect(readLastSettingsPage()).toBe("terminal");
    rememberSettingsPage("tool_clients");
    expect(readLastSettingsPage()).toBe("tool_clients");
    expect(localStorage.length).toBe(0);
  });

  it("ignores values that are not settings pages", () => {
    sessionStorage.setItem("sedes-settings-last-page", "constructor");
    expect(readLastSettingsPage()).toBeUndefined();
    sessionStorage.setItem("sedes-settings-last-page", "tool-clients");
    expect(readLastSettingsPage()).toBeUndefined();
  });

  it("survives unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => rememberSettingsPage("general")).not.toThrow();
    expect(readLastSettingsPage()).toBeUndefined();
  });
});

describe("reselecting the current page", () => {
  it("reaches listeners until they are removed", () => {
    const onReselect = vi.fn();
    const remove = installSettingsPageReselectListener(window, onReselect);
    requestSettingsPageReselect("environments");
    expect(onReselect).toHaveBeenCalledWith("environments");
    remove();
    requestSettingsPageReselect("general");
    expect(onReselect).toHaveBeenCalledOnce();
  });
});
