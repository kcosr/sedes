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
  #confirmed: InstalledExecutionPolicy | undefined;
  #status: ExecutionPolicyStatus | undefined;
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
    this.detach();
    this.#connection = { peer, service, controller: new AbortController() };
    this.#conflict =
      this.#conflictedIncarnation === service.serviceIncarnation ||
      this.recovery?.blocked(service.serviceIncarnation) === true;
  }

  detach(): void {
    const published = this.#status !== undefined;
    this.#connection?.controller.abort();
    this.#connection = undefined;
    this.#clearTimer();
    this.#attempt = undefined;
    this.#confirmed = undefined;
    this.#lastRequested = undefined;
    this.#status = undefined;
    this.#retryIndex = 0;
    this.#conflict = false;
    for (const lease of this.#routeLeases) lease.end();
    if (published) this.#notify();
  }

  get status() {
    return this.#status;
  }
  get conflict() {
    return this.#conflict;
  }

  #ready(key: string, generation: number): boolean {
    return (
      !this.#conflict &&
      !!this.#status?.readiness.some(
        (entry) =>
          entry.id === key &&
          entry.generation === generation &&
          entry.state === "ready",
      )
    );
  }

  capabilityGeneration(id: string): number | undefined {
    const grant = this.#readDesired().snapshot.capabilities.find(
      (entry) => entry.id === id,
    );
    return grant &&
      this.#confirmed?.snapshot.capabilities.some(
        (confirmed) =>
          confirmed.id === id && confirmed.generation === grant.generation,
      ) &&
      this.#ready(`capability:${id}`, grant.generation)
      ? grant.generation
      : undefined;
  }

  backendGeneration(id: string): number | undefined {
    const grant = this.#readDesired().snapshot.backends.find(
      (entry) => entry.id === id,
    );
    return grant &&
      this.#confirmed?.snapshot.backends.some(
        (confirmed) =>
          confirmed.id === id && confirmed.generation === grant.generation,
      ) &&
      this.#ready(`backend:${id}`, grant.generation)
      ? grant.generation
      : undefined;
  }

  targetGeneration(backendId: string, targetId: string): number | undefined {
    if (this.backendGeneration(backendId) === undefined) return undefined;
    const target = this.#readDesired()
      .snapshot.backends.find((candidate) => candidate.id === backendId)
      ?.targets.find((candidate) => candidate.id === targetId);
    const installed = this.#confirmed?.snapshot.backends
      .find((candidate) => candidate.id === backendId)
      ?.targets.find((candidate) => candidate.id === targetId);
    return target && target.generation === installed?.generation
      ? target.generation
      : undefined;
  }

  workspaceRoots(): InstalledExecutionPolicy["snapshot"]["roots"] {
    return this.#readDesired().snapshot.roots.filter(
      (root) =>
        this.#confirmed?.snapshot.roots.some(
          (installed) =>
            installed.id === root.id &&
            installed.path === root.path &&
            installed.generation === root.generation,
        ) && this.#ready(`root:${root.id}`, root.generation),
    );
  }

  routeGeneration(backendId: string): number | undefined {
    const generation = this.capabilityGeneration("agent_tools_cli");
    return generation !== undefined &&
      this.backendGeneration(backendId) !== undefined &&
      this.#ready(`route:${backendId}`, generation)
      ? generation
      : undefined;
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
      this.#confirmed = desired;
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
