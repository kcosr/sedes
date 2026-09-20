import { expect, it, vi } from "vitest";
import { SidecarProtocolDeliveryError } from "../../src/internal/sidecar-protocol/contracts.js";
import { SidecarOperationError } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import { CodexSidecarRuntimeConnection } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { ClaudeSidecarRuntimeConnection } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import type { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";

it.each(["codex", "claude"] as const)("%s control preserves delivery uncertainty and unrecognized responses", async provider => {
  const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" };
  const knownCode = provider === "codex" ? "codex_runtime_confirmation_stale" : "claude_persistent_confirmation_stale";
  const call = vi.fn();
  const channel = { call, encodeBody: async () => ({}) } as unknown as SidecarRuntimeChannel;
  const stop = provider === "codex"
    ? () => new CodexSidecarRuntimeConnection(channel).stop({ scope, runtimeId: "runtime", controllerId: "1" }, "revision", true)
    : () => new ClaudeSidecarRuntimeConnection(channel).stop({ configuration: {
      ...scope, executablePath: "/claude", configDirectory: "/config", initializationTimeoutMs: 1000,
    }, runtimeId: "11111111-1111-4111-8111-111111111111", controllerEpoch: 1, expectedRevision: "revision", force: true });
  for (const error of [
    new Error(knownCode),
    new SidecarProtocolDeliveryError(knownCode, "sent_outcome_unknown"),
    new SidecarOperationError("sidecar_operation_failed"),
  ]) {
    call.mockRejectedValueOnce(error);
    await expect(stop()).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(BackendRuntimeControlRejectedError);
  }
  const confirmed = new SidecarOperationError(knownCode);
  call.mockRejectedValueOnce(confirmed);
  await expect(stop()).rejects.toMatchObject({ name: "BackendRuntimeControlRejectedError", reason: "confirmation_stale", cause: confirmed });
});
