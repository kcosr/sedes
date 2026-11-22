import { SidecarServiceManagementError } from "./sidecar-provisioner.js";

const recoveryCodes = [
  "sidecar_service_recovery_required",
  "sidecar_service_target_identity_unavailable",
  "sidecar_service_owner_unreachable",
  "sidecar_service_orphan_cleanup_unproven",
  "sidecar_service_launch_evidence_invalid",
  "sidecar_service_launch_identity_unrecorded",
  "sidecar_service_live_child",
  "sidecar_service_unsupported_launch_kind",
  "sidecar_service_containment_unproven",
  "sidecar_service_inspection_failed",
  "sidecar_service_replacement_ready",
] as const;
export type SidecarOwnershipRecoveryCode = typeof recoveryCodes[number];

export function isSidecarOwnershipRecoveryCode(code: string): code is SidecarOwnershipRecoveryCode {
  return recoveryCodes.includes(code as SidecarOwnershipRecoveryCode);
}

/** Preserve the ownership diagnosis through attachment wrappers into runtime status. */
export function sidecarOwnershipRecoveryCode(error: unknown): SidecarOwnershipRecoveryCode | undefined {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (error instanceof SidecarServiceManagementError && isSidecarOwnershipRecoveryCode(error.code)) {
      return error.code;
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
    case "sidecar_service_launch_evidence_invalid":
      return "The previous sidecar's launch records are incomplete or inconsistent. Preserve them and verify process cleanup for this environment on the host.";
    case "sidecar_service_launch_identity_unrecorded":
      return "The previous sidecar recorded a launch before spawning, but its child identity is missing. Inspect the host for that launch before repairing ownership.";
    case "sidecar_service_live_child":
      return "A child process owned by the previous sidecar is still running. Wait for it to exit, then retry.";
    case "sidecar_service_unsupported_launch_kind":
      return "The previous sidecar used a launch path whose descendants cannot be verified after a crash. Inspect its processes on the host before repairing ownership.";
    case "sidecar_service_containment_unproven":
      return "The recorded process could have descendants outside its original session. Verify cleanup of this environment's processes on the host before repairing ownership.";
    case "sidecar_service_inspection_failed":
      return "Sedes could not inspect this environment's launch evidence. Restore access to its process metadata and service directory, then retry.";
    case "sidecar_service_replacement_ready":
      return "The previous sidecar exited and its launch records permit replacement. Connect to check ownership again and start a replacement.";
    case "sidecar_service_target_identity_unavailable":
      return "Sedes cannot read the host's process identity. Restore access to the platform process-identity facility and retry. Keep ownership records intact; an unreadable process is not proof that it stopped.";
    case "sidecar_service_recovery_required":
      return "Sedes cannot validate this environment's saved sidecar ownership. Inspect its ownership record and host process identity; see the operator recovery guide. Repair records only after confirming the exact service and its children stopped.";
  }
}
