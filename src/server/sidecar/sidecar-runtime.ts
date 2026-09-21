import { randomBytes, randomUUID } from "node:crypto";
import type { SidecarCapabilityInventory } from "../../internal/sidecar-protocol/control-v2.js";
import { SIDECAR_WIRE_VERSION } from "../../internal/sidecar-protocol/envelopes.js";
import {
  SidecarFrameWriteError,
  SidecarProtocolDeliveryError,
  type SidecarByteStream,
} from "../../internal/sidecar-protocol/contracts.js";
import type { SidecarOperationRegistry } from "../../internal/sidecar-protocol/operation-registry.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarArtifactRegistration } from "./sidecar-artifact.js";
import { SidecarProvisionerCleanupError, type SidecarProvisioner } from "./sidecar-provisioner.js";
import { SidecarServiceManagementError, type SidecarArtifactInstallation, type SidecarServiceControlInput, type SidecarServiceControlBoundary } from "./sidecar-provisioner.js";
import type { SidecarServiceStatus, SidecarManagementReceipt } from "../../internal/sidecar-protocol/service-management-v1.js";

const DEFAULT_IDLE_MILLISECONDS = 5 * 60_000;

export class SidecarUnavailableError extends Error {
  readonly diagnosticCode = "sidecar_unavailable" as const;

  constructor(options?: ErrorOptions) {
    super("sidecar_unavailable", options);
    this.name = "SidecarUnavailableError";
  }
}

export class SidecarSessionCleanupError extends Error {
  readonly diagnosticCode = "sidecar_session_cleanup_failed" as const;

  constructor(options: ErrorOptions) {
    super("sidecar_session_cleanup_failed", options);
    this.name = "SidecarSessionCleanupError";
  }
}

export interface SidecarRuntimeSession {
  readonly negotiatedCapabilities: readonly SidecarCapabilityInventory[];
  readonly closed: Promise<unknown>;
  close(reason: string): Promise<void>;
}

export type SidecarLifecycleEvidence =
  | Readonly<{ readonly availability: "available" }>
  | Readonly<{
      readonly availability: "unavailable";
      readonly diagnosticCode:
        "sidecar_carrier_failed" | "sidecar_session_failed";
    }>;

export type SidecarAuthorizedCapability =
  | Readonly<{
      readonly capabilityId: "directory_browser";
      readonly majorVersion: 1;
    }>
  | Readonly<{
      readonly capabilityId: "workspace_files";
      readonly majorVersion: 8;
    }>
  | Readonly<{
      readonly capabilityId: "workspace_tools";
      readonly majorVersion: 2;
    }>
  | Readonly<{
      readonly capabilityId:
        | "workspace_context"
        | "workspace_skills"
        | "composer_attachments";
      readonly majorVersion: 1;
    }>
  | Readonly<{ readonly capabilityId: "interactive_terminal"; readonly majorVersion: 2 }>
  | Readonly<{
      readonly capabilityId: "agent_tools_cli";
      readonly majorVersion: 3;
    }>;

export type SidecarRuntimeCapability = Readonly<{
  readonly capabilityId: string;
  readonly majorVersion: number;
  readonly operations: readonly string[];
}>;

export interface SidecarRuntimeLease<
  Session extends SidecarRuntimeSession,
> {
  readonly session: Session;
  readonly carrierGeneration: number;
  readonly serviceStatus: SidecarServiceStatus;
  release(): void;
}

interface AutomaticRecoveryAttachment<Session extends SidecarRuntimeSession> {
  readonly existingOnly: boolean;
  readonly controller: AbortController;
  readonly promise: Promise<SidecarRuntimeLease<Session>>;
  references: number;
  lease: SidecarRuntimeLease<Session> | undefined;
}

export interface SidecarRuntimeOwnerOptions<
  Session extends SidecarRuntimeSession,
> {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  readonly environmentConfigurationRevision: number;
  readonly operationsConfigurationRevision: number;
  readonly authorizedCapabilities: readonly SidecarAuthorizedCapability[];
  readonly authorizedRuntimeCapabilities: readonly SidecarRuntimeCapability[];
  readonly isAutomaticConnectionEnabled: () => boolean | Promise<boolean>;
  readonly activeEnvironmentConfigurationRevision: () =>
    number | Promise<number>;
  readonly activeOperationsConfigurationRevision: () =>
    number | Promise<number>;
  readonly artifact: SidecarArtifactRegistration;
  readonly provisioner: SidecarProvisioner;
  readonly sedesOperations: SidecarOperationRegistry;
  readonly startSession: (input: {
    readonly executionEnvironmentId?: string;
    readonly stream: SidecarByteStream;
    readonly transportKind: string;
    readonly carrierGeneration: number;
    readonly sessionNonce: string;
    readonly artifact: Pick<SidecarArtifactRegistration, "buildId" | "artifactSha256">;
    readonly installation: SidecarArtifactInstallation;
    readonly authorizedCapabilities: readonly SidecarAuthorizedCapability[];
    readonly authorizedRuntimeCapabilities: readonly SidecarRuntimeCapability[];
    readonly sedesOperations: SidecarOperationRegistry;
    readonly signal: AbortSignal;
  }) => Promise<Session>;
  readonly idleMilliseconds?: number;
  /** Synchronous presence for outbound carriers; SSH can establish one lazily. */
  readonly isTransportAvailable?: () => boolean;
  readonly onLifecycleEvidence?: (
    evidence: SidecarLifecycleEvidence,
  ) => void | Promise<void>;
  readonly onBackgroundError?: (error: unknown) => void;
}

