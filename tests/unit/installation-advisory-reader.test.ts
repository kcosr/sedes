import { describe, expect, it, vi } from "vitest";
import {
  CompositeInstallationAdvisoryReader,
  NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
  subscribeInstallationAdvisoryPublication,
} from "../../src/server/application/installation-advisory-reader.js";
import type {
  BackendInstallationAdvisoryRuntime,
  InstallationAdvisoryBackendEnvironment,
} from "../../src/server/application/installation-advisory-reader.js";
import { MutableBackendInstallationAdvisorySource } from "../../src/server/backends/backend-installation-advisories.js";
import type { InstallationAdvisorySource } from "../../src/server/backends/module.js";
import {
  MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES,
  MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES,
  MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES,
  MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES,
} from "../../src/shared/protocol/application.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "tenant-one",
  principalId: "principal-one",
};
const wrongScope: RequestScope = {
  tenantId: "tenant-one",
  principalId: "principal-two",
};

function runtime(
  id: string,
  label: string,
  source: InstallationAdvisorySource,
): BackendInstallationAdvisoryRuntime {
  return {
    scope,
    instance: {
      id,
      tenantId: "tenant-one",
      kind: "codex_app_server",
      label,
      enabled: true,
      configurationRevision: 1,
      protocolRelease: "0.153.0",
    },
    installationAdvisories: source,
  };
}

function backendEnvironments(
  entries: Record<string, readonly [string, "local" | "ssh", string]>,
): ReadonlyMap<string, InstallationAdvisoryBackendEnvironment> {
  return new Map(
    Object.entries(entries).map(([id, [environmentId, kind, label]]) => [
      id,
      { id: environmentId, kind, label },
    ]),
  );
}

const newerThanTested = {
  id: "runtime_newer_than_tested",
  tone: "warning" as const,
  title: { text: "Local Codex is newer than tested" },
  message: { text: "Running 0.154.0; Sedes is tested through 0.153.0." },
};

