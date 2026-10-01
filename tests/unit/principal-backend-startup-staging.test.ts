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
    desiredInstanceRevision: desiredInstanceRevision ?? (() => 1),
  });
  return {registry, collection};
}

function plan(
  id: string,
  options: {
    revision?: number;
    namespace?: string;
    start?: (signal?: AbortSignal) => Promise<void>;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function heldStartup() {
  const entered = deferred<AbortSignal>();
  const aborted = deferred<void>();
  const released = deferred<void>();
  return {
    entered: entered.promise,
    aborted: aborted.promise,
    release: () => released.resolve(),
    async start(signal?: AbortSignal) {
      if (!signal) throw new Error("startup_signal_missing");
      entered.resolve(signal);
      if (signal.aborted) aborted.resolve();
      else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      // Model a provider which finishes its in-flight call after cancellation.
      await released.promise;
    },
  };
}

describe("principal backend startup staging", () => {
  it("stops the startup deadline once ready even while publication is queued", async () => {
    vi.useFakeTimers();
    const { collection } = fixture();
    const retiring = deferred<void>();
    const releaseRetirement = deferred<void>();
    const peer = plan("peer", { close: async () => {
      retiring.resolve();
      await releaseRetirement.promise;
    } });
    let startupSignal: AbortSignal | undefined;
    const configured = plan("ready", { start: async signal => { startupSignal = signal; } });
    try {
      await collection.apply(peer, retire);
      const startup = await collection.reserveStartup(configured, retire, { startupTimeoutMs: 50 });
      await expect(startup.completion).resolves.toEqual({ status: "ready" });
      const removal = collection.remove("peer", retire);
      await retiring.promise;
      const publication = startup.publish();
      await vi.advanceTimersByTimeAsync(100);
      expect(startupSignal?.aborted).toBe(false);
      releaseRetirement.resolve();
      await removal;
      await expect(publication).resolves.toMatchObject({ status: "applied", runtime: configured.runtime });
      expect(configured.runtime.close).not.toHaveBeenCalled();
      expect(configured.release).not.toHaveBeenCalled();
    } finally {
      releaseRetirement.resolve();
      await collection.close();
      vi.useRealTimers();
    }
  });

  it.each(["caller", "handle"] as const)("%s cancellation still prevents publication after startup becomes ready", async source => {
    const { collection } = fixture();
    const caller = new AbortController();
    const configured = plan("ready");
    const startup = await collection.reserveStartup(configured, retire, {
      signal: caller.signal, startupTimeoutMs: 50,
    });
    await expect(startup.completion).resolves.toEqual({ status: "ready" });
    if (source === "caller") caller.abort();
    else startup.cancel();
    await expect(startup.publish()).rejects.toThrow();
    expect(collection.runtimes.size).toBe(0);
    await startup.discard();
    expect(configured.runtime.close).toHaveBeenCalledOnce();
    expect(configured.release).toHaveBeenCalledOnce();
    await collection.close();
  });

  it("expires the startup budget while initialization is still pending", async () => {
    vi.useFakeTimers();
    const { collection } = fixture();
    const entered = deferred<void>();
    const configured = plan("pending", { start: async signal => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    } });
    try {
      const startup = await collection.reserveStartup(configured, retire, { startupTimeoutMs: 50 });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      await expect(startup.completion).resolves.toMatchObject({
        status: "failed", cleanupPending: false, error: { name: "TimeoutError" },
      });
      await expect(startup.publish()).rejects.toThrow();
      expect(configured.runtime.close).toHaveBeenCalledOnce();
      expect(configured.release).toHaveBeenCalledOnce();
      expect(collection.runtimes.size).toBe(0);
    } finally {
      await collection.close();
      vi.useRealTimers();
    }
  });

  it("publishes a healthy peer while another startup holds its native claim", async () => {
    const { collection, registry } = fixture();
    const held = heldStartup();
    const slow = plan("slow", { namespace: "held-store", start: held.start });
    const startup = await collection.reserveStartup(slow, retire);
    await held.entered;
    try {
      expect(collection.runtimes.has("slow")).toBe(false);
      expect(() => registry.driver(slow.context.connections[0]!)).toThrow();
      const collision = plan("collision", { namespace: "held-store" });
      await expect(collection.reserveStartup(collision, retire)).rejects.toThrow("backend_native_namespace_reused");
      expect(collision.acquire).not.toHaveBeenCalled();
      const peer = plan("peer");
      const peerStartup = await collection.reserveStartup(peer, retire);
      await expect(peerStartup.completion).resolves.toEqual({ status: "ready" });
      await expect(peerStartup.publish()).resolves.toMatchObject({ status: "applied" });
      expect(collection.runtimes.get("peer")).toBe(peer.runtime);
      expect(() => registry.driver(peer.context.connections[0]!)).not.toThrow();
      expect(slow.runtime.close).not.toHaveBeenCalled();
    } finally {
      held.release();
      await startup.discard();
      await collection.close();
    }
  });

  it.each(["remove", "close"] as const)("%s aborts pending startup and waits for late completion without publishing", async operation => {
    const { collection, registry } = fixture();
    const held = heldStartup();
    const configured = plan("pending", { start: held.start });
    const startup = await collection.reserveStartup(configured, retire);
    const signal = await held.entered;
    const unusedRetirement: BackendRuntimeRetirementAuthority = {
      run: vi.fn(async () => { throw new Error("unpublished_runtime_has_no_borrowers"); }),
    };
    let settled = false;
    const removal = (operation === "remove"
      ? collection.remove("pending", unusedRetirement)
      : collection.close()).then(() => { settled = true; });
    await held.aborted;
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(configured.runtime.close).not.toHaveBeenCalled();
    expect(configured.release).not.toHaveBeenCalled();
    held.release();
    await removal;
    await expect(startup.completion).resolves.toMatchObject({ status: "failed", cleanupPending: false });
    await expect(startup.publish()).rejects.toThrow();
    expect(collection.runtimes.size).toBe(0);
    expect(() => registry.driver(configured.context.connections[0]!)).toThrow();
    expect(unusedRetirement.run).not.toHaveBeenCalled();
    expect(configured.runtime.close).toHaveBeenCalledOnce();
    expect(configured.release).toHaveBeenCalledOnce();
    await collection.close();
  });

  it("rejects ready startup when the desired revision changed before publication", async () => {
    let desiredRevision = 1;
    const { collection, registry } = fixture(() => desiredRevision);
    const configured = plan("backend");
    const startup = await collection.reserveStartup(configured, retire);
    await startup.completion;
    desiredRevision = 2;
    await expect(startup.publish()).rejects.toThrow("backend_runtime_startup_superseded");
    expect(collection.runtimes.size).toBe(0);
    expect(() => registry.driver(configured.context.connections[0]!)).toThrow();
    await startup.discard();
    expect(configured.runtime.close).toHaveBeenCalledOnce();
    expect(configured.release).toHaveBeenCalledOnce();
    const next = plan("backend", { revision: 2 });
    const replacement = await collection.reserveStartup(next, retire);
    await replacement.completion;
    await replacement.publish();
    expect(collection.runtimes.get("backend")).toBe(next.runtime);
    await collection.close();
  });

  it("retains failed cleanup claims until removal proves runtime closure", async () => {
    const { collection } = fixture();
    let cleanupBlocked = true;
    const configured = plan("failed", {
      namespace: "owned-store",
      start: async () => { throw new Error("provider_start_failed"); },
      close: async () => { if (cleanupBlocked) throw new Error("provider_cleanup_unproven"); },
    });
    const startup = await collection.reserveStartup(configured, retire);
    await expect(startup.completion).resolves.toMatchObject({ status: "failed", cleanupPending: true });
    expect(configured.release).not.toHaveBeenCalled();
    await expect(collection.reserveStartup(plan("failed"), retire)).rejects.toThrow("backend_runtime_cleanup_pending");
    const peer = plan("peer", { namespace: "owned-store" });
    await expect(collection.reserveStartup(peer, retire)).rejects.toThrow("backend_native_namespace_reused");
    expect(peer.acquire).not.toHaveBeenCalled();
    cleanupBlocked = false;
    await collection.remove("failed", retire);
    expect(configured.release).toHaveBeenCalledOnce();
    expect(collection.failures.has("failed")).toBe(false);
    const replacement = await collection.reserveStartup(peer, retire);
    await replacement.completion;
    await replacement.publish();
    expect(collection.runtimes.get("peer")).toBe(peer.runtime);
    await collection.close();
  });

  it("an old cancelled handle cannot publish or withdraw its replacement", async () => {
    const { collection } = fixture();
    const held = heldStartup();
    const old = plan("backend", { start: held.start });
    const startup = await collection.reserveStartup(old, retire);
    await held.entered;
    startup.cancel();
    held.release();
    await startup.completion;
    await startup.discard();
    const next = plan("backend");
    const replacement = await collection.reserveStartup(next, retire);
    await replacement.completion;
    await replacement.publish();
    await expect(startup.publish()).rejects.toThrow();
    await startup.discard();
    expect(collection.runtimes.get("backend")).toBe(next.runtime);
    expect(collection.failures.has("backend")).toBe(false);
    expect(next.runtime.close).not.toHaveBeenCalled();
    expect(next.release).not.toHaveBeenCalled();
    await collection.close();
  });

  it("removes a reservation queued before removal even before its entry exists", async () => {
    const { collection } = fixture();
    const held = heldStartup();
    const configured = plan("pending", { start: held.start });
    const reservation = collection.reserveStartup(configured, retire);
    const removal = collection.remove("pending", retire);
    const startup = await reservation;
    // Removal can abort before runtime.start is entered at all.
    held.release();
    await removal;
    await expect(startup.publish()).rejects.toThrow();
    expect(collection.runtimes.size).toBe(0);
    expect(configured.release).toHaveBeenCalledOnce();
    await collection.close();
  });

  it("does not install a reservation if shutdown begins during retirement", async () => {
    const { collection } = fixture();
    const retiring = deferred<void>();
    const releaseRetirement = deferred<void>();
    const existing = plan("backend", { close: async () => {
      retiring.resolve();
      await releaseRetirement.promise;
    } });
    await collection.apply(existing, retire);
    const next = plan("backend");
    const reservation = collection.reserveStartup(next, retire);
    await retiring.promise;
    const shutdown = collection.close();
    releaseRetirement.resolve();
    await expect(reservation).rejects.toThrow("backend_runtime_collection_closed");
    await shutdown;
    expect(next.acquire).not.toHaveBeenCalled();
    expect(next.createRuntime).not.toHaveBeenCalled();
    expect(collection.runtimes.size).toBe(0);
  });
});
