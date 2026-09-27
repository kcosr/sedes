import { z } from "zod";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { isSidecarRevisionChanged, type SidecarRuntimeLease, type SidecarRuntimeProvider } from "../../sidecar/runtime-channel.js";
import { BackendRuntimeControlRejectedError } from "../runtime-control.js";
import { openCodeRuntimeNamespaceKey, type OpenCodeRuntimeLease, type OpenCodeRuntimeSnapshot } from "./opencode-runtime.js";
import type { OpenCodeRuntimeConfiguration } from "./opencode-runtime-configuration.js";
import type { OpenCodeRuntimeTarget } from "./opencode-native-host.js";
import type { OpenCodeHostToolAdmission, OpenCodeHostToolAdmissionResult, OpenCodeHostToolTarget } from "./opencode-host-agent-tools.js";
import type { OpenCodeApplicationOperationIdentity, OpenCodeMutationControl, OpenCodeMutationIdentity, OpenCodeMutationInput, OpenCodeMutationMethod,
  OpenCodeMutationOutcome, OpenCodeMutationOutput, OpenCodeNativeAuthority, OpenCodeNativePort,
  OpenCodeObservationEnd, OpenCodeObservationRecord, OpenCodePortObservation, OpenCodeReadInput,
  OpenCodeReadMethod, OpenCodeReadOutput } from "./opencode-native-port.js";
import { decodeOpenCodeNativeFailure, OpenCodeNativeMutationDeliveryError, openCodeNativeFailureSchema,
  parseOpenCodeReadInput, parseOpenCodeReadOutput, parseOpenCodeMutationInput, parseOpenCodeMutationControl,
  parseOpenCodeMutationOutput, parseOpenCodeObservationBoundary, parseOpenCodeObservationRecords,
  parseAdmission, parseCompaction, parseMutationSession } from "./opencode-native-codecs.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { openCodeRuntimeExecuteOperation, openCodeRuntimeControlOperation, openCodeRuntimeCommandLane,
  openCodeRuntimeResponseSchema, openCodeRuntimeInfoSchema, openCodeRuntimeTargetSchema,
  openCodePortAdmissionSchema, openCodeRuntimeSuccessSchema, openCodeRuntimeInspectionSchema, openCodeObservationPollTargetSchema,
  type OpenCodeRuntimeCommandInput, type OpenCodeRuntimeInfo } from "./opencode-runtime-wire.js";

