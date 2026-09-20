import {
  MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES,
  MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES,
  MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES,
  MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES,
  normalizedInstallationAdvisorySchema,
  type NormalizedInstallationAdvisory,
} from "../../shared/protocol/application.js";
import { BACKEND_BRANDS } from "../backends/contracts.js";
import type {
  BackendModuleRuntime,
  InstallationAdvisorySource,
} from "../backends/module.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface InstallationAdvisoryReader {
  read(scope: RequestScope): readonly NormalizedInstallationAdvisory[];
}

export interface ObservableInstallationAdvisoryReader extends InstallationAdvisoryReader {
  subscribe(scope: RequestScope, listener: () => void): () => void;
}

/** Coalesces a burst to the current in-flight publish plus one dirty follow-up. */
export function subscribeInstallationAdvisoryPublication(
  reader: ObservableInstallationAdvisoryReader,
  scope: RequestScope,
  publish: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  let closed = false;
  let publishing = false;
  let dirty = false;
  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch {
      // Advisory publication remains diagnostic and cannot affect its source.
    }
  };
  const drain = async (): Promise<void> => {
    if (closed || publishing) return;
    publishing = true;
    try {
      do {
        dirty = false;
        try {
          await publish();
        } catch (error) {
          report(error);
        }
      } while (!closed && dirty);
    } finally {
      publishing = false;
    }
  };
  const unsubscribe = reader.subscribe(scope, () => {
    if (closed) return;
    dirty = true;
    void drain();
  });
  return () => {
    if (closed) return;
    closed = true;
    dirty = false;
    unsubscribe();
  };
}

export type BackendInstallationAdvisoryRuntime = Pick<
  BackendModuleRuntime,
  "scope" | "instance"
> & {
  readonly installationAdvisories: InstallationAdvisorySource;
};

/** The single execution environment a backend instance may be bound to. */
export type InstallationAdvisoryBackendEnvironment = {
  readonly id: string;
  readonly kind: "local" | "ssh" | "outbound";
  readonly label: string;
};

export const NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES: InstallationAdvisorySource =
  Object.freeze({
    active: () => [],
    subscribe: () => () => undefined,
  });

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function requireScope(expected: RequestScope, received: RequestScope): void {
  if (!sameScope(expected, received)) {
    throw new Error("installation_advisory_scope_mismatch");
  }
}

function activeContributions(
  source: InstallationAdvisorySource,
  maximum: number,
  errorCode: string,
): ReturnType<InstallationAdvisorySource["active"]> {
  const active = source.active();
  if (active.length > maximum) {
    throw new Error(errorCode);
  }
  return active;
}

function normalizedBackendAdvisoryId(
  backendInstanceId: string,
  contributionId: string,
): string {
  return `backend_instance/${encodeURIComponent(backendInstanceId)}/${contributionId}`;
}

/**
 * Exact-principal composite projection for application and backend conditions.
 * Sources report only current process-local state; the composite validates both
 * each source and the final aggregate against the shared wire bound.
 */
export class CompositeInstallationAdvisoryReader implements ObservableInstallationAdvisoryReader {
  readonly #scope: RequestScope;
  readonly #application: InstallationAdvisorySource;
  #runtimes: readonly BackendInstallationAdvisoryRuntime[] = [];
  readonly #subscriptions = new Map<
    () => void,
    { listener: () => void; releases: (() => void)[] }
  >();

  readonly #backendEnvironments: ReadonlyMap<
    string,
    InstallationAdvisoryBackendEnvironment
  >;

  constructor(input: {
    readonly scope: RequestScope;
    readonly application: InstallationAdvisorySource;
    readonly runtimes: ReadonlyMap<string, BackendInstallationAdvisoryRuntime>;
    readonly backendEnvironments: ReadonlyMap<
      string,
      InstallationAdvisoryBackendEnvironment
    >;
  }) {
    this.#backendEnvironments = input.backendEnvironments;
    this.#scope = Object.freeze({ ...input.scope });
    this.#application = input.application;
    this.replaceRuntimes(input.scope, input.runtimes);
  }

