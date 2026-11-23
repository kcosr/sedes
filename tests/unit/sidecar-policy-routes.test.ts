import { describe, expect, it, vi } from "vitest";
import { ExecutionPolicyRoutes } from "../../src/server/sidecar/execution-policy-routes.js";
import type { ExecutionPolicySnapshot } from "../../src/internal/sidecar-protocol/execution-policy.js";

describe("backend-scoped CLI endpoint lifetime", () => {
  it("fences a revoked route while its executable check is outstanding", async () => {
    const granted = {
      capabilities: [{ id: "agent_tools_cli", generation: 1 }],
      backends: [
        {
          id: "one",
          kind: "opencode",
          generation: 1,
          targets: [],
          launchDigest: "a".repeat(64),
        },
      ],
      roots: [],
    };
    let installed: ExecutionPolicySnapshot = granted;
    let finish!: (available: boolean) => void;
    const availability = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const start = vi.fn(async () => ({
      endpointUrl: "unix:///tmp/sedes.sock",
      available: async () => true,
      close: async () => {},
    }));
    const routes = new ExecutionPolicyRoutes({
      readPolicy: () => installed,
      start,
      executableAvailable: () => availability,
      endpointKey: "a".repeat(24),
      executableDirectory: "/opt/sedes",
      inheritedPath: "/bin",
    });
    routes.refresh(installed);
    installed = { ...granted, capabilities: [] };
    routes.refresh(installed);
    finish(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(start).not.toHaveBeenCalled();
    expect(() => routes.binding("one")).toThrow("unavailable");
    await routes.close();
  });
  it("prepares only granted routes, detects readiness loss, scopes retries and fences old endpoints across re-grant", async () => {
    vi.useFakeTimers();
    let available = true;
    const closes = vi.fn(async () => {});
    const start = vi.fn(async (key: string) => ({
      endpointUrl: "unix:///tmp/" + key + ".sock",
      close: closes,
      available: async () => available,
    }));
    const backend = (id: string) => ({
      id,
      kind: "opencode",
      generation: 1,
      launchDigest: "0".repeat(64),
      targets: [],
    });
    let snapshot: ExecutionPolicySnapshot = {
      backends: [backend("one")],
      roots: [],
      capabilities: [],
    };
    const manager = new ExecutionPolicyRoutes({
      readPolicy: () => snapshot,
      start,
      executableAvailable: async () => true,
      executableDirectory: "/opt/sedes",
      endpointKey: "a".repeat(24),
      inheritedPath: "/bin",
    });
    const grant = (generation: number) => {
      snapshot = {
        ...snapshot,
        capabilities: [{ id: "agent_tools_cli", generation }],
      };
      manager.refresh(snapshot);
    };
    try {
      manager.refresh(snapshot);
      expect(start).not.toHaveBeenCalled();
      grant(2);
      await vi.advanceTimersByTimeAsync(0);
      const descriptor = manager.descriptor({
        backendInstanceId: "one",
        generation: 2,
        capabilityId: "agent_tools_cli",
      });
      const original = manager.binding("one");
      snapshot = {
        ...snapshot,
        backends: [...snapshot.backends, backend("two")],
      };
      manager.refresh(snapshot);
      expect(manager.state("one")).toBe("ready");
      expect(manager.state("two")).toBe("preparing");
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.endpoint("two")).not.toBe(descriptor.endpoint);
      available = false;
      await manager.checkReadiness("one");
      expect(() => manager.binding("one")).toThrow("unavailable");
      expect(manager.state("two")).toBe("ready");
      available = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.endpoint("one")).not.toBe(descriptor.endpoint);
      snapshot = { ...snapshot, capabilities: [] };
      manager.refresh(snapshot);
      expect(() => manager.assertBinding(original)).toThrow("denied");
      grant(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(() => manager.assertBinding(original)).toThrow("denied");
      expect(() =>
        manager.descriptor({
          backendInstanceId: "two",
          generation: 2,
          capabilityId: "agent_tools_cli",
        }),
      ).toThrow("denied");
      expect(manager.state("one")).toBe("ready");
      expect(closes).toHaveBeenCalled();
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });
});
