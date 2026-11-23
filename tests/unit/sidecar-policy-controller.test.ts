import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionPolicyStatus,
  InstalledExecutionPolicy,
} from "../../src/internal/sidecar-protocol/execution-policy.js";
import type { SidecarServiceStatus } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SidecarPolicyController } from "../../src/server/sidecar/sidecar-policy-controller.js";

const service = {
  serviceIncarnation: "daemon",
  controllerEpoch: 4,
} as SidecarServiceStatus;
const configuration = { environmentRevision: 1, operationsRevision: 1 };

function policy(revision: number, grant = revision): InstalledExecutionPolicy {
  return {
    revision,
    digest: String(revision).padStart(64, "0"),
    configuration,
    snapshot: {
      roots: [{ id: "home", path: "/home/user", generation: 1 }],
      capabilities: [{ id: "agent_tools_cli", generation: grant }],
      backends: [
        {
          id: "backend",
          kind: "pi_native",
          generation: 1,
          launchDigest: "1".repeat(64),
          targets: [{ id: "target", generation: 1 }],
        },
      ],
    },
  };
}

function status(desired?: InstalledExecutionPolicy): ExecutionPolicyStatus {
  const feature = desired?.snapshot.capabilities[0];
  return {
    incarnation: service.serviceIncarnation,
    controllerEpoch: service.controllerEpoch,
    configuration,
    installed: desired
      ? { revision: desired.revision, digest: desired.digest }
      : null,
    readiness: !desired
      ? []
      : [
          { id: "root:home", generation: 1, state: "ready" },
          { id: "backend:backend", generation: 1, state: "ready" },
          ...(feature
            ? [
                {
                  id: "capability:agent_tools_cli",
                  generation: feature.generation,
                  state: "ready" as const,
                },
                {
                  id: "route:backend",
                  generation: feature.generation,
                  state: "ready" as const,
                },
              ]
            : []),
        ],
  };
}

afterEach(() => vi.useRealTimers());

