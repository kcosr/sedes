import { describe, expect, it, vi } from "vitest";
import {
  PrincipalBackendRuntimeCollection,
  type BackendRuntimePlan,
  type BackendRuntimeRetirementAuthority,
} from "../../src/server/runtime/principal-backend-runtime-collection.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  BACKEND_BRANDS,
  type ConversationBackendDriver,
} from "../../src/server/backends/contracts.js";
import {
  type BackendModuleRuntime,
  type BackendNativeStoreLifecycle,
} from "../../src/server/backends/module.js";
import { type SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import { boundDisplayText } from "../../src/server/conversations/payload-policy.js";
import { savedAgentBackendTypeIdSchema } from "../../src/shared/protocol/saved-agents.js";

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const retire: BackendRuntimeRetirementAuthority = {
  run: async (_runtime, change) => await change(),
};
const savedAgent = {
  typeId: savedAgentBackendTypeIdSchema.parse("pi"),
  backendKind: "pi",
  overrideSchemaVersion: 1,
  presentation: {
    typeId: savedAgentBackendTypeIdSchema.parse("pi"),
    label: boundDisplayText("Pi"),
    brand: BACKEND_BRANDS.pi,
  },
} as SavedAgentBackendAdapter;

function fixture(desiredInstanceRevision?: (id: string) => number | undefined) {
  const registry = new AgentBackendRegistry();
  const collection = new PrincipalBackendRuntimeCollection({ scope, registry,
    desiredInstanceRevision: desiredInstanceRevision ?? (id => registry.instances(scope).find(instance => instance.id === id)?.configurationRevision),
  });
  return {registry, collection};
}

function plan(
  id: string,
  options: {
    revision?: number;
    namespace?: string;
    start?: () => Promise<void>;
    close?: () => Promise<void>;
    acquire?: BackendNativeStoreLifecycle["acquire"];
    adapter?: SavedAgentBackendAdapter;
  } = {},
) {
  const instance = {
    id,
    tenantId: scope.tenantId,
    kind: "pi" as const,
    label: id,
    enabled: true,
    configurationRevision: options.revision ?? 1,
    protocolRelease: "test",
  };
  const connections = [
    {
      id: `connection-${id}`,
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: id,
      kind: "pi_sdk" as const,
      backendInstanceId: id,
      executionEnvironmentId: "env-a",
      label: id,
      enabled: true,
      configurationRevision: options.revision ?? 1,
    },
  ];
  const createDriver = vi.fn(
    (connection) =>
      ({
        instance,
        connection,
        health: async () => ({ available: true }),
      }) as ConversationBackendDriver,
  );
  const runtime = {
    scope,
    instance,
    driverFactory: {
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: createDriver,
    },
    threadPersistence: {},
    bindingDetails: {},
    presentation: {},
    actionPersistence: {},
    discoveryPersistence: {},
    discovery: {},
    savedAgents: options.adapter ?? { ...savedAgent },
    automationExecutionPolicy: {},
    managedProviderTerminals: {},
    installationAdvisories: {},
    start: vi.fn(options.start ?? (async () => undefined)),
    close: vi.fn(options.close ?? (async () => undefined)),
  } as unknown as BackendModuleRuntime;
  const release = vi.fn(async () => undefined);
  const acquire = vi.fn(options.acquire ?? (async () => ({ release })));
  const createRuntime = vi.fn(() => runtime);
  const namespace = options.namespace ?? id;
  const result = {
    prepared: {
      backendInstanceId: id,
      module: { backendKind: "pi", protocolRelease: "test" },
      nativeNamespaces: [{ namespaceKey: namespace, sortKey: namespace }],
      nativeStores: [
        {
          namespaceKey: namespace,
          sortKey: namespace,
          label: namespace,
          acquire,
        },
      ],
      createRuntime,
    },
    context: {
      scope,
      instance,
      connections,
      environmentChannel: { scope, executionEnvironmentId: "env-a" },
      environmentOperations: { environmentId: "env-a" },
      agentToolCli: { availability: "unavailable", reason: "cli_unavailable" },
    },
  } as unknown as BackendRuntimePlan;
  return { ...result, runtime, release, acquire, createRuntime, createDriver };
}

describe("principal backend runtime reconciliation", () => {
  it("denies new drivers when only the desired backend configuration revision changes", async () => {
    let desiredRevision = 1;
    const {collection, registry} = fixture(() => desiredRevision);
    const initial = plan("one");
    await collection.apply(initial, retire);
    expect(() => registry.driver(initial.context.connections[0]!)).not.toThrow();
    initial.createDriver.mockClear();
    desiredRevision = 2;
    expect(() => registry.driver(initial.context.connections[0]!)).toThrow(
      expect.objectContaining({ code: "runtime_unavailable", retryable: true }),
    );
    expect(initial.createDriver).not.toHaveBeenCalled();
    expect(initial.runtime.close).not.toHaveBeenCalled();
    await collection.close();
  });

  it("replaces every live contribution behind a caller fence without touching peers", async () => {
    const { collection, registry } = fixture();
    const first = plan("one");
    const peer = plan("two");
    const next = plan("one", { revision: 2 });
    const retainedMaps = [
      collection.threadPersistence,
      collection.bindingDetails,
      collection.presentation,
      collection.actionPersistence,
      collection.discoveryPersistence,
      collection.savedAgents,
      collection.automationExecutionPolicy,
      collection.managedProviderTerminals,
      collection.installationAdvisories,
    ];
    await collection.apply(first, retire);
    await collection.apply(peer, retire);
    const stale = registry.driver(first.context.connections[0]!);
    const staleHealth = stale.health;
    const fenced: BackendRuntimeRetirementAuthority = {
      run: async (runtime, change) => {
        expect(runtime).toBe(first.runtime);
        expect(collection.runtimes.get("one")).toBe(first.runtime);
        expect(first.runtime.close).not.toHaveBeenCalled();
        const result = await change();
        expect(collection.runtimes.get("one")).toBe(next.runtime);
        return result;
      },
    };
    expect((await collection.apply(next, fenced)).status).toBe("applied");
    for (const map of retainedMaps) expect(map.has("one")).toBe(true);
    expect(collection.presentation.get("one")).toBe(next.runtime.presentation);
    expect(
      collection.savedAgentAdapters.requireByBackendInstanceId("one"),
    ).toBe(next.runtime.savedAgents);
    expect(
      collection.savedAgentAdapters.requireByBackendInstanceId("two"),
    ).toBe(peer.runtime.savedAgents);
    expect(first.runtime.close).toHaveBeenCalledOnce();
    expect(first.release).toHaveBeenCalledOnce();
    expect(peer.runtime.close).not.toHaveBeenCalled();
    expect(peer.release).not.toHaveBeenCalled();
    expect(() => staleHealth()).toThrow("backend_registry_generation_changed");
    expect(() => registry.driver(first.context.connections[0]!)).toThrow(
      "Configuration change pending",
    );
    await expect(
      registry.driver(next.context.connections[0]!).health(),
    ).resolves.toMatchObject({ available: true });
    await collection.remove("one", retire);
    for (const map of retainedMaps) expect(map.has("one")).toBe(false);
    expect(
      collection.savedAgentAdapters.findByBackendInstanceId("one"),
    ).toBeUndefined();
    expect(collection.runtimes.get("two")).toBe(peer.runtime);
    await collection.close();
  });

  it("preserves a healthy runtime when the admission fence rejects retirement", async () => {
    const { collection, registry } = fixture();
    const first = plan("one");
    await collection.apply(first, retire);
    await expect(
      collection.apply(plan("one", { revision: 2 }), {
        run: async () => {
          throw new Error("active_work");
        },
      }),
    ).rejects.toThrow("active_work");
    expect(first.runtime.close).not.toHaveBeenCalled();
    await expect(
      registry.driver(first.context.connections[0]!).health(),
    ).resolves.toMatchObject({ available: true });
    await collection.close();
  });

  it("keeps management and healthy peers usable when one backend fails startup", async () => {
    const { collection, registry } = fixture();
    const healthy = plan("healthy");
    const failed = plan("failed", {
      start: async () => {
        throw new Error("provider offline");
      },
    });
    await collection.apply(healthy, retire);
    await expect(collection.apply(failed, retire)).resolves.toMatchObject({
      status: "failed",
      cleanupPending: false,
    });
    expect(collection.failures.has("failed")).toBe(true);
    expect(failed.runtime.close).toHaveBeenCalledOnce();
    expect(failed.release).toHaveBeenCalledOnce();
    expect(healthy.runtime.close).not.toHaveBeenCalled();
    expect(registry.instances(scope).map(({ id }) => id)).toEqual(["healthy"]);
    const retry = plan("failed");
    await collection.apply(retry, retire);
    expect(collection.failures.has("failed")).toBe(false);
    await collection.close();
  });

  it("holds native leases and blocks replacement after unproven runtime cleanup", async () => {
    const { collection } = fixture();
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup unknown"))
      .mockResolvedValue(undefined);
    const old = plan("one", { close });
    await collection.apply(old, retire);
    const next = plan("one", { revision: 2 });
    await expect(collection.apply(next, retire)).resolves.toMatchObject({
      status: "failed",
      cleanupPending: true,
    });
    expect(next.acquire).not.toHaveBeenCalled();
    expect(old.release).not.toHaveBeenCalled();
    expect(collection.runtimes.has("one")).toBe(false);
    await expect(collection.apply(next, retire)).rejects.toThrow(
      "backend_runtime_cleanup_pending",
    );
    await expect(
      collection.apply(plan("other", { namespace: "one" }), retire),
    ).rejects.toThrow("backend_native_namespace_reused");
    await collection.remove("one", retire);
    expect(old.release).toHaveBeenCalledOnce();
    expect((await collection.apply(next, retire)).status).toBe("applied");
    await collection.close();
  });

  it("retains a failing startup's namespace when its cleanup also fails", async () => {
    const { collection } = fixture();
    const failed = plan("one", {
      start: async () => {
        throw new Error("start");
      },
      close: vi
        .fn()
        .mockRejectedValueOnce(new Error("close"))
        .mockResolvedValue(undefined),
    });
    await expect(collection.apply(failed, retire)).resolves.toMatchObject({
      status: "failed",
      cleanupPending: true,
    });
    expect(failed.release).not.toHaveBeenCalled();
    await expect(
      collection.apply(plan("other", { namespace: "one" }), retire),
    ).rejects.toThrow("backend_native_namespace_reused");
    await collection.close();
    expect(failed.release).toHaveBeenCalledOnce();
  });

  it("validates namespace and principal ownership before touching a healthy runtime", async () => {
    const { collection } = fixture();
    const first = plan("one");
    const peer = plan("two");
    await collection.apply(first, retire);
    await collection.apply(peer, retire);
    const conflict = plan("one", { namespace: "two" });
    await expect(collection.apply(conflict, retire)).rejects.toThrow(
      "backend_native_namespace_reused",
    );
    const foreign = plan("one");
    await expect(
      collection.apply(
        {
          ...foreign,
          context: {
            ...foreign.context,
            scope: { ...scope, principalId: "foreign" },
          },
        },
        retire,
      ),
    ).rejects.toThrow("backend_runtime_instance_plan_invalid");
    expect(first.runtime.close).not.toHaveBeenCalled();
    expect(conflict.createRuntime).not.toHaveBeenCalled();
    await collection.close();
  });

  it("unwinds only the locks acquired before a later acquisition fails", async () => {
    const { collection } = fixture();
    const candidate = plan("one");
    const secondAcquire = vi.fn(async () => {
      throw new Error("store busy");
    });
    const result = await collection.apply(
      {
        ...candidate,
        prepared: {
          ...candidate.prepared,
          nativeNamespaces: [
            ...candidate.prepared.nativeNamespaces,
            { namespaceKey: "z", sortKey: "z" },
          ],
          nativeStores: [
            ...candidate.prepared.nativeStores,
            {
              namespaceKey: "z",
              sortKey: "z",
              label: "second",
              acquire: secondAcquire,
            },
          ],
        },
      },
      retire,
    );
    expect(result).toMatchObject({ status: "failed", cleanupPending: false });
    expect(candidate.acquire).toHaveBeenCalledOnce();
    expect(secondAcquire).toHaveBeenCalledOnce();
    expect(candidate.release).toHaveBeenCalledOnce();
    expect(candidate.createRuntime).not.toHaveBeenCalled();
    await collection.close();
  });

  it("retains an unconfirmed native lease release and retries it without reclosing the runtime", async () => {
    const { collection } = fixture();
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("lease release unknown"))
      .mockResolvedValue(undefined);
    const candidate = plan("one", { acquire: async () => ({ release }) });
    await collection.apply(candidate, retire);
    await expect(collection.remove("one", retire)).rejects.toThrow(
      "lease release unknown",
    );
    expect(candidate.runtime.close).toHaveBeenCalledOnce();
    await expect(
      collection.apply(plan("other", { namespace: "one" }), retire),
    ).rejects.toThrow("backend_native_namespace_reused");
    await collection.remove("one", retire);
    expect(candidate.runtime.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
    await collection.close();
  });

  it("releases acquired locks when createRuntime throws", async () => {
    const { collection } = fixture();
    const broken = plan("one");
    broken.createRuntime.mockImplementation(() => {
      throw new Error("create failed");
    });
    await expect(collection.apply(broken, retire)).resolves.toMatchObject({
      status: "failed",
      cleanupPending: false,
    });
    expect(broken.release).toHaveBeenCalledOnce();
    await collection.close();
  });

  it("validates Saved Agent contract conflicts without publishing a partial bundle", async () => {
    const { collection, registry } = fixture();
    const first = plan("one");
    await collection.apply(first, retire);
    const invalid = plan("two", {
      adapter: { ...savedAgent, overrideSchemaVersion: 2 },
    });
    await expect(collection.apply(invalid, retire)).resolves.toMatchObject({
      status: "failed",
      cleanupPending: false,
    });
    expect(collection.runtimes.has("two")).toBe(false);
    expect(
      collection.savedAgentAdapters.requireByTypeId(savedAgent.typeId),
    ).toBe(first.runtime.savedAgents);
    expect(registry.instances(scope).map(({ id }) => id)).toEqual(["one"]);
    await collection.close();
  });

  it("serializes native ownership admission during overlapping adds", async () => {
    const { collection } = fixture();
    const results = await Promise.allSettled([
      collection.apply(plan("one", { namespace: "shared" }), retire),
      collection.apply(plan("two", { namespace: "shared" }), retire),
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    expect(collection.runtimes.size).toBe(1);
    await collection.close();
    await expect(collection.apply(plan("three"), retire)).rejects.toThrow(
      "backend_runtime_collection_closed",
    );
  });
});
