import type { BackendRuntimeDiagnostic } from "../module.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export const openCodeStoreRecoveryCodes = [
  "opencode_native_store_recovery_required", "opencode_native_store_already_owned",
  "opencode_native_store_release_unproved", "opencode_native_store_initialization_unproved",
] as const;

/** These fixed messages can cross the normalized Settings boundary. */
export function openCodeRuntimeDiagnostic(error: unknown): BackendRuntimeDiagnostic | undefined {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (!(error instanceof OpenCodeRuntimeError)) continue;
    const code = error.code;
    if (openCodeStoreRecoveryCodes.some(candidate => candidate === code)) return {
      connectionState: "recovery_required",
      message: "The execution host's OpenCode store is fenced by an existing or unproved Sedes owner. On that Linux host, use sedes opencode-owner inspect --store PATH with the configured database path. Recover only the exact inspected dead owner; keep the ownership record intact and leave external OpenCode daemons running. After recovery, reload Sedes to retry target health; Settings Refresh only inspects existing state. See the operator recovery guide.",
    };
    if (error.code === "opencode_tools_capability_unavailable") return { connectionState: "unknown",
      message: "This sidecar lacks the required OpenCode tool relay. Upgrade and restart the sidecar to enable Sedes tools; unrelated negotiated host operations remain available.",
    };
    if (error.code === "opencode_runtime_capability_unavailable" || error.code === "opencode_platform_unsupported") return {
      connectionState: "unknown",
      message: "This host does not advertise the required OpenCode runtime. OpenCode requires a Linux execution host and a current Sedes sidecar. Upgrade and restart the sidecar on a supported host; other negotiated host operations remain available.",
    };
    if (error.code === "opencode_release_incompatible") return { connectionState: "unknown",
      message: "The execution host must use stock opencode2 2.0.18. Check the selected executable and external daemon version on that host." };
  }
  return undefined;
}
