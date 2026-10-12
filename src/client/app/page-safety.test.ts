import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  android: false,
  capabilities: vi.fn<() => Promise<{ safeFrames: boolean }>>(),
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => mocks }));
vi.mock("./client-platform.js", () => ({ isAndroidClient: () => mocks.android }));
import { supportsSafePageFrames } from "./page-safety.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); mocks.android = false; });

describe("page native isolation admission", () => {
  it("needs no native bridge on web and Electron", async () => {
    expect(await supportsSafePageFrames()).toBe(true);
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });
  it("requires a positive modern-bridge handshake on Android", async () => {
    mocks.android = true;
    mocks.capabilities.mockResolvedValue({ safeFrames: false });
    expect(await supportsSafePageFrames()).toBe(false);
    mocks.capabilities.mockResolvedValue({ safeFrames: true });
    expect(await supportsSafePageFrames()).toBe(true);
  });
  it("fails closed if a missing bridge never replies", async () => {
    vi.useFakeTimers();
    mocks.android = true;
    mocks.capabilities.mockReturnValue(new Promise(() => {}));
    const result = supportsSafePageFrames();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toBe(false);
  });
});
