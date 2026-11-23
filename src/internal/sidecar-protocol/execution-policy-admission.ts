import {
  SidecarOperationError,
  type SidecarOperationKey,
} from "./operation-registry.js";
import type { ExecutionPolicySnapshot } from "./execution-policy.js";

export const providerRuntimeCapabilities: Readonly<Record<string, string>> =
  Object.freeze({
    codex_app_server: "codex_runtime",
    claude_agent_sdk: "claude_persistent_runtime",
    pi_native: "pi_native_runtime",
    opencode: "opencode_runtime",
    antigravity: "antigravity_runtime",
  });
const retainedOperations: Readonly<Record<string, readonly string[]>> = {
  workspace_files: [
    "root.close",
    "files.watch_close",
    "files.download_cancel",
    "mutation.inspect",
    "mutation.acknowledge",
    "mutation.list",
  ],
  workspace_tools: [
    "workspace.close",
    "shell.cancel",
    "shell.inspect",
    "shell.acknowledge",
    "shell.list",
    "mutation.inspect",
    "mutation.acknowledge",
    "mutation.list",
  ],
  composer_attachments: ["materialization.abort", "materialization.release"],
  interactive_terminal: [
    "terminal.attach",
    "terminal.read",
    "terminal.snapshot_chunk",
    "terminal.producer",
    "terminal.stop",
    "terminal.detach",
    "terminal.acknowledge",
    "terminal.forget",
  ],
};
export function retainedPolicyOperation(key: SidecarOperationKey): boolean {
  return terminalReceiptOperation(key) || retainedOperations[key.capabilityId]?.includes(key.operation) === true;
}
/** These handlers distinguish an exact receipt replay from a new PTY effect. */
export function terminalReceiptOperation(key: SidecarOperationKey): boolean {
  return key.capabilityId === "interactive_terminal" && (key.operation === "terminal.input" || key.operation === "terminal.resize");
}
/** Normal observers need the live terminal grant. Recovery can inspect the exact retained terminal. */
export function grantIndependentSettlement(key: SidecarOperationKey): boolean {
  if (
    key.capabilityId === "interactive_terminal" &&
    [
      "terminal.attach",
      "terminal.read",
      "terminal.snapshot_chunk",
      "terminal.producer",
    ].includes(key.operation)
  )
    return false;
  return !terminalReceiptOperation(key) && retainedPolicyOperation(key);
}
export function providerPolicyOperation(key: SidecarOperationKey): boolean {
  return (
    Object.values(providerRuntimeCapabilities).includes(key.capabilityId) ||
    key.capabilityId === "codex_managed_tui"
  );
}
/** Typed provider handlers enforce launch authority after decoding nested operations. */
export function requiresCapabilityGrant(key: SidecarOperationKey): boolean {
  return key.capabilityId !== "control" && key.capabilityId !== "runtime_bodies" &&
    !grantIndependentSettlement(key) && !providerPolicyOperation(key);
}
export function requirePolicyCapability(
  policy: ExecutionPolicySnapshot,
  key: SidecarOperationKey,
  request: unknown,
  confirmed?: ExecutionPolicySnapshot,
): void {
  const { capabilityId } = key;
  if (capabilityId === "environment_variables") {
    const id =
      request && typeof request === "object" && "backendInstanceId" in request
        ? request.backendInstanceId
        : undefined;
    const b = policy.backends.find((b) => b.id === id);
    if (
      !b ||
      (confirmed &&
        !confirmed.backends.some(
          (c) => c.id === b.id && c.generation === b.generation,
        ))
    )
      throw new SidecarOperationError("sidecar_policy_backend_denied");
    return;
  }
  const feature =
    capabilityId === "opencode_tools" ? "agent_tools_cli" : capabilityId;
  const grant = policy.capabilities.find((c) => c.id === feature);
  if (
    !grant ||
    (confirmed &&
      !confirmed.capabilities.some(
        (c) => c.id === feature && c.generation === grant.generation,
      ))
  )
    throw new SidecarOperationError("sidecar_policy_feature_denied");
}
