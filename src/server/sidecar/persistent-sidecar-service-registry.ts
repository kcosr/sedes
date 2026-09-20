import { createHash, randomUUID } from "node:crypto";
import type { SidecarAbandonmentRecord } from "./sidecar-abandonment-archive.js";
import {
  SIDECAR_SERVICE_MAXIMUM_RESOURCES,
  sameSidecarServiceConfiguration,
  sameSidecarServiceScope,
  sidecarResourceSnapshotSchema,
  sidecarServiceConfigurationSchema,
  sidecarServiceScopeSchema,
  sidecarServiceStatusSchema,
  type SidecarResourceSnapshot,
  type SidecarServiceConfiguration,
  type SidecarServiceScope,
  type SidecarServiceStatus,
} from "../../internal/sidecar-protocol/service-management-v1.js";

export interface SidecarResourceStopContext {
  /** Explicit operator interruption may abandon delivery state, never process cleanup. */
  readonly force: boolean;
}

export interface SidecarResourceParticipant {
  readonly resourceId: string;
  readonly kind: SidecarResourceSnapshot["kind"];
  snapshot(): { readonly state: SidecarResourceSnapshot["state"]; readonly revision: string; readonly blockers: readonly SidecarResourceSnapshot["blockers"][number][] };
  /** Read-only native evidence refresh. Stop fences admission; status does not. */
  prepareRestart?(): Promise<void>;
  /** Resolves only when owned resources have positively settled/terminated. */
  stop(reason: string, context: SidecarResourceStopContext): Promise<void>;
  /** A lost controller changes attachment ownership, never resource lifetime. */
  onDetach?(): void;
}

export class SidecarResourceHandoffPendingError extends Error {
  readonly code = "sidecar_resource_handoff_pending";
  constructor() { super("sidecar_resource_handoff_pending"); this.name = "SidecarResourceHandoffPendingError"; }
}

/** One scoped service's resource authority; connection peers never own this. */
export class PersistentSidecarServiceRegistry {
  readonly scope: SidecarServiceScope;
  readonly serviceIncarnation = randomUUID();
  readonly #buildId: string;
  readonly #artifactSha256: string;
  readonly #runtimeWireVersion: number;
  readonly #resources = new Map<string, SidecarResourceParticipant>();
  readonly #refreshes = new Map<SidecarResourceParticipant, Promise<void>>();
  readonly #observationFailures = new Set<SidecarResourceParticipant>();
  readonly #recordAbandonment: ((record: SidecarAbandonmentRecord) => Promise<void>) | undefined;
  #controllerEpoch = 0;
  #attached = false;
  #attachmentMode: "none" | "normal" | "recovery" = "none";
  #state: SidecarServiceStatus["state"] = "ready";
  #desiredConfiguration: SidecarServiceConfiguration;
  #effectiveConfiguration: SidecarServiceConfiguration;
  #stopPromise: Promise<void> | undefined;

  constructor(input: {
    readonly scope: SidecarServiceScope;
    readonly buildId: string;
    readonly artifactSha256: string;
    readonly runtimeWireVersion: number;
    readonly configuration: SidecarServiceConfiguration;
    readonly recordAbandonment?: (record: SidecarAbandonmentRecord) => Promise<void>;
  }) {
    this.scope = Object.freeze(sidecarServiceScopeSchema.parse(input.scope));
    this.#buildId = input.buildId;
    this.#artifactSha256 = input.artifactSha256;
    this.#runtimeWireVersion = input.runtimeWireVersion;
    this.#recordAbandonment = input.recordAbandonment;
    this.#desiredConfiguration = Object.freeze(sidecarServiceConfigurationSchema.parse(input.configuration));
    this.#effectiveConfiguration = this.#desiredConfiguration;
    this.status();
  }

