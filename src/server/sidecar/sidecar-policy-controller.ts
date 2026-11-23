import type {
  ExecutionPolicyStatus,
  InstalledExecutionPolicy,
} from "../../internal/sidecar-protocol/execution-policy.js";
import type { SidecarServiceStatus } from "../../internal/sidecar-protocol/service-management-v1.js";

const DELIVERY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

export interface PolicyConnection {
  readPolicy(signal?: AbortSignal): Promise<ExecutionPolicyStatus>;
  applyPolicy(
    desired: InstalledExecutionPolicy,
    signal?: AbortSignal,
    observed?: ExecutionPolicyStatus,
  ): Promise<ExecutionPolicyStatus>;
}

type PolicyStamp = Pick<InstalledExecutionPolicy, "revision" | "digest">;
export interface SidecarPolicyRecovery {
  blocked(incarnation: string): boolean;
  requireRecovery(
    incarnation: string,
    desired: PolicyStamp,
    installed: PolicyStamp,
  ): void;
}

interface PolicyEvidence {
  status: ExecutionPolicyStatus;
  confirmed: InstalledExecutionPolicy;
}

interface AttachedController {
  peer: PolicyConnection;
  service: SidecarServiceStatus;
  controller: AbortController;
}

/** In-memory evidence belongs to exactly one authenticated normal attachment.
 * SQLite remains authoritative even while a policy transfer is in progress. */
