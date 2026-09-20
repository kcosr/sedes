import { describe, expect, it, vi } from "vitest";
const plugin = vi.hoisted(() => ({ getCredential: vi.fn(), setCredential: vi.fn(), removeCredential: vi.fn(), removeProfileCredentials: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => plugin }));
import { getCredential, setCredential, removeCredential, removeProfileCredentials } from "./client-credentials.js";
describe("native credential bridge", () => {
  it("normalizes origin while preserving stable profile identity", async () => {
    plugin.getCredential.mockResolvedValue({ credential: "device-token" });
    expect(await getCredential("remote-1", "https://EXAMPLE.com:443/")).toBe("device-token");
    expect(plugin.getCredential).toHaveBeenCalledWith({ profileId: "remote-1", serverUrl: "https://example.com" });
    await setCredential("remote-1", "https://example.com", "device-token");
    expect(plugin.setCredential).toHaveBeenCalledWith({ profileId: "remote-1", serverUrl: "https://example.com", credential: "device-token" });
    await removeCredential("remote-1", "https://example.com");
    await removeProfileCredentials("remote-1");
    expect(plugin.removeProfileCredentials).toHaveBeenCalledWith({ profileId: "remote-1" });
  });
  it("rejects path, embedded credentials and URL fragment", async () => {
    for (const origin of ["https://example.com/api", "https://user:pass@example.com", "https://example.com/#pair-token", "file:///tmp"]) {
      await expect(getCredential("remote-1", origin)).rejects.toThrow("Invalid credential server origin");
    }
  });
});