describe("installation advisory projection", () => {
  it("preserves subscriptions and publishes nothing for the same runtime identities", () => {
    const source = new MutableBackendInstallationAdvisorySource();
    const subscribe = vi.spyOn(source, "subscribe");
    const first = runtime("first", "First", source);
    const second = runtime("second", "Second", source);
    const reader = new CompositeInstallationAdvisoryReader({
      scope, application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([["first", first], ["second", second]]),
      backendEnvironments: backendEnvironments({
        first: ["local", "local", "Local"], second: ["local", "local", "Local"],
      }),
    });
    const listener = vi.fn();
    const unsubscribe = reader.subscribe(scope, listener);
    expect(reader.replaceRuntimes(scope, new Map([["second", second], ["first", first]]))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("moves active subscriptions to replacement runtimes and denies another principal", () => {
    const first = new MutableBackendInstallationAdvisorySource();
    const replacement = new MutableBackendInstallationAdvisorySource();
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        ["codex-local", runtime("codex-local", "Codex", first)],
      ]),
      backendEnvironments: backendEnvironments({
        "codex-local": ["local", "local", "Local"],
      }),
    });
    const listener = vi.fn();
    const unsubscribe = reader.subscribe(scope, listener);
    expect(() => reader.replaceRuntimes(wrongScope, new Map())).toThrow(
      "installation_advisory_scope_mismatch",
    );
    reader.replaceRuntimes(
      scope,
      new Map([["codex-local", runtime("codex-local", "Codex", replacement)]]),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    first.replace([newerThanTested]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reader.read(scope)).toEqual([]);
    replacement.replace([newerThanTested]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(reader.read(scope)).toHaveLength(1);
    unsubscribe();
    unsubscribe();
    replacement.replace([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("projects active assessments with stable backend instance display scope", () => {
    const localSource = new MutableBackendInstallationAdvisorySource();
    const alternateSource = new MutableBackendInstallationAdvisorySource();
    localSource.replace([newerThanTested]);
    alternateSource.replace([newerThanTested]);
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        ["codex-local", runtime("codex-local", "Local Codex", localSource)],
        [
          "codex-alternate",
          runtime("codex-alternate", "Alternate Codex", alternateSource),
        ],
      ]),
      backendEnvironments: backendEnvironments({
        "codex-local": ["local", "local", "Local"],
        "codex-alternate": ["alternate", "ssh", "Alternate host"],
      }),
    });

    expect(reader.read(scope)).toEqual(
      [
        ["codex-alternate", "Alternate Codex"],
        ["codex-local", "Local Codex"],
      ].map(([backendInstanceId, label]) => ({
        ...newerThanTested,
        id: `backend_instance/${backendInstanceId}/runtime_newer_than_tested`,
        source: {
          kind: "backend_instance" as const,
          backendInstanceId,
          label: { text: label },
          ...(backendInstanceId === "codex-alternate"
            ? {
                environment: {
                  id: "alternate",
                  label: { text: "Alternate host" },
                },
              }
            : {}),
          backend: "codex" as const,
        },
      })),
    );
  });

  it("orders equal backend labels by execution environment label", () => {
    const remoteSource = new MutableBackendInstallationAdvisorySource();
    const localSource = new MutableBackendInstallationAdvisorySource();
    remoteSource.replace([newerThanTested]);
    localSource.replace([newerThanTested]);
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        ["codex-remote", runtime("codex-remote", "Codex", remoteSource)],
        ["codex-local", runtime("codex-local", "Codex", localSource)],
      ]),
      backendEnvironments: backendEnvironments({
        "codex-local": ["local", "local", "Local"],
        "codex-remote": ["srv", "ssh", "srv"],
      }),
    });

    expect(reader.read(scope).map(({ id }) => id)).toEqual([
      "backend_instance/codex-local/runtime_newer_than_tested",
      "backend_instance/codex-remote/runtime_newer_than_tested",
    ]);
  });

  it("rejects a runtime without a resolved execution environment", () => {
    expect(
      () =>
        new CompositeInstallationAdvisoryReader({
          scope,
          application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
          runtimes: new Map([
            [
              "codex-local",
              runtime(
                "codex-local",
                "Codex",
                new MutableBackendInstallationAdvisorySource(),
              ),
            ],
          ]),
          backendEnvironments: new Map(),
        }),
    ).toThrow("installation_advisory_backend_environment_missing");
  });

  it("deduplicates replacement semantics and releases subscriptions", () => {
    const source = new MutableBackendInstallationAdvisorySource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source.replace([newerThanTested]);
    source.replace([{ ...newerThanTested }]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    source.replace([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates publication listener failures from runtime observation", () => {
    const listenerError = new Error("publication failed");
    const onListenerError = vi.fn();
    const source = new MutableBackendInstallationAdvisorySource(
      onListenerError,
    );
    const succeedingListener = vi.fn();
    source.subscribe(() => {
      throw listenerError;
    });
    source.subscribe(succeedingListener);

    expect(() => source.replace([newerThanTested])).not.toThrow();
    expect(onListenerError).toHaveBeenCalledWith(listenerError);
    expect(succeedingListener).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate, unbounded, and open-shaped contributions", () => {
    const source = new MutableBackendInstallationAdvisorySource();
    expect(() => source.replace([newerThanTested, newerThanTested])).toThrow(
      "duplicate_backend_installation_advisory_id",
    );
    expect(() =>
      source.replace([{ ...newerThanTested, id: "INVALID CONTRIBUTION ID" }]),
    ).toThrow();
    expect(() =>
      source.replace([
        { ...newerThanTested, providerPayload: {} } as typeof newerThanTested,
      ]),
    ).toThrow();
    expect(() =>
      source.replace(
        Array.from(
          {
            length: MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES + 1,
          },
          (_, index) => ({ ...newerThanTested, id: `warning-${index}` }),
        ),
      ),
    ).toThrow("too_many_backend_installation_advisories");
  });

  it("subscribes once to each source and releases each subscription", () => {
    const first = new MutableBackendInstallationAdvisorySource();
    const second = new MutableBackendInstallationAdvisorySource();
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        ["first", runtime("first", "First", first)],
        ["second", runtime("second", "Second", second)],
      ]),
      backendEnvironments: backendEnvironments({
        first: ["first-env", "local", "First host"],
        second: ["second-env", "ssh", "Second host"],
      }),
    });
    const listener = vi.fn();
    const unsubscribe = reader.subscribe(scope, listener);

    first.replace([newerThanTested]);
    second.replace([newerThanTested]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    first.replace([]);
    second.replace([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("refreshes the authoritative application projection when assessments change", async () => {
    const source = new MutableBackendInstallationAdvisorySource();
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        ["codex-local", runtime("codex-local", "Local Codex", source)],
      ]),
      backendEnvironments: backendEnvironments({
        "codex-local": ["local", "local", "Local"],
      }),
    });
    const publish = vi.fn(async () => undefined);
    const onError = vi.fn();
    const unsubscribe = subscribeInstallationAdvisoryPublication(
      reader,
      scope,
      publish,
      onError,
    );

    source.replace([newerThanTested]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();

    unsubscribe();
    source.replace([]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("projects the explicit application source without backend presentation", () => {
    const application = new MutableBackendInstallationAdvisorySource();
    application.replace([
      {
        id: "storage-nearly-full",
        tone: "warning",
        title: { text: "Storage is nearly full" },
        message: { text: "Free space before starting more work." },
      },
    ]);
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application,
      runtimes: new Map(),
      backendEnvironments: new Map(),
    });

    expect(reader.read(scope)).toEqual([
      {
        id: "application/storage-nearly-full",
        tone: "warning",
        title: { text: "Storage is nearly full" },
        message: { text: "Free space before starting more work." },
        source: { kind: "application" },
      },
    ]);
  });

  it("denies reads, subscriptions, and runtime contributions across scope", () => {
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map(),
      backendEnvironments: new Map(),
    });
    expect(() => reader.read(wrongScope)).toThrow(
      "installation_advisory_scope_mismatch",
    );
    expect(() => reader.subscribe(wrongScope, () => undefined)).toThrow(
      "installation_advisory_scope_mismatch",
    );
    expect(
      () =>
        new CompositeInstallationAdvisoryReader({
          scope,
          application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
          runtimes: new Map([
            [
              "wrong",
              {
                ...runtime(
                  "wrong",
                  "Wrong",
                  new MutableBackendInstallationAdvisorySource(),
                ),
                scope: wrongScope,
              },
            ],
          ]),
          backendEnvironments: backendEnvironments({
            wrong: ["wrong-env", "ssh", "Wrong host"],
          }),
        }),
    ).toThrow("installation_advisory_scope_mismatch");
  });

  it("composes individually valid source quotas within the shared aggregate bound", () => {
    expect(
      MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES +
        MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES *
          MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES,
    ).toBe(MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES);
    const contribution = (index: number) => ({
      ...newerThanTested,
      id: `warning-${index}`,
    });
    const sourceWith = (count: number) => ({
      active: () =>
        Array.from({ length: count }, (_, index) => contribution(index)),
      subscribe: () => () => undefined,
    });
    const tooManyApplication = new CompositeInstallationAdvisoryReader({
      scope,
      application: sourceWith(MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES + 1),
      runtimes: new Map(),
      backendEnvironments: new Map(),
    });
    expect(() => tooManyApplication.read(scope)).toThrow(
      "too_many_application_installation_advisories",
    );

    const tooManyBackend = new CompositeInstallationAdvisoryReader({
      scope,
      application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
      runtimes: new Map([
        [
          "codex-local",
          runtime(
            "codex-local",
            "Local Codex",
            sourceWith(MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES + 1),
          ),
        ],
      ]),
      backendEnvironments: backendEnvironments({
        "codex-local": ["local", "local", "Local"],
      }),
    });
    expect(() => tooManyBackend.read(scope)).toThrow(
      "too_many_backend_instance_installation_advisories",
    );

    const runtimes = new Map(
      Array.from(
        { length: MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES },
        (_, index) => {
          const id = `codex-${index}`;
          return [
            id,
            runtime(
              id,
              `Codex ${index}`,
              sourceWith(MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES),
            ),
          ] as const;
        },
      ),
    );
    const maximumComposite = new CompositeInstallationAdvisoryReader({
      scope,
      application: sourceWith(MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES),
      runtimes,
      backendEnvironments: backendEnvironments(
        Object.fromEntries(
          [...runtimes.keys()].map((id) => [
            id,
            ["env", "ssh", `Host ${id}`] as const,
          ]),
        ),
      ),
    });
    expect(maximumComposite.read(scope)).toHaveLength(
      MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES,
    );

    const tooManyRuntimes = new Map(runtimes);
    tooManyRuntimes.set(
      "one-too-many",
      runtime(
        "one-too-many",
        "One too many",
        new MutableBackendInstallationAdvisorySource(),
      ),
    );
    expect(
      () =>
        new CompositeInstallationAdvisoryReader({
          scope,
          application: NO_ACTIVE_APPLICATION_INSTALLATION_ADVISORIES,
          runtimes: tooManyRuntimes,
          backendEnvironments: backendEnvironments({
            "one-too-many": ["env", "ssh", "Host"],
          }),
        }),
    ).toThrow("too_many_installation_advisory_backend_sources");
  });

  it("rejects duplicate normalized advisory IDs before returning", () => {
    const duplicateApplicationSource = {
      active: () => [newerThanTested, { ...newerThanTested }],
      subscribe: () => () => undefined,
    };
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: duplicateApplicationSource,
      runtimes: new Map(),
      backendEnvironments: new Map(),
    });

    expect(() => reader.read(scope)).toThrow(
      "duplicate_normalized_installation_advisory_id",
    );
  });

  it("coalesces a pending first publication and an arbitrary callback burst", async () => {
    const source = new MutableBackendInstallationAdvisorySource();
    const reader = new CompositeInstallationAdvisoryReader({
      scope,
      application: source,
      runtimes: new Map(),
      backendEnvironments: new Map(),
    });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const publish = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const unsubscribe = subscribeInstallationAdvisoryPublication(
      reader,
      scope,
      publish,
      vi.fn(),
    );

    source.replace([newerThanTested]);
    for (let index = 0; index < 20; index += 1) {
      source.replace(index % 2 === 0 ? [] : [newerThanTested]);
    }
    expect(publish).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