export class SidecarPolicyController {
  readonly #readDesired: () => InstalledExecutionPolicy;
  readonly #notify: () => void;
  #connection: AttachedController | undefined;
  #attempt: Promise<void> | undefined;
  #lastRequested: string | undefined;
  #retryIndex = 0;
  #timer: NodeJS.Timeout | undefined;
  #confirmed: PolicyEvidence | undefined;
  #status: ExecutionPolicyStatus | undefined;
  #renewable: PolicyEvidence | undefined;
  #conflictedIncarnation: string | undefined;
  #conflict = false;
  readonly #routeLeases = new Set<{
    generation: number;
    backendId: string;
    backendGeneration?: number;
    end(): void;
  }>();

  constructor(
    readDesired: () => InstalledExecutionPolicy,
    notify: () => void,
    readonly recovery?: SidecarPolicyRecovery,
  ) {
    this.#readDesired = readDesired;
    this.#notify = notify;
  }

  attach(peer: PolicyConnection, service: SidecarServiceStatus): void {
    const renewable = this.#renewable;
    this.detach();
    if (renewable?.status.incarnation === service.serviceIncarnation) this.#renewable = renewable;
    this.#connection = { peer, service, controller: new AbortController() };
    this.#conflict = this.requiresRecovery(service.serviceIncarnation);
  }

  detach(retainForAcquisition = false): void {
    // Detached evidence can advertise eligible work. Only a newly synchronized
    // attachment can admit it or issue routes.
    this.#renewable = retainForAcquisition && !this.#conflict
      ? this.#confirmed ?? this.#renewable : undefined;
    const published = this.#status !== undefined;
    this.#connection?.controller.abort();
    this.#connection = undefined;
    this.#clearTimer();
    this.#attempt = undefined;
    this.#confirmed = undefined;
    this.#lastRequested = undefined;
    this.#status = undefined;
    this.#retryIndex = 0;
    // A disconnected quarantined peer stays fenced until a new incarnation is observed.
    this.#conflict = this.#conflict && retainForAcquisition;
    for (const lease of this.#routeLeases) lease.end();
    if (published) this.#notify();
  }

  get status() {
    return this.#status;
  }
  requiresRecovery(incarnation: string): boolean {
    return this.#conflictedIncarnation === incarnation || this.recovery?.blocked(incarnation) === true;
  }

  get conflict() {
    return this.#conflict;
  }

  #evidence(forAcquisition: boolean, desired: InstalledExecutionPolicy): PolicyEvidence | undefined {
    if (this.#conflict) return undefined;
    const evidence = this.#confirmed ?? (forAcquisition ? this.#renewable : undefined);
    return evidence && !diverges(evidence.confirmed, desired) ? evidence : undefined;
  }

  /** A desired subject without an observation can initiate discovery. Once
   * the current attachment has replied, its readiness governs acquisition. */
  #mayDiscover(forAcquisition: boolean, desired: InstalledExecutionPolicy): boolean {
    return forAcquisition && !this.#conflict &&
      (!this.#connection || (!this.#status && !!this.#attempt)) &&
      !diverges(this.#renewable?.confirmed ?? null, desired);
  }

  capabilityGeneration(id: string, forAcquisition = false): number | undefined {
    const desired = this.#readDesired();
    const grant = desired.snapshot.capabilities.find(entry => entry.id === id);
    const evidence = this.#evidence(forAcquisition, desired);
    if (!grant) return undefined;
    const observed = evidence?.confirmed.snapshot.capabilities.some(
      installed => installed.id === id && installed.generation === grant.generation,
    );
    return (observed ? subjectReady(evidence, `capability:${id}`, grant.generation) : this.#mayDiscover(forAcquisition, desired))
      ? grant.generation : undefined;
  }

  backendGeneration(id: string, forAcquisition = false): number | undefined {
    const desired = this.#readDesired();
    const grant = desired.snapshot.backends.find(entry => entry.id === id);
    const evidence = this.#evidence(forAcquisition, desired);
    return grant && evidence?.confirmed.snapshot.backends.some(
      installed => installed.id === id && installed.generation === grant.generation,
    ) && subjectReady(evidence, `backend:${id}`, grant.generation) ? grant.generation : undefined;
  }

  targetGeneration(backendId: string, targetId: string, forAcquisition = false): number | undefined {
    const desired = this.#readDesired();
    const evidence = this.#evidence(forAcquisition, desired);
    const backend = desired.snapshot.backends.find(entry => entry.id === backendId);
    const installed = evidence?.confirmed.snapshot.backends.find(entry => entry.id === backendId);
    const target = backend?.targets.find(entry => entry.id === targetId);
    if (!backend || !target) return undefined;
    const discover = this.#mayDiscover(forAcquisition, desired);
    if (backend.generation !== installed?.generation) return discover ? target.generation : undefined;
    if (!subjectReady(evidence, `backend:${backendId}`, backend.generation)) return undefined;
    return discover || installed.targets.some(entry => entry.id === targetId && entry.generation === target.generation)
      ? target.generation : undefined;
  }

  workspaceRoots(forAcquisition = false): InstalledExecutionPolicy["snapshot"]["roots"] {
    const desired = this.#readDesired();
    const evidence = this.#evidence(forAcquisition, desired);
    const discover = this.#mayDiscover(forAcquisition, desired);
    return desired.snapshot.roots.filter(root => {
      const observed = evidence?.confirmed.snapshot.roots.some(
        installed => installed.id === root.id && installed.path === root.path && installed.generation === root.generation,
      );
      return observed ? subjectReady(evidence, `root:${root.id}`, root.generation) : discover;
    });
  }

  routeGeneration(backendId: string): number | undefined {
    const generation = this.capabilityGeneration("agent_tools_cli");
    return generation !== undefined &&
      this.backendGeneration(backendId) !== undefined &&
      subjectReady(this.#confirmed, `route:${backendId}`, generation) ? generation : undefined;
  }

  leaseRoute(
    generation: number,
    backendId: string,
  ): { closed: Promise<void>; signal: AbortSignal; release(): void } {
    const backendGeneration = this.backendGeneration(backendId);
    if (this.routeGeneration(backendId) !== generation)
      throw new Error("sidecar_policy_route_unavailable");
    const controller = new AbortController();
    let end!: () => void;
    const closed = new Promise<void>((resolve) => {
      end = resolve;
    });
    const lease = {
      generation,
      backendId,
      backendGeneration,
      end: () => {
        this.#routeLeases.delete(lease);
        controller.abort();
        end();
      },
    };
    this.#routeLeases.add(lease);
    return { closed, signal: controller.signal, release: lease.end };
  }

  #invalidateRoutes(): void {
    for (const lease of this.#routeLeases) {
      if (
        this.routeGeneration(lease.backendId) !== lease.generation ||
        this.backendGeneration(lease.backendId) !== lease.backendGeneration
      )
        lease.end();
    }
  }

  /** Called after a save, explicit retry, or attach. A save may supersede an
   * in-flight snapshot. The same serial executor will converge on the latest. */
  synchronize(force = false): Promise<void> {
    this.#invalidateRoutes();
    const desired = this.#readDesired();
    const key = `${desired.revision}:${desired.digest}`;
    // Routine reconciliation keeps the scheduled backoff for an unchanged
    // request. Completion here is not proof: admission reads confirmed grants.
    if (!force && key === this.#lastRequested)
      return this.#attempt ?? Promise.resolve();
    this.#lastRequested = key;
    this.#retryIndex = 0;
    return this.#start();
  }

  #start(): Promise<void> {
    const connection = this.#connection;
    if (!connection) return Promise.resolve();
    if (this.#attempt) return this.#attempt;
    this.#clearTimer();
    const attempt = this.#deliver(connection)
      .catch((error) => {
        if (!connection.controller.signal.aborted) {
          const delay = DELIVERY_BACKOFF_MS[this.#retryIndex++] ?? 300_000;
          this.#schedule(delay);
        }
        throw error;
      })
      .finally(() => {
        if (this.#attempt === attempt) this.#attempt = undefined;
      });
    this.#attempt = attempt;
    return attempt;
  }

  async #deliver(connection: AttachedController): Promise<void> {
    const signal = connection.controller.signal;
    for (;;) {
      let observed = await connection.peer.readPolicy(signal);
      signal.throwIfAborted();
      this.#assertAttachment(observed, connection.service);
      let desired = this.#readDesired();
      if (!this.#conflict && diverges(observed.installed, desired)) {
        // A save can race the read and the preceding request can have lost its
        // reply. Confirm both durable desired state and this daemon's epoch.
        observed = await connection.peer.readPolicy(signal);
        signal.throwIfAborted();
        this.#assertAttachment(observed, connection.service);
        desired = this.#readDesired();
      }
      if (this.#conflict || diverges(observed.installed, desired)) {
        const changed =
          !this.#conflict ||
          JSON.stringify(this.#status) !== JSON.stringify(observed);
        this.#renewable = undefined;
        this.#conflict = true;
        this.#conflictedIncarnation = observed.incarnation;
        if (observed.installed && !this.recovery?.blocked(observed.incarnation))
          this.recovery?.requireRecovery(
            observed.incarnation,
            desired,
            observed.installed,
          );
        this.#confirmed = undefined;
        this.#status = observed;
        this.#invalidateRoutes();
        if (changed) this.#notify();
        return;
      }
      if (
        !this.#confirmed ||
        observed.installed?.revision !== desired.revision ||
        observed.installed?.digest !== desired.digest
      ) {
        observed = await connection.peer.applyPolicy(desired, signal, observed);
        signal.throwIfAborted();
        this.#assertAttachment(observed, connection.service);
      }
      if (
        observed.installed?.revision !== desired.revision ||
        observed.installed.digest !== desired.digest ||
        observed.configuration.environmentRevision !==
          desired.configuration.environmentRevision ||
        observed.configuration.operationsRevision !==
          desired.configuration.operationsRevision
      )
        throw new Error("sidecar_policy_confirmation_invalid");
      const latest = this.#readDesired();
      if (
        latest.revision !== desired.revision ||
        latest.digest !== desired.digest
      )
        continue;
      const changed =
        JSON.stringify(this.#status) !== JSON.stringify(observed) ||
        this.#conflict;
      this.#status = observed;
      this.#renewable = undefined;
      this.#confirmed = {confirmed: desired, status: observed};
      this.#conflict = false;
      this.#retryIndex = 0;
      this.#invalidateRoutes();
      this.#schedule(
        observed.readiness.some((entry) => entry.state === "preparing")
          ? 2_000
          : 30_000,
      );
      if (changed) this.#notify();
      return;
    }
  }

  #assertAttachment(
    observed: ExecutionPolicyStatus,
    service: SidecarServiceStatus,
  ): void {
    if (
      observed.incarnation !== service.serviceIncarnation ||
      observed.controllerEpoch !== service.controllerEpoch
    )
      throw new Error("sidecar_policy_controller_changed");
  }

  #schedule(delay: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      void this.#start().catch(() => undefined);
    }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function subjectReady(evidence: PolicyEvidence | undefined, key: string, generation: number): boolean {
  return evidence?.status.readiness.some(entry => entry.id === key && entry.generation === generation && entry.state === "ready") === true;
}

function diverges(
  installed: PolicyStamp | null,
  desired: PolicyStamp,
): boolean {
  return (
    installed !== null &&
    (installed.revision > desired.revision ||
      (installed.revision === desired.revision &&
        installed.digest !== desired.digest))
  );
}
