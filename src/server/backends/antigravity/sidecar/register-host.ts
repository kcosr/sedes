import { SidecarOperationError } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { launchAdmission, currentBackendGrant, type ProviderPolicyAttachment } from "../../provider-policy-admission.js";
import { runtimeLaunchDigest } from "../../provider-launch-digest.js";
import type { SidecarOperationRegistry } from "../../../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarRuntimeChannel } from "../../../sidecar/runtime-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import { AntigravityError } from "../port.js";
import type { AntigravityHostRegistry } from "../host/host-registry.js";
import type { AntigravityHostAuthority } from "../host/native-host.js";
import { antigravityHostCommandSchema, antigravityHostCommandLane, antigravityRuntimeOperations, type AntigravityHostCommand } from "./wire.js";

/** SSH and outbound peers borrow the same persistent execution-host resources. */
export function registerAntigravityHost(input: ProviderPolicyAttachment & { readonly registry: SidecarOperationRegistry;
  readonly channel: SidecarRuntimeChannel; readonly hosts: AntigravityHostRegistry;
  readonly services: PersistentSidecarServiceRegistry; readonly controllerEpoch: number }): () => void {
  let detached = false; const attached = new Map<string, "normal" | "retained">();
  const assertCurrent = () => { if (detached) throw new AntigravityError("antigravity_attachment_detached"); input.services.assertController(input.controllerEpoch); };
  const authority: AntigravityHostAuthority = { assertCurrent, assertAdmission: () => {
    assertCurrent();
    try { input.services.assertAdmission(input.controllerEpoch); }
    catch (error) { throw new AntigravityError("antigravity_service_admission_unavailable", "not_sent", { cause: error }); }
  } };
  const run = async (command: AntigravityHostCommand, signal: AbortSignal): Promise<unknown> => {
    assertCurrent(); signal.throwIfAborted();
    if (command.controllerEpoch !== input.controllerEpoch || command.serviceIncarnation !== input.services.serviceIncarnation) throw new AntigravityError("antigravity_controller_stale");
    if (command.action === "ensure" || command.action === "lookup" || command.action === "lookup_retained") {
      const admission = command.action === "ensure" ? launchAdmission(input, "antigravity", command.configuration.backendInstanceId,
        runtimeLaunchDigest.antigravity(command.configuration, command.configuration.startupEnvironmentVariables)) : undefined;
      const host = command.action === "lookup_retained" ? await input.hosts.lookupRetained(command.backendInstanceId, input.controllerEpoch)
        : command.action === "ensure" ? await input.hosts.ensure(command.configuration, input.controllerEpoch)
        : await input.hosts.lookup(command.configuration, input.controllerEpoch);
      if (host) admission?.bind(host);
      assertCurrent(); if (!host) return null;
      if (!attached.has(host.runtimeId) || command.action !== "lookup_retained") attached.set(host.runtimeId, command.action === "lookup_retained" ? "retained" : "normal");
      return { runtimeId: host.runtimeId };
    }
    if (command.action === "release") { await input.hosts.release(command.runtimeId, command.input.handleId, signal, authority); return { ok: true }; }
    const mode = attached.get(command.runtimeId); if (!mode) throw new AntigravityError("antigravity_runtime_not_attached");
    const host = input.hosts.get(command.runtimeId);
    const callAuthority = { assertCurrent, assertAdmission: () => {
      if (mode === "retained") throw new AntigravityError("antigravity_recovery_read_only");
      try { currentBackendGrant(input, host); }
      catch (cause) { throw new AntigravityError("antigravity_recovery_read_only", "not_sent", { cause }); }
      const tools = command.action === "create" || command.action === "attach" ? command.input.agentTools : undefined;
      if (tools) {
        if (!input.validateAgentToolRoute) throw new AntigravityError("antigravity_tool_route_denied");
        input.validateAgentToolRoute(host.input.configuration.backendInstanceId, tools.endpoint, tools.executableDirectory, tools.inheritedPath);
      }
      authority.assertAdmission();
    } };
    if (["catalog", "list", "attach", "connect"].includes(command.action)) callAuthority.assertAdmission();
    if (command.action === "history" && !host.hasRetainedSession(command.input)) callAuthority.assertAdmission();
    switch (command.action) {
      case "connect": return host.connect(signal, callAuthority);
      case "catalog": return host.catalog(command.input, signal, callAuthority);
      case "create": return host.create(command.input, signal, callAuthority);
      case "acknowledge_creation": await host.acknowledgeCreation(command.input, signal, callAuthority); return { ok: true };
      case "list": return host.listSessions(command.input, signal, callAuthority);
      case "history": return host.readHistory(command.input, signal, callAuthority);
      case "attach": return host.attach(command.input, signal, callAuthority);
      case "attach_existing": return host.attachExisting(command.input, signal, callAuthority);
      case "request": return host.request(command.input, signal, callAuthority);
      case "outcome": return host.outcome(command.input, signal, callAuthority);
      case "acknowledge_operation": await host.acknowledgeOperation(command.input, signal, callAuthority); return { ok: true };
      case "observe": return host.observe(command.input, signal, callAuthority);
      case "acknowledge": await host.acknowledge(command.input, signal, callAuthority); return { ok: true };
      case "retire_session": return host.retireSession(command.input, signal, callAuthority);
      case "inspect": return host.inspect(signal, callAuthority);
      case "stop": await input.hosts.stop(command.runtimeId, command.input.expectedRevision, command.input.force, signal, callAuthority); attached.delete(command.runtimeId); return { ok: true };
    }
  };
  for (const operation of antigravityRuntimeOperations) input.registry.register(operation, async (body, context) => {
    let runtimeVersion: string | null = null;
    try {
      const command = antigravityHostCommandSchema.parse(await input.channel.decodeBody(body));
      if (antigravityHostCommandLane(command) !== operation.lane) throw new AntigravityError("antigravity_operation_lane_invalid");
      const value = await run(command, context.signal);
      try { if ("runtimeId" in command) runtimeVersion = input.hosts.get(command.runtimeId).runtimeVersion; } catch { /* Successfully stopped hosts have no runtime version. */ }
      return await input.channel.encodeBody({ status: "ok", runtimeVersion, value });
    } catch (error) {
      return await input.channel.encodeBody({ status: "failed", runtimeVersion, failure: error instanceof AntigravityError
        ? { code: error.code, delivery: error.delivery } : error instanceof SidecarOperationError ? { code: "antigravity_policy_denied", delivery: "not_sent" }
        : { code: "antigravity_host_request_failed", delivery: "sent_outcome_unknown" } });
    }
  });
  return () => { detached = true; attached.clear(); };
}
