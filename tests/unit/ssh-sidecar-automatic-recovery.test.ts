import { describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import { SIDECAR_ARTIFACT_ID, SIDECAR_ARTIFACT_MODES, SIDECAR_MINIMUM_NODE_VERSION } from "../../src/server/sidecar/sidecar-artifact.js";

describe("automatic recovery preference races", () => {
  it("rechecks connection intent after asynchronous revision probes before installing or attaching", async () => {
    let enabled = true;
    const install = vi.fn(async () => ({ accountHome: "/home/remote", nodeExecutable: "/usr/bin/node", envExecutable: "/usr/bin/env",
      stateRoot: "/home/remote/.local/state/sedes/sidecar", environment: { HOME: "/home/remote" }, executableDirectory: "/fixture", executablePath: "/fixture/sedes" }));
    const unavailable = vi.fn(async (): Promise<never> => { throw new Error("unexpected_attachment"); });
    const scope = { tenantId: "tenant", principalId: "principal" };
    const owner = new SidecarRuntimeOwner({ scope, executionEnvironmentId: "remote", environmentConfigurationRevision: 1, operationsConfigurationRevision: 1,
      authorizedCapabilities: [{ capabilityId: "workspace_files", majorVersion: 7 }], authorizedRuntimeCapabilities: [],
      activeEnvironmentConfigurationRevision: async () => { enabled = false; return 1; }, activeOperationsConfigurationRevision: () => 1,
      isAutomaticConnectionEnabled: () => enabled,
      artifact: { artifactId: SIDECAR_ARTIFACT_ID, modes: SIDECAR_ARTIFACT_MODES, executableDirectory: "/fixture", executablePath: "/fixture/sedes",
        artifactSha256: "a".repeat(64), artifactBytes: 1, buildId: "fixture", minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: [] },
      provisioner: { transportKind: "ssh_stdio", install, launch: unavailable, attachExisting: unavailable, inspect: async () => undefined, inspectReceipt: async () => undefined, withdrawReceipt: async () => undefined, control: async () => undefined },
      sedesOperations: new SidecarOperationRegistry(), startSession: unavailable });
    await expect(owner.acquireAutomaticRecovery(scope, "remote", new AbortController().signal)).rejects.toThrow("sidecar_unavailable");
    expect(install).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    await owner.close();
  });
});
