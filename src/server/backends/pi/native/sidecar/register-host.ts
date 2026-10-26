import type { SidecarOperationRegistry } from "../../../../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarRuntimeChannel } from "../../../../sidecar/runtime-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../../sidecar/persistent-sidecar-service-registry.js";
import { PiNativeError } from "../port.js";
import type { PiNativeHostRegistry } from "../host/host-registry.js";
import type { PiNativeHostAuthority } from "../host/native-host.js";
import { piNativeHostCommandSchema, piNativeHostCommandLane, piNativeRuntimeOperations,
  type PiNativeHostCommand } from "./wire.js";

/** One registration serves SSH and outbound carriers. No peer owns the host. */
export function registerPiNativeHost(input: {
  readonly registry: SidecarOperationRegistry;
  readonly channel: SidecarRuntimeChannel;
  readonly hosts: PiNativeHostRegistry;
  readonly services: PersistentSidecarServiceRegistry;
  readonly controllerEpoch: number;
}): () => void {
  let detached = false;
  const attached = new Map<string, "normal" | "retained">();
  const assertCurrent = () => {
    if (detached) throw new PiNativeError("pi_native_attachment_detached");
    input.services.assertController(input.controllerEpoch);
  };
  const authority: PiNativeHostAuthority = { assertCurrent, assertAdmission: () => {
    assertCurrent(); input.services.assertAdmission(input.controllerEpoch);
  } };
  const run = async (command: PiNativeHostCommand, signal: AbortSignal): Promise<unknown> => {
    assertCurrent(); signal.throwIfAborted();
    if (command.controllerEpoch !== input.controllerEpoch || command.serviceIncarnation !== input.services.serviceIncarnation) throw new PiNativeError("pi_native_controller_stale");
    if (command.action === "ensure" || command.action === "lookup" || command.action === "lookup_retained") {
      const host = command.action === "lookup_retained"
        ? await input.hosts.lookupRetained(command.backendInstanceId, input.controllerEpoch)
        : await input.hosts[command.action](command.configuration, input.controllerEpoch);
      assertCurrent();
      if (!host) return null;
      if (!attached.has(host.runtimeId) || command.action !== "lookup_retained") attached.set(host.runtimeId, command.action === "lookup_retained" ? "retained" : "normal");
      return { runtimeId: host.runtimeId };
    }
    // Cleanup may follow Stop on another authenticated port, or a carrier
    // replacement. The registry proves the exact live or retired handle.
    if (command.action === "release") {
      await input.hosts.release(command.runtimeId, command.input.handleId, signal, authority);
      return { ok: true };
    }
    const mode = attached.get(command.runtimeId);
    if (!mode) throw new PiNativeError("pi_native_runtime_not_attached");
    const host = input.hosts.get(command.runtimeId);
    const callAuthority = mode === "retained" ? { assertCurrent, assertAdmission: () => { throw new PiNativeError("pi_native_recovery_read_only"); } } : authority;
    switch (command.action) {
      case "catalog": return host.catalog(command.input, signal, callAuthority);
      case "resolve_session_directory": return host.resolveSessionDirectory(command.input, signal, callAuthority);
      case "create": return host.create(command.input, signal, callAuthority);
      case "fork": return host.fork(command.input, signal, callAuthority);
      case "reconcile_fork": return host.reconcileFork(command.input, signal, callAuthority);
      case "list": return host.listSessions(command.input, signal, callAuthority);
      case "history": return host.readHistory(command.input, signal, callAuthority);
      case "attach": return host.attach(command.input, signal, callAuthority);
      case "attach_for_drain": return host.attachForDrain(command.input, signal, callAuthority);
      case "attach_for_control": return host.attachForControl(command.input, signal, callAuthority);
      case "request": return host.request(command.input, signal, callAuthority);
      case "outcome": return host.outcome(command.input, signal, callAuthority);
      case "acknowledge_operation": await host.acknowledgeOperation(command.input, signal, callAuthority); return { ok: true };
      case "abandon_observation": return host.abandonObservation(command.input, signal, callAuthority);
      case "observe": return host.observe(command.input, signal, callAuthority);
      case "acknowledge": await host.acknowledge(command.input, signal, callAuthority); return { ok: true };
      case "acknowledge_observation_gap": await host.acknowledgeObservationGap(command.input, signal, callAuthority); return { ok: true };
      case "retire_session": return host.retireSession(command.input, signal, callAuthority);
      case "inspect": return host.inspect(signal, callAuthority);
      case "stop": await input.hosts.stop(command.runtimeId, command.input.expectedRevision, command.input.force, signal, callAuthority); attached.delete(command.runtimeId); return { ok: true };
    }
  };
  for (const operation of piNativeRuntimeOperations) input.registry.register(operation, async (body, context) => {
    try {
      const command = piNativeHostCommandSchema.parse(await input.channel.decodeBody(body));
      if (piNativeHostCommandLane(command) !== operation.lane) throw new PiNativeError("pi_native_operation_lane_invalid");
      const value = await run(command, context.signal);
      return await input.channel.encodeBody({ status: "ok", value });
    } catch (error) {
      return await input.channel.encodeBody({ status: "failed", failure: error instanceof PiNativeError
        ? { code: error.code, delivery: error.delivery }
        : { code: "pi_native_host_request_failed", delivery: "sent_outcome_unknown" } });
    }
  });
  return () => { detached = true; attached.clear(); };
}