  get controllerEpoch(): number { return this.#controllerEpoch; }
  get attached(): boolean { return this.#attached; }

  /** Diagnostic preservation is best effort; it never vetoes authorized process cleanup. */
  async recordAbandonment(record: SidecarAbandonmentRecord): Promise<void> {
    try { await this.#recordAbandonment?.(record); } catch { /* Archive implementations report their own bounded diagnostic. */ }
  }

  assertScope(scope: SidecarServiceScope): void {
    if (!sameSidecarServiceScope(scope, this.scope)) throw new Error("sidecar_service_scope_mismatch");
  }

  register(participant: SidecarResourceParticipant): () => void {
    if (this.#state !== "ready") throw new Error("sidecar_service_not_accepting_work");
    if (this.#resources.has(participant.resourceId)) throw new Error("sidecar_resource_duplicate");
    if (this.#resources.size >= SIDECAR_SERVICE_MAXIMUM_RESOURCES) throw new Error("sidecar_resource_capacity_exceeded");
    this.#snapshot(participant);
    this.#resources.set(participant.resourceId, participant);
    return () => {
      if (this.#resources.get(participant.resourceId) === participant) this.#resources.delete(participant.resourceId);
      this.#observationFailures.delete(participant);
    };
  }

  /** Synchronous fencing is atomic with respect to new JS admission callbacks. */
  assertAdmission(controllerEpoch: number): void {
    this.assertController(controllerEpoch);
    if (this.#attachmentMode === "recovery") throw new Error("sidecar_recovery_attachment_read_only");
    if (this.#state !== "ready") throw new Error("sidecar_service_not_accepting_work");
    if (!sameSidecarServiceConfiguration(this.#desiredConfiguration, this.#effectiveConfiguration)) {
      throw new Error("sidecar_configuration_pending");
    }
  }

  assertController(controllerEpoch: number): void {
    if (!this.#attached || controllerEpoch !== this.#controllerEpoch) throw new Error("sidecar_controller_stale");
    if (this.#state === "stopped") throw new Error("sidecar_service_not_ready");
  }

  attach(configuration: SidecarServiceConfiguration, mode: "normal" | "recovery" = "normal"): number {
    if (this.#state !== "ready" && this.#state !== "handoff_pending") throw new Error("sidecar_service_not_ready");
    if (this.#controllerEpoch >= Number.MAX_SAFE_INTEGER) throw new Error("sidecar_controller_epoch_exhausted");
    this.detach(this.#controllerEpoch);
    this.#desiredConfiguration = Object.freeze(sidecarServiceConfigurationSchema.parse(configuration));
    if (!sameSidecarServiceConfiguration(this.#desiredConfiguration, this.#effectiveConfiguration)) {
      // Existing hosts may have cached grants. A changed revision needs a clean
      // service replacement; an idle observation alone cannot reauthorize them.
      if (this.#resources.size === 0) this.#effectiveConfiguration = this.#desiredConfiguration;
    }
    this.#attached = true;
    this.#attachmentMode = mode;
    return ++this.#controllerEpoch;
  }

  detach(controllerEpoch: number): void {
    if (!this.#attached || controllerEpoch !== this.#controllerEpoch) return;
    this.#attached = false;
    this.#attachmentMode = "none";
    for (const participant of this.#resources.values()) {
      try { participant.onDetach?.(); }
      catch { this.#state = "cleanup_unproven"; }
    }
  }

  status(): SidecarServiceStatus {
    const resources = this.#resourceSnapshots();
    return sidecarServiceStatusSchema.parse({
      scope: this.scope, serviceIncarnation: this.serviceIncarnation,
      buildId: this.#buildId, artifactSha256: this.#artifactSha256,
      runtimeWireVersion: this.#runtimeWireVersion,
      controllerEpoch: this.#controllerEpoch, attached: this.#attached, attachmentMode: this.#attachmentMode, state: this.#state,
      desiredConfiguration: this.#desiredConfiguration, effectiveConfiguration: this.#effectiveConfiguration,
      configurationState: sameSidecarServiceConfiguration(this.#desiredConfiguration, this.#effectiveConfiguration) ? "applied" : "pending",
      resources,
      resourcesFingerprint: fingerprint(resources),
    });
  }

  /** Refresh stale uncertainty without freezing normal admission or requiring a runtime attachment. */
  async refreshStatus(): Promise<SidecarServiceStatus> {
    if (this.#state !== "ready") return this.status();
    await Promise.all([...this.#resources.values()]
      .filter(participant => this.#snapshot(participant).state === "unknown")
      .map(participant => this.#refresh(participant, 1_000).catch(() => undefined)));
    return this.status();
  }

  async #refresh(participant: SidecarResourceParticipant, timeoutMilliseconds: number): Promise<void> {
    if (!participant.prepareRestart) return;
    let pending = this.#refreshes.get(participant);
    if (!pending) {
      pending = Promise.resolve().then(() => participant.prepareRestart!());
      this.#refreshes.set(participant, pending);
      void pending.then(() => {
        this.#refreshes.delete(participant);
        this.#observationFailures.delete(participant);
      }, () => {
        this.#refreshes.delete(participant);
        if (this.#resources.get(participant.resourceId) === participant) this.#observationFailures.add(participant);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sidecar_service_upgrade_inspection_failed")), timeoutMilliseconds);
      })]);
    } catch (error) {
      if (this.#resources.get(participant.resourceId) === participant) this.#observationFailures.add(participant);
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  async stop(input: {
    readonly expectedServiceIncarnation: string;
    readonly controllerEpoch: number;
    readonly expectedConfiguration: SidecarServiceConfiguration;
    readonly expectedResourcesFingerprint: string;
    readonly force: boolean;
    readonly reason: string;
  }): Promise<void> {
    if (input.expectedServiceIncarnation !== this.serviceIncarnation || input.controllerEpoch !== this.#controllerEpoch ||
      !sameSidecarServiceConfiguration(input.expectedConfiguration, this.#desiredConfiguration)) {
      throw new Error("sidecar_service_confirmation_stale");
    }
    // Only an explicit forced stop may retry unproven cleanup; every other
    // caller observes the retained outcome of the attempt that failed.
    const retryingCleanup = this.#state === "cleanup_unproven" && input.force;
    if (this.#stopPromise && !retryingCleanup) return await this.#stopPromise;
    if (this.#state === "draining") throw new Error("sidecar_service_stop_in_progress");
    if (this.#state !== "ready" && this.#state !== "handoff_pending" && !retryingCleanup) throw new Error("sidecar_service_cleanup_unproven");
    // Fence before observing blockers. All hosts must call assertAdmission
    // before committing launches or mutations, including after awaited probes.
    const previousState = this.#state;
    this.#state = "draining";
    this.#stopPromise = undefined;
    // Check the user's observation before our own native refresh can settle it.
    const confirmed = this.#resourceSnapshots();
    if (fingerprint(confirmed) !== input.expectedResourcesFingerprint) {
      this.#state = previousState;
      throw new Error("sidecar_service_confirmation_stale");
    }
    try {
      // Automatic replacement needs complete native evidence and grants the
      // native inventory its ten-second budget. Explicit Stop can interrupt
      // unknown work, so it need not wait beyond the short observation budget.
      await Promise.all([...this.#resources.values()].map((participant) => this.#refresh(participant, input.force ? 1_000 : 10_000)));
    } catch {
      if (!input.force) {
        this.#state = previousState;
        throw new Error("sidecar_service_upgrade_inspection_failed");
      }
    }
    const blockers = this.#resourceSnapshots();
    if (!onlySettledResources(confirmed, blockers, input.force)) {
      this.#state = previousState;
      throw new Error("sidecar_service_confirmation_stale");
    }
    if (!input.force && blockers.some((resource) => resource.state === "unknown" || resource.blockers.includes("cleanup_unproven"))) {
      this.#state = previousState;
      throw new Error("sidecar_service_cleanup_unproven");
    }
    if (!input.force && blockers.some((resource) => resource.state === "active" || resource.blockers.length > 0)) {
      this.#state = previousState;
      throw new Error("sidecar_service_upgrade_blocked");
    }
    this.#state = "stopping";
    this.#stopPromise = (async () => {
      const results = await Promise.allSettled([...this.#resources.values()].map((participant) => participant.stop(input.reason, { force: input.force })));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0 && failures.every((result) => result.reason instanceof SidecarResourceHandoffPendingError ||
        (result.reason instanceof Error && result.reason.message === "sidecar_resource_handoff_pending"))) {
        this.#state = "handoff_pending";
        // Explicit stop can be retried after the caller receives and acknowledges
        // bounded terminal/command results. New launches remain fenced meanwhile.
        this.#stopPromise = undefined;
        throw new SidecarResourceHandoffPendingError();
      }
      if (failures.length > 0) {
        this.#state = "cleanup_unproven";
        throw new Error("sidecar_service_cleanup_unproven");
      }
      this.#resources.clear();
      this.#observationFailures.clear();
      this.#attached = false;
      this.#attachmentMode = "none";
      this.#state = "stopped";
    })();
    return await this.#stopPromise;
  }

  #snapshot(participant: SidecarResourceParticipant): SidecarResourceSnapshot {
    try {
      if (this.#observationFailures.has(participant)) throw new Error("sidecar_resource_observation_unavailable");
      return sidecarResourceSnapshotSchema.parse({resourceId: participant.resourceId, kind: participant.kind, ...participant.snapshot()});
    } catch {
      return sidecarResourceSnapshotSchema.parse({resourceId: participant.resourceId, kind: participant.kind, state: "unknown", revision: "unknown", blockers: ["unknown_state"]});
    }
  }

  #resourceSnapshots(): SidecarResourceSnapshot[] {
    return [...this.#resources.values()].map((participant) => this.#snapshot(participant))
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  }
}

function fingerprint(resources: readonly SidecarResourceSnapshot[]): string {
  return createHash("sha256").update(JSON.stringify(resources)).digest("hex");
}

/** The fenced refresh may prove old work ended, but cannot confirm different work. */
function onlySettledResources(before: readonly SidecarResourceSnapshot[], after: readonly SidecarResourceSnapshot[], force: boolean): boolean {
  const previous = new Map(before.map(resource => [resource.resourceId, resource]));
  return after.every(resource => {
    const old = previous.get(resource.resourceId);
    if (!old || old.kind !== resource.kind) return false;
    if (JSON.stringify(old) === JSON.stringify(resource)) return true;
    // Explicit Stop owns every previously confirmed resource. Admission is
    // fenced, so output and refreshed native activity cannot revoke that intent.
    if (force) return true;
    // A changed active/unknown revision might describe newly discovered work.
    // Only positive, complete settlement can replace the confirmed revision.
    return resource.state === "idle" && resource.blockers.length === 0 &&
      (old.state !== "idle" || old.blockers.length > 0);
  });
}
