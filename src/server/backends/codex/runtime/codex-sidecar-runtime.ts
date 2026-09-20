import { environmentVariableOverridesSchema } from "../../../../shared/protocol/environment-variables.js";
import { sidecarUpgradeBlockerSchema } from "../../../../internal/sidecar-protocol/service-management-v1.js";
import { z } from "zod";
import { SidecarOperationError, type SidecarOperationRegistry, type SidecarOperationDefinition } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { BackendRuntimeControlRejectedError } from "../../runtime-control.js";
import type { SidecarRuntimeChannel } from "../../../sidecar/runtime-channel.js";
import { sidecarRuntimeBodySchema } from "../../../sidecar/runtime-body-channel.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import { codexRuntimeConnectionSchema } from "../codex-backend-configuration.js";
import { CODEX_APP_SERVER_RELEASE } from "../codex-release-guard.js";
import type { CodexRpcRequestReceipt } from "../rpc/codex-rpc-client.js";
import { CodexRpcDeliveryError, CodexRpcProtocolError, CodexRpcRemoteError } from "../rpc/errors.js";
import { codexRuntimeCommandSchema, codexRuntimeEventSchema, codexRuntimeOutcomeSchema, codexRuntimeOutcomeReferencesSchema, codexRuntimeSnapshotSchema, type CodexRuntimeCommand } from "./codex-runtime-wire.js";
import type { CodexRuntimeAuthority, CodexRuntimeConnection, CodexRuntimeEvent, CodexRuntimeOutcome } from "./codex-runtime-protocol.js";
import type { CodexRuntimeConfiguration, CodexRuntimeHostRegistry } from "./codex-runtime-host-registry.js";
import { CodexRuntimeEventOrder } from "./codex-runtime-event-order.js";
import { attachmentDiagnostic, type AttachmentDiagnosticFields } from "../../../diagnostics/attachment-diagnostics.js";

