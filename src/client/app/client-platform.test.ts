import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: false, name: "web" }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
}));

import {
  isAndroidClient,
  isElectronClient,
  isPackagedClient,
} from "./client-platform.js";

describe("client platform classification", () => {
  beforeEach(() => {
    platform.native = false;
    platform.name = "web";
  });

  it("classifies browser, Android, and Electron without conflating them", () => {
    expect(isPackagedClient()).toBe(false);
    expect(isAndroidClient()).toBe(false);
    expect(isElectronClient()).toBe(false);

    platform.native = true;
    platform.name = "android";
    expect(isAndroidClient()).toBe(true);
    expect(isElectronClient()).toBe(false);

    platform.name = "electron";
    expect(isAndroidClient()).toBe(false);
    expect(isElectronClient()).toBe(true);
  });
});
