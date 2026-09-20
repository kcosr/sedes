import { windowsSidecarIpc } from "./sidecar-windows-ipc.js";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { LengthPrefixedSidecarFrameTransport } from "../../internal/sidecar-protocol/length-prefixed-frame-transport.js";
import { SidecarOperationRegistry } from "../../internal/sidecar-protocol/operation-registry.js";
import { SidecarProtocolPeer } from "../../internal/sidecar-protocol/protocol-peer.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../internal/sidecar-protocol/service-management-channel.js";
import {
  SIDECAR_MANAGEMENT_VERSION,
  sidecarManagementRequestSchema,
  sidecarManagementResponseSchema,
  type SidecarManagementRequest,
  type SidecarManagementResponse,
} from "../../internal/sidecar-protocol/service-management-v1.js";
import { PersistentSidecarServiceRegistry } from "./persistent-sidecar-service-registry.js";
import { SidecarRuntimeAttachment } from "./sidecar-runtime-attachment.js";
import { sidecarSocketByteStream } from "./sidecar-socket-byte-stream.js";
import { PersistentSidecarManagementReceipts } from "./persistent-sidecar-management-receipts.js";
import { attachmentDiagnostic } from "../diagnostics/attachment-diagnostics.js";
import { deliveryDiagnosticsEnabled } from "../diagnostics/delivery-diagnostic-output.js";

export interface PersistentSidecarRuntimeAttachmentContext {
  readonly registry: SidecarOperationRegistry;
  readonly peer: SidecarProtocolPeer;
  readonly attachment: SidecarRuntimeAttachment;
  readonly controllerEpoch: number;
  readonly sessionNonce: string;
  /** New effects, including continuation after an awaited admission probe. */
  readonly assertAdmission: () => void;
  /** Status, result handoff and controller operations while draining. */
  readonly assertController: () => void;
}

