import { RetainedRuntimeLifecycle } from "../../retained-runtime-lifecycle.js";
import { codexManagedTuiOperations } from "./codex-runtime-managed-tui.js";
import { randomUUID } from "node:crypto";
import { attachmentDiagnostic, type AttachmentDiagnosticFields } from "../../../diagnostics/attachment-diagnostics.js";
import type { BackendRuntimeAdministration } from "../../module.js";
import type { VerifiedCodexRuntimeVersion } from "../codex-release-guard.js";
import { isSidecarRevisionChanged, type SidecarRuntimeProvider, type SidecarRuntimeLease } from "../../../sidecar/runtime-channel.js";
import type { ProviderTransportScope } from "../../../provider-protocol/transport/assured-framed-transport.js";
import { CodexSharedClientFacade, type CodexReadyClientGeneration } from "../codex-client-facade.js";
import type { CodexServerRequestRouter } from "../codex-server-request-router.js";
import type { CodexRuntimeReceiptSink } from "./codex-runtime-receipt-store.js";
import type { CodexRuntimeConfiguration } from "./codex-runtime-host-registry.js";
import { CodexRuntimeClient, type CodexRuntimeAttachmentFailure } from "./codex-runtime-client.js";
import { CodexSidecarRuntimeConnection } from "./codex-sidecar-runtime.js";

/** Main owns only attachment/recovery. Its provider implementation, native
 * sockets and subprocesses remain in the sidecar across main shutdown. */
