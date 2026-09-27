import { randomUUID } from "node:crypto";
import type { SidecarOperationRegistry } from "../../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarRuntimeChannel } from "../../sidecar/runtime-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../sidecar/persistent-sidecar-service-registry.js";
import type { OpenCodeRuntimeHostRegistry } from "./opencode-runtime-host-registry.js";
import type { OpenCodeNativeHost } from "./opencode-native-host.js";
import type { OpenCodeNativePort, OpenCodeObservationEnd, OpenCodePortObservation } from "./opencode-native-port.js";
import { OPENCODE_CONTROL_MUTATIONS } from "./opencode-native-port.js";
import { encodeOpenCodeNativeFailure, parseOpenCodeReadInput, parseOpenCodeMutationInput } from "./opencode-native-codecs.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { openCodeRuntimeCommandSchema, openCodeRuntimeCommandLane, openCodeRuntimeOperations,
  type OpenCodeRuntimeCommand, type OpenCodeRuntimeInfo } from "./opencode-runtime-wire.js";
import type { OpenCodeRuntime } from "./opencode-runtime.js";

interface PortAttachment { readonly host: OpenCodeNativeHost; readonly port: OpenCodeNativePort; readonly recovery: boolean; }
interface ObservationAttachment { readonly purpose: "evidence" | "presentation"; readonly portId: string; readonly observation: OpenCodePortObservation;
  end?: OpenCodeObservationEnd; polling: boolean; }

/** One handler registration for SSH and outbound peers. The service registry
 * owns native runtimes; this object owns only disposable attachment references. */
