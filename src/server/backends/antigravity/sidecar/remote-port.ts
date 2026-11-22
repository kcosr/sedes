import { z } from "zod";
import { isSidecarRevisionChanged, type SidecarRuntimeLease, type SidecarRuntimeProvider } from "../../../sidecar/runtime-channel.js";
import { AntigravityError, type AntigravityPort, type AntigravityRuntimeConfiguration } from "../port.js";
import { antigravityRuntimeOperations, antigravityHostCommandSchema, antigravityHostCommandLane,
  antigravityHostResponseSchema, antigravityExecuteOperation, antigravityControlOperation,
  antigravitySetupSchema, antigravityIdentitySchema, antigravityListSchema, antigravityHistorySchema,
  antigravityAttachmentSchema, antigravityOutcomeSchema, antigravityObservationSchema,
  antigravityInspectionSchema, antigravityRetirementSchema, antigravitySuccessSchema, type AntigravityHostCommandInput,
} from "./wire.js";
type Attachment = { readonly lease: SidecarRuntimeLease; readonly runtimeId: string; retained: boolean; released: boolean };
const runtimeSchema = z.strictObject({ runtimeId: z.string().uuid() });

/** Disposable controller proxy. Provider work belongs to the persistent service. */
export class AntigravityRemotePort implements AntigravityPort {
  #attachment?: Attachment;
  #opening?: Promise<Attachment>;
  #identity?: { readonly runtimeId: string; readonly serviceIncarnation: string };
  #closed = false;
  readonly #handles = new Set<string>();
  readonly #lifetime = new AbortController();
  constructor(readonly input: { readonly configuration: AntigravityRuntimeConfiguration;
    readonly sidecarRuntime: SidecarRuntimeProvider; readonly existingOnly?: boolean }) {}
  async #get(signal?: AbortSignal, existingOnly = false): Promise<Attachment> {
    signal?.throwIfAborted(); if (this.#closed) throw new AntigravityError("antigravity_remote_closed");
    if (this.#attachment) {
      const attachment = this.#attachment;
      if (attachment.retained && !existingOnly && !this.input.existingOnly) {
        // An existing-only lease may be a service-level recovery attachment.
        // Config lookup cannot grant admission on that carrier. Reacquire normal
        // authority, then #open checks the exact retained owner without ensure.
        const opening = this.#opening ??= this.#open(false).then(result => {
          this.#release(attachment); return result;
        }).finally(() => { this.#opening = undefined; });
        const result = await opening; signal?.throwIfAborted(); return result;
      }
      return attachment;
    }
    const opening = this.#opening ??= this.#open(existingOnly).finally(() => { this.#opening = undefined; });
    const result = await opening; signal?.throwIfAborted(); return result;
  }
  async #open(existingOnly: boolean): Promise<Attachment> {
    let retained = existingOnly || (this.input.existingOnly ?? false);
    const lease = retained ? await this.input.sidecarRuntime.acquireExisting(this.#lifetime.signal)
      : await this.input.sidecarRuntime.acquire(this.#lifetime.signal).catch(async error => {
        if (!this.#identity || !isSidecarRevisionChanged(error)) throw error;
        retained = true; return this.input.sidecarRuntime.acquire(this.#lifetime.signal, { existingOnly: true });
      });
    try {
      lease.channel.assertReady();
      if (!antigravityRuntimeOperations.every(operation => lease.channel.supportsOperation(operation))) throw new AntigravityError("antigravity_remote_unsupported");
      if (this.#identity && lease.serviceIncarnation !== this.#identity.serviceIncarnation) throw new AntigravityError("antigravity_runtime_incarnation_changed", "sent_outcome_unknown");
      const value = await call(lease, retained
        ? { action: "lookup_retained", backendInstanceId: this.input.configuration.backendInstanceId }
        : { action: this.#identity ? "lookup" : "ensure", configuration: this.input.configuration }, this.#lifetime.signal);
      if (value === null) throw new AntigravityError("antigravity_retained_runtime_missing");
      const { runtimeId } = runtimeSchema.parse(value);
      if (this.#identity && runtimeId !== this.#identity.runtimeId) throw new AntigravityError("antigravity_runtime_incarnation_changed", "sent_outcome_unknown");
      if (this.#closed) throw new AntigravityError("antigravity_remote_closed");
      this.#identity = { runtimeId, serviceIncarnation: lease.serviceIncarnation };
      const attachment = { lease, runtimeId, retained, released: false }; this.#attachment = attachment;
      void lease.closed.then(() => this.#discard(attachment), () => this.#discard(attachment)); return attachment;
    } catch (error) { lease.release(); throw error; }
  }
  #release(attachment: Attachment) { if (!attachment.released) { attachment.released = true; attachment.lease.release(); } }
  #discard(attachment: Attachment) { if (this.#attachment === attachment) this.#attachment = undefined; this.#release(attachment); }
  async #invoke(action: string, input: unknown, signal?: AbortSignal, existingOnly = false): Promise<unknown> {
    const attachment = await this.#get(signal, existingOnly);
    return call(attachment.lease, { action, runtimeId: attachment.runtimeId, input } as AntigravityHostCommandInput, signal);
  }
  async catalog(input: Parameters<AntigravityPort["catalog"]>[0], signal?: AbortSignal) { return antigravitySetupSchema.parse(await this.#invoke("catalog", input, signal)); }
  async connect(signal?: AbortSignal) { return z.strictObject({ runtimeId: z.string().uuid(), version: z.string().min(1).max(128) }).parse(await this.#invoke("connect", {}, signal)); }
  async create(input: Parameters<AntigravityPort["create"]>[0], signal?: AbortSignal) { return antigravityIdentitySchema.parse(await this.#invoke("create", input, signal)); }
  async acknowledgeCreation(input: Parameters<AntigravityPort["acknowledgeCreation"]>[0], signal?: AbortSignal) { antigravitySuccessSchema.parse(await this.#invoke("acknowledge_creation", input, signal, true)); }
  async listSessions(input: Parameters<AntigravityPort["listSessions"]>[0], signal?: AbortSignal) { return antigravityListSchema.parse(await this.#invoke("list", input, signal)); }
  async readHistory(input: Parameters<AntigravityPort["readHistory"]>[0], signal?: AbortSignal) {
    const history = antigravityHistorySchema.nullable().parse(await this.#invoke("history", input, signal));
    if (history === null && input.knownRevision === undefined) throw new AntigravityError("antigravity_history_revision_unproven", "sent_outcome_unknown");
    return history;
  }
  async attach(input: Parameters<AntigravityPort["attach"]>[0], signal?: AbortSignal) {
    const result = antigravityAttachmentSchema.parse(await this.#invoke("attach", input, signal)); this.#handles.add(result.handleId); return result;
  }
  async attachExisting(input: Parameters<AntigravityPort["attachExisting"]>[0], signal?: AbortSignal) {
    try { const result = antigravityAttachmentSchema.nullable().parse(await this.#invoke("attach_existing", input, signal, true)); if (result) this.#handles.add(result.handleId); return result; }
    catch (error) { if (error instanceof AntigravityError && error.code === "antigravity_retained_runtime_missing") return null; throw error; }
  }
  async request(input: Parameters<AntigravityPort["request"]>[0], signal?: AbortSignal) { return antigravityOutcomeSchema.parse(await this.#invoke("request", input, signal, ["cancel", "permission"].includes(input.command.type))); }
  async outcome(input: Parameters<AntigravityPort["outcome"]>[0], signal?: AbortSignal) { return antigravityOutcomeSchema.parse(await this.#invoke("outcome", input, signal, true)); }
  async acknowledgeOperation(input: Parameters<AntigravityPort["acknowledgeOperation"]>[0], signal?: AbortSignal) { antigravitySuccessSchema.parse(await this.#invoke("acknowledge_operation", input, signal, true)); }
  async observe(input: Parameters<AntigravityPort["observe"]>[0], signal?: AbortSignal) { return antigravityObservationSchema.parse(await this.#invoke("observe", input, signal, true)); }
  async acknowledge(input: Parameters<AntigravityPort["acknowledge"]>[0], signal?: AbortSignal) { antigravitySuccessSchema.parse(await this.#invoke("acknowledge", input, signal, true)); }
  async release(input: Parameters<AntigravityPort["release"]>[0], signal?: AbortSignal) {
    if (this.#closed) { if (!this.#handles.has(input.handleId)) throw new AntigravityError("antigravity_session_unknown", "sent_outcome_unknown"); return; }
    antigravitySuccessSchema.parse(await this.#invoke("release", input, signal, true));
  }
  async retireSession(input: Parameters<AntigravityPort["retireSession"]>[0], signal?: AbortSignal) {
    try { return antigravityRetirementSchema.parse(await this.#invoke("retire_session", input, signal, true)); }
    catch (error) { if (error instanceof AntigravityError && error.code === "antigravity_retained_runtime_missing") return "absent" as const; throw error; }
  }
  async inspect(signal?: AbortSignal) { return antigravityInspectionSchema.parse(await this.#invoke("inspect", {}, signal, true)); }
  async stop(input: Parameters<AntigravityPort["stop"]>[0], signal?: AbortSignal) { antigravitySuccessSchema.parse(await this.#invoke("stop", input, signal, true)); }
  async close() {
    if (this.#closed) return; this.#closed = true; this.#lifetime.abort();
    if (this.#attachment) this.#discard(this.#attachment);
    await Promise.allSettled([this.#opening]);
  }
}
async function call(lease: SidecarRuntimeLease, input: AntigravityHostCommandInput, signal?: AbortSignal): Promise<unknown> {
  let crossed = false;
  try {
    const command = antigravityHostCommandSchema.parse({ ...input, controllerEpoch: lease.controllerEpoch, serviceIncarnation: lease.serviceIncarnation });
    const body = await lease.channel.encodeBody(command); signal?.throwIfAborted(); crossed = true;
    const invoke = async (wireSignal?: AbortSignal) => {
      const encoded = await lease.channel.call(antigravityHostCommandLane(command) === "control" ? antigravityControlOperation : antigravityExecuteOperation,
        body, wireSignal ? { signal: wireSignal } : undefined);
      return antigravityHostResponseSchema.parse(await lease.channel.decodeBody(encoded));
    };
    // Observation cancellation ends the caller wait after the admitted bounded
    // exchange drains; aborting an in-flight write would destroy a shared carrier.
    const observation = ["observe", "outcome", "acknowledge", "acknowledge_operation", "inspect"].includes(command.action);
    const response = observation && signal ? await drainObservation(signal, invoke) : await invoke(signal);
    if (response.status === "failed") throw new AntigravityError(response.failure.code, response.failure.delivery);
    return response.value;
  } catch (error) {
    if (error instanceof AntigravityError) throw error;
    const delivery = (error as { delivery?: unknown } | null)?.delivery;
    throw new AntigravityError("antigravity_sidecar_unavailable", !crossed || delivery === "not_sent" ? "not_sent" : "sent_outcome_unknown", { cause: error });
  }
}
async function drainObservation<T>(signal: AbortSignal, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const wire = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abort = () => { timer ??= setTimeout(() => { wire.abort(signal.reason); rejectDeadline(new AntigravityError("antigravity_observation_cancelled", "sent_outcome_unknown")); }, 5000); };
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  try { const result = await Promise.race([invoke(wire.signal), deadline]); signal.throwIfAborted(); return result; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