export class CodexRemoteRuntimeSupervisor {
  readonly client: CodexSharedClientFacade;
  readonly administration: BackendRuntimeAdministration;
  readonly #controller = new AbortController();
  readonly #scope: ProviderTransportScope;
  #current: CodexReadyClientGeneration | undefined;
  #remote: CodexRuntimeClient | undefined;
  #connection: CodexSidecarRuntimeConnection | undefined;
  #lease: SidecarRuntimeLease | undefined;
  #generation = 0;
  #runtimeId: string | undefined;
  #retainedIdentity: { readonly runtimeId: string; readonly serviceIncarnation: string } | undefined;
  #generationOffset = 0;
  #started = false;
  #closed = false;
  #retainedUnavailable = false;
  #idleRequested = false;
  #connecting: Promise<void> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #subscriptions: (() => void)[] = [];
  #attachmentAttempt = 0;
  constructor(readonly input: {
    scope: ProviderTransportScope; provider: SidecarRuntimeProvider;
    configuration: CodexRuntimeConfiguration;
    serverRequests: CodexServerRequestRouter; receipts: CodexRuntimeReceiptSink;
    onRuntimeVersionAssessment?: (assessment: VerifiedCodexRuntimeVersion) => void;
  }) {
    this.#scope = input.scope;
    this.administration = {
      inspect: async () => {
        const attachment = await this.attachment();
        return await this.#connection!.inspect({ scope: this.#scope, runtimeId: attachment.runtimeId, controllerId: String(attachment.controllerEpoch) });
      },
      stop: async ({ expectedRevision, force }) => {
        const attachment = await this.attachment();
        const authority = { scope: this.#scope, runtimeId: attachment.runtimeId, controllerId: String(attachment.controllerEpoch) };
        const retirementOperationId = randomUUID();
        await this.#connection!.stop(authority, expectedRevision, force);
        if (this.input.receipts.pending(authority).length === 0) this.input.receipts.compactRetiredRuntime(authority, {
          disposition: "confirmed_retired", runtimeId: attachment.runtimeId, retirementOperationId, retiredAt: Date.now(),
        });
        await this.close();
      },
      restart: async ({ expectedRevision, force }) => {
        const attachment = await this.attachment();
        const authority = { scope: this.#scope, runtimeId: attachment.runtimeId, controllerId: String(attachment.controllerEpoch) };
        const retirementOperationId = randomUUID();
        await this.#connection!.stop(authority, expectedRevision, force);
        if (this.input.receipts.pending(authority).length === 0) this.input.receipts.compactRetiredRuntime(authority, {
          disposition: "confirmed_retired", runtimeId: attachment.runtimeId, retirementOperationId, retiredAt: Date.now(),
        });
        const remote = this.#remote;
        this.#discardAttachment("operator_restart");
        // Closing also clears client timers and listeners on a reused carrier.
        // The stop may already have removed the native attachment.
        await remote?.close().catch(() => undefined);
        this.#retainedIdentity = undefined;
        await this.#connect();
      },
    };
    this.client = new CodexSharedClientFacade({
      residency: new RetainedRuntimeLifecycle({
        wake: () => {
          if (!this.#idleRequested && this.client.lifecycleSnapshot().state !== "idle") return;
          return (async () => {
            const attachment = await this.attachment();
            await this.#connection!.wake({ scope: this.#scope, runtimeId: attachment.runtimeId, controllerId: String(attachment.controllerEpoch) });
            this.#idleRequested = false;
          })();
        },
        retire: async () => {
          const lease = this.#lease;
          const connection = this.#connection;
          const remote = this.#remote;
          const runtimeId = this.#runtimeId;
          if (this.#closed || !lease || !connection || !runtimeId || !remote) return;
          this.#idleRequested = true;
          try {
            await remote.drainAcknowledgements();
            if (this.#lease !== lease || this.#closed) return;
            await connection.idle({ scope: this.#scope, runtimeId, controllerId: String(lease.controllerEpoch) },
              remote.client.lifecycleSnapshot().generation - this.#generationOffset);
          } catch (error) {
            this.#reportIdleReleaseError(error);
            this.#lost(lease, "idle_release", error);
          }
        },
      }),
      current: () => this.#current, latestGeneration: () => this.#generation,
      retireGeneration: async (generation, reason) => { await this.#remote?.client.retireGeneration(generation, reason); },
      persistentSessions: {
        reattachThread: async (threadId, options) => await this.#remote?.client.persistentSessions?.reattachThread(threadId, options),
        detachThread: async (threadId, generation, evicted) => { await this.#remote?.client.persistentSessions?.detachThread(threadId, generation, evicted); },
      },
    });
  }
  managedTuiAvailable(): boolean {
    return !this.#closed && this.#lease !== undefined && codexManagedTuiOperations.every(operation => this.#lease!.channel.supportsOperation(operation));
  }
  async appliedOwnedPath(): Promise<string> {
    const attachment = await this.attachment();
    return await this.#connection!.appliedOwnedPath({ scope: this.#scope, runtimeId: attachment.runtimeId, controllerId: String(attachment.controllerEpoch) });
  }
  async attachment() {
    if (!this.#lease || !this.#remote || !this.#runtimeId) await this.#connect();
    if (!this.#lease || !this.#remote || !this.#runtimeId) throw new Error("codex_remote_runtime_unavailable");
    return { channel: this.#lease.channel, runtimeId: this.#runtimeId, controllerEpoch: this.#lease.controllerEpoch, closed: this.#lease.closed,
      providerGeneration: this.#remote.client.lifecycleSnapshot().generation - this.#generationOffset, generationOffset: this.#generationOffset };
  }
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // Remote startup cannot hold HTTP/Settings readiness behind an unavailable
    // host. The lifecycle stays reconciling until the attachment is ready.
    void this.#connect().catch(() => this.#scheduleRetry());
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller.abort();
    if (this.#retry) clearTimeout(this.#retry);
    await this.#connecting?.catch(() => undefined);
    const remote = this.#remote;
    this.#discardAttachment("supervisor_close");
    await remote?.close().catch(() => undefined);
    this.client.updateLifecycle({ state: "closed", generation: this.#generation });
  }
  async #connect(): Promise<void> {
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#performConnect().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }
  async #performConnect(): Promise<void> {
    if (this.#closed) return;
    if (this.#retainedUnavailable) throw new Error("codex_retained_runtime_unavailable");
    this.client.updateLifecycle({ state: "reconciling", generation: this.#generation });
    let lease: SidecarRuntimeLease | undefined;
    let existingOnly = false;
    const attempt = ++this.#attachmentAttempt;
    const started = performance.now();
    let stage = "lease_acquire";
    let stageStarted = started;
    this.#diagnostic("connect_start", { stage });
    try {
      lease = await this.input.provider.acquire(this.#controller.signal).catch(async error => {
        if (!this.#retainedIdentity || !isSidecarRevisionChanged(error)) throw error;
        this.#diagnostic("retained_acquire", { stage, durationMs: performance.now() - stageStarted }, error);
        existingOnly = true;
        return await this.input.provider.acquire(this.#controller.signal, { existingOnly: true });
      });
      this.#diagnostic("stage_complete", { stage, controllerEpoch: lease.controllerEpoch, durationMs: performance.now() - stageStarted });
      if (this.#closed) { lease.release(); return; }
      const connection = new CodexSidecarRuntimeConnection(lease.channel);
      stage = existingOnly ? "runtime_lookup" : "runtime_ensure";
      stageStarted = performance.now();
      const runtimeId = existingOnly
        ? await connection.lookup(this.input.configuration)
        : await connection.ensure(this.input.configuration);
      this.#diagnostic("stage_complete", { stage, controllerEpoch: lease.controllerEpoch, durationMs: performance.now() - stageStarted });
      if (!runtimeId || (existingOnly && (runtimeId !== this.#retainedIdentity!.runtimeId || lease.serviceIncarnation !== this.#retainedIdentity!.serviceIncarnation))) {
        connection.close();
        throw new Error("codex_retained_runtime_unavailable");
      }
      this.#retainedIdentity = { runtimeId, serviceIncarnation: lease.serviceIncarnation };
      if (this.#closed) { connection.close(); lease.release(); return; }
      this.#runtimeId = runtimeId;
      this.#generationOffset = this.#generation;
      const remote = new CodexRuntimeClient({
        connection, authority: { scope: this.#scope, runtimeId, controllerId: String(lease.controllerEpoch) },
        generationOffset: this.#generation, serverRequests: this.input.serverRequests, receipts: this.input.receipts,
        ...(this.input.onRuntimeVersionAssessment ? { onRuntimeVersionAssessment: this.input.onRuntimeVersionAssessment } : {}),
        onAttachmentFailure: failure => this.#lost(lease!, failure.stage, failure.error, failure),
        onIdleReleaseError: error => this.#reportIdleReleaseError(error),
      });
      this.#remote = remote; this.#connection = connection; this.#lease = lease;
      void lease.closed.then(value => this.#lost(lease!, "lease_closed", value), error => this.#lost(lease!, "lease_rejected", error));
      this.#subscriptions = [
        remote.client.subscribeLifecycle(lifecycle => {
          this.#generation = Math.max(this.#generation, lifecycle.generation);
          this.#current = lifecycle.state === "ready" ? {
            generation: lifecycle.generation, request: remote.client.request.bind(remote.client), requestWithReceipt: remote.client.requestWithReceipt.bind(remote.client),
          } : undefined;
          this.client.updateLifecycle({ ...lifecycle, generation: this.#generation });
        }),
        remote.client.subscribeNotifications(notification => this.client.forwardNotification(notification.generation, notification)),
      ];
      stage = "runtime_start";
      stageStarted = performance.now();
      await remote.start();
      this.#diagnostic("connect_complete", { stage, durationMs: performance.now() - started });
    } catch (error) {
      this.#diagnostic("connect_failed", { stage, attachmentAttempt: attempt, controllerEpoch: lease?.controllerEpoch,
        durationMs: performance.now() - stageStarted }, error);
      this.#remote?.disconnected();
      if (this.#lease === lease) this.#discardAttachment("connection_failed"); else lease?.release();
      for (let cause: unknown = error, depth = 0; existingOnly && cause instanceof Error && depth < 8; cause = cause.cause, depth++) {
        if (cause.message === "codex_retained_runtime_unavailable" || cause.message === "sidecar_service_absent") {
          this.#retainedUnavailable = true;
          this.client.updateLifecycle({ state: "unavailable", generation: this.#generation, unavailableReason: "runtime_configuration_unavailable" });
          break;
        }
      }
      throw error;
    }
  }
  #reportIdleReleaseError(error: unknown): void {
    console.warn("codex_idle_release_deferred", {
      backendInstanceId: this.#scope.backendInstanceId,
      executionEnvironmentId: this.#scope.executionEnvironmentId,
      reason: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
  }
  #lost(lease: SidecarRuntimeLease, reason: string, error?: unknown, failure?: CodexRuntimeAttachmentFailure): void {
    if (this.#lease !== lease) return;
    this.#diagnostic("attachment_lost", { reason, stage: failure?.stage, operationId: failure?.operationId,
      method: failure?.method, controllerEpoch: lease.controllerEpoch }, error);
    this.#remote?.disconnected();
    this.#discardAttachment(reason);
    if (!this.#closed) this.#scheduleRetry();
  }
  #discardAttachment(reason: string): void {
    this.#diagnostic("attachment_discard", { reason });
    for (const remove of this.#subscriptions.splice(0)) remove();
    this.#current = undefined;
    this.#connection?.close(); this.#connection = undefined;
    this.#lease?.release(); this.#lease = undefined;
    this.#remote = undefined;
    this.#runtimeId = undefined;
  }
  #diagnostic(event: string, fields: AttachmentDiagnosticFields, error?: unknown): void {
    attachmentDiagnostic(event, { backendInstanceId: this.#scope.backendInstanceId,
      executionEnvironmentId: this.#scope.executionEnvironmentId, generation: this.#generation,
      attachmentAttempt: this.#attachmentAttempt, controllerEpoch: this.#lease?.controllerEpoch, ...fields }, error);
  }
  #scheduleRetry(): void {
    if (this.#closed || this.#retainedUnavailable || this.#retry) return;
    this.client.updateLifecycle({ state: "reconciling", generation: this.#generation });
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#connect().catch(() => this.#scheduleRetry());
    }, 1000);
    this.#retry.unref();
  }
}
