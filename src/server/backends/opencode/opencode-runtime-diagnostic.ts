import type { BackendRuntimeDiagnostic } from "../module.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export const openCodeOwnerRecoveryCodes = [
  "opencode_runtime_owner_recovery_required", "opencode_runtime_owner_already_owned",
  "opencode_runtime_owner_release_unproved", "opencode_runtime_owner_initialization_unproved",
] as const;

/** These fixed messages can cross the normalized Settings boundary. */
export function openCodeRuntimeDiagnostic(error: unknown): BackendRuntimeDiagnostic | undefined {
  const pending = [{ error, depth: 0 }], visited = new Set<Error>();
  let diagnostic: BackendRuntimeDiagnostic | undefined;
  for (let index = 0; index < pending.length && index < 32; index++) {
    const { error: current, depth } = pending[index]!;
    if (!(current instanceof Error) || depth >= 8 || visited.has(current)) continue;
    visited.add(current);
    // Read only data properties. Untrusted error text, custom accessors,
    // cycles, and arbitrarily wide/deep aggregates cannot reach Settings.
    const cause: unknown = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    if (cause !== undefined && pending.length < 32) pending.push({ error: cause, depth: depth + 1 });
    if (current instanceof AggregateError) {
      const errors: unknown = Object.getOwnPropertyDescriptor(current, "errors")?.value;
      if (Array.isArray(errors)) for (let child = 0; child < errors.length && pending.length < 32; child++) {
        pending.push({ error: Object.getOwnPropertyDescriptor(errors, child)?.value, depth: depth + 1 });
      }
    }
    if (!(current instanceof OpenCodeRuntimeError)) continue;
    const classified = diagnosticForCode(current.code);
    // Cleanup must precede retrying the original failed launch. Prefer that
    // action even when an aggregate also contains a diagnosed startup error.
    if (current.code === "opencode_owned_cleanup_unproved") return classified;
    diagnostic ??= classified;
  }
  return diagnostic;
}

function diagnosticForCode(code: string): BackendRuntimeDiagnostic | undefined {
  if (code === "opencode_owned_cleanup_unproved") return {
    connectionState: "recovery_required",
    recoveryAction: "stop",
    message: "Sedes could not prove cleanup of its owned OpenCode process and runtime resources. Use backend Stop to retry cleanup before using Start. Keep ownership records intact. If Stop still cannot prove cleanup, inspect the execution host and follow the operator recovery guide.",
  };
  if (openCodeOwnerRecoveryCodes.some(candidate => candidate === code)) return {
    connectionState: "recovery_required",
    message: "This scoped OpenCode runtime is fenced by an existing or unproved Sedes owner. On that Linux host, use sedes opencode-owner inspect --authority-key KEY using its record under the host account Sedes state directory. Recover only the exact inspected dead owner; keep the ownership record intact and leave external OpenCode daemons running. After recovery, use backend Connect or Start to retry startup; Settings Refresh only inspects existing state. See the operator recovery guide.",
  };
  if (code === "opencode_tools_capability_unavailable") return { connectionState: "unknown",
    message: "This sidecar lacks the required OpenCode tool relay. Upgrade and restart the sidecar to enable Sedes tools; unrelated negotiated host operations remain available.",
  };
  if (code === "opencode_runtime_capability_unavailable" || code === "opencode_platform_unsupported") return {
    connectionState: "unknown",
    message: "This host does not advertise the required OpenCode runtime. OpenCode requires a Linux execution host and a current Sedes sidecar. Upgrade and restart the sidecar on a supported host; other negotiated host operations remain available.",
  };
  if (code === "opencode_release_incompatible") return { connectionState: "unknown",
    message: "The execution host must use stock opencode2 2.0.18. Check the selected executable and external daemon version on that host." };
  if (code === "opencode_executable_unavailable") return { connectionState: "unknown",
    message: "The execution host could not find or execute stock opencode2 2.0.18. Install it on that host in the Sedes service or sidecar startup PATH, or set the backend Advanced executable path or startup PATH override. A login shell can have a different PATH. Then use backend Connect or Start to retry startup." };
  if (code === "opencode_runtime_owner_directory_invalid") return { connectionState: "unknown",
    message: "Sedes could not safely access the OpenCode ownership directory under the execution host account's state directory. Check the host account HOME/XDG_STATE_HOME, parent access, and ownership-directory permissions: the final directory must belong to that account, have mode 0700, and not be a symlink. Preserve existing owner records, then use backend Connect or Start to retry startup." };
  return undefined;
}
