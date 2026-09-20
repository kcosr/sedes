// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applySidebarWidth,
  clampSidebarWidth,
  getSidebarWidth,
  installSidebarWidth,
  setSidebarWidth,
  sidebarWidthDefault,
  sidebarWidthMax,
  sidebarWidthMin,
} from "./sidebar-width";

describe("sidebar width compatibility", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--sidebar-width");
  });

  it("preserves the public limits, storage key, and default", () => {
    expect([sidebarWidthMin, sidebarWidthDefault, sidebarWidthMax]).toEqual([
      220, 260, 420,
    ]);
    expect(getSidebarWidth()).toBe(260);
    expect(clampSidebarWidth(219.6)).toBe(220);
    expect(setSidebarWidth(333.6)).toBe(334);
    expect(localStorage.getItem("sedes-sidebar-width")).toBe("334");
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      "334px",
    );
  });

  it("preserves uncommitted application and installation behavior", () => {
    applySidebarWidth(301.25);
    expect(localStorage.getItem("sedes-sidebar-width")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      "301.25px",
    );
    localStorage.setItem("sedes-sidebar-width", "410");
    installSidebarWidth();
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe(
      "410px",
    );
  });
});
