import type { SidecarOperationKey } from "../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarLaunchRecorder } from "./sidecar-launch-ledger.js";

// These Unix runtime entry points either do not start processes, or have a
// pre-spawn recorder in their implementation. Enumerate operations within
// their exact major version so new operations always start on the manual path.
const coveredOperations: ReadonlyMap<string, readonly string[]> = new Map([
  ["control:3", ["hello", "ping", "go_away", "policy.read", "policy.stage", "policy.apply", "policy.acquire_route", "policy.acquire_opencode_route", "policy.authorize_variables"]],
  ["runtime_bodies:1", ["body.offer"]],
  ["environment_variables:1", ["variables.resolve"]],
  ["directory_browser:1", ["directories.list"]],
  ["workspace_context:1", ["context.read"]],
  ["workspace_skills:1", ["catalog.read", "skill.resolve"]],
  ["composer_attachments:1", ["materialization.open", "materialization.append", "materialization.commit",
    "materialization.abort", "materialization.release"]],
  ["workspace_files:8", ["root.open", "root.validate", "root.close", "files.list", "files.list_directory",
    "files.read", "files.download_start", "files.download_cancel", "files.write", "files.resolve_link",
    "files.discover_link_root", "files.watch_close", "mutation.list", "mutation.inspect", "mutation.acknowledge"]],
  ["workspace_tools:2", ["workspace.open", "workspace.close", "file.read", "file.write", "file.edit",
    "directory.list", "mutation.list", "mutation.inspect", "mutation.acknowledge", "shell.start",
    "shell.cancel", "shell.inspect", "shell.list", "shell.acknowledge"]],
  ["interactive_terminal:2", ["terminal.prepare", "terminal.create", "terminal.attach", "terminal.read",
    "terminal.snapshot_chunk", "terminal.input", "terminal.producer", "terminal.resize", "terminal.stop",
    "terminal.detach", "terminal.acknowledge", "terminal.forget"]],
  ["codex_runtime:1", ["runtime.ensure", "runtime.lookup", "runtime.execute", "runtime.prepare_thread_archive"]],
  ["codex_managed_tui:3", ["tui.control", "tui.execute"]],
  ["pi_native_runtime:4", ["runtime.control", "runtime.execute"]],
  ["antigravity_runtime:7", ["runtime.control", "runtime.execute"]],
  ["claude_persistent_runtime:8", ["runtime.lookup", "runtime.inspect", "runtime.stop", "runtime.ensure", "runtime.execute"]],
  ["opencode_runtime:7", ["runtime.execute", "runtime.control"]],
]);

export function recordUncoveredRuntimeOperation(
  recorder: Pick<SidecarLaunchRecorder, "markUnsupported">,
  key: SidecarOperationKey,
): void | Promise<void> {
  if (coveredOperations.get(`${key.capabilityId}:${key.majorVersion}`)?.includes(key.operation)) return;
  // Git, watcher discovery and fd/rg probes can launch below their engines.
  // Mark the operation before dispatch, including work scheduled by a watch.
  // Only registered (server-defined) keys reach this hook.
  return recorder.markUnsupported(`${key.capabilityId}:${key.majorVersion}:${key.operation}`);
}