describe("persistent sidecar policy synchronization", () => {
  it("limits disconnected evidence to acquisition of unchanged grants on a known incarnation", async () => {
    let desired = policy(3);
    const peer = {readPolicy: async () => status(desired), applyPolicy: async (next: InstalledExecutionPolicy) => status(next)};
    const controller = new SidecarPolicyController(() => desired, vi.fn());
    controller.attach(peer, service);
    await controller.synchronize();
    controller.detach(true);
    expect(controller.status).toBeUndefined();
    expect(controller.targetGeneration("backend", "target")).toBeUndefined();
    expect(controller.targetGeneration("backend", "target", true)).toBe(1);
    expect(controller.workspaceRoots(true)).toEqual(desired.snapshot.roots);
    expect(controller.routeGeneration("backend")).toBeUndefined();
    desired = policy(2);
    expect(controller.targetGeneration("backend", "target", true)).toBeUndefined();
    desired = policy(4);
    expect(controller.capabilityGeneration("agent_tools_cli", true)).toBeUndefined();
    controller.attach(peer, {...service, serviceIncarnation: "different"});
    expect(controller.targetGeneration("backend", "target", true)).toBeUndefined();
    controller.detach();
  });

  it("confirms a fresh epoch, keeps surviving subjects usable while applying, and fences a withdrawn route immediately", async () => {
    let desired = policy(1);
    let host = status(desired);
    let releaseUpdate!: () => void;
    const barrier = new Promise<void>((ok) => {
      releaseUpdate = ok;
    });
    const peer = {
      readPolicy: vi.fn(async () => host),
      applyPolicy: vi.fn(async (next: InstalledExecutionPolicy) => {
        if (next.revision === 2) await barrier;
        return (host = status(next));
      }),
    };
    const changed = vi.fn();
    const controller = new SidecarPolicyController(() => desired, changed);
    controller.attach(peer, service);
    expect(controller.routeGeneration("backend")).toBeUndefined();
    await controller.synchronize();
    expect(peer.applyPolicy).toHaveBeenCalledTimes(1);
    const route = controller.leaseRoute(1, "backend");
    desired = policy(2);
    const updating = controller.synchronize();
    await route.closed;
    expect(controller.routeGeneration("backend")).toBeUndefined();
    expect(controller.targetGeneration("backend", "target")).toBe(1);
    expect(controller.workspaceRoots()).toEqual(desired.snapshot.roots);
    releaseUpdate();
    await updating;
    expect(controller.routeGeneration("backend")).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    controller.detach();
    expect(controller.workspaceRoots()).toEqual([]);
  });

  it("reads after a lost apply reply and converges to the latest saved policy without repeating work", async () => {
    vi.useFakeTimers();
    let desired = policy(1);
    let host = status();
    const applyPolicy = vi.fn(async (next: InstalledExecutionPolicy) => {
      host = status(next);
      if (next.revision === 1) throw Error("reply lost");
      return host;
    });
    const controller = new SidecarPolicyController(() => desired, vi.fn());
    controller.attach({ readPolicy: async () => host, applyPolicy }, service);
    await expect(controller.synchronize()).rejects.toThrow("reply lost");
    expect(controller.capabilityGeneration("agent_tools_cli")).toBeUndefined();
    desired = policy(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.routeGeneration("backend")).toBe(3);
    expect(applyPolicy.mock.calls.map(([next]) => next.revision)).toEqual([
      1, 3,
    ]);
    controller.detach();
  });

  it("reports divergence once and preserves the daemon for explicit recovery", async () => {
    const desired = policy(4);
    const changed = vi.fn();
    const applyPolicy = vi.fn(async () => status(desired));
    const controller = new SidecarPolicyController(() => desired, changed);
    controller.attach(
      { readPolicy: async () => status(policy(7)), applyPolicy },
      service,
    );
    await controller.synchronize();
    await controller.synchronize(true);
    expect(controller.conflict).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(applyPolicy).not.toHaveBeenCalled();
    expect(controller.backendGeneration("backend")).toBeUndefined();
    controller.detach();
  });

  it("carries a verified restore fence across subsequent saves, attachment changes and main restart", async () => {
    let desired = policy(4);
    let observed = status(policy(7));
    const fenced = new Set<string>();
    const recovery = {
      blocked: (id: string) => fenced.has(id),
      requireRecovery: vi.fn((id: string) => {
        fenced.add(id);
      }),
    };
    const peer = {
      readPolicy: async () => observed,
      applyPolicy: vi.fn(async (next: InstalledExecutionPolicy) => ({
        ...status(next),
        incarnation: observed.incarnation,
      })),
    };
    const first = new SidecarPolicyController(() => desired, vi.fn(), recovery);
    first.attach(peer, service);
    await first.synchronize();
    expect(recovery.requireRecovery).toHaveBeenCalledOnce();
    first.detach();
    desired = policy(8);
    const restarted = new SidecarPolicyController(
      () => desired,
      vi.fn(),
      recovery,
    );
    restarted.attach(peer, service);
    await restarted.synchronize();
    expect(restarted.conflict).toBe(true);
    expect(peer.applyPolicy).not.toHaveBeenCalled();
    observed = { ...status(), incarnation: "new-service" };
    restarted.attach(peer, {
      ...service,
      serviceIncarnation: observed.incarnation,
    });
    await restarted.synchronize();
    expect(restarted.conflict).toBe(false);
    expect(peer.applyPolicy).toHaveBeenCalledOnce();
    restarted.detach();
  });

  it("polls preparing subjects at two seconds and keeps exhausted retries dormant through ordinary maintenance", async () => {
    vi.useFakeTimers();
    const desired = policy(1);
    const preparing = status(desired);
    const peer = {
      readPolicy: vi.fn(async () => status(desired)),
      applyPolicy: async () => ({
        ...preparing,
        readiness: preparing.readiness.map((entry) =>
          entry.id === "route:backend"
            ? { ...entry, state: "preparing" as const }
            : entry,
        ),
      }),
    };
    const controller = new SidecarPolicyController(() => desired, vi.fn());
    controller.attach(peer, service);
    await controller.synchronize();
    expect(controller.routeGeneration("backend")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.routeGeneration("backend")).toBe(1);
    peer.readPolicy.mockRejectedValue(Error("delivery timeout"));
    await expect(controller.synchronize(true)).rejects.toThrow();
    const initial = peer.readPolicy.mock.calls.length;
    for (const delay of [1, 2, 4, 8, 16, 30])
      await vi.advanceTimersByTimeAsync(delay * 1000);
    expect(peer.readPolicy.mock.calls.length).toBe(initial + 6);
    await controller.synchronize();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peer.readPolicy.mock.calls.length).toBe(initial + 6);
    controller.detach();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(peer.readPolicy.mock.calls.length).toBe(initial + 6);
  });
});
