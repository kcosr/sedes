import { SidecarServiceManagementError } from "./sidecar-provisioner.js";

const recoveryCodes = [
  "sidecar_service_recovery_required",
  "sidecar_service_target_identity_unavailable",
  "sidecar_service_owner_unreachable",
  "sidecar_service_orphan_cleanup_unproven",
] as const;
export type SidecarOwnershipRecoveryCode = typeof recoveryCodes[number];

/** Preserve the ownership diagnosis through attachment wrappers into runtime status. */
export function sidecarOwnershipRecoveryCode(error: unknown): SidecarOwnershipRecoveryCode | undefined {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (error instanceof SidecarServiceManagementError && recoveryCodes.includes(error.code as SidecarOwnershipRecoveryCode)) {
      return error.code as SidecarOwnershipRecoveryCode;
    }
  }
  return undefined;
}

export function sidecarOwnershipRecoveryMessage(code: SidecarOwnershipRecoveryCode): string {
  switch (code) {
    case "sidecar_service_owner_unreachable":
      return "The sidecar process is still running, but its management endpoint is unavailable. On the host, verify this environment's exact sidecar process and request its graceful shutdown (SIGTERM on Linux/macOS), then retry. Leave other environments and external provider servers running.";
    case "sidecar_service_orphan_cleanup_unproven":
      return "The previous sidecar process has exited, but Sedes cannot prove that its owned child processes stopped. Replacement is blocked to avoid competing workers. Verify cleanup of this exact environment on the host before repairing its ownership record; see the operator recovery guide.";
    case "sidecar_service_target_identity_unavailable":
      return "Sedes cannot read the host's process identity. Restore access to the platform process-identity facility and retry. Keep ownership records intact; an unreadable process is not proof that it stopped.";
    case "sidecar_service_recovery_required":
      return "Sedes cannot validate this environment's saved sidecar ownership. Inspect its ownership record and host process identity; see the operator recovery guide. Repair records only after confirming the exact service and its children stopped.";
  }
}
