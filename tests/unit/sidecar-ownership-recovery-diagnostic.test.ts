import { describe, expect, it } from "vitest";
import { sidecarOwnershipRecoveryCode, sidecarOwnershipRecoveryMessage } from "../../src/server/sidecar/sidecar-ownership-recovery-diagnostic.js";
import { SidecarServiceManagementError } from "../../src/server/sidecar/sidecar-provisioner.js";

describe("sidecar ownership recovery diagnostics", () => {
  it.each([
    ["sidecar_service_owner_unreachable", "process is still running"],
    ["sidecar_service_orphan_cleanup_unproven", "process has exited"],
    ["sidecar_service_target_identity_unavailable", "cannot read the host's process identity"],
    ["sidecar_service_recovery_required", "cannot validate this environment's saved sidecar ownership"],
  ] as const)("retains %s through attachment wrappers", (code, explanation) => {
    const error = new Error("attachment_failed", { cause: new Error("transport_failed", { cause: new SidecarServiceManagementError(code) }) });
    expect(sidecarOwnershipRecoveryCode(error)).toBe(code);
    expect(sidecarOwnershipRecoveryMessage(code)).toContain(explanation);
  });

  it("does not misclassify connection failure or provider reconciliation as crashed ownership", () => {
    for (const code of ["sidecar_management_connection_failed", "sidecar_resource_handoff_pending", "sidecar_service_cleanup_unproven"])
      expect(sidecarOwnershipRecoveryCode(new SidecarServiceManagementError(code))).toBeUndefined();
    expect(sidecarOwnershipRecoveryCode(new Error("sidecar_service_orphan_cleanup_unproven"))).toBeUndefined();
  });

  it("bounds malformed cyclic exception chains", () => {
    const error = new Error("wrapper");
    error.cause = error;
    expect(sidecarOwnershipRecoveryCode(error)).toBeUndefined();
  });
});