export function registerOpenCodeRuntimeHost(input: {
  readonly registry: SidecarOperationRegistry;
  readonly channel: SidecarRuntimeChannel;
  readonly hosts: OpenCodeRuntimeHostRegistry;
  readonly services: PersistentSidecarServiceRegistry;
  readonly controllerEpoch: number;
}): () => void {
  const runtimes = new Map<string, "attached" | "recovery" | "administration">();
  const ports = new Map<string, PortAttachment>();
  const observations = new Map<string, ObservationAttachment>();
  let detached = false;
  const assertController = () => {
    if (detached) throw denied();
    input.services.assertController(input.controllerEpoch);
  };
  const closeObservation = async (id: string) => {
    const item = observations.get(id);
    if (!item) return;
    observations.delete(id); await item.observation.close();
  };
  const releasePort = (id: string) => {
    const item = ports.get(id);
    if (!item) return;
    ports.delete(id);
    for (const [observationId, observation] of observations) {
      if (observation.portId === id) void closeObservation(observationId);
    }
    item.host.release(item.port);
  };
  const portFor = (command: Extract<OpenCodeRuntimeCommand, { portId: string }>) => {
    if (!["attached", "recovery"].includes(runtimes.get(command.runtimeId) ?? "")) throw denied();
    const item = ports.get(command.portId);
    if (!item || item.port.authority.runtimeId !== command.runtimeId ||
        item.port.authority.nativeGeneration !== command.nativeGeneration || item.port.lifetime.aborted) throw denied();
    return item;
  };
  const observationFor = (command: Extract<OpenCodeRuntimeCommand, { observationId: string }>) => {
    portFor(command);
    const item = observations.get(command.observationId);
    if (!item || item.portId !== command.portId) throw denied();
    return item;
  };
  const execute = async (command: OpenCodeRuntimeCommand, signal: AbortSignal): Promise<unknown> => {
    assertController();
    if (command.controllerEpoch !== input.controllerEpoch || command.serviceIncarnation !== input.services.serviceIncarnation) throw denied();
    switch (command.action) {
      case "ensure": case "lookup": case "lookup_recovery": {
        const runtime = await input.hosts[command.action === "lookup_recovery" ? "lookup" : command.action](command.configuration, input.controllerEpoch);
        assertController();
        if (!runtime) return null;
        const recovery = command.action === "lookup_recovery";
        if (!recovery) {
          input.services.assertAdmission(input.controllerEpoch);
          if (!command.configuration.instance.enabled || !command.configuration.connections.some(connection => connection.enabled)) throw denied();
        }
        runtimes.set(runtime.runtimeId, recovery ? "recovery" : "attached"); return runtimeInfo(runtime);
      }
      case "lookup_retained": {
        const runtime = await input.hosts.lookupRetained(command.backendInstanceId, input.controllerEpoch);
        assertController();
        if (!runtime) return null;
        if (!runtimes.has(runtime.runtimeId)) runtimes.set(runtime.runtimeId, "administration");
        return runtimeInfo(runtime);
      }
    }
    if (!runtimes.has(command.runtimeId)) throw denied();
    const runtime = input.hosts.getRuntime(command.runtimeId);
    switch (command.action) {
      case "info": return runtimeInfo(runtime);
      case "inspect": return input.hosts.inspect(command.runtimeId);
      case "stop": {
        await input.hosts.stop(command.runtimeId, command.expectedRevision, command.force);
        for (const [id, item] of ports) if (item.port.authority.runtimeId === command.runtimeId) releasePort(id);
        runtimes.delete(command.runtimeId); return { ok: true };
      }
    }
    if (!["attached", "recovery"].includes(runtimes.get(command.runtimeId) ?? "") || runtime.snapshot().generation !== command.nativeGeneration) throw denied();
    if (command.action === "assert_current") { await runtime.assertCurrent(); return { ok: true }; }
    if (command.action === "acquire" || command.action === "acquire_retained") {
      const recovery = command.action === "acquire_retained";
      if (recovery ? runtimes.get(command.runtimeId) !== "recovery" : runtimes.get(command.runtimeId) !== "attached") throw denied();
      if (!recovery) input.services.assertAdmission(input.controllerEpoch);
      if (ports.size >= 4_096) throw denied();
      const host = input.hosts.get(command.runtimeId), port = recovery ? host.acquireRetained(command.target) : host.acquire(command.target), portId = randomUUID();
      ports.set(portId, { host, port, recovery }); return { portId, authority: port.authority };
    }
    const { port, recovery } = portFor(command);
    switch (command.action) {
      case "release": releasePort(command.portId); return { ok: true };
      case "read": {
        if (recovery && ["listSessions", "listModels", "listSkills", "getDefaultModel"].includes(command.method)) throw denied();
        return port.read(command.method, parseOpenCodeReadInput(command.method, command.input),
          command.deadlineAt === null ? { signal } : { deadlineAt: command.deadlineAt, signal });
      }
      case "mutate": {
        if (!OPENCODE_CONTROL_MUTATIONS.has(command.method)) {
          // Outcome lookup is explicit: a recovery attachment never dispatches
          // or infers a replay from an identity without its original request.
          if (recovery) throw denied();
          input.services.assertAdmission(input.controllerEpoch);
        }
        // A disconnected/cancelled carrier cannot cancel an admitted write.
        return port.mutate(command.method, parseOpenCodeMutationInput(command.method, command.input), command.control);
      }
      case "outcome": return port.outcome(command.method, command.identity);
      case "acknowledge_mutation": await port.acknowledgeMutation(command.method, command.identity); return { ok: true };
      case "acknowledge_operation": await port.acknowledgeOperation(command.identity); return { ok: true };
      case "observe_open": {
        if (observations.size >= 512) throw denied();
        const observation = port.observe({ signal, purpose: command.purpose, ...(command.after ? { after: command.after } : {}) });
        const observationId = randomUUID(), attachment: ObservationAttachment = { purpose: command.purpose, portId: command.portId, observation, polling: false };
        observations.set(observationId, attachment);
        void observation.ended.then(end => { attachment.end = end; });
        try { const boundary = await observation.ready; assertController(); return { observationId, boundary }; }
        catch (error) { await closeObservation(observationId); throw error; }
      }
      case "observe_poll": {
        const item = observationFor(command);
        if (item.purpose !== command.purpose) throw denied();
        if (item.polling) throw denied();
        item.polling = true;
        try {
          if (!item.end) {
            // Finite polls free ordinary-lane slots even for silent sessions.
            try { await item.observation.wait(AbortSignal.any([signal, AbortSignal.timeout(1_000)])); }
            catch (error) { if (!item.end && !(error instanceof Error && error.name === "TimeoutError")) throw error; }
          }
          assertController();
          return item.end ? { status: "ended", reason: item.end.reason,
            ...(item.end.error ? { failure: encodeOpenCodeNativeFailure(item.end.error, false) } : {}) }
            : { status: "events", records: item.observation.drain() };
        } finally { item.polling = false; }
      }
      case "observe_ack": await observationFor(command).observation.acknowledge(command.cursor); return { ok: true };
      case "observe_close": observationFor(command); await closeObservation(command.observationId); return { ok: true };
    }
  };
  for (const operation of openCodeRuntimeOperations) input.registry.register(operation, async (body, context) => {
    let command: OpenCodeRuntimeCommand | undefined;
    try {
      assertController();
      command = openCodeRuntimeCommandSchema.parse(await input.channel.decodeBody(body));
      context.signal.throwIfAborted(); assertController();
      if (openCodeRuntimeCommandLane(command) !== operation.lane) throw denied();
      const value = await execute(command, context.signal);
      assertController();
      return input.channel.encodeBody({ status: "ok", value });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const reason = command?.action === "stop" ? stopRefusals.get(code) : undefined;
      return input.channel.encodeBody(reason ? { status: "control_rejected", reason }
        : { status: "failed", failure: encodeOpenCodeNativeFailure(error, command?.action === "mutate") });
    }
  });
  return () => {
    if (detached) return;
    detached = true;
    for (const id of [...ports.keys()]) releasePort(id);
    runtimes.clear();
  };
}
function runtimeInfo(runtime: OpenCodeRuntime): OpenCodeRuntimeInfo {
  return { runtimeId: runtime.runtimeId, nativeNamespaceKey: runtime.nativeNamespaceKey, snapshot: runtime.snapshot() };
}
const stopRefusals = new Map<string, "confirmation_stale" | "blocked" | "cleanup_unproven">([
  ["opencode_runtime_confirmation_stale", "confirmation_stale"],
  ["opencode_runtime_restart_blocked", "blocked"],
  ["opencode_runtime_cleanup_unproven", "cleanup_unproven"],
] as const);
function denied(): OpenCodeRuntimeError { return new OpenCodeRuntimeError("opencode_request_authority_mismatch"); }
