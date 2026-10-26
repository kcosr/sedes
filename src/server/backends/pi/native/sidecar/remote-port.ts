import { z } from "zod";
import { isSidecarRevisionChanged, type SidecarRuntimeLease, type SidecarRuntimeProvider } from "../../../../sidecar/runtime-channel.js";
import { PiNativeError, type PiNativePort, type PiNativeRuntimeConfiguration, type PiNativeInspection, type PiNativeSessionIdentity, type PiNativeAttachment } from "../port.js";
import {
  piNativeHostCommandSchema, piNativeHostCommandLane, piNativeRuntimeOperations,
  piNativeExecuteOperation, piNativeControlOperation, piNativeHostResponseSchema,
  piNativeIdentitySchema, piNativeCatalogSchema, piNativeListSchema, piNativeHistorySchema,
  piNativeAttachmentSchema, piNativeOutcomeSchema, piNativeObservationSchema,
  piNativeInspectionSchema, piNativeSuccessSchema, type PiNativeHostCommandInput,
  piNativeRetirementSchema,
  piNativeDrainAttachmentSchema,
  piNativeObservationReleaseSchema,
  piNativeSessionDirectorySchema,
} from "./wire.js";

interface Attachment { readonly lease: SidecarRuntimeLease; readonly runtimeId: string; readonly recoveries: Set<string>; }
const runtimeSchema = z.strictObject({ runtimeId: z.string().uuid() });

/** Disposable main-side handle. Closing it never closes the execution host. */
export class PiNativeRemotePort implements PiNativePort {
  #attachment?: Attachment;
  #opening?: Promise<Attachment>;
  #recoveryAttachment?: Attachment;
  #recoveryOpening?: Promise<Attachment>;
  #identity?: { runtimeId: string; serviceIncarnation: string };
  readonly #handles = new Set<string>();
  readonly #recoveryHandles = new Map<string, PiNativeSessionIdentity & { readonly generation: string; readonly mode: "drain" | "control" }>();
  #closed = false;
  readonly #lifetime = new AbortController();
  constructor(readonly input: {
    readonly configuration: PiNativeRuntimeConfiguration;
    readonly sidecarRuntime: SidecarRuntimeProvider;
    readonly existingOnly?: boolean;
  }) {}