  /** Refresh exact runtime subscriptions after an admitted configuration change. */
  replaceRuntimes(
    scope: RequestScope,
    runtimes: ReadonlyMap<string, BackendInstallationAdvisoryRuntime>,
  ): boolean {
    requireScope(this.#scope, scope);
    const next = Object.freeze(
      [...runtimes.values()].sort((left, right) =>
        left.instance.id.localeCompare(right.instance.id),
      ),
    );
    if (next.length > MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES) {
      throw new Error("too_many_installation_advisory_backend_sources");
    }
    for (const runtime of next) {
      requireScope(this.#scope, runtime.scope);
      if (runtime.instance.tenantId !== this.#scope.tenantId) {
        throw new Error("installation_advisory_scope_mismatch");
      }
      if (!this.#backendEnvironments.has(runtime.instance.id)) {
        throw new Error("installation_advisory_backend_environment_missing");
      }
    }
    if (next.length === this.#runtimes.length &&
      next.every((runtime, index) => runtime === this.#runtimes[index])) return false;
    this.#runtimes = next;
    for (const subscription of this.#subscriptions.values()) {
      for (const release of subscription.releases) release();
      subscription.releases = this.#subscribeSources(subscription.listener);
      subscription.listener();
    }
    return true;
  }

  read(scope: RequestScope): readonly NormalizedInstallationAdvisory[] {
    requireScope(this.#scope, scope);
    const advisories: NormalizedInstallationAdvisory[] = [];
    for (const contribution of activeContributions(
      this.#application,
      MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES,
      "too_many_application_installation_advisories",
    )) {
      advisories.push(
        normalizedInstallationAdvisorySchema.parse({
          ...contribution,
          id: `application/${contribution.id}`,
          source: { kind: "application" },
        }),
      );
    }
    for (const runtime of this.#runtimes) {
      const environment = this.#backendEnvironments.get(runtime.instance.id)!;
      // The local environment is the default host and adds no identity to a
      // backend label, so only remote environments are projected.
      const remoteEnvironment =
        environment.kind !== "local"
          ? { id: environment.id, label: boundDisplayText(environment.label) }
          : undefined;
      for (const contribution of activeContributions(
        runtime.installationAdvisories,
        MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES,
        "too_many_backend_instance_installation_advisories",
      )) {
        advisories.push(
          normalizedInstallationAdvisorySchema.parse({
            ...contribution,
            id: normalizedBackendAdvisoryId(
              runtime.instance.id,
              contribution.id,
            ),
            source: {
              kind: "backend_instance",
              backendInstanceId: runtime.instance.id,
              label: boundDisplayText(runtime.instance.label),
              ...(remoteEnvironment ? { environment: remoteEnvironment } : {}),
              backend: BACKEND_BRANDS[runtime.instance.kind],
            },
          }),
        );
      }
    }
    if (advisories.length > MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES) {
      throw new Error("too_many_aggregate_installation_advisories");
    }
    const advisoryIds = new Set<string>();
    for (const advisory of advisories) {
      if (advisoryIds.has(advisory.id)) {
        throw new Error("duplicate_normalized_installation_advisory_id");
      }
      advisoryIds.add(advisory.id);
    }
    advisories.sort(
      (left, right) =>
        (left.source.kind === "backend_instance"
          ? left.source.label.text
          : ""
        ).localeCompare(
          right.source.kind === "backend_instance"
            ? right.source.label.text
            : "",
        ) ||
        (left.source.kind === "backend_instance"
          ? (left.source.environment?.label.text ?? "")
          : ""
        ).localeCompare(
          right.source.kind === "backend_instance"
            ? (right.source.environment?.label.text ?? "")
            : "",
        ) ||
        left.title.text.localeCompare(right.title.text) ||
        left.id.localeCompare(right.id),
    );
    return Object.freeze(advisories);
  }

  subscribe(scope: RequestScope, listener: () => void): () => void {
    requireScope(this.#scope, scope);
    const entry = { listener, releases: this.#subscribeSources(listener) };
    const release = () => {
      if (!this.#subscriptions.delete(release)) return;
      for (const unsubscribe of entry.releases) unsubscribe();
    };
    this.#subscriptions.set(release, entry);
    return release;
  }

  #subscribeSources(listener: () => void): (() => void)[] {
    return [
      this.#application.subscribe(listener),
      ...this.#runtimes.map((runtime) =>
        runtime.installationAdvisories.subscribe(listener),
      ),
    ];
  }
}

export const NO_INSTALLATION_ADVISORIES: InstallationAdvisoryReader =
  Object.freeze({ read: () => [] });