/**
 * Environment-scoped owner for one lazy sidecar generation. It emits lifecycle
 * evidence but owns no environment-availability policy or Codex lifecycle, and
 * it never falls back to a local filesystem.
 */
export class SidecarRuntimeOwner<Session extends SidecarRuntimeSession> {
  readonly #scope: RequestScope;
  readonly #executionEnvironmentId: string;
  readonly #environmentConfigurationRevision: number;
  readonly #operationsConfigurationRevision: number;
  readonly #authorizedCapabilities: readonly SidecarAuthorizedCapability[];
  readonly #authorizedRuntimeCapabilities: readonly SidecarRuntimeCapability[];
  readonly #isAutomaticConnectionEnabled: () => boolean | Promise<boolean>;
  readonly #activeEnvironmentConfigurationRevision: () =>
    number | Promise<number>;
  readonly #activeOperationsConfigurationRevision: () =>
    number | Promise<number>;
  readonly #artifact: SidecarArtifactRegistration;
  readonly #provisioner: SidecarRuntimeOwnerOptions<Session>["provisioner"];
  readonly #sedesOperations: SidecarOperationRegistry;
  readonly #startSession: SidecarRuntimeOwnerOptions<Session>["startSession"];
  readonly #idleMilliseconds: number;
  readonly #isTransportAvailable: () => boolean;
  readonly #onLifecycleEvidence: (
    evidence: SidecarLifecycleEvidence,
  ) => void | Promise<void>;
  readonly #onBackgroundError: (error: unknown) => void;
  readonly #closeController = new AbortController();
  #attachmentController = new AbortController();
  #intentionallyDisconnected = false;
  #startPromise: Promise<OwnedSession<Session>> | undefined;
  #current: OwnedSession<Session> | undefined;
  #carrierGeneration = 0;
  #operationLeases = 0;
  #watchLeases = 0;
  #agentToolLeases = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  readonly #retiringSessions = new Set<Promise<void>>();
  readonly #sessionRetirements = new WeakMap<Session, Promise<void>>();
  #lastNegotiatedCapabilities: readonly SidecarCapabilityInventory[] | undefined;
  readonly #recoverySessions = new Set<Session>();
  #automaticRecovery: AutomaticRecoveryAttachment<Session> | undefined;
  #retirementFailure: unknown;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(input: SidecarRuntimeOwnerOptions<Session>) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.executionEnvironmentId ||
      !Number.isSafeInteger(input.environmentConfigurationRevision) ||
      input.environmentConfigurationRevision < 0 ||
      !Number.isSafeInteger(input.operationsConfigurationRevision) ||
      input.operationsConfigurationRevision < 0 ||
      input.authorizedCapabilities.length > 8 ||
      !Array.isArray(input.authorizedRuntimeCapabilities) || input.authorizedRuntimeCapabilities.length > 32 ||
      input.authorizedRuntimeCapabilities.length + input.authorizedCapabilities.filter((capability) => capability.capabilityId !== "agent_tools_cli").length + (input.authorizedRuntimeCapabilities.length ? 1 : 0) + 1 > 32 ||
      input.authorizedRuntimeCapabilities.some((capability) => !/^[a-z][a-z0-9_]{0,119}$/u.test(capability.capabilityId) || ["control", "runtime_bodies", "agent_tools_cli"].includes(capability.capabilityId) ||
        input.authorizedCapabilities.some((ancillary) => ancillary.capabilityId === capability.capabilityId) ||
        !Number.isSafeInteger(capability.majorVersion) || capability.majorVersion < 1 || capability.majorVersion > 65535 ||
        !Array.isArray(capability.operations) || capability.operations.length < 1 || capability.operations.length > 128 ||
        capability.operations.some((operation: string) => !/^[a-z][a-z0-9_.-]{0,119}$/u.test(operation)) || new Set(capability.operations).size !== capability.operations.length) ||
      new Set(input.authorizedRuntimeCapabilities.map((capability) => capability.capabilityId)).size !== input.authorizedRuntimeCapabilities.length ||
      typeof input.isAutomaticConnectionEnabled !== "function" ||
      new Set(
        input.authorizedCapabilities.map(
          ({ capabilityId, majorVersion }) =>
            `${capabilityId}\0${majorVersion}`,
        ),
      ).size !== input.authorizedCapabilities.length ||
      input.authorizedCapabilities.some(
        ({ capabilityId, majorVersion }) =>
          (capabilityId !== "directory_browser" &&
            capabilityId !== "workspace_files" &&
            capabilityId !== "workspace_tools" &&
            capabilityId !== "workspace_context" &&
            capabilityId !== "workspace_skills" &&
            capabilityId !== "composer_attachments" &&
            capabilityId !== "interactive_terminal" &&
            capabilityId !== "agent_tools_cli") ||
          majorVersion !==
            (capabilityId === "workspace_files"
              ? 8
              : capabilityId === "workspace_tools"
                ? 2
              : capabilityId === "agent_tools_cli"
                ? 3
                : capabilityId === "interactive_terminal" ? 2 : 1),
      ) ||
      input.authorizedCapabilities.some(
        ({ capabilityId }) => capabilityId === "workspace_tools",
      ) !==
        input.authorizedCapabilities.some(
          ({ capabilityId }) => capabilityId === "workspace_context",
        )
    ) {
      throw new Error("sidecar_runtime_configuration_invalid");
    }
    const idleMilliseconds =
      input.idleMilliseconds ?? DEFAULT_IDLE_MILLISECONDS;
    if (!Number.isSafeInteger(idleMilliseconds) || idleMilliseconds <= 0) {
      throw new Error("sidecar_runtime_idle_invalid");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#executionEnvironmentId = input.executionEnvironmentId;
    this.#environmentConfigurationRevision =
      input.environmentConfigurationRevision;
    this.#operationsConfigurationRevision =
      input.operationsConfigurationRevision;
    this.#authorizedCapabilities = Object.freeze(
      input.authorizedCapabilities.map((capability) =>
        Object.freeze({ ...capability }),
      ),
    );
    this.#authorizedRuntimeCapabilities = Object.freeze(input.authorizedRuntimeCapabilities.map((capability) => Object.freeze({ ...capability })));
    this.#isAutomaticConnectionEnabled = input.isAutomaticConnectionEnabled;
    this.#activeEnvironmentConfigurationRevision =
      input.activeEnvironmentConfigurationRevision;
    this.#activeOperationsConfigurationRevision =
      input.activeOperationsConfigurationRevision;
    this.#artifact = input.artifact;
    this.#provisioner = input.provisioner;
    this.#sedesOperations = input.sedesOperations;
    this.#startSession = input.startSession;
    this.#idleMilliseconds = idleMilliseconds;
    this.#isTransportAvailable = input.isTransportAvailable ?? (() => true);
    this.#onLifecycleEvidence = input.onLifecycleEvidence ?? (() => undefined);
    this.#onBackgroundError = input.onBackgroundError ?? (() => undefined);
  }

  get negotiatedCapabilities(): readonly SidecarCapabilityInventory[] {
    return this.#closed || this.#intentionallyDisconnected || !this.#isTransportAvailable() ? [] : this.#lastNegotiatedCapabilities ?? [];
  }

  /** Lazy admission is possible before the first handshake. Once observed,
   * missing native capabilities stay unavailable through idle retirement;
   * every operation still validates its newly acquired session inventory. */
  canAcquireCapability(capabilityId: string, majorVersion: number): boolean {
    if (this.#closed || this.#intentionallyDisconnected || this.#retirementFailure !== undefined || !this.#isTransportAvailable()) return false;
    if (!this.#authorizedCapabilities.some(capability => capability.capabilityId === capabilityId && capability.majorVersion === majorVersion)) return false;
    return this.#lastNegotiatedCapabilities === undefined || this.#lastNegotiatedCapabilities.some(capability => capability.capabilityId === capabilityId && capability.majorVersion === majorVersion);
  }

  get artifact(): SidecarArtifactRegistration {
    return this.#artifact;
  }

  inspectService(signal: AbortSignal): Promise<SidecarServiceStatus | undefined> { return this.#provisioner.inspect(signal); }
  inspectServiceReceipt(mutationId: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined> { return this.#provisioner.inspectReceipt(mutationId, signal); }
  /** Fences an unacknowledged mutation id remotely; undefined means the service is gone. */
  withdrawServiceReceipt(mutationId: string, expectedServiceIncarnation: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined> { return this.#provisioner.withdrawReceipt(mutationId, expectedServiceIncarnation, signal); }

  acquireRecovery(scope: RequestScope, executionEnvironmentId: string, signal: AbortSignal, requiredCapabilities: readonly SidecarAuthorizedCapability[] = []): Promise<SidecarRuntimeLease<Session>> {
    return this.#acquireRecovery(scope, executionEnvironmentId, signal, false, requiredCapabilities);
  }

  acquireAutomaticRecovery(scope: RequestScope, executionEnvironmentId: string, signal: AbortSignal): Promise<SidecarRuntimeLease<Session>> {
    return this.#acquireAutomaticRecovery(scope, executionEnvironmentId, signal, false);
  }

  /** Existing backend work may finish under its original grants while replacement is pending.
   * The daemon attachment is recovery-only: it cannot admit a new process or operation. */
  acquireRetainedRecovery(scope: RequestScope, executionEnvironmentId: string, signal: AbortSignal): Promise<SidecarRuntimeLease<Session>> {
    return this.#acquireAutomaticRecovery(scope, executionEnvironmentId, signal, true);
  }

  async #acquireAutomaticRecovery(scope: RequestScope, executionEnvironmentId: string, signal: AbortSignal, allowPendingRevision: boolean): Promise<SidecarRuntimeLease<Session>> {
    const attachmentSignal = this.#attachmentController.signal;
    this.#assertScope(scope, executionEnvironmentId);
    await this.#assertActive(allowPendingRevision);
    attachmentSignal.throwIfAborted();
    signal.throwIfAborted();
    let attachment = this.#automaticRecovery;
    if (allowPendingRevision && attachment && !attachment.existingOnly) {
      // A previous observer may have borrowed a normal controller. A retained
      // backend must instead use a daemon-enforced recovery-only attachment.
      this.#automaticRecovery = undefined;
      attachment.controller.abort();
      attachment.lease?.release();
      attachment = undefined;
    }
    if (!attachment) {
      const controller = new AbortController();
      attachment = {
        existingOnly: allowPendingRevision,
        controller,
        references: 0,
        lease: undefined,
        promise: this.#acquireRecovery(scope, executionEnvironmentId, controller.signal, true, [], allowPendingRevision),
      };
      this.#automaticRecovery = attachment;
      const owned = attachment;
      const forget = () => {
        if (this.#automaticRecovery === owned) this.#automaticRecovery = undefined;
      };
      void owned.promise.then((lease) => {
        owned.lease = lease;
        if (owned.references === 0) lease.release();
        void lease.session.closed.then(forget, forget);
      }, forget);
    }
    const owned = attachment;
    const release = this.#referenceAutomaticRecovery(owned);
    try {
      const lease = await withAbort(owned.promise, signal);
      this.#assertScope(scope, executionEnvironmentId);
      await this.#assertActive(allowPendingRevision);
      attachmentSignal.throwIfAborted();
      owned.controller.signal.throwIfAborted();
      signal.throwIfAborted();
      return Object.freeze({ ...lease, release });
    } catch (error) {
      release();
      throw error;
    }
  }

  #referenceAutomaticRecovery(owned: AutomaticRecoveryAttachment<Session>): () => void {
    owned.references += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owned.references -= 1;
      if (owned.references !== 0) return;
      if (this.#automaticRecovery === owned) this.#automaticRecovery = undefined;
      owned.controller.abort();
      owned.lease?.release();
    };
    return release;
  }

  async #borrowRetainedRecovery(required: readonly SidecarAuthorizedCapability[], signal: AbortSignal): Promise<SidecarRuntimeLease<Session> | undefined> {
    const owned = this.#automaticRecovery;
    if (this.#current || this.#intentionallyDisconnected || !owned?.existingOnly || owned.controller.signal.aborted ||
      required.some(capability => !this.#authorizedCapabilities.some(admitted =>
        admitted.capabilityId === capability.capabilityId && admitted.majorVersion === capability.majorVersion))) return undefined;
    const release = this.#referenceAutomaticRecovery(owned);
    try {
      const lease = await withAbort(owned.promise, signal);
      this.#assertScope(this.#scope, this.#executionEnvironmentId);
      signal.throwIfAborted();
      owned.controller.signal.throwIfAborted();
      if (this.#automaticRecovery !== owned || this.#intentionallyDisconnected) throw new SidecarUnavailableError();
      return Object.freeze({ ...lease, release });
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Revalidate retained automatic work before observing or cancelling it. */
  async assertAutomaticRecoveryActive(scope: RequestScope, executionEnvironmentId: string): Promise<void> {
    this.#assertScope(scope, executionEnvironmentId);
    await this.#assertActive();
  }

  async #acquireRecovery(scope: RequestScope, executionEnvironmentId: string, signal: AbortSignal, automatic: boolean, requiredCapabilities: readonly SidecarAuthorizedCapability[], allowPendingRevision = false): Promise<SidecarRuntimeLease<Session>> {
    this.#assertScope(scope, executionEnvironmentId);
    const recoveryCapabilities = this.#recoveryCapabilities(requiredCapabilities);
    if (automatic) await this.#assertActive(allowPendingRevision);
    if (this.#closed || signal.aborted) throw new SidecarUnavailableError({ cause: signal.reason });
    const borrowed = allowPendingRevision ? undefined : this.#borrowCurrentRecovery(requiredCapabilities);
    if (borrowed) return borrowed;
    const retained = automatic ? undefined : await this.#borrowRetainedRecovery(requiredCapabilities, signal);
    if (retained) return retained;
    if (this.#recoverySessions.size >= 8) throw new SidecarUnavailableError();
    const attachmentSignal = this.#attachmentController.signal;
    const controller = AbortSignal.any([signal, this.#closeController.signal, ...(automatic ? [attachmentSignal] : [])]);
    // This stages a verified client artifact only. attachExisting cannot start
    // a service and its read-only epoch cannot launch or mutate remote work.
    await this.#provisioner.install(controller);
    if (automatic) await this.#assertActive(allowPendingRevision);
    controller.throwIfAborted();
    // A normal session may have finished starting while artifact verification
    // awaited I/O. Inspection must preserve its existing controller too.
    if (this.#startPromise) {
      await withAbort(this.#startPromise.then(() => undefined, () => undefined), controller);
      if (automatic) await this.#assertActive(allowPendingRevision);
      controller.throwIfAborted();
    }
    const available = allowPendingRevision ? undefined : this.#borrowCurrentRecovery(requiredCapabilities);
    if (available) return available;
    const retainedAfterInstall = automatic ? undefined : await this.#borrowRetainedRecovery(requiredCapabilities, controller);
    if (retainedAfterInstall) return retainedAfterInstall;
    // The service admits one controller. A live normal session that cannot
    // grant the required capabilities is retired here deliberately, rather
    // than being evicted remotely as an unexplained failure.
    if (this.#current && !this.#intentionallyDisconnected) await this.#retireCurrent("sidecar_recovery_replaced");
    const carrierGeneration = ++this.#carrierGeneration;
    const sessionNonce = randomBytes(32).toString("base64url");
    const stream = await this.#provisioner.attachExisting(carrierGeneration, sessionNonce, controller);
    let session: Session;
    try {
      if (automatic) await this.#assertActive(allowPendingRevision);
      controller.throwIfAborted();
      session = await this.#startSession({ stream, transportKind: this.#provisioner.transportKind, carrierGeneration, sessionNonce, artifact: stream.serviceStatus, installation: stream.installation,
        executionEnvironmentId: this.#executionEnvironmentId,
        authorizedCapabilities: recoveryCapabilities, authorizedRuntimeCapabilities: this.#authorizedRuntimeCapabilities,
        sedesOperations: this.#sedesOperations, signal: controller });
    } catch (error) { await stream.close("sidecar_recovery_handshake_failed").catch(() => undefined); throw error; }
    try { if (automatic) await this.#assertActive(allowPendingRevision); controller.throwIfAborted(); }
    catch (error) { await this.#beginSessionRetirement(session, "sidecar_recovery_admission_changed"); throw error; }
    this.#recoverySessions.add(session);
    // Automatic observation must stop when the operator disconnects. Manual
    // recovery attachments deliberately remain available after disconnect.
    const detachAutomatic = () => {
      void this.#beginSessionRetirement(session, "sidecar_intentionally_disconnected").catch(this.#onBackgroundError);
    };
    const remove = () => {
      attachmentSignal.removeEventListener("abort", detachAutomatic);
      this.#recoverySessions.delete(session);
    };
    if (automatic) {
      attachmentSignal.addEventListener("abort", detachAutomatic, { once: true });
      if (attachmentSignal.aborted) detachAutomatic();
    }
    void session.closed.then(remove, remove);
    let released = false;
    return { session, carrierGeneration, serviceStatus: stream.serviceStatus, release: () => {
      if (released) return;
      released = true;
      remove();
      void this.#beginSessionRetirement(session, "sidecar_recovery_detached").catch(this.#onBackgroundError);
    } };
  }

  #recoveryCapabilities(required: readonly SidecarAuthorizedCapability[]): readonly SidecarAuthorizedCapability[] {
    const allowed = { workspace_files: 8, workspace_tools: 2, workspace_context: 1, interactive_terminal: 2 } as const;
    if (!Array.isArray(required) || required.length > 4 || required.some((capability) => !capability ||
      Object.keys(capability).length !== 2 || !Object.hasOwn(capability, "capabilityId") || !Object.hasOwn(capability, "majorVersion") || !Object.hasOwn(allowed, capability.capabilityId) ||
      allowed[capability.capabilityId as keyof typeof allowed] !== capability.majorVersion) ||
      new Set(required.map((capability) => capability.capabilityId)).size !== required.length) throw new Error("sidecar_recovery_capabilities_invalid");
    const merged = [...this.#authorizedCapabilities];
    for (const capability of required) if (!merged.some((normal) => normal.capabilityId === capability.capabilityId)) merged.push(capability);
    if (merged.some(({ capabilityId }) => capabilityId === "workspace_tools") !== merged.some(({ capabilityId }) => capabilityId === "workspace_context") ||
      merged.filter(({ capabilityId }) => capabilityId !== "agent_tools_cli").length + this.#authorizedRuntimeCapabilities.length +
        (this.#authorizedRuntimeCapabilities.length ? 1 : 0) + 1 > 32) throw new Error("sidecar_recovery_capabilities_invalid");
    const order = ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli", "interactive_terminal"];
    return Object.freeze(merged.sort((left, right) => order.indexOf(left.capabilityId) - order.indexOf(right.capabilityId)).map((capability) => Object.freeze({ ...capability })));
  }

  #borrowCurrentRecovery(required: readonly SidecarAuthorizedCapability[]): SidecarRuntimeLease<Session> | undefined {
    const owned = this.#current;
    if (!owned || this.#intentionallyDisconnected || required.some((capability) => !this.#authorizedCapabilities.some((normal) =>
      normal.capabilityId === capability.capabilityId && normal.majorVersion === capability.majorVersion))) return undefined;
    // Inspection has the same bounded attachment lifetime as an operation
    // lease, without starting a carrier or replacing its authenticated epoch.
    this.#clearIdleTimer();
    this.#operationLeases += 1;
    let released = false;
    return Object.freeze({ session: owned.session, carrierGeneration: owned.carrierGeneration, serviceStatus: owned.serviceStatus,
      release: () => {
        if (released) return;
        released = true;
        this.#operationLeases -= 1;
        this.#scheduleIdleIfEligible();
      },
    });
  }

  async connect(signal: AbortSignal): Promise<SidecarServiceStatus> {
    this.#intentionallyDisconnected = false;
    await this.#session(signal);
    let status = await this.inspectService(signal);
    if (!status) throw new SidecarUnavailableError();
    if (this.#outdated(status) && status.resources.every((resource) => resource.state === "idle" && resource.blockers.length === 0)) {
      // The service answered, is compatible, and owns no unsettled work: this
      // is the proven-safe idle replacement that needs no confirmation. The
      // service still refuses if work was admitted since this observation.
      try {
        await this.controlService({ mutationId: randomUUID(), operation: "upgrade", expectedServiceIncarnation: status.serviceIncarnation,
          controllerEpoch: status.controllerEpoch, expectedConfiguration: status.desiredConfiguration,
          expectedResourcesFingerprint: status.resourcesFingerprint, force: false }, signal);
      } catch (error) {
        if (!(error instanceof SidecarServiceManagementError) ||
          !["sidecar_service_confirmation_stale", "sidecar_service_upgrade_blocked", "sidecar_service_cleanup_unproven"].includes(error.code)) throw error;
      }
      this.#intentionallyDisconnected = false;
      await this.#session(signal);
      status = await this.inspectService(signal);
      if (!status) throw new SidecarUnavailableError();
    }
    return status;
  }

  #outdated(status: SidecarServiceStatus): boolean {
    return status.runtimeWireVersion === SIDECAR_WIRE_VERSION && (status.artifactSha256 !== this.#artifact.artifactSha256 ||
      status.effectiveConfiguration.environmentRevision !== this.#environmentConfigurationRevision ||
      status.effectiveConfiguration.operationsRevision !== this.#operationsConfigurationRevision);
  }

  async disconnect(reason = "sidecar_intentionally_disconnected"): Promise<void> {
    this.#intentionallyDisconnected = true;
    await this.#retireAttachment(reason);
  }

  /** Carrier loss retires attachment authority without changing operator intent. */
  async disconnectTransport(reason: string): Promise<void> {
    await this.#retireAttachment(reason);
  }

  async #retireAttachment(reason: string): Promise<void> {
    const automaticRecovery = this.#automaticRecovery;
    this.#automaticRecovery = undefined;
    automaticRecovery?.controller.abort(new SidecarUnavailableError());
    this.#attachmentController.abort(new SidecarUnavailableError());
    const starting = this.#startPromise;
    await this.#retireCurrent(reason);
    try { await starting; }
    catch (error) { if (!(error instanceof SidecarUnavailableError)) throw error; }
    this.#attachmentController = new AbortController();
  }

  async controlService(input: SidecarServiceControlInput, signal: AbortSignal, boundary?: SidecarServiceControlBoundary): Promise<SidecarServiceStatus | undefined> {
    const completeControl: SidecarServiceControlBoundary = async effect => {
      const result = await effect();
      await this.disconnect(input.operation === "stop" ? "sidecar_explicitly_stopped" : "sidecar_replaced");
      return result;
    };
    if (!boundary) return await completeControl(() => this.#provisioner.control(input, signal));
    return await this.#provisioner.control(input, signal, effect => boundary(() => completeControl(effect)));
  }

  get activeOperationLeaseCount(): number {
    return this.#operationLeases;
  }

  get activeWatchLeaseCount(): number {
    return this.#watchLeases;
  }

  get activeAgentToolLeaseCount(): number {
    return this.#agentToolLeases;
  }

  async acquireOperation(
    scope: RequestScope,
    executionEnvironmentId: string,
    signal: AbortSignal,
  ): Promise<SidecarRuntimeLease<Session>> {
    return await this.#acquire(
      "operation",
      scope,
      executionEnvironmentId,
      signal,
    );
  }

  async acquireWatch(
    scope: RequestScope,
    executionEnvironmentId: string,
    signal: AbortSignal,
  ): Promise<SidecarRuntimeLease<Session>> {
    return await this.#acquire("watch", scope, executionEnvironmentId, signal);
  }

  async acquireAgentTools(
    scope: RequestScope,
    executionEnvironmentId: string,
    signal: AbortSignal,
  ): Promise<SidecarRuntimeLease<Session>> {
    if (
      !this.#authorizedCapabilities.some(
        ({ capabilityId }) => capabilityId === "agent_tools_cli",
      )
    ) {
      throw new SidecarUnavailableError();
    }
    return await this.#acquire(
      "agent_tools",
      scope,
      executionEnvironmentId,
      signal,
    );
  }

  close(reason = "sidecar_runtime_closed"): Promise<void> {
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  async #acquire(
    kind: "operation" | "watch" | "agent_tools",
    scope: RequestScope,
    executionEnvironmentId: string,
    signal: AbortSignal,
  ): Promise<SidecarRuntimeLease<Session>> {
    this.#assertScope(scope, executionEnvironmentId);
    if (signal.aborted) {
      throw new SidecarUnavailableError({ cause: signal.reason });
    }
    this.#clearIdleTimer();
    if (kind === "operation") this.#operationLeases += 1;
    else if (kind === "watch") this.#watchLeases += 1;
    else this.#agentToolLeases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (kind === "operation") this.#operationLeases -= 1;
      else if (kind === "watch") this.#watchLeases -= 1;
      else this.#agentToolLeases -= 1;
      this.#scheduleIdleIfEligible();
    };
    try {
      const owned = await this.#session(signal);
      if (signal.aborted) {
        throw new SidecarUnavailableError({
          cause: signal.reason,
        });
      }
      return Object.freeze({
        session: owned.session,
        carrierGeneration: owned.carrierGeneration,
        serviceStatus: owned.serviceStatus,
        release,
      });
    } catch (error) {
      release();
      if (error instanceof SidecarUnavailableError) throw error;
      throw new SidecarUnavailableError({ cause: error });
    }
  }

  async #session(signal: AbortSignal): Promise<OwnedSession<Session>> {
    await this.#assertActive();
    const current = this.#current;
    if (current) return current;
    let starting = this.#startPromise;
    if (!starting) {
      starting = this.#start();
      this.#startPromise = starting;
      void starting
        .finally(() => {
          if (this.#startPromise === starting) this.#startPromise = undefined;
        })
        .catch(() => undefined);
    }
    return await withAbort(starting, signal);
  }

  async #start(): Promise<OwnedSession<Session>> {
    let stream: SidecarByteStream | undefined;
    let session: Session | undefined;
    let launchAttempted = false;
    let handshakeStarted = false;
    const signal = AbortSignal.any([this.#closeController.signal, this.#attachmentController.signal]);
    try {
      for (const recovery of this.#recoverySessions) void this.#beginSessionRetirement(recovery, "sidecar_normal_attachment_replaced_recovery");
      await Promise.all([...this.#retiringSessions]);
      await this.#assertActive();
      await this.#provisioner.install(
        signal,
      );
      await this.#assertActive();
      const carrierGeneration = ++this.#carrierGeneration;
      const sessionNonce = randomBytes(32).toString("base64url");
      launchAttempted = true;
      const launched = await this.#provisioner.launch(
        carrierGeneration,
        sessionNonce,
        signal,
      );
      stream = launched;
      await this.#assertActive();
      handshakeStarted = true;
      session = await this.#startSession({
        executionEnvironmentId: this.#executionEnvironmentId,
        stream,
        transportKind: this.#provisioner.transportKind,
        carrierGeneration,
        sessionNonce,
        // The handshake verifies the build actually serving, which may be a
        // compatible predecessor that still owns work.
        artifact: launched.serviceStatus,
        installation: launched.installation,
        authorizedCapabilities: this.#authorizedCapabilities,
        authorizedRuntimeCapabilities: this.#authorizedRuntimeCapabilities,
        sedesOperations: this.#sedesOperations,
        signal,
      });
      await this.#assertActive();
      const owned = Object.freeze({ session, carrierGeneration, serviceStatus: launched.serviceStatus });
      this.#current = owned;
      this.#lastNegotiatedCapabilities = session.negotiatedCapabilities;
      const readyPublication = this.#publishLifecycleEvidence({
        availability: "available",
      });
      void session.closed.then(
        () => this.#sessionClosed(owned),
        (error) => this.#sessionClosed(owned, error),
      );
      await readyPublication;
      return owned;
    } catch (error) {
      let cleanupFailure: unknown;
      try {
        await session?.close("sidecar_start_failed");
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      try {
        await stream?.close("sidecar_start_failed");
      } catch (cleanupError) {
        cleanupFailure ??= cleanupError;
      }
      if (cleanupFailure !== undefined) {
        this.#retirementFailure ??= cleanupFailure;
        throw cleanupFailure;
      }
      if (error instanceof SidecarProvisionerCleanupError) {
        this.#retirementFailure ??= error;
        throw error;
      }
      if (launchAttempted && !handshakeStarted && !serviceAnswered(error)) {
        // A service that refused or deferred admission is reachable; only a
        // carrier that never reached management is a connectivity failure.
        await this.#publishLifecycleEvidence({
          availability: "unavailable",
          diagnosticCode: "sidecar_carrier_failed",
        });
      } else if (handshakeStarted && isSidecarTransportFailure(error)) {
        await this.#publishLifecycleEvidence({
          availability: "unavailable",
          diagnosticCode: "sidecar_session_failed",
        });
      }
      if (error instanceof SidecarUnavailableError) throw error;
      throw new SidecarUnavailableError({ cause: error });
    }
  }

  #sessionClosed(owned: OwnedSession<Session>, error?: unknown): void {
    if (this.#current !== owned) return;
    this.#current = undefined;
    if (error instanceof SidecarSessionCleanupError) {
      this.#retirementFailure ??= error;
    } else {
      void this.#publishLifecycleEvidence({
        availability: "unavailable",
        diagnosticCode: "sidecar_session_failed",
      });
    }
    if (error !== undefined && !this.#closed) this.#onBackgroundError(error);
    this.#scheduleIdleIfEligible();
  }

  #scheduleIdleIfEligible(): void {
    if (
      this.#closed ||
      this.#idleTimer ||
      !this.#current ||
      this.#operationLeases !== 0 ||
      this.#watchLeases !== 0 ||
      this.#agentToolLeases !== 0
    ) {
      return;
    }
    const owned = this.#current;
    const timer = setTimeout(() => {
      if (this.#idleTimer !== timer) return;
      this.#idleTimer = undefined;
      if (
        this.#closed ||
        this.#current !== owned ||
        this.#operationLeases !== 0 ||
        this.#watchLeases !== 0 ||
        this.#agentToolLeases !== 0
      ) {
        this.#scheduleIdleIfEligible();
        return;
      }
      this.#current = undefined;
      void this.#beginSessionClose(owned, "sidecar_idle_expired").catch(
        this.#onBackgroundError,
      );
    }, this.#idleMilliseconds);
    timer.unref();
    this.#idleTimer = timer;
  }

  #clearIdleTimer(): void {
    if (!this.#idleTimer) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  async #performClose(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdleTimer();
    this.#closeController.abort(new SidecarUnavailableError());
    const starting = this.#startPromise;
    const current = this.#current;
    this.#current = undefined;
    const retirementsToJoin = new Set(this.#retiringSessions);
    for (const recovery of this.#recoverySessions) retirementsToJoin.add(this.#beginSessionRetirement(recovery, reason));
    this.#recoverySessions.clear();
    if (current) {
      retirementsToJoin.add(this.#beginSessionClose(current, reason));
    }

    const failures: unknown[] = [];
    if (this.#retirementFailure !== undefined) {
      failures.push(this.#retirementFailure);
    }
    if (starting) {
      try {
        await starting;
      } catch (error) {
        // Aborting an ordinary in-flight install/start is expected during
        // shutdown. Cleanup failures deliberately escape #start unwrapped.
        if (!(error instanceof SidecarUnavailableError)) {
          failures.push(error);
        }
      }
    }
    for (const retirement of this.#retiringSessions) {
      retirementsToJoin.add(retirement);
    }
    const retirements = await Promise.allSettled([...retirementsToJoin]);
    for (const result of retirements) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) throw failures[0];
  }

  #assertScope(scope: RequestScope, executionEnvironmentId: string): void {
    if (this.#retirementFailure !== undefined) {
      throw new SidecarUnavailableError({
        cause: this.#retirementFailure,
      });
    }
    if (
      this.#closed ||
      scope.tenantId !== this.#scope.tenantId ||
      scope.principalId !== this.#scope.principalId ||
      executionEnvironmentId !== this.#executionEnvironmentId
    ) {
      throw new SidecarUnavailableError();
    }
  }

  async #assertActive(allowPendingRevision = false): Promise<void> {
    if (this.#retirementFailure !== undefined) {
      throw new SidecarUnavailableError({
        cause: this.#retirementFailure,
      });
    }
    if (this.#closed || this.#closeController.signal.aborted) throw unavailable("sidecar_runtime_closed");
    if (this.#intentionallyDisconnected) throw unavailable("sidecar_intentionally_disconnected");
    if (!(await this.#isAutomaticConnectionEnabled())) throw unavailable("sidecar_automatic_connection_disabled");
    if (!this.#isTransportAvailable()) throw unavailable("sidecar_transport_unavailable");
    let environmentRevision: number;
    let operationsRevision: number;
    try {
      [environmentRevision, operationsRevision] = await Promise.all([
        this.#activeEnvironmentConfigurationRevision(),
        this.#activeOperationsConfigurationRevision(),
      ]);
    } catch (error) {
      throw new SidecarUnavailableError({ cause: error });
    }
    if (this.#retirementFailure !== undefined) {
      throw new SidecarUnavailableError({
        cause: this.#retirementFailure,
      });
    }
    if (
      this.#closed ||
      (!allowPendingRevision && (environmentRevision !== this.#environmentConfigurationRevision ||
      operationsRevision !== this.#operationsConfigurationRevision))
    ) {
      if (!this.#closed) {
        try {
          await this.#retireCurrent("sidecar_revision_changed");
        } catch (error) {
          throw new SidecarUnavailableError({ cause: error });
        }
        throw unavailable("sidecar_revision_changed");
      }
      throw unavailable("sidecar_runtime_closed");
    }
    if (this.#closed || this.#closeController.signal.aborted) throw unavailable("sidecar_runtime_closed");
    if (this.#intentionallyDisconnected) throw unavailable("sidecar_intentionally_disconnected");
    if (!(await this.#isAutomaticConnectionEnabled())) throw unavailable("sidecar_automatic_connection_disabled");
    if (!this.#isTransportAvailable()) throw unavailable("sidecar_transport_unavailable");
  }

  #publishLifecycleEvidence(
    evidence: SidecarLifecycleEvidence,
  ): Promise<void> {
    const publication = this.#lifecycleTail.then(async () => {
      if (this.#closed) return;
      let environmentRevision: number;
      let operationsRevision: number;
      try {
        [environmentRevision, operationsRevision] = await Promise.all([
          this.#activeEnvironmentConfigurationRevision(),
          this.#activeOperationsConfigurationRevision(),
        ]);
      } catch (error) {
        this.#onBackgroundError(error);
        return;
      }
      if (
        this.#closed ||
        environmentRevision !== this.#environmentConfigurationRevision ||
        operationsRevision !== this.#operationsConfigurationRevision
      ) {
        return;
      }
      try {
        await this.#onLifecycleEvidence(evidence);
      } catch (error) {
        this.#onBackgroundError(error);
      }
    });
    this.#lifecycleTail = publication.catch(() => undefined);
    return publication;
  }

  async #retireCurrent(reason: string): Promise<void> {
    this.#clearIdleTimer();
    const current = this.#current;
    if (current) {
      this.#current = undefined;
      void this.#beginSessionClose(current, reason);
    }
    await Promise.all([...this.#retiringSessions]);
  }

  #beginSessionClose(
    owned: OwnedSession<Session>,
    reason: string,
  ): Promise<void> {
    return this.#beginSessionRetirement(owned.session, reason);
  }

  #beginSessionRetirement(session: Session, reason: string): Promise<void> {
    const existing = this.#sessionRetirements.get(session);
    if (existing) return existing;
    const retirement = Promise.resolve()
      .then(() => session.close(reason))
      .catch((error: unknown) => {
        this.#retirementFailure ??= error;
        throw error;
      });
    this.#sessionRetirements.set(session, retirement);
    this.#retiringSessions.add(retirement);
    void retirement
      .finally(() => this.#retiringSessions.delete(retirement))
      .catch(() => undefined);
    return retirement;
  }
}

/** Administration reads the cause to tell a refused attachment from an unreachable host. */
function unavailable(code: "sidecar_runtime_closed" | "sidecar_intentionally_disconnected" | "sidecar_automatic_connection_disabled" | "sidecar_transport_unavailable" | "sidecar_revision_changed"): SidecarUnavailableError {
  return new SidecarUnavailableError({ cause: new Error(code) });
}

function serviceAnswered(error: unknown): boolean {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (error instanceof SidecarServiceManagementError) return true;
  }
  return false;
}

function isSidecarTransportFailure(error: unknown): boolean {
  return (
    error instanceof SidecarFrameWriteError ||
    error instanceof SidecarProtocolDeliveryError
  );
}

interface OwnedSession<Session extends SidecarRuntimeSession> {
  readonly serviceStatus: SidecarServiceStatus;
  readonly session: Session;
  readonly carrierGeneration: number;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => finish(false, signal.reason);
    const finish = (success: boolean, value: unknown) => {
      signal.removeEventListener("abort", abort);
      if (success) resolve(value as T);
      else reject(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
  });
}
