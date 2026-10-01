import type { BackendRuntimeAdministration, BackendRuntimeRecoveryContext } from "../module.js";
import type { SidecarRuntimeLease } from "../../sidecar/runtime-channel.js";
import { ConversationBindingRepository } from "../../db/repositories/conversation-binding-repository.js";
import { callOpenCodeRemoteRuntime } from "./opencode-remote-runtime.js";
import { openCodeRuntimeInfoSchema, openCodeRuntimeInspectionSchema, openCodeRuntimeOperations, openCodeRuntimeSuccessSchema } from "./opencode-runtime-wire.js";
import { OpenCodeRuntimeError, OPENCODE_RELEASE } from "./opencode-release.js";

/** Retained administration deliberately ignores desired native paths. It only
 * addresses the exact authenticated backend owner, and cannot ensure/launch. */
export async function recoverOpenCodeRuntimeAdministration(context: BackendRuntimeRecoveryContext): Promise<BackendRuntimeAdministration | undefined> {
  const environments = new Set(context.connections.map(connection => connection.executionEnvironmentId));
  if (context.instance.kind !== "opencode" || context.instance.protocolRelease !== OPENCODE_RELEASE ||
      context.instance.tenantId !== context.scope.tenantId || environments.size !== 1 || !context.connections.length ||
      new Set(context.connections.map(connection => connection.id)).size !== context.connections.length ||
      context.connections.some(connection => connection.kind !== "opencode_http" || connection.tenantId !== context.scope.tenantId ||
        connection.ownerPrincipalId !== context.scope.principalId || connection.backendInstanceId !== context.instance.id)) throw denied();
  const withExisting = async <T>(run: (lease: SidecarRuntimeLease, runtimeId: string | undefined) => Promise<T>, initial = false): Promise<T> => {
    const lease = await context.sidecarRuntime.acquireRecovery();
    try {
      lease.channel.assertReady();
      const supported = openCodeRuntimeOperations.map(operation => lease.channel.supportsOperation(operation));
      if (initial && supported.every(value => !value)) return run(lease, undefined);
      if (!supported.every(Boolean)) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
      const result = await callOpenCodeRemoteRuntime(lease, { action: "lookup_retained", backendInstanceId: context.instance.id });
      const current = result === null ? undefined : openCodeRuntimeInfoSchema.parse(result).runtimeId;
      return await run(lease, current);
    } finally { lease.release(); }
  };
  const runtimeId = await withExisting(async (_lease, current) => current, true);
  if (!runtimeId) return undefined;
  const assertSame = (current: string | undefined) => {
    if (current !== runtimeId) throw new OpenCodeRuntimeError("opencode_runtime_identity_changed");
  };
  const stop: BackendRuntimeAdministration["stop"] = input => withExisting(async (lease, current) => {
    if (!current) return; // Only authenticated positive absence proves retirement.
    assertSame(current);
    openCodeRuntimeSuccessSchema.parse(await callOpenCodeRemoteRuntime(lease, { action: "stop", runtimeId, ...input }));
  });
  return {
    inspect: () => withExisting(async (lease, current) => {
      assertSame(current);
      const inspection = openCodeRuntimeInspectionSchema.parse(await callOpenCodeRemoteRuntime(lease, { action: "inspect", runtimeId }));
      const bindings = new ConversationBindingRepository(context.database);
      return { ...inspection, retainedThreadIds: (inspection.retainedThreadIds ?? []).filter(threadId => {
        const binding = bindings.getBinding(context.scope, threadId);
        return binding?.backendInstanceId === context.instance.id && environments.has(binding.executionEnvironmentId);
      }) };
    }),
    stop,
    // Applying the desired replacement belongs to main composition after cleanup.
    restart: stop,
  };
}
function denied(): OpenCodeRuntimeError { return new OpenCodeRuntimeError("opencode_request_authority_mismatch"); }