/** Provider-private facade. Carrier choice is entirely in SidecarRuntimeProvider. */
export class OpenCodeRemoteRuntime {
  readonly nativeNamespaceKey: string;
  #attachment?: SidecarRuntimeLease;
  #info?: OpenCodeRuntimeInfo;
  #starting?: Promise<void>;
  #closed = false;
  #recovery = false;
  #serviceIncarnation?: string;
  #lifetime = new AbortController();
  readonly #ports = new Set<{ release(): Promise<void> }>();
  constructor(readonly input: { readonly configuration: OpenCodeRuntimeConfiguration; readonly provider: SidecarRuntimeProvider;
    readonly acquireRecovery: (signal?: AbortSignal) => Promise<SidecarRuntimeLease> }) {
    const environmentId = input.configuration.connections[0]!.executionEnvironmentId;
    this.nativeNamespaceKey = openCodeRuntimeNamespaceKey(environmentId, input.configuration.nativeStorePath);
  }
  get runtimeId(): string | undefined { return this.#info?.runtimeId; }
  snapshot(): OpenCodeRuntimeSnapshot {
    return this.#info?.snapshot ?? { state: this.#starting ? "starting" : "stopped",
      ownership: this.input.configuration.connection.ownership, references: 0 };
  }
  start(): Promise<void> {
    if (this.#closed) return Promise.reject(unavailable());
    if (this.#starting) return this.#starting;
    if (this.#attachment && this.#info?.snapshot.state === "ready") return this.assertCurrent();
    this.#starting = this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }
  async #start(): Promise<void> {
    let recovery = !this.input.configuration.instance.enabled || !this.input.configuration.connections.some(connection => connection.enabled);
    const attachment = recovery ? await this.input.acquireRecovery() : await this.input.provider.acquire().catch(async error => {
      if (!isSidecarRevisionChanged(error)) throw error;
      recovery = true; return this.input.acquireRecovery();
    });
    try {
      if (this.#closed) throw unavailable();
      let value = await call(attachment, { action: recovery ? "lookup_recovery" : "lookup", configuration: this.input.configuration });
      if (value === null && !recovery && !this.#info) value = await call(attachment, { action: "ensure", configuration: this.input.configuration });
      const info = openCodeRuntimeInfoSchema.parse(value);
      if (info.nativeNamespaceKey !== this.nativeNamespaceKey ||
          this.#info && (this.#info.runtimeId !== info.runtimeId || this.#info.snapshot.generation !== info.snapshot.generation ||
            this.#serviceIncarnation !== attachment.serviceIncarnation) ||
          info.snapshot.state !== "ready" || !info.snapshot.generation || !info.snapshot.identity) throw unavailable();
      if (this.#closed) throw unavailable();
      this.#lifetime = new AbortController(); this.#info = info; this.#attachment = attachment;
      this.#recovery = recovery; this.#serviceIncarnation = attachment.serviceIncarnation;
      void attachment.closed.then(() => this.#disconnected(attachment), () => this.#disconnected(attachment));
    } catch (error) { attachment.release(); throw error; }
  }
  #disconnected(attachment: SidecarRuntimeLease): void {
    if (this.#attachment !== attachment) return;
    this.#attachment = undefined; this.#lifetime.abort();
    if (this.#info) this.#info = { ...this.#info, snapshot: { ...this.#info.snapshot, state: "disconnected" } };
    attachment.release();
  }
  async health(): Promise<{ readonly available: boolean; readonly checkedAt: string }> {
    try { await this.assertCurrent(); return { available: true, checkedAt: new Date().toISOString() }; }
    catch { return { available: false, checkedAt: new Date().toISOString() }; }
  }
  async assertCurrent(signal?: AbortSignal): Promise<void> {
    const { attachment, info } = this.#ready();
    const result = await call(attachment, { action: "assert_current", runtimeId: info.runtimeId, nativeGeneration: info.snapshot.generation! }, signal);
    openCodeRuntimeSuccessSchema.parse(result);
    if (this.#attachment !== attachment) throw unavailable();
  }
  acquire(value: OpenCodeRuntimeTarget): OpenCodeRuntimeLease {
    const { attachment, info } = this.#ready(), target = openCodeRuntimeTargetSchema.parse(value), recovery = this.#recovery;
    const connection = this.input.configuration.connections[0]!;
    const authority: OpenCodeNativeAuthority = Object.freeze({ tenantId: connection.tenantId, principalId: connection.ownerPrincipalId,
      executionEnvironmentId: connection.executionEnvironmentId, backendInstanceId: connection.backendInstanceId,
      runtimeId: info.runtimeId, nativeGeneration: info.snapshot.generation!, ...target });
    Object.freeze(authority.session);
    const controller = new AbortController(), lifetime = AbortSignal.any([controller.signal, this.#lifetime.signal]);
    let opening: Promise<string> | undefined, portId: string | undefined, released = false;
    const ensurePort = async () => {
      lifetime.throwIfAborted();
      if (portId) return portId;
      return opening ??= (async () => {
        const admitted = openCodePortAdmissionSchema.parse(await call(attachment, { action: recovery ? "acquire_retained" : "acquire", runtimeId: info.runtimeId,
          nativeGeneration: info.snapshot.generation!, target }));
        if (configurationFingerprint(admitted.authority) !== configurationFingerprint(authority)) throw unavailable();
        portId = admitted.portId;
        if (lifetime.aborted) {
          void call(attachment, { ...scope(portId), action: "release" }).catch(() => undefined);
          lifetime.throwIfAborted();
        }
        return portId;
      })();
    };
    const scope = (id: string) => ({ runtimeId: info.runtimeId, nativeGeneration: info.snapshot.generation!, portId: id });
    const client: OpenCodeNativePort = Object.freeze({ authority, ownerKey: `${info.runtimeId}:${info.snapshot.generation}`, lifetime,
      read: async <K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>, options?: { signal?: AbortSignal; deadlineAt?: number }): Promise<OpenCodeReadOutput<K>> => {
        const captured = parseOpenCodeReadInput(method, input), id = await ensurePort();
        const result = await call(attachment, { ...scope(id), action: "read", method, input: captured, deadlineAt: options?.deadlineAt ?? null },
          AbortSignal.any([lifetime, ...(options?.signal ? [options.signal] : [])]));
        return parseOpenCodeReadOutput(method, captured, result);
      },
      mutate: async <K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl,
        options?: { signal?: AbortSignal }): Promise<OpenCodeMutationOutput<K>> => {
        const captured = parseOpenCodeMutationInput(method, input), capturedControl = parseOpenCodeMutationControl(control);
        try {
          const id = await ensurePort();
          const result = await call(attachment, { ...scope(id), action: "mutate", method, input: captured, control: capturedControl },
            AbortSignal.any([lifetime, ...(options?.signal ? [options.signal] : [])]));
          return parseOpenCodeMutationOutput(method, captured, result);
        } catch (error) {
          if (error instanceof OpenCodeNativeMutationDeliveryError) throw error;
          // Controls carry stable step identities, not proof that this is the
          // first attempt. Even a locally refused retry can follow a prior
          // effect through another facade; only the host journal may prove it
          // not sent across the operation's lifetime.
          throw new OpenCodeNativeMutationDeliveryError("sent_outcome_unknown", "opencode_mutation_outcome_unknown");
        }
      },
      outcome: async <K extends OpenCodeMutationMethod>(method: K, identity: OpenCodeMutationIdentity) =>
        parseOutcome(method, authority, await call(attachment, { ...scope(await ensurePort()), action: "outcome", method, identity })),
      acknowledgeMutation: async (method: OpenCodeMutationMethod, identity: OpenCodeMutationIdentity) => {
        openCodeRuntimeSuccessSchema.parse(await call(attachment, { ...scope(await ensurePort()), action: "acknowledge_mutation", method, identity }));
      },
      acknowledgeOperation: async (identity: OpenCodeApplicationOperationIdentity) => {
        openCodeRuntimeSuccessSchema.parse(await call(attachment, { ...scope(await ensurePort()), action: "acknowledge_operation", identity }));
      },
      observe: (options: Parameters<OpenCodeNativePort["observe"]>[0]) => remoteObservation({
        signal: AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]),
        open: async observationSignal => {
          const base = scope(await ensurePort());
          const result = observationAdmissionSchema.parse(await call(attachment, { ...base, action: "observe_open", purpose: options.purpose,
            ...(options.after ? { after: options.after } : {}) }, observationSignal));
          return { boundary: parseOpenCodeObservationBoundary(result.boundary),
            poll: () => pollObservations(attachment, options.purpose, { ...base, observationId: result.observationId }, observationSignal),
            acknowledge: async cursor => { openCodeRuntimeSuccessSchema.parse(await call(attachment, {
              ...base, action: "observe_ack", observationId: result.observationId, cursor })); },
            close: async () => { await call(attachment, { ...base, action: "observe_close", observationId: result.observationId }); },
          };
        },
      }),
    });
    const lease = { release: async () => {
      if (released) return;
      released = true; controller.abort(); this.#ports.delete(lease);
      if (portId) await call(attachment, { ...scope(portId), action: "release" }).catch(() => undefined);
    } };
    this.#ports.add(lease);
    return Object.freeze({ client, generation: info.snapshot.generation!, identity: info.snapshot.identity!, release: () => { void lease.release(); } });
  }
  async admitToolSession(_target: OpenCodeHostToolTarget, _admission: OpenCodeHostToolAdmission,
    _signal?: AbortSignal): Promise<OpenCodeHostToolAdmissionResult> { throw new OpenCodeRuntimeError("opencode_agent_tools_unavailable"); }
  releaseToolSession(_target: OpenCodeHostToolTarget): void { /* R3 installs the retained host tool route. */ }
  async inspect() {
    const { attachment, info } = this.#ready();
    return openCodeRuntimeInspectionSchema.parse(await call(attachment, { action: "inspect", runtimeId: info.runtimeId }));
  }
  async stop(): Promise<{ readonly cleanup: "proved"; readonly nativeInterrupts: "incomplete" | "not_owned" }> {
    const { attachment, info } = this.#ready();
    const inspection = await this.inspect();
    openCodeRuntimeSuccessSchema.parse(await call(attachment, { action: "stop", runtimeId: info.runtimeId,
      expectedRevision: inspection.revision, force: true }));
    this.#lifetime.abort(); this.#info = undefined; this.#attachment = undefined; attachment.release();
    return { cleanup: "proved", nativeInterrupts: this.input.configuration.connection.ownership === "owned" ? "incomplete" : "not_owned" };
  }
  /** Main teardown detaches. Only explicit administration may stop the owner. */
  async close(): Promise<{ readonly cleanup: "proved"; readonly nativeInterrupts: "not_owned" }> {
    this.#closed = true; this.#lifetime.abort();
    await this.#starting?.catch(() => undefined);
    await Promise.allSettled([...this.#ports].map(port => port.release()));
    this.#attachment?.release(); this.#attachment = undefined;
    return { cleanup: "proved", nativeInterrupts: "not_owned" };
  }
  #ready() {
    if (this.#closed || !this.#attachment || !this.#info || this.#info.snapshot.state !== "ready" || this.#lifetime.signal.aborted) throw unavailable();
    return { attachment: this.#attachment, info: this.#info };
  }
}

export async function callOpenCodeRemoteRuntime(attachment: SidecarRuntimeLease, command: OpenCodeRuntimeCommandInput, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const channel = attachment.channel;
  const definition = openCodeRuntimeCommandLane(command) === "control" ? openCodeRuntimeControlOperation : openCodeRuntimeExecuteOperation;
  if (!channel.supportsOperation(definition)) throw unavailable();
  const body = await channel.encodeBody({ ...command, controllerEpoch: attachment.controllerEpoch, serviceIncarnation: attachment.serviceIncarnation });
  signal?.throwIfAborted();
  const response = openCodeRuntimeResponseSchema.parse(await channel.decodeBody(await channel.call(definition, body, { signal })));
  if (response.status === "failed") throw decodeOpenCodeNativeFailure(response.failure);
  if (response.status === "control_rejected") throw new BackendRuntimeControlRejectedError(response.reason);
  return response.value;
}
const call = callOpenCodeRemoteRuntime;
const observationAdmissionSchema = z.strictObject({ observationId: z.string().min(1).max(256), boundary: z.unknown() });
const observationPollSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("events"), records: z.unknown() }),
  z.strictObject({ status: z.literal("ended"), reason: z.enum(["closed", "aborted", "disconnected", "malformed", "overflow", "failed", "resnapshot_required", "superseded"]),
    failure: openCodeNativeFailureSchema.optional() }),
]);
type PollTarget = z.infer<typeof openCodeObservationPollTargetSchema>;
type PollPurpose = "evidence" | "presentation";
const observationBatchSchema = z.array(z.strictObject({ observationId: z.string().min(1).max(256), result: observationPollSchema })).max(512);
interface PendingPoll {
  readonly target: PollTarget;
  readonly signal: AbortSignal;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abort(): void;
}
// The channel is the authenticated carrier boundary, shared by every OpenCode
// facade. At most two long-polls (one per purpose) occupy its request slots.
const observationPollers = new WeakMap<SidecarRuntimeLease["channel"], Map<PollPurpose, {
  readonly pending: Set<PendingPoll>; running: boolean;
}>>();
function pollObservations(attachment: SidecarRuntimeLease, purpose: PollPurpose, target: PollTarget, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  let purposes = observationPollers.get(attachment.channel);
  if (!purposes) { purposes = new Map(); observationPollers.set(attachment.channel, purposes); }
  let state = purposes.get(purpose);
  if (!state) { state = { pending: new Set(), running: false }; purposes.set(purpose, state); }
  const poller = state;
  const response = new Promise<unknown>((resolve, reject) => {
    const pending: PendingPoll = { target, signal, resolve, reject, abort: () => { poller.pending.delete(pending); reject(signal.reason); } };
    poller.pending.add(pending); signal.addEventListener("abort", pending.abort, { once: true });
  });
  if (!poller.running) {
    poller.running = true;
    queueMicrotask(() => { void (async () => {
      try {
        while (poller.pending.size) {
          const batch = [...poller.pending].slice(0, 512);
          // Caller cancellation ends only that subscriber. Cancelling the last
          // in-flight subscriber may cancel this read-only batch safely.
          const controller = new AbortController();
          const cancel = () => { if (batch.every(item => item.signal.aborted)) controller.abort(); };
          for (const item of batch) item.signal.addEventListener("abort", cancel, { once: true });
          try {
            const result = observationBatchSchema.parse(await call(attachment, { action: "observe_poll", purpose, targets: batch.map(item => item.target) }, controller.signal));
            const byId = new Map(result.map(item => [item.observationId, item.result]));
            if (byId.size !== batch.length || result.length !== batch.length || batch.some(item => !byId.has(item.target.observationId))) throw unavailable();
            for (const item of batch) item.resolve(byId.get(item.target.observationId));
          } catch (error) { for (const item of batch) item.reject(error); }
          finally {
            for (const item of batch) {
              poller.pending.delete(item); item.signal.removeEventListener("abort", item.abort); item.signal.removeEventListener("abort", cancel);
            }
          }
        }
      } finally { poller.running = false; }
    })(); });
  }
  return response;
}
type RemoteObservationConnection = { boundary: Awaited<OpenCodePortObservation["ready"]>; poll(): Promise<unknown>;
  acknowledge: OpenCodePortObservation["acknowledge"]; close(): Promise<void> };
function remoteObservation(input: { signal: AbortSignal; open(signal: AbortSignal): Promise<RemoteObservationConnection> }): OpenCodePortObservation {
  let connection: RemoteObservationConnection | undefined, end: OpenCodeObservationEnd | undefined;
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([input.signal, controller.signal]);
  const queue: OpenCodeObservationRecord[] = [], waiters = new Set<() => void>();
  let finishEnd!: (end: OpenCodeObservationEnd) => void;
  const ended = new Promise<OpenCodeObservationEnd>(resolve => { finishEnd = resolve; });
  const wake = () => { for (const notify of [...waiters]) notify(); };
  const finish = (value: OpenCodeObservationEnd) => {
    if (end) return; end = value; controller.abort(); queue.length = 0; input.signal.removeEventListener("abort", abort); wake(); finishEnd(value);
    void connection?.close().catch(() => undefined);
  };
  const abort = () => finish({ reason: "aborted", error: new OpenCodeRuntimeError("opencode_event_aborted") });
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const ready = input.open(requestSignal).then(opened => {
    connection = opened;
    if (end) { void opened.close().catch(() => undefined); throw end.error ?? unavailable(); }
    void (async () => {
      try {
        while (!end) {
          // One bounded batch at a time; slow clients never drain retained proof
          // into an unbounded local transport queue.
          if (queue.length) { await waitForWake(waiters, requestSignal); continue; }
          const polled = observationPollSchema.parse(await opened.poll());
          if (end) break;
          if (polled.status === "ended") {
            finish({ reason: polled.reason, ...(polled.failure ? { error: decodeOpenCodeNativeFailure(polled.failure) } : {}) }); break;
          }
          queue.push(...parseOpenCodeObservationRecords(polled.records)); wake();
        }
      } catch { finish({ reason: "disconnected", error: new OpenCodeRuntimeError("opencode_event_disconnected") }); }
    })();
    return opened.boundary;
  }).catch(error => { finish({ reason: "failed", error: unavailable() }); throw error; });
  void ready.catch(() => undefined);
  const assertOpen = () => { if (end) throw end.error ?? new OpenCodeRuntimeError("opencode_event_closed"); };
  return { ready, ended, get failure() { return end?.error; },
    drain: () => { assertOpen(); const records = queue.splice(0); wake(); return records; },
    wait: async signal => { assertOpen();
      if (!queue.length) await waitForWake(waiters, signal);
      assertOpen(); },
    acknowledge: async cursor => { await ready; if (end) throw end.error ?? new OpenCodeRuntimeError("opencode_event_closed");
      if (!connection) throw unavailable(); await connection.acknowledge(cursor); },
    close: async () => { finish({ reason: "closed" }); },
  };
}
function waitForWake(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { waiters.delete(done); signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { waiters.delete(done); reject(signal!.reason); };
    waiters.add(done); signal?.addEventListener("abort", abort, { once: true });
  });
}
const outcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("completed"), result: z.unknown() }),
  z.strictObject({ status: z.literal("failed"), failure: openCodeNativeFailureSchema }),
]);
function parseOutcome<K extends OpenCodeMutationMethod>(method: K, authority: OpenCodeNativeAuthority, value: unknown): OpenCodeMutationOutcome<OpenCodeMutationOutput<K>> {
  const outcome = outcomeSchema.parse(value);
  if (outcome.status !== "completed") return outcome;
  // Outcome lookup has no request payload. Validate the native DTO and bound
  // session here; the consumer checks its reserved input ID/fingerprint.
  let parsed: unknown;
  if (method === "createSession") {
    const session = parseMutationSession(outcome.result);
    if (session.id !== authority.session?.nativeSessionID || session.location.directory !== authority.directory) throw unavailable();
    parsed = session;
  } else if (method === "prompt" || method === "compact") {
    const admission = method === "prompt" ? parseAdmission(outcome.result) : parseCompaction(outcome.result);
    if (admission.sessionID !== authority.session?.nativeSessionID) throw unavailable(); parsed = admission;
  } else if (method === "interruptSession") parsed = z.strictObject({ interrupted: z.boolean() }).parse(outcome.result);
  else parsed = openCodeRuntimeSuccessSchema.parse(outcome.result);
  return { status: "completed", result: parsed as OpenCodeMutationOutput<K> };
}
function unavailable(): OpenCodeRuntimeError { return new OpenCodeRuntimeError("opencode_runtime_unavailable"); }