/** Private Unix service endpoint. Management is decoded before runtime frames. */
export class PersistentSidecarServiceServer {
  readonly attachment = new SidecarRuntimeAttachment();
  readonly closed: Promise<void>;
  readonly #registry: PersistentSidecarServiceRegistry;
  readonly #endpointPath: string;
  readonly #onRuntimeAttachment: (input: PersistentSidecarRuntimeAttachmentContext) => void;
  readonly #receipts: PersistentSidecarManagementReceipts;
  readonly #onStopped: () => Promise<void>;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #resolveClosed: () => void;
  #endpointIdentity: { readonly dev: number; readonly ino: number } | undefined;
  #endpointKey: Buffer | undefined;
  #started = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly registry: PersistentSidecarServiceRegistry;
    readonly endpointPath: string;
    readonly onRuntimeAttachment: (input: PersistentSidecarRuntimeAttachmentContext) => void;
    readonly receipts: PersistentSidecarManagementReceipts;
    readonly onStopped: () => Promise<void>;
  }) {
    this.#registry = input.registry;
    this.#endpointPath = input.endpointPath;
    this.#onRuntimeAttachment = input.onRuntimeAttachment;
    this.#receipts = input.receipts;
    this.#onStopped = input.onStopped;
    let resolveClosed!: () => void;
    this.closed = new Promise((resolve) => { resolveClosed = resolve; });
    this.#resolveClosed = resolveClosed;
    this.#server = createServer((socket) => {
      if (this.#sockets.size >= 128) { socket.destroy(); return; }
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
      void this.#accept(socket).catch(() => socket.destroy());
    });
    this.attachment.subscribe((event) => {
      if (event === "detached") this.#registry.detach(this.attachment.controllerEpoch);
    });
  }

  async listen(): Promise<void> {
    if (this.#started) throw new Error("sidecar_service_already_started");
    this.#started = true;
    if (process.platform === "win32") this.#endpointKey = await windowsSidecarIpc.prepareKey(this.#endpointPath);
    await new Promise<void>((resolve, reject) => {
      const error = (failure: Error) => reject(failure);
      this.#server.once("error", error);
      this.#server.listen(this.#endpointPath, () => {
        this.#server.removeListener("error", error);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      await chmod(this.#endpointPath, 0o600);
      const metadata = await lstat(this.#endpointPath);
      this.#endpointIdentity = { dev: metadata.dev, ino: metadata.ino };
    }
  }

  async stop(force: boolean, reason: string): Promise<void> {
    const status = this.#registry.status();
    await this.#registry.stop({ expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
      expectedConfiguration: status.desiredConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint, force, reason });
    // Resources are proven stopped; a failed retirement record must not keep
    // the retired service listening.
    try {
      await this.#onStopped();
    } finally {
      await this.#closeEndpoint();
    }
  }

  async #accept(socket: Socket): Promise<void> {
    if (this.#endpointKey) await windowsSidecarIpc.authenticate(socket, this.#endpointKey, "server");
    const original = sidecarSocketByteStream(socket);
    const { value: request, stream } = await readSidecarManagementRecord(original, sidecarManagementRequestSchema, AbortSignal.timeout(10_000));
    let requestScopeAdmitted = false;
    let admittedControllerEpoch: number | undefined;
    let retired = false;
    try {
      this.#registry.assertScope(request.scope);
      requestScopeAdmitted = true;
      if (request.operation === "status") {
        await this.#registry.refreshStatus();
        await writeSidecarManagementRecord(stream, this.#response(request));
        socket.end();
        return;
      }
      if (request.operation === "receipt") {
        await writeSidecarManagementRecord(stream, { managementVersion: SIDECAR_MANAGEMENT_VERSION, requestId: request.requestId,
          outcome: "receipt", receipt: await this.#receipts.read(request.mutationId) ?? null });
        socket.end();
        return;
      }
      if (request.operation === "withdraw") {
        // Same precondition as a control: only the service the requester
        // observed may fence its id. A replaced service leaves it to polling.
        if (request.expectedServiceIncarnation !== this.#registry.serviceIncarnation) throw new Error("sidecar_service_confirmation_stale");
        const withdrawal = await this.#receipts.withdraw(request.mutationId, this.#registry.serviceIncarnation);
        await writeSidecarManagementRecord(stream, { managementVersion: SIDECAR_MANAGEMENT_VERSION, requestId: request.requestId, outcome: "receipt", receipt: withdrawal.receipt });
        socket.end();
        return;
      }
      if (request.operation !== "attach") {
        // Admission waits behind durable ledger writes. A requester whose
        // carrier ended meanwhile cannot observe this outcome and recovers
        // through the receipt instead, so the effect must not begin.
        let requesterGone = false;
        void (async () => {
          try { for await (const trailing of stream.bytes) void trailing; }
          catch { /* the closure itself is the signal */ }
          requesterGone = true;
        })();
        const admission = await this.#receipts.begin(request, this.#registry.serviceIncarnation);
        if (!admission.created) {
          await writeSidecarManagementRecord(stream, { managementVersion: SIDECAR_MANAGEMENT_VERSION, requestId: request.requestId, outcome: "receipt", receipt: admission.receipt });
          socket.end();
          return;
        }
        if (requesterGone || socket.destroyed) {
          await this.#receipts.finish(request.requestId, "failed", "sidecar_management_requester_gone");
          throw new Error("sidecar_management_requester_gone");
        }
        try {
          await this.#registry.stop({ ...request, reason: request.operation === "restart" ? "sidecar_service_replacement" : "sidecar_service_explicit_stop" });
        } catch (error) {
          const code = managementFailureCode(error);
          await this.#receipts.finish(request.requestId, code === "sidecar_resource_handoff_pending" ? "handoff_pending" : "failed", code);
          throw error;
        }
        // Resources are proven stopped. Whatever happens next, the endpoint
        // closes after this request is answered (see the finally below): a
        // service with no owned work must exit rather than keep listening.
        retired = true;
        try {
          // Record the retired incarnation before the receipt claims completion,
          // so a completed receipt always implies a replacement may proceed
          // once this process exits.
          await this.#onStopped();
        } catch (error) {
          // Closing the remaining hosts or writing the "stopped" ownership
          // record failed after the resources ended. The receipt settles as
          // failed with that code so a replay reports the failure instead of
          // pending forever, and the response names it. The ownership record
          // may still read "running" while this process exits, so the next
          // bootstrap demands explicit recovery instead of trusting an
          // unrecorded retirement; the receipt stays readable for that review.
          await this.#receipts.finish(request.requestId, "failed", managementFailureCode(error)).catch(() => undefined);
          throw error;
        }
        try {
          await this.#receipts.finish(request.requestId, "completed");
        } catch (error) {
          // The service retired and recorded "stopped", but its ledger could
          // not record the completion. The receipt stays "accepted" (a replay
          // reports an unknown outcome) while the response names the ledger
          // failure; a fresh stop after this exit finds the service absent.
          throw new Error("sidecar_management_receipt_unsettled", { cause: error });
        }
        await writeSidecarManagementRecord(stream, this.#response(request));
        socket.end();
        return;
      }
      const status = this.#registry.status();
      // Compatibility is the runtime protocol, not the build. A newer main
      // attaches to an older compatible service and reports it as outdated;
      // the runtime handshake still verifies the exact build it is talking to.
      if (request.runtimeWireVersion !== status.runtimeWireVersion) throw new Error("sidecar_runtime_upgrade_required");
      const controllerEpoch = this.#registry.attach(request.configuration, request.mode);
      admittedControllerEpoch = controllerEpoch;
      const registry = new SidecarOperationRegistry({ beforeDispatch: () => this.#registry.assertController(controllerEpoch) });
      // There is no provider/session lifetime in this carrier. Even protocol
      // errors must detach resource callbacks before peer cancellation runs.
      const transport = new LengthPrefixedSidecarFrameTransport({
        assurance: { kind: "persistent_sidecar_unix", carrierGeneration: request.carrierGeneration }, stream,
      });
      const detach = () => {
        this.#registry.detach(controllerEpoch);
        this.attachment.detach(controllerEpoch);
      };
      const peer = new SidecarProtocolPeer({
        role: "sidecar", transport, sessionNonce: request.sessionNonce, registry,
        onReady: () => this.attachment.ready(controllerEpoch),
        onClosing: detach,
        diagnosticsEnabled: deliveryDiagnosticsEnabled,
        onDiagnostic: (record, error) => attachmentDiagnostic("sidecar_heartbeat_trace", {
          executionEnvironmentId: this.#registry.scope.executionEnvironmentId,
          controllerEpoch, ...record,
        }, error),
      });
      this.attachment.replace(peer, controllerEpoch);
      this.#onRuntimeAttachment({ registry, peer, attachment: this.attachment, controllerEpoch, sessionNonce: request.sessionNonce,
        assertAdmission: () => this.#registry.assertAdmission(controllerEpoch),
        assertController: () => this.#registry.assertController(controllerEpoch) });
      await writeSidecarManagementRecord(stream, this.#response(request));
      peer.start();
      const watchdog = setInterval(() => {
        const activity = peer.activitySnapshot();
        if (Date.now() - activity.lastInboundActivityAtMilliseconds >= 35_000) {
          attachmentDiagnostic("sidecar_upstream_liveness_expired", {
            executionEnvironmentId: this.#registry.scope.executionEnvironmentId,
            controllerEpoch, carrierGeneration: request.carrierGeneration,
            transportKind: "persistent_sidecar_unix", role: "sidecar",
            inboundIdleMs: Date.now() - activity.lastInboundActivityAtMilliseconds,
            pendingOperationRequests: activity.pendingOperationRequests,
            pendingOperationSends: activity.pendingOperationSends,
          });
          detach();
          void peer.close("sidecar_upstream_liveness_expired").catch(() => undefined);
        }
      }, 10_000);
      watchdog.unref();
      try { await transport.closed; }
      finally { clearInterval(watchdog); detach(); }
    } catch (error) {
      if (admittedControllerEpoch !== undefined) {
        this.#registry.detach(admittedControllerEpoch);
        this.attachment.detach(admittedControllerEpoch);
      }
      const response: SidecarManagementResponse = {
        managementVersion: SIDECAR_MANAGEMENT_VERSION, requestId: request.requestId, outcome: "error", code: managementFailureCode(error),
        ...(requestScopeAdmitted ? { status: this.#registry.status() } : {}),
      };
      await writeSidecarManagementRecord(stream, sidecarManagementResponseSchema.parse(response)).catch(() => undefined);
      socket.end();
    } finally {
      // A retired service closes its endpoint once its answer passed the write
      // boundary, whether that answer was completion or a post-retirement
      // failure. A requester that vanished before reading it cannot keep the
      // service listening; the durable receipt already answers it.
      if (retired) await this.#closeEndpoint(socket);
    }
  }

  #response(request: SidecarManagementRequest): SidecarManagementResponse {
    return sidecarManagementResponseSchema.parse({ managementVersion: SIDECAR_MANAGEMENT_VERSION,
      requestId: request.requestId, outcome: "ok", status: this.#registry.status() });
  }

  #closeEndpoint(responseSocket?: Socket): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#registry.detach(this.#registry.controllerEpoch);
      this.attachment.detach(this.#registry.controllerEpoch);
      for (const socket of this.#sockets) if (socket !== responseSocket) socket.destroy();
      // A response already passed its write boundary; a half-open requester
      // cannot keep the retired service alive indefinitely.
      responseSocket?.end();
      const timer = responseSocket ? setTimeout(() => responseSocket.destroy(), 1_000) : undefined;
      timer?.unref();
      await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
      if (timer) clearTimeout(timer);
      const current = process.platform === "win32" ? undefined : await lstat(this.#endpointPath).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (current && current.dev === this.#endpointIdentity?.dev && current.ino === this.#endpointIdentity.ino) await unlink(this.#endpointPath);
      this.#resolveClosed();
    })();
    return this.#closePromise;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** A management code is a bare identifier; any other failure is reported generically. */
function managementFailureCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,119}$/u.test(error.message) ? error.message : "sidecar_management_failed";
}
