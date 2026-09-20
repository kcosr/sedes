import { describe, expect, it } from "vitest";
import {
  electronBuilderUnpackedDirectory,
} from "../../scripts/electron-package-layout.mjs";

describe("Electron package layout", () => {
  it.each([
    ["darwin", "x64", "mac"],
    ["darwin", "arm64", "mac-arm64"],
    ["linux", "x64", "linux-unpacked"],
    ["linux", "arm64", "linux-arm64-unpacked"],
    ["win32", "x64", "win-unpacked"],
    ["win32", "arm64", "win-arm64-unpacked"],
  ])("maps %s %s to %s", (platform, architecture, expected) => {
    expect(electronBuilderUnpackedDirectory(platform, architecture)).toBe(
      expected,
    );
  });

  it("rejects unsupported or incomplete platform information", () => {
    expect(() => electronBuilderUnpackedDirectory("freebsd", "x64")).toThrow(
      "electron_package_platform_unsupported:freebsd",
    );
    expect(() => electronBuilderUnpackedDirectory("darwin", "")).toThrow(
      "electron_package_architecture_invalid",
    );
  });
});
