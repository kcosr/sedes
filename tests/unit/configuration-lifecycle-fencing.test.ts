import { describe, expect, it, vi } from "vitest";
import type { SidecarManagementReceipt } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import type { ConfigurationLifecycleRequest, ConfigurationLifecycleResult, ConfigurationRuntimeState } from "../../src/shared/protocol/configuration-admin.js";
import { fencePriorLifecycleForStop, type PendingConfigurationLifecycle } from "../../src/server/configuration-admin/configuration-lifecycle-fencing.js";

function fixture() {
  const runtime: ConfigurationRuntimeState = {
    resourceKind: "environment", resourceId: "environment-a", desiredRevision: 2, effectiveRevision: 1,
    preference: "automatic", applyState: "pending", connectionState: "connected", incarnation: "service-old",
    softwareVersion: "old", upgradeState: "required", activeResources: 1,
    supportedActions: ["stop", "restart", "upgrade"], lastError: null,
  };
  const oldRequest: ConfigurationLifecycleRequest = {
    mutationId: "00000000-0000-4000-8000-000000000001", expectedRevision: 1,
    resourceKind: "environment", resourceId: "environment-a", action: "upgrade",
    expectedIncarnation: "service-old", impactToken: "old-impact",
  };
  const entry: PendingConfigurationLifecycle = { request: oldRequest, result: { mutationId: oldRequest.mutationId, state: "unknown", runtime } };
  const request: ConfigurationLifecycleRequest = { ...oldRequest,
    mutationId: "00000000-0000-4000-8000-000000000002", expectedRevision: 2, action: "stop", impactToken: "stop-impact" };
  const receipt = (state: SidecarManagementReceipt["state"]): SidecarManagementReceipt => ({
    mutationId: oldRequest.mutationId, serviceIncarnation: "service-old", requestFingerprint: "a".repeat(64), state,
  });
  const management = {
    inspectServiceReceipt: vi.fn<() => Promise<SidecarManagementReceipt | undefined>>().mockResolvedValue(undefined),
    withdrawServiceReceipt: vi.fn<() => Promise<SidecarManagementReceipt | undefined>>().mockResolvedValue(receipt("withdrawn")),
    inspectService: vi.fn<() => Promise<{ serviceIncarnation: string } | undefined>>().mockResolvedValue({ serviceIncarnation: "service-old" }),
  };
  const recover = vi.fn<() => Promise<ConfigurationLifecycleResult | undefined>>().mockResolvedValue(undefined);
  const complete = vi.fn<(entry: PendingConfigurationLifecycle, result: ConfigurationLifecycleResult) => void>();
  return { input: { request, pending: [entry], priorHasRemoteExecutor: true, management, recover, complete }, entry, receipt };
}

