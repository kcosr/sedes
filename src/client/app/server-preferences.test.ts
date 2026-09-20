import { beforeEach, describe, expect, it, vi } from "vitest";
const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));
import { emptyPackagedConnections, loadPackagedConnections, savePackagedConnections } from "./server-preferences.js";
const profile = { id: "10000000-0000-4000-8000-000000000001", name: "Home", baseUrl: "https://sedes.example" };
const saved = { version: 1 as const, profiles: [profile], selectedProfileId: profile.id };
beforeEach(() => vi.resetAllMocks());
describe("packaged connections", () => {
  it("starts with no profiles and reads only its owned document", async () => {
    preferences.get.mockResolvedValue({ value: null });
    await expect(loadPackagedConnections()).resolves.toEqual(emptyPackagedConnections());
    expect(preferences.get).toHaveBeenCalledWith({ key: "sedes.connections.v1" });
  });
  it("round trips multiple connections with an explicit selection", async () => {
    const connections = { ...saved, profiles: [profile, { ...profile, id: "10000000-0000-4000-8000-000000000002", name: "Office", baseUrl: "https://office.example" }] };
    await expect(savePackagedConnections(connections)).resolves.toEqual(connections);
    preferences.get.mockResolvedValue({ value: preferences.set.mock.calls[0]![0].value });
    await expect(loadPackagedConnections()).resolves.toEqual(connections);
  });
  it("rejects corrupted documents, credentials, duplicate IDs and dangling selections", async () => {
    const invalid = [
      "not json", { ...saved, version: 2 }, { ...saved, token: "secret" },
      { ...saved, profiles: [{ ...profile, credential: "secret" }] },
      { ...saved, profiles: [profile, profile] },
      { ...saved, profiles: [] },
      { ...saved, profiles: [{ ...profile, baseUrl: "https://sedes.example/" }] },
      { ...saved, profiles: [{ ...profile, baseUrl: "https://user:pass@sedes.example" }] },
    ];
    for (const value of invalid) {
      preferences.get.mockResolvedValue({ value: typeof value === "string" ? value : JSON.stringify(value) });
      await expect(loadPackagedConnections()).rejects.toThrow();
    }
  });
  it("validates before overwriting a saved document", async () => {
    await expect(savePackagedConnections({ ...saved, profiles: [] })).rejects.toThrow();
    expect(preferences.set).not.toHaveBeenCalled();
  });
  it("propagates preference failures", async () => {
    preferences.set.mockRejectedValue(new Error("Storage unavailable"));
    await expect(savePackagedConnections(saved)).rejects.toThrow("Storage unavailable");
  });
});