const capability = { capabilityId: "codex_runtime", majorVersion: 1 } as const;
const stopRefusals = new Map<string, BackendRuntimeControlRejectedError["reason"]>([
  ["codex_runtime_confirmation_stale", "confirmation_stale"],
  ["codex_runtime_restart_blocked", "blocked"],
  ["codex_runtime_outcomes_unacknowledged", "blocked"],
  ["codex_runtime_cleanup_unproven", "cleanup_unproven"],
]);
const id = z.string().min(1).max(512);
const instanceSchema = z.strictObject({ id, tenantId: id, kind: z.literal("codex_app_server"), label: z.string().min(1).max(512), enabled: z.boolean(), configurationRevision: z.number().int().nonnegative(), protocolRelease: z.literal(CODEX_APP_SERVER_RELEASE) });
const connectionSchema = z.strictObject({ id, tenantId: id, ownerPrincipalId: id, templateId: id, kind: z.literal("codex_app_server"), backendInstanceId: id, executionEnvironmentId: id, label: z.string().min(1).max(512), enabled: z.boolean(), configurationRevision: z.number().int().nonnegative() });
const configurationSchema = z.strictObject({ startupEnvironmentVariables: environmentVariableOverridesSchema.optional(), instance: instanceSchema, connections: z.array(connectionSchema).min(1).max(256), connection: codexRuntimeConnectionSchema });
const successSchema = z.strictObject({ ok: z.literal(true) });
const reattachResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("attached"), receipt: z.strictObject({ generation: z.number().int().positive(), inboundSequence: z.number().int().nonnegative(), result: z.unknown() }) }),
  z.strictObject({ status: z.literal("remote_error"), code: z.number().int(), message: z.string().max(8192), generation: z.number().int().positive(), method: id, data: z.unknown().optional() }),
  z.strictObject({ status: z.literal("delivery_error"), code: z.string().min(1).max(256), delivery: z.enum(["not_sent", "sent_outcome_unknown"]), generation: z.number().int().positive(), method: id.optional() }),
  z.strictObject({ status: z.literal("protocol_error"), code: z.string().min(1).max(256), generation: z.number().int().positive() }),
]);
export const codexRuntimeEnsureOperation: SidecarOperationDefinition<{ configuration: CodexRuntimeConfiguration }, { runtimeId: string }> = {
  ...capability, operation: "runtime.ensure", requestSchema: z.strictObject({ configuration: configurationSchema }),
  responseSchema: z.strictObject({ runtimeId: id }), lane: "operation", maximumDeadlineMilliseconds: 120_000,
};
export const codexRuntimeLookupOperation: SidecarOperationDefinition<{ configuration: CodexRuntimeConfiguration }, { runtimeId: string | null }> = {
  ...capability, operation: "runtime.lookup", requestSchema: z.strictObject({ configuration: configurationSchema }),
  responseSchema: z.strictObject({ runtimeId: id.nullable() }), lane: "control", maximumDeadlineMilliseconds: 120_000,
};
export const codexRuntimeExecuteOperation = {
  ...capability, operation: "runtime.execute", requestSchema: sidecarRuntimeBodySchema,
  responseSchema: sidecarRuntimeBodySchema, lane: "operation", maximumDeadlineMilliseconds: 600_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
export const codexRuntimeOperations = [codexRuntimeEnsureOperation, codexRuntimeLookupOperation, codexRuntimeExecuteOperation] as const;
const eventDefinition = { ...capability, event: "runtime.event", schema: z.strictObject({ runtimeId: id, body: sidecarRuntimeBodySchema }) };

/** Register once per authenticated peer; hosts/receipts remain service-owned.
 * Queued events are transient transport buffers, bounded independently of
 * provider output. An absent/slow subscriber is detached rather than blocking
 * the provider's stdout reader or evicting pending results. */
export function registerCodexRuntimeHost(input: {
  registry: SidecarOperationRegistry; channel: SidecarRuntimeChannel;
  hosts: CodexRuntimeHostRegistry; services: PersistentSidecarServiceRegistry;
  controllerEpoch: number; onDetach(): void;
}): () => void {
  let detached = false;
  let eventBytes = 0;
  let eventCount = 0;
  const events = new Map<string, CodexRuntimeEventOrder>();
  const attached = new Map<string, CodexRuntimeAuthority>();
  const eventOrder = (runtimeId: string) => {
    let order = events.get(runtimeId);
    if (!order) { order = new CodexRuntimeEventOrder(); events.set(runtimeId, order); }
    return order;
  };
  const forgetAttachment = (runtimeId: string) => {
    attached.delete(runtimeId);
    const order = events.get(runtimeId);
    order?.clearAffinities();
    // Preserve queued fences across detach/reattach on this same carrier.
    if (order?.idle) events.delete(runtimeId);
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    for (const [runtimeId, authority] of attached) {
      // A confirmed stop can remove the host before a peer/watchdog detaches.
      // Lookup itself can throw; one retired host must not abort peer cleanup.
      try { void input.hosts.get(runtimeId).detach(authority).catch(() => undefined); }
      catch { /* The runtime is already gone. */ }
    }
    attached.clear();
    events.clear();
    input.onDetach();
  };
  const sendEvent = (runtimeId: string, event: CodexRuntimeEvent) => {
    if (detached) return;
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (eventBytes + size > 256 * 1024 * 1024 || eventCount >= 1024) { detach(); return; }
    eventBytes += size; eventCount++;
    const order = eventOrder(runtimeId);
    void order.enqueue(event, async () => {
      if (detached) return;
      const body = await input.channel.encodeBody(event);
      await input.channel.peer.sendEvent({ ...eventDefinition, payload: { runtimeId, body } });
    }).catch(detach).finally(() => {
      eventBytes -= size; eventCount--;
      if (!attached.has(runtimeId) && order.idle && events.get(runtimeId) === order) events.delete(runtimeId);
    });
  };
  input.registry.register(codexRuntimeEnsureOperation, async ({ configuration }) => {
    if (detached) throw new Error("codex_runtime_attachment_detached");
    const host = await input.hosts.ensure(configuration, input.controllerEpoch);
    return { runtimeId: host.runtimeId };
  });
  input.registry.register(codexRuntimeLookupOperation, async ({ configuration }) => {
    if (detached) throw new Error("codex_runtime_attachment_detached");
    return { runtimeId: (await input.hosts.lookup(configuration, input.controllerEpoch))?.runtimeId ?? null };
  });
  input.registry.register(codexRuntimeExecuteOperation, async body => {
    if (detached) throw new Error("codex_runtime_attachment_detached");
    const command = codexRuntimeCommandSchema.parse(await input.channel.decodeBody(body));
    if (command.authority.controllerId !== String(input.controllerEpoch)) throw new Error("codex_runtime_controller_stale");
    const host = input.hosts.get(command.authority.runtimeId);
    if (command.action === "inspect" || command.action === "stop" || command.action === "recover_outcomes" || command.action === "recover_outcome" || command.action === "acknowledge_recovered_outcome") {
      input.services.assertController(input.controllerEpoch);
      host.assertScope(command.authority);
    } else if (command.action !== "attach") host.assertAuthority(command.authority);
    const order = eventOrder(host.runtimeId);
    // Capture response affinity before a reply settles its pending request.
    const affinity = order.commandAffinity(command);
    let result: unknown;
    switch (command.action) {
      case "shell_path": {
        input.services.assertAdmission(input.controllerEpoch);
        const runtime = input.hosts.getRuntime(host.runtimeId);
        if (runtime.configuration.connection.ownership !== "owned" || !runtime.configuration.childEnvironment) throw new Error("codex_owned_environment_unavailable");
        result = { path: runtime.configuration.childEnvironment.PATH ?? "" };
        break;
      }
      case "evict_thread":
        input.services.assertController(input.controllerEpoch);
        await host.evictThread(command.authority, command.threadId, command.generation);
        result = { ok: true }; break;
      case "idle": {
        input.services.assertController(input.controllerEpoch);
        const runtime = input.hosts.getRuntime(host.runtimeId);
        result = { idle: await host.idle(command.authority, command.generation, async () => {
          input.services.assertController(input.controllerEpoch);
          if (input.hosts.managedTui.admissionFrozen(host.runtimeId)) return false;
          const releaseAdmission = input.hosts.managedTui.freezeAdmission(host.runtimeId);
          try {
            const tui = input.hosts.managedTui.activity(host.runtimeId);
            if (tui.state !== "idle" || tui.blockers.length) return false;
            await runtime.supervisor.park();
            return true;
          } finally { releaseAdmission(); }
        }) };
        break;
      }
      case "wake":
        input.services.assertAdmission(input.controllerEpoch);
        host.cancelIdle();
        await input.hosts.getRuntime(host.runtimeId).supervisor.wake();
        result = { ok: true }; break;
      case "attach": {
        input.services.assertController(input.controllerEpoch);
        const snapshot = await host.attach(command.authority, event => sendEvent(host.runtimeId, event));
        for (const request of snapshot.pendingRequests) order.rememberRequest(request);
        result = snapshot;
        attached.set(host.runtimeId, command.authority);
        break;
      }
      case "detach":
        await host.detach(command.authority);
        forgetAttachment(host.runtimeId);
        result = { ok: true }; break;
      case "submit": {
        if (!host.isRetainedThreadRead(command.input)) input.services.assertAdmission(input.controllerEpoch);
        const rejectReservation = order.reserveSubmission(command);
        try { result = await host.submit(command.authority, command.input); }
        catch (error) {
          rejectReservation();
          if (!(error instanceof CodexRpcDeliveryError)) throw error;
          result = { status: "failed", operationId: command.input.operationId, method: command.input.method, failure: { kind: "delivery", code: error.message, delivery: error.delivery, generation: error.generation, method: command.input.method } };
        }
        break;
      }
      case "outcome": result = await host.outcome(command.authority, command.operationId); break;
      case "recover_outcomes": result = host.retainedOutcomeReferences(); break;
      case "recover_outcome": result = host.readRetainedOutcome(command.operationId); break;
      case "acknowledge_recovered_outcome": host.acknowledgeRetainedOutcome(command.operationId); order.acknowledge(command.operationId); result = { ok: true }; break;
      case "acknowledge": await host.acknowledge(command.authority, command.operationId); order.acknowledge(command.operationId); result = { ok: true }; break;
      case "respond":
        // Exact pending requests belong to already-admitted work; the host
        // validates their generation, identity and response shape.
        input.services.assertController(input.controllerEpoch);
        await host.respond(command.authority, command.input); result = { ok: true }; break;
      case "inspect":
        result = await input.hosts.inspect(command.authority.runtimeId); break;
      case "stop":
        try { await input.hosts.stop(command.authority.runtimeId, command.expectedRevision, command.force); }
        catch (error) {
          if (error instanceof Error && stopRefusals.has(error.message)) throw new SidecarOperationError(error.message, false, { cause: error });
          throw error;
        }
        forgetAttachment(host.runtimeId);
        result = { ok: true }; break;
      case "reattach_thread": {
        // Reattachment only reads an existing resident session; no native
        // thread/resume or thread/start is performed by this host path.
        input.services.assertController(input.controllerEpoch);
        try {
          const receipt = await host.reattachThread(command.authority, command.threadId, command.timeoutMilliseconds);
          result = receipt ? { status: "attached", receipt } : { status: "missing" };
        } catch (error) {
          // Preserve provider read semantics across the private carrier. In
          // particular, a new thread has no materialized history before its
          // first message; the conversation handle already handles that state.
          if (error instanceof CodexRpcRemoteError) result = { status: "remote_error", code: error.code, message: error.message.slice(0, 8192), generation: error.generation, method: error.method, ...(error.data === undefined ? {} : { data: error.data }) };
          else if (error instanceof CodexRpcDeliveryError) result = { status: "delivery_error", code: error.message, delivery: error.delivery, generation: error.generation, ...(error.method === undefined ? {} : { method: error.method }) };
          else if (error instanceof CodexRpcProtocolError) result = { status: "protocol_error", code: error.message, generation: error.generation };
          else throw error;
        }
        result = reattachResultSchema.parse(result);
        break;
      }
      case "retire":
        input.services.assertAdmission(input.controllerEpoch);
        await host.retire(command.authority, command.generation, command.reason); result = { ok: true }; break;
    }
    // Preserve the native thread's notification/receipt fence. Other threads
    // can progress independently; runtime-wide lifecycle events still fence
    // every thread. Receipt release and inspection carry no transcript fence.
    if (command.action !== "acknowledge" && command.action !== "acknowledge_recovered_outcome" && command.action !== "inspect") {
      await order.fence(affinity);
    }
    return await input.channel.encodeBody(result);
  });
  return detach;
}

export class CodexSidecarRuntimeConnection implements CodexRuntimeConnection {
  constructor(readonly channel: SidecarRuntimeChannel) {}
  readonly #listeners = new Map<string, () => void>();
  async ensure(configuration: CodexRuntimeConfiguration): Promise<string> {
    return (await this.channel.call(codexRuntimeEnsureOperation, { configuration })).runtimeId;
  }
  async lookup(configuration: CodexRuntimeConfiguration): Promise<string | undefined> {
    return (await this.channel.call(codexRuntimeLookupOperation, { configuration })).runtimeId ?? undefined;
  }
  async attach(authority: CodexRuntimeAuthority, listener: (event: CodexRuntimeEvent) => void) {
    let chain = Promise.resolve();
    this.#listeners.get(authority.runtimeId)?.();
    const remove = this.channel.onEvent({ ...eventDefinition, listener: ({ runtimeId, body }) => {
      if (runtimeId !== authority.runtimeId) return;
      chain = chain.then(async () => {
        let stage = "event_body_decode";
        const started = performance.now();
        try {
          const decoded = await this.channel.decodeBody(body);
          stage = "event_schema_decode";
          const event = codexRuntimeEventSchema.parse(decoded);
          stage = "event_listener";
          listener(event);
        } catch (error) {
          this.#diagnostic(authority, "runtime_event_failed", { stage, durationMs: performance.now() - started,
            reason: "codex_runtime_event_invalid", requestedClose: true }, error);
          throw error;
        }
      });
      void chain.catch(async () => {
        try { await this.channel.peer.close("codex_runtime_event_invalid"); }
        catch (error) { this.#diagnostic(authority, "runtime_event_close_failed", { stage: "event_close" }, error); }
      });
    } });
    this.#listeners.set(authority.runtimeId, remove);
    try { return codexRuntimeSnapshotSchema.parse(await this.#execute({ action: "attach", authority })); }
    catch (error) { remove(); this.#listeners.delete(authority.runtimeId); throw error; }
  }
  async evictThread(authority: CodexRuntimeAuthority, threadId: string, generation: number): Promise<void> {
    successSchema.parse(await this.#execute({ action: "evict_thread", authority, threadId, generation }));
  }
  async idle(authority: CodexRuntimeAuthority, generation: number): Promise<boolean> {
    return z.strictObject({ idle: z.boolean() }).parse(await this.#execute({ action: "idle", authority, generation })).idle;
  }
  async wake(authority: CodexRuntimeAuthority): Promise<void> {
    successSchema.parse(await this.#execute({ action: "wake", authority }));
  }
  async detach(authority: CodexRuntimeAuthority): Promise<void> {
    try { successSchema.parse(await this.#execute({ action: "detach", authority })); }
    finally { this.#listeners.get(authority.runtimeId)?.(); this.#listeners.delete(authority.runtimeId); }
  }
  async submit(authority: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["submit"]>[1]): Promise<CodexRuntimeOutcome> {
    return codexRuntimeOutcomeSchema.parse(await this.#execute({ action: "submit", authority, input }));
  }
  async outcome(authority: CodexRuntimeAuthority, operationId: string): Promise<CodexRuntimeOutcome> {
    return codexRuntimeOutcomeSchema.parse(await this.#execute({ action: "outcome", authority, operationId }));
  }
  async recoverOutcomes(authority: CodexRuntimeAuthority) {
    return codexRuntimeOutcomeReferencesSchema.parse(await this.#execute({ action: "recover_outcomes", authority }));
  }
  async recoverOutcome(authority: CodexRuntimeAuthority, operationId: string): Promise<CodexRuntimeOutcome> {
    return codexRuntimeOutcomeSchema.parse(await this.#execute({ action: "recover_outcome", authority, operationId }));
  }
  async acknowledgeRecoveredOutcome(authority: CodexRuntimeAuthority, operationId: string): Promise<void> {
    successSchema.parse(await this.#execute({ action: "acknowledge_recovered_outcome", authority, operationId }));
  }
  async acknowledge(authority: CodexRuntimeAuthority, operationId: string): Promise<void> { successSchema.parse(await this.#execute({ action: "acknowledge", authority, operationId })); }
  async respond(authority: CodexRuntimeAuthority, input: Parameters<CodexRuntimeConnection["respond"]>[1]): Promise<void> { successSchema.parse(await this.#execute({ action: "respond", authority, input })); }
  async retire(authority: CodexRuntimeAuthority, generation: number, reason: string): Promise<void> { successSchema.parse(await this.#execute({ action: "retire", authority, generation, reason })); }
  async reattachThread(authority: CodexRuntimeAuthority, threadId: string, timeoutMilliseconds: number): Promise<CodexRpcRequestReceipt<unknown> | undefined> {
    const value = reattachResultSchema.parse(await this.#execute({ action: "reattach_thread", authority, threadId, timeoutMilliseconds }));
    if (value.status === "remote_error") throw new CodexRpcRemoteError(value);
    if (value.status === "delivery_error") throw new CodexRpcDeliveryError(value);
    if (value.status === "protocol_error") throw new CodexRpcProtocolError(value.code, value.generation);
    return value.status === "attached" ? value.receipt : undefined;
  }
  async appliedOwnedPath(authority: CodexRuntimeAuthority): Promise<string> {
    return z.strictObject({ path: z.string().max(16384).refine(value => !value.includes("\0")) }).parse(await this.#execute({ action: "shell_path", authority })).path;
  }
  async inspect(authority: CodexRuntimeAuthority) {
    return z.strictObject({ state: z.enum(["idle", "active", "unknown"]), startupEnvironmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/), incarnation: id, revision: z.string().min(1).max(160), blockers: z.array(sidecarUpgradeBlockerSchema).max(7) }).parse(await this.#execute({ action: "inspect", authority }));
  }
  async stop(authority: CodexRuntimeAuthority, expectedRevision: string, force: boolean): Promise<void> {
    try { successSchema.parse(await this.#execute({ action: "stop", authority, expectedRevision, force })); }
    catch (error) {
      const reason = error instanceof SidecarOperationError ? stopRefusals.get(error.code) : undefined;
      if (reason) throw new BackendRuntimeControlRejectedError(reason, { cause: error });
      throw error;
    }
  }
  close(): void { for (const remove of this.#listeners.values()) remove(); this.#listeners.clear(); }
  async #execute(command: CodexRuntimeCommand): Promise<unknown> {
    let stage = `command_${command.action}_validate`;
    let started = performance.now();
    const correlation = command.action === "submit" ? { operationId: command.input.operationId, method: command.input.method }
      : "operationId" in command ? { operationId: command.operationId } : {};
    const complete = () => {
      const durationMs = performance.now() - started;
      if (durationMs >= 1000) this.#diagnostic(command.authority, "runtime_command_slow", { stage, ...correlation, durationMs });
    };
    try {
      const request = codexRuntimeCommandSchema.parse(command);
      stage = `command_${command.action}_body_encode`;
      started = performance.now();
      const body = await this.channel.encodeBody(request);
      complete();
      stage = `command_${command.action}_rpc_wait`;
      started = performance.now();
      const response = await this.channel.call(codexRuntimeExecuteOperation, body);
      complete();
      stage = `command_${command.action}_body_decode`;
      started = performance.now();
      const decoded = await this.channel.decodeBody(response);
      complete();
      return decoded;
    } catch (error) {
      this.#diagnostic(command.authority, "runtime_command_failed", { stage, ...correlation, durationMs: performance.now() - started }, error);
      throw error;
    }
  }
  #diagnostic(authority: CodexRuntimeAuthority, event: string, fields: AttachmentDiagnosticFields, error?: unknown): void {
    attachmentDiagnostic(event, { backendInstanceId: authority.scope.backendInstanceId,
      executionEnvironmentId: authority.scope.executionEnvironmentId, controllerEpoch: Number(authority.controllerId), ...fields }, error);
  }
}
