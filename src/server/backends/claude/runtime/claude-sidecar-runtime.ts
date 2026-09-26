import { z } from "zod";
import { sidecarUpgradeBlockerSchema } from "../../../../internal/sidecar-protocol/service-management-v1.js";
import { SidecarOperationError, type SidecarOperationDefinition, type SidecarOperationRegistry } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { BackendRuntimeControlRejectedError } from "../../runtime-control.js";
import type { SidecarRuntimeChannel } from "../../../sidecar/runtime-channel.js";
import { sidecarRuntimeBodySchema } from "../../../sidecar/runtime-body-channel.js";
import { claudePersistentCommandSchema, claudePersistentConfigurationSchema, claudePersistentEventSchema,
  type ClaudePersistentCommand, type ClaudePersistentConfiguration, type ClaudePersistentEvent } from "./claude-persistent-runtime-wire.js";
import type { ClaudePersistentRuntimeRegistry } from "./claude-persistent-runtime-registry.js";

const capability = { capabilityId: "claude_persistent_runtime", majorVersion: 1 } as const;
const stopRefusals = new Map<string, BackendRuntimeControlRejectedError["reason"]>([
  ["claude_persistent_confirmation_stale", "confirmation_stale"],
  ["claude_persistent_restart_blocked", "blocked"],
  ["claude_persistent_outcomes_unacknowledged", "blocked"],
  ["claude_persistent_cleanup_unproven", "cleanup_unproven"],
]);
export const claudePersistentRuntimeEnsureOperation = {
  ...capability, operation: "runtime.ensure", requestSchema: claudePersistentConfigurationSchema,
  responseSchema: z.strictObject({ runtimeId: z.string().uuid() }), lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<ClaudePersistentConfiguration, { runtimeId: string }>;
export const claudePersistentRuntimeExecuteOperation = {
  ...capability, operation: "runtime.execute", requestSchema: sidecarRuntimeBodySchema, responseSchema: sidecarRuntimeBodySchema,
  lane: "operation", maximumDeadlineMilliseconds: 600_000,
} satisfies SidecarOperationDefinition<z.infer<typeof sidecarRuntimeBodySchema>, z.infer<typeof sidecarRuntimeBodySchema>>;
const lookupRequestSchema = z.strictObject({ configuration: claudePersistentConfigurationSchema, controllerEpoch: z.number().int().positive() });
const administrationRequestSchema = lookupRequestSchema.extend({ runtimeId: z.string().uuid() });
export const claudePersistentRuntimeLookupOperation = {
  ...capability, operation: "runtime.lookup", requestSchema: lookupRequestSchema,
  responseSchema: z.strictObject({ runtimeId: z.string().uuid().nullable() }), lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof lookupRequestSchema>, { runtimeId: string | null }>;
const count = z.number().int().nonnegative().max(1_000_000);
const inspectionSchema = z.strictObject({ startupEnvironmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["idle", "active", "unknown"]), incarnation: z.string().uuid(),
  revision: z.string().min(1).max(512), blockers: z.array(sidecarUpgradeBlockerSchema).max(7),
  // Retained sessions whose work needs a main attachment, live work first.
  retainedSessionIds: z.array(z.string().uuid()).max(32),
  activity: z.strictObject({ runningTurns: count, pendingInteractions: count, unacknowledgedSessions: count,
    background: z.strictObject({ agents: count, commands: count, other: count, unknownSessions: count }) }) });
export const claudePersistentRuntimeInspectOperation = {
  ...capability, operation: "runtime.inspect", requestSchema: administrationRequestSchema, responseSchema: inspectionSchema,
  lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof administrationRequestSchema>, z.infer<typeof inspectionSchema>>;
const stopRequestSchema = administrationRequestSchema.extend({ expectedRevision: z.string().min(1).max(512), force: z.boolean() });
export const claudePersistentRuntimeStopOperation = {
  ...capability, operation: "runtime.stop", requestSchema: stopRequestSchema, responseSchema: z.strictObject({ stopped: z.literal(true) }),
  lane: "operation", maximumDeadlineMilliseconds: 120_000,
} satisfies SidecarOperationDefinition<z.infer<typeof stopRequestSchema>, { stopped: true }>;
export const claudePersistentRuntimeOperations = [claudePersistentRuntimeEnsureOperation, claudePersistentRuntimeExecuteOperation,
  claudePersistentRuntimeLookupOperation, claudePersistentRuntimeInspectOperation, claudePersistentRuntimeStopOperation] as const;
const eventDefinition = { ...capability, event: "runtime.event", schema: z.strictObject({ runtimeId: z.string().uuid(), body: sidecarRuntimeBodySchema }) };

export function registerClaudePersistentRuntimeHost(input: {
  registry: SidecarOperationRegistry; channel: SidecarRuntimeChannel; hosts: ClaudePersistentRuntimeRegistry;
  controllerEpoch: number; onDetach(): void;
}): () => void {
  let detached = false;
  const attached = new Set<string>();
  let eventCount = 0;
  let eventBytes = 0;
  let chain = Promise.resolve();
  const detach = () => {
    if (detached) return;
    detached = true;
    for (const id of attached) { try { input.hosts.get(id).detach(input.controllerEpoch); } catch { /* Already stopped. */ } }
    attached.clear(); input.onDetach();
  };
  const existing = (request: z.infer<typeof lookupRequestSchema>) => {
    if (detached) throw new Error("claude_persistent_attachment_detached");
    if (request.controllerEpoch !== input.controllerEpoch) throw new Error("claude_persistent_controller_stale");
    return input.hosts.lookup(request.configuration, request.controllerEpoch);
  };
  const assertIncarnation = (request: z.infer<typeof administrationRequestSchema>) => {
    const host = existing(request);
    if (!host || host.runtimeId !== request.runtimeId) throw new Error("claude_persistent_administration_incarnation_changed");
    return host;
  };
  input.registry.register(claudePersistentRuntimeLookupOperation, request => ({ runtimeId: existing(request)?.runtimeId ?? null }));
  input.registry.register(claudePersistentRuntimeInspectOperation, request => input.hosts.inspect(assertIncarnation(request).runtimeId));
  input.registry.register(claudePersistentRuntimeStopOperation, async request => {
    try { await input.hosts.stop(assertIncarnation(request).runtimeId, request.expectedRevision, request.force); }
    catch (error) {
      if (error instanceof Error && stopRefusals.has(error.message)) throw new SidecarOperationError(error.message, false, { cause: error });
      throw error;
    }
    return { stopped: true };
  });
  input.registry.register(claudePersistentRuntimeEnsureOperation, configuration => {
    if (detached) throw new Error("claude_persistent_attachment_detached");
    return { runtimeId: input.hosts.ensure(configuration, input.controllerEpoch).runtimeId };
  });
  input.registry.register(claudePersistentRuntimeExecuteOperation, async body => {
    if (detached) throw new Error("claude_persistent_attachment_detached");
    const command = claudePersistentCommandSchema.parse(await input.channel.decodeBody(body));
    if (command.controllerEpoch !== input.controllerEpoch) throw new Error("claude_persistent_controller_stale");
    const host = input.hosts.get(command.runtimeId);
    attached.add(host.runtimeId);
    const result = await host.execute(command, event => {
      if (detached) return;
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (eventCount >= 1024 || eventBytes + bytes > 64 * 1024 * 1024) { detach(); return; }
      eventCount++; eventBytes += bytes;
      chain = chain.then(async () => {
        if (detached) return;
        const encoded = await input.channel.encodeBody(event);
        await input.channel.peer.sendEvent({ ...eventDefinition, payload: { runtimeId: host.runtimeId, body: encoded } });
      }).catch(detach).finally(() => { eventCount--; eventBytes -= bytes; });
    });
    return await input.channel.encodeBody(result);
  });
  return detach;
}

export class ClaudeSidecarRuntimeConnection {
  constructor(readonly channel: SidecarRuntimeChannel) {}
  close(): void {}
  async ensure(configuration: ClaudePersistentConfiguration): Promise<string> {
    return (await this.channel.call(claudePersistentRuntimeEnsureOperation, configuration)).runtimeId;
  }
  async lookup(configuration: ClaudePersistentConfiguration, controllerEpoch: number): Promise<string | undefined> {
    return (await this.channel.call(claudePersistentRuntimeLookupOperation, { configuration, controllerEpoch })).runtimeId ?? undefined;
  }
  async inspect(input: z.infer<typeof administrationRequestSchema>) {
    return await this.channel.call(claudePersistentRuntimeInspectOperation, input);
  }
  async stop(input: z.infer<typeof stopRequestSchema>): Promise<void> {
    try { await this.channel.call(claudePersistentRuntimeStopOperation, input); }
    catch (error) {
      const reason = error instanceof SidecarOperationError ? stopRefusals.get(error.code) : undefined;
      if (reason) throw new BackendRuntimeControlRejectedError(reason, { cause: error });
      throw error;
    }
  }
  async execute(command: ClaudePersistentCommand): Promise<unknown> {
    const body = await this.channel.encodeBody(claudePersistentCommandSchema.parse(command));
    return await this.channel.decodeBody(await this.channel.call(claudePersistentRuntimeExecuteOperation, body));
  }
  onEvent(runtimeId: string, listener: (event: ClaudePersistentEvent) => void): () => void {
    let chain = Promise.resolve();
    return this.channel.onEvent({ ...eventDefinition, listener: event => {
      if (event.runtimeId !== runtimeId) return;
      chain = chain.then(async () => listener(claudePersistentEventSchema.parse(await this.channel.decodeBody(event.body))));
      void chain.catch(() => this.channel.peer.close("claude_persistent_event_invalid"));
    } });
  }
}
