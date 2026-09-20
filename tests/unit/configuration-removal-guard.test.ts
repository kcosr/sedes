import { describe, expect, it, vi } from "vitest";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { commitWithConfigurationRemovalGuard, type ConfigurationRemovalGuard } from "../../src/server/configuration-admin/configuration-removal-guard.js";

function document(): ConfigurationDocument {
  return {
    executionEnvironments: [{ id: "environment-z", kind: "local", label: "Local", workspaceRoots: ["/tmp"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } },
      { id: "environment-a", kind: "ssh", label: "Remote", hostAlias: "remote", workspaceRoots: ["/tmp"], operations: { kind: "none" } }],
    backends: ["backend-z", "backend-a"].map(id => ({ id, kind: "pi", label: id, enabled: true, modelPolicy: { type: "catalog" } })),
    targets: [{ id: "target-z", kind: "pi_sdk", label: "Z", backendInstanceId: "backend-z", executionEnvironmentId: "environment-z", enabled: true },
      { id: "target-a", kind: "pi_sdk", label: "A", backendInstanceId: "backend-a", executionEnvironmentId: "environment-z", enabled: true },
      { id: "target-a-second", kind: "pi_sdk", label: "A second", backendInstanceId: "backend-a", executionEnvironmentId: "environment-z", enabled: true }],
    defaultTargetId: "target-z", webSearch: null,
  };
}
function guard(events: string[], fail?: string): ConfigurationRemovalGuard {
  const hold = async <T>(key: string, callback: () => Promise<T>): Promise<T> => {
    events.push(`enter:${key}`);
    if (key === fail) throw new Error("stop_not_proven");
    try { return await callback(); } finally { events.push(`release:${key}`); }
  };
  return { withBackendStopped: (id, callback) => hold(`backend:${id}`, callback), withEnvironmentStopped: (id, callback) => hold(`environment:${id}`, callback) };
}

describe("configuration removal guard", () => {
  it("holds deduplicated sorted backend fences then environment fences through async commit", async () => {
    const events: string[] = [];
    const previous = document();
    const next: ConfigurationDocument = { ...previous, executionEnvironments: [], backends: [], targets: [], defaultTargetId: null };
    const result = await commitWithConfigurationRemovalGuard({ previous, next, ...guard(events), commit: async () => { events.push("commit:start"); await Promise.resolve(); events.push("commit:end"); return 42; } });
    expect(result).toBe(42);
    expect(events).toEqual(["enter:backend:backend-a", "enter:backend:backend-z", "enter:environment:environment-a", "enter:environment:environment-z", "commit:start", "commit:end",
      "release:environment:environment-z", "release:environment:environment-a", "release:backend:backend-z", "release:backend:backend-a"]);
  });

  it("guards the owner of removed targets even when the backend remains", async () => {
    const previous = document();
    const next = { ...previous, targets: previous.targets.filter(target => target.backendInstanceId !== "backend-a") };
    const events: string[] = [];
    await commitWithConfigurationRemovalGuard({ previous, next, ...guard(events), commit: () => events.push("commit") });
    expect(events).toEqual(["enter:backend:backend-a", "commit", "release:backend:backend-a"]);
  });

  it("aborts before commit when any proof fails and releases earlier fences", async () => {
    const previous = document();
    const next: ConfigurationDocument = { ...previous, backends: [], targets: [], executionEnvironments: [], defaultTargetId: null };
    const events: string[] = [];
    const commit = vi.fn();
    await expect(commitWithConfigurationRemovalGuard({ previous, next, ...guard(events, "environment:environment-a"), commit })).rejects.toThrow("stop_not_proven");
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual(["enter:backend:backend-a", "enter:backend:backend-z", "enter:environment:environment-a", "release:backend:backend-z", "release:backend:backend-a"]);
  });

  it("does not guard disabling, policy or label edits, or adding definitions", async () => {
    const previous = document();
    const next = structuredClone(previous);
    for (const backend of next.backends) { backend.enabled = false; backend.label = "Changed"; backend.modelPolicy = { type: "denylist", denied: [{ modelIds: ["model-a"] }] }; }
    for (const target of next.targets) target.enabled = false;
    next.defaultTargetId = null;
    next.backends.push({ id: "new", kind: "pi", label: "New", enabled: false, modelPolicy: { type: "catalog" } });
    const events: string[] = [];
    await commitWithConfigurationRemovalGuard({ previous, next, ...guard(events), commit: () => events.push("commit") });
    expect(events).toEqual(["commit"]);
  });

  it("releases every held fence when the commit fails", async () => {
    const previous = document();
    const events: string[] = [];
    await expect(commitWithConfigurationRemovalGuard({ previous, next: { ...previous, targets: [] }, ...guard(events), commit: () => { throw new Error("database_failure"); } })).rejects.toThrow("database_failure");
    expect(events).toEqual(["enter:backend:backend-a", "enter:backend:backend-z", "release:backend:backend-z", "release:backend:backend-a"]);
  });
});