describe("explicit Stop lifecycle fencing", () => {
  it("atomically withdraws an unadmitted command before permitting Stop", async () => {
    const { input, entry } = fixture();
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.management.withdrawServiceReceipt).toHaveBeenCalledWith(entry.request.mutationId, "service-old");
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "rejected", runtime: expect.objectContaining({
      desiredRevision: 2, preference: "automatic", lastError: expect.stringContaining("withdrawn before admission"),
    }) }));
  });

  it("refuses Stop when late admission wins the withdrawal race", async () => {
    const { input, receipt } = fixture();
    input.management.withdrawServiceReceipt.mockResolvedValue(receipt("accepted"));
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: false, message: expect.stringContaining("still finishing") });
    expect(input.complete).not.toHaveBeenCalled();
  });

  it("does not attempt withdrawal or settlement for a known active remote command", async () => {
    const { input, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(receipt("accepted"));
    expect((await fencePriorLifecycleForStop(input)).allowed).toBe(false);
    expect(input.management.withdrawServiceReceipt).not.toHaveBeenCalled();
    expect(input.complete).not.toHaveBeenCalled();
  });

  it.each([undefined, "accepted"] as const)("fences an old %s receipt when a new service owns the environment", async state => {
    const { input, entry, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(state ? receipt(state) : undefined);
    input.management.inspectService.mockResolvedValue({ serviceIncarnation: "service-new" });
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.management.withdrawServiceReceipt).not.toHaveBeenCalled();
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "unavailable" }));
  });

  it("does not claim a completed remote restart reached its desired state", async () => {
    const { input, entry, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(receipt("completed"));
    input.recover.mockRejectedValue(new Error("replacement_not_reachable"));
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "unavailable", runtime: expect.objectContaining({
      lastError: expect.stringContaining("requested end state was not confirmed"),
    }) }));
  });

  it("uses a confirmed outcome without allowing it to overwrite the newer Stop admission", async () => {
    const { input, entry, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(receipt("completed"));
    input.recover.mockResolvedValue({ ...entry.result, state: "applied", runtime: {
      ...entry.result.runtime, desiredRevision: 3, preference: "stopped", connectionState: "stopped", applyState: "applied",
    } });
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "applied", runtime: expect.objectContaining({
      desiredRevision: 2, preference: "automatic", connectionState: "stopped",
    }) }));
  });

  it.each(["failed", "handoff_pending"] as const)("a terminal %s command cannot veto the next Stop", async state => {
    const { input, entry, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(receipt(state));
    input.recover.mockRejectedValue(new Error("status_unavailable"));
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "rejected" }));
  });

  it("fails closed on unreachable management and preserves the unknown outcome", async () => {
    const { input } = fixture();
    input.management.inspectServiceReceipt.mockRejectedValue(new Error("host_unreachable"));
    expect((await fencePriorLifecycleForStop(input)).allowed).toBe(false);
    expect(input.complete).not.toHaveBeenCalled();
    expect(input.management.withdrawServiceReceipt).not.toHaveBeenCalled();
  });

  it.each([undefined, "accepted"] as const)("permits Stop with an old %s receipt and verified absent service without claiming upgrade success", async state => {
    const { input, entry, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(state ? receipt(state) : undefined);
    input.management.inspectService.mockResolvedValue(undefined);
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "unavailable", runtime: expect.objectContaining({
      desiredRevision: 2, preference: "automatic", lastError: expect.stringContaining("no longer present"),
    }) }));
    expect(input.management.withdrawServiceReceipt).not.toHaveBeenCalled();
  });

  it("does not mistake an unreachable service for verified retirement of an accepted command", async () => {
    const { input, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue(receipt("accepted"));
    input.management.inspectService.mockRejectedValue(new Error("host_unreachable"));
    expect((await fencePriorLifecycleForStop(input)).allowed).toBe(false);
    expect(input.complete).not.toHaveBeenCalled();
  });

  it("accepts recovery proof that an absent service completed the previous Stop", async () => {
    const { input, entry } = fixture();
    entry.request.action = "stop";
    input.management.inspectService.mockResolvedValue(undefined);
    input.recover.mockResolvedValue({ ...entry.result, state: "applied" });
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.management.withdrawServiceReceipt).not.toHaveBeenCalled();
  });

  it.each(["mutationId", "serviceIncarnation"] as const)("rejects a receipt with the wrong %s", async field => {
    const { input, receipt } = fixture();
    input.management.inspectServiceReceipt.mockResolvedValue({ ...receipt("accepted"), [field]: "other" });
    input.management.inspectService.mockResolvedValue({ serviceIncarnation: "service-new" });
    expect((await fencePriorLifecycleForStop(input)).allowed).toBe(false);
    expect(input.complete).not.toHaveBeenCalled();
  });

  it("does not use environment receipt authority for an unresolved backend command", async () => {
    const { input, entry } = fixture();
    input.request.resourceKind = entry.request.resourceKind = "backend";
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: false, message: expect.stringContaining("stop its execution environment") });
    expect(input.management.inspectServiceReceipt).not.toHaveBeenCalled();
    expect(input.complete).not.toHaveBeenCalled();
  });

  it.each(["backend", "environment"] as const)("supersedes an unconfirmed %s command with no remote executor", async resourceKind => {
    const { input, entry } = fixture();
    input.priorHasRemoteExecutor = false;
    input.request.resourceKind = entry.request.resourceKind = resourceKind;
    entry.request.action = resourceKind === "backend" ? "restart" : "connect";
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.complete).toHaveBeenCalledWith(entry, expect.objectContaining({ state: "unavailable", runtime: expect.objectContaining({
      desiredRevision: 2, preference: "automatic", lastError: expect.stringContaining("superseded by explicit Stop"),
    }) }));
    expect(input.management.inspectServiceReceipt).not.toHaveBeenCalled();
  });

  it("does not treat a missing management owner as proof that a remote executor does not exist", async () => {
    const { input } = fixture();
    const { management: _unavailable, ...withoutManagement } = input;
    expect((await fencePriorLifecycleForStop(withoutManagement)).allowed).toBe(false);
    expect(input.complete).not.toHaveBeenCalled();
  });

  it("ignores the current admission and different resources", async () => {
    const { input, entry } = fixture();
    input.pending = [
      { ...entry, request: input.request },
      { ...entry, request: { ...entry.request, resourceId: "environment-other" } },
      { ...entry, request: { ...entry.request, resourceKind: "backend" } },
    ];
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.management.inspectServiceReceipt).not.toHaveBeenCalled();
    expect(input.recover).not.toHaveBeenCalled();
  });

  it("does not withdraw prior commands for an automatic start or another action", async () => {
    const { input } = fixture();
    input.request.action = "start";
    expect(await fencePriorLifecycleForStop(input)).toEqual({ allowed: true });
    expect(input.management.inspectServiceReceipt).not.toHaveBeenCalled();
    expect(input.complete).not.toHaveBeenCalled();
  });
});