  async #get(signal?: AbortSignal, retainedOnly = false): Promise<Attachment> {
    signal?.throwIfAborted();
    if (this.#closed) throw new PiNativeError("pi_native_remote_port_closed");
    const retained = retainedOnly ? this.#recoveryAttachment : this.#attachment;
    if (retained) return retained;
    // One controller opens an attachment; caller cancellation cannot cancel
    // another caller's establishment or dispose an admitted remote owner.
    const opening = retainedOnly
      ? this.#recoveryOpening ??= this.#open(true).finally(() => { this.#recoveryOpening = undefined; })
      : this.#opening ??= this.#open(false).finally(() => { this.#opening = undefined; });
    const attachment = await opening;
    signal?.throwIfAborted();
    return attachment;
  }
  async #open(retainedOnly: boolean): Promise<Attachment> {
    let recovery = retainedOnly || (this.input.existingOnly ?? false);
    const lease = recovery
      ? await this.input.sidecarRuntime.acquireExisting(this.#lifetime.signal)
      : await this.input.sidecarRuntime.acquire(this.#lifetime.signal).catch(async error => {
        if (!this.#identity || !isSidecarRevisionChanged(error)) throw error;
        recovery = true;
        return this.input.sidecarRuntime.acquire(this.#lifetime.signal, { existingOnly: true });
      });
    try {
      if (this.#closed) throw new PiNativeError("pi_native_remote_port_closed");
      lease.channel.assertReady();
      if (!piNativeRuntimeOperations.every(operation => lease.channel.supportsOperation(operation))) throw new PiNativeError("pi_native_remote_runtime_unsupported");
      if (this.#identity && lease.serviceIncarnation !== this.#identity.serviceIncarnation) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
      const value = await call(lease, recovery
        ? { action: "lookup_retained", backendInstanceId: this.input.configuration.backendInstanceId }
        : { action: this.#identity ? "lookup" : "ensure", configuration: this.input.configuration }, this.#lifetime.signal);
      if (value === null) throw new PiNativeError("pi_native_retained_runtime_missing", "not_sent");
      const { runtimeId } = runtimeSchema.parse(value);
      if (this.#identity && runtimeId !== this.#identity.runtimeId) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
      if (this.#closed) throw new PiNativeError("pi_native_remote_port_closed");
      this.#identity = { runtimeId, serviceIncarnation: lease.serviceIncarnation };
      const attachment = { lease, runtimeId, recoveries: new Set<string>() };
      if (retainedOnly) this.#recoveryAttachment = attachment;
      else this.#attachment = attachment;
      void lease.closed.then(() => this.#discard(attachment), () => this.#discard(attachment));
      return attachment;
    } catch (error) { lease.release(); throw error; }
  }
  #discard(attachment: Attachment): void {
    if (this.#attachment === attachment) this.#attachment = undefined;
    else if (this.#recoveryAttachment === attachment) this.#recoveryAttachment = undefined;
    else return;
    attachment.lease.release();
  }
  async #invoke(action: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = input as { handleId?: string; sessionId?: string; sessionFile?: string; cwd?: string };
    const recovery = value.handleId ? this.#recoveryHandles.has(value.handleId)
      : action === "history" ? [...this.#recoveryHandles.values()].some(identity => identity.sessionId === value.sessionId && identity.sessionFile === value.sessionFile && identity.cwd === value.cwd)
      : action === "inspect" && !this.#attachment && this.#recoveryHandles.size > 0;
    const attachment = await this.#get(signal, recovery);
    if (recovery && value.handleId && !attachment.recoveries.has(value.handleId)) {
      const retained = this.#recoveryHandles.get(value.handleId)!;
      const { sessionId, sessionFile, cwd } = retained;
      const schema = retained.mode === "drain" ? piNativeDrainAttachmentSchema : piNativeAttachmentSchema;
      const restored = schema.nullable().parse(await call(attachment.lease,
        { action: retained.mode === "drain" ? "attach_for_drain" : "attach_for_control", runtimeId: attachment.runtimeId, input: { sessionId, sessionFile, cwd } }, signal));
      if (!restored || restored.handleId !== value.handleId || restored.generation !== retained.generation)
        throw new PiNativeError("pi_native_session_identity_mismatch", "sent_outcome_unknown");
      attachment.recoveries.add(value.handleId);
    }
    return call(attachment.lease, { action, input, runtimeId: attachment.runtimeId } as PiNativeHostCommandInput, signal);
  }
  async catalog(input: Parameters<PiNativePort["catalog"]>[0], signal?: AbortSignal) {
    return piNativeCatalogSchema.parse(await this.#invoke("catalog", input, signal));
  }
  async create(input: Parameters<PiNativePort["create"]>[0], signal?: AbortSignal) {
    return piNativeIdentitySchema.parse(await this.#invoke("create", input, signal));
  }
  async resolveSessionDirectory(input: Parameters<PiNativePort["resolveSessionDirectory"]>[0], signal?: AbortSignal) {
    return piNativeSessionDirectorySchema.parse(await this.#invoke("resolve_session_directory", input, signal));
  }
  async fork(input: Parameters<PiNativePort["fork"]>[0], signal?: AbortSignal) {
    return piNativeIdentitySchema.parse(await this.#invoke("fork", input, signal));
  }
  async reconcileFork(input: Parameters<PiNativePort["reconcileFork"]>[0], signal?: AbortSignal) {
    return piNativeIdentitySchema.nullable().parse(await this.#invoke("reconcile_fork", input, signal));
  }
  async listSessions(input: Parameters<PiNativePort["listSessions"]>[0], signal?: AbortSignal) {
    return piNativeListSchema.parse(await this.#invoke("list", input, signal));
  }
  async readHistory(input: Parameters<PiNativePort["readHistory"]>[0], signal?: AbortSignal) {
    const { sessionId, sessionFile, cwd } = input;
    return piNativeHistorySchema.parse(await this.#invoke("history", { sessionId, sessionFile, cwd }, signal));
  }
  async attach(input: Parameters<PiNativePort["attach"]>[0], signal?: AbortSignal) {
    const attachment = piNativeAttachmentSchema.parse(await this.#invoke("attach", input, signal));
    this.#handles.add(attachment.handleId);
    return attachment;
  }
  async attachForDrain(input: Parameters<PiNativePort["attachForDrain"]>[0], signal?: AbortSignal) {
    return this.#attachForRecovery(input, "drain", value => piNativeDrainAttachmentSchema.nullable().parse(value), signal);
  }
  async attachForControl(input: Parameters<PiNativePort["attachForControl"]>[0], signal?: AbortSignal) {
    return this.#attachForRecovery(input, "control", value => piNativeAttachmentSchema.nullable().parse(value), signal);
  }
  async #attachForRecovery<T extends PiNativeAttachment>(input: PiNativeSessionIdentity, mode: "drain" | "control", parse: (value: unknown) => T | null, signal?: AbortSignal): Promise<T | null> {
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    let owner: Attachment;
    try {
      owner = await this.#get(combined, true);
    } catch (error) {
      if (error instanceof PiNativeError && error.code === "pi_native_retained_runtime_missing") return null;
      throw error;
    }
    const { sessionId, sessionFile, cwd } = input;
    const attachment = parse(await call(owner.lease,
      { action: mode === "drain" ? "attach_for_drain" : "attach_for_control", runtimeId: owner.runtimeId, input: { sessionId, sessionFile, cwd } }, combined));
    if (attachment) {
      this.#handles.add(attachment.handleId);
      this.#recoveryHandles.set(attachment.handleId, { sessionId, sessionFile, cwd, generation: attachment.generation, mode });
      owner.recoveries.add(attachment.handleId);
    }
    return attachment;
  }
  async request(input: Parameters<PiNativePort["request"]>[0], signal?: AbortSignal) {
    return piNativeOutcomeSchema.parse(await this.#invoke("request", input, signal));
  }
  async outcome(input: Parameters<PiNativePort["outcome"]>[0], signal?: AbortSignal) {
    return piNativeOutcomeSchema.parse(await this.#invoke("outcome", input, signal));
  }
  async acknowledgeOperation(input: Parameters<PiNativePort["acknowledgeOperation"]>[0], signal?: AbortSignal) {
    piNativeSuccessSchema.parse(await this.#invoke("acknowledge_operation", input, signal));
  }
  async abandonObservation(input: Parameters<PiNativePort["abandonObservation"]>[0], signal?: AbortSignal) {
    return piNativeObservationReleaseSchema.parse(await this.#invoke("abandon_observation", input, signal));
  }
  async observe(input: Parameters<PiNativePort["observe"]>[0], signal?: AbortSignal) {
    return piNativeObservationSchema.parse(await this.#invoke("observe", input, signal));
  }
  async acknowledge(input: Parameters<PiNativePort["acknowledge"]>[0], signal?: AbortSignal) {
    piNativeSuccessSchema.parse(await this.#invoke("acknowledge", input, signal));
  }
  async acknowledgeObservationGap(input: Parameters<PiNativePort["acknowledgeObservationGap"]>[0], signal?: AbortSignal) {
    piNativeSuccessSchema.parse(await this.#invoke("acknowledge_observation_gap", input, signal));
  }
  async release(input: Parameters<PiNativePort["release"]>[0], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed) {
      // Lifecycle disposal closes this main-side port before actor cleanup.
      // These exact handles now own no local attachment; remote work may still
      // be retained if Stop failed, so this must not claim provider retirement.
      if (!this.#handles.has(input.handleId)) throw new PiNativeError("pi_native_session_unknown", "sent_outcome_unknown");
      return;
    }
    const identity = this.#identity;
    if (!identity) throw new PiNativeError("pi_native_runtime_not_attached");
    const retained = this.#recoveryHandles.has(input.handleId) ? this.#recoveryAttachment : this.#attachment;
    if (retained) {
      piNativeSuccessSchema.parse(await call(retained.lease, { action: "release", input, runtimeId: identity.runtimeId }, signal));
      this.#released(input.handleId);
      return;
    }
    // A successful Stop can remove this runtime before a lost carrier returns.
    // Release only its pinned identity on the same existing service: never
    // ensure a replacement runtime merely to dispose an old handle.
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const lease = await this.input.sidecarRuntime.acquireExisting(combined);
    try {
      combined.throwIfAborted(); lease.channel.assertReady();
      if (lease.serviceIncarnation !== identity.serviceIncarnation) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
      if (!piNativeRuntimeOperations.every(operation => lease.channel.supportsOperation(operation))) throw new PiNativeError("pi_native_remote_runtime_unsupported");
      piNativeSuccessSchema.parse(await call(lease, { action: "release", input, runtimeId: identity.runtimeId }, combined));
      this.#released(input.handleId);
    } finally { lease.release(); }
  }
  #released(handleId: string): void {
    this.#handles.delete(handleId); this.#recoveryHandles.delete(handleId);
    this.#attachment?.recoveries.delete(handleId); this.#recoveryAttachment?.recoveries.delete(handleId);
    if (!this.#recoveryHandles.size && this.#recoveryAttachment) this.#discard(this.#recoveryAttachment);
  }
  async inspect(signal?: AbortSignal): Promise<PiNativeInspection> {
    const inspection = piNativeInspectionSchema.parse(await this.#invoke("inspect", {}, signal));
    if (inspection.runtimeId !== this.#identity?.runtimeId) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
    return inspection;
  }
  async retireSession(input: Parameters<PiNativePort["retireSession"]>[0], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed) throw new PiNativeError("pi_native_remote_port_closed");
    const combined = signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal;
    const lease = await this.input.sidecarRuntime.acquireExisting(combined);
    try {
      combined.throwIfAborted(); lease.channel.assertReady();
      if (this.#identity && lease.serviceIncarnation !== this.#identity.serviceIncarnation) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
      if (!piNativeRuntimeOperations.every(operation => lease.channel.supportsOperation(operation))) throw new PiNativeError("pi_native_remote_runtime_unsupported");
      const value = await call(lease, { action: "lookup_retained", backendInstanceId: this.input.configuration.backendInstanceId }, combined);
      if (value === null) return "absent" as const;
      const { runtimeId } = runtimeSchema.parse(value);
      if (this.#identity && runtimeId !== this.#identity.runtimeId) throw new PiNativeError("pi_native_runtime_incarnation_changed", "sent_outcome_unknown");
      const { sessionId, sessionFile, cwd } = input;
      return piNativeRetirementSchema.parse(await call(lease, { action: "retire_session", runtimeId, input: { sessionId, sessionFile, cwd } }, combined));
    } finally { lease.release(); }
  }
  async startupEnvironmentState(): Promise<"not_started" | "started" | "unknown"> {
    if (this.#closed) return "unknown";
    let lease: SidecarRuntimeLease | undefined;
    try {
      lease = await this.input.sidecarRuntime.acquireExisting(this.#lifetime.signal);
      lease.channel.assertReady();
      if (this.#identity && this.#identity.serviceIncarnation !== lease.serviceIncarnation) return "unknown";
      const supported = piNativeRuntimeOperations.map(operation => lease!.channel.supportsOperation(operation));
      if (supported.every(value => !value)) return this.#identity ? "unknown" : "not_started";
      if (!supported.every(Boolean)) return "unknown";
      const value = await call(lease, { action: "lookup_retained", backendInstanceId: this.input.configuration.backendInstanceId }, this.#lifetime.signal);
      if (value === null) return "not_started";
      const { runtimeId } = runtimeSchema.parse(value);
      if (this.#identity && this.#identity.runtimeId !== runtimeId) return "unknown";
      const inspected = piNativeInspectionSchema.parse(await call(lease, { action: "inspect", runtimeId, input: {} }, this.#lifetime.signal));
      if (inspected.runtimeId !== runtimeId) return "unknown";
      // Even an idle host retains its applied startup configuration.
      return inspected.state === "unknown" ? "unknown" : "started";
    } catch { return "unknown"; }
    finally { lease?.release(); }
  }
  async stop(input: Parameters<PiNativePort["stop"]>[0], signal?: AbortSignal) {
    piNativeSuccessSchema.parse(await this.#invoke("stop", input, signal));
  }
  async close(): Promise<void> {
    this.#closed = true; this.#lifetime.abort();
    if (this.#attachment) this.#discard(this.#attachment);
    if (this.#recoveryAttachment) this.#discard(this.#recoveryAttachment);
    await Promise.allSettled([this.#opening, this.#recoveryOpening]);
  }
}

async function call(lease: SidecarRuntimeLease, input: PiNativeHostCommandInput, signal?: AbortSignal): Promise<unknown> {
  let crossed = false;
  try {
    const command = piNativeHostCommandSchema.parse({ ...input, controllerEpoch: lease.controllerEpoch, serviceIncarnation: lease.serviceIncarnation });
    const body = await lease.channel.encodeBody(command);
    signal?.throwIfAborted();
    crossed = true;
    const encoded = await lease.channel.call(piNativeHostCommandLane(command) === "control" ? piNativeControlOperation : piNativeExecuteOperation, body, signal ? { signal } : undefined);
    const response = piNativeHostResponseSchema.parse(await lease.channel.decodeBody(encoded));
    if (response.status === "failed") throw new PiNativeError(response.failure.code, response.failure.delivery);
    return response.value;
  } catch (error) {
    if (error instanceof PiNativeError) throw error;
    const delivery = (error as { delivery?: unknown } | null)?.delivery;
    throw new PiNativeError("pi_native_sidecar_unavailable", delivery === "not_sent" || !crossed ? "not_sent" : "sent_outcome_unknown", { cause: error });
  }
}
