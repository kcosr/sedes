import { describe, expect, it, vi } from "vitest";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
  MAXIMUM_BOUNDED_RECENT_DISCOVERY_PAGES,
} from "../../src/server/conversations/backend-discovery-service.js";
import type {
  DiscoveredConversationPage,
  NativeConversationArchiveInput,
  NativeConversationArchiveResult,
} from "../../src/server/backends/contracts.js";
import type { ConversationBindingRecord } from "../../src/server/db/repositories/conversation-binding-repository.js";
import type { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};
const neverAbortedSignal = new AbortController().signal;

function fixture(options: {
  readonly reservedForkChildren?: readonly string[];
  readonly nativeArchive?: boolean;
  readonly connectionProfileIds?: readonly string[];
} = {}) {
  const database = {
    transaction: <Result>(operation: () => Result) => operation,
  };
  const discover =
    vi.fn<
      (input: {
        readonly cursor?: string;
      }) => Promise<DiscoveredConversationPage>
    >();
  const finishDiscovery = vi.fn<InventoryRepository["finishDiscovery"]>(() => []);
  const listDiscoveryAbsenceCandidates = vi.fn<InventoryRepository["listDiscoveryAbsenceCandidates"]>(() => []);
  const nativeArchive = vi.fn<
    (input: NativeConversationArchiveInput) => Promise<NativeConversationArchiveResult>
  >();
  const markDiscoveredAvailable = vi.fn();
  const onThreadChanged = vi.fn(
    async (_scope: RequestScope, _applicationThreadId: string) => undefined,
  );
  const recordImportedNativeOrigin = vi.fn();
  const createUnboundThread = vi.fn(() => { throw new Error("test_unexpected_import"); });
  const isReservedForkChild = vi.fn((_scope: RequestScope, input: { readonly backendConversationId: string }) =>
    options.reservedForkChildren?.includes(input.backendConversationId) === true);
  const inventory = {
    database,
    getWorkspace: vi.fn(() => ({ environmentId: "environment-1" })),
    getThread: vi.fn(() => ({
      thread: {
        workspaceId: "workspace-1",
        environmentId: "environment-1",
        backendInstanceId: "backend-1",
        connectionProfileId: "connection-1",
      },
    })),
    markDiscoveredAvailable,
    listDiscoveryAbsenceCandidates,
    finishDiscovery,
  };
  const service = new BackendDiscoveryService({
    targets: {
      discovery: vi.fn(async () => ({
        connection: {
          id: "connection-1",
          executionEnvironmentId: "environment-1",
          backendInstanceId: "backend-1",
        },
        workspace: {
          canonicalPath: "/workspace",
        },
        driver: { discover, ...(options.nativeArchive ? { nativeArchive } : {}) },
      })),
    } as never,
    inventory: inventory as never,
    bindings: {
      database,
      findByBackendConversation: vi.fn(
        (
          _scope: RequestScope,
          _backendInstanceId: string,
          backendConversationId: string,
        ) =>
          backendConversationId.startsWith("parent-") ||
          options.reservedForkChildren?.includes(backendConversationId)
            ? undefined
            : { applicationThreadId: `application-${backendConversationId}` },
      ),
      createUnboundThread,
    } as never,
    lineage: {
      database,
      findOrigin: vi.fn(() => undefined),
      recordImportedNativeOrigin,
      isReservedForkChild,
    } as never,
    forks: { reconcileDiscoveredFork: async () => undefined },
    persistence: new Map([
      [
        "backend-1",
        {
          database,
          initializeThread: () => undefined,
          saveBoundBindingDetail: () => undefined,
        },
      ],
    ]) as never,
    connectionProfileId: "connection-1",
    ...(options.connectionProfileIds ? { connectionProfileIds: options.connectionProfileIds } : {}),
    onAncestryReconciliationConflict: () => undefined,
    onForkReconciliationError: () => undefined,
    onThreadChanged,
  });
  return {
    createUnboundThread,
    isReservedForkChild,
    discover,
    finishDiscovery,
    listDiscoveryAbsenceCandidates,
    nativeArchive,
    markDiscoveredAvailable,
    onThreadChanged,
    recordImportedNativeOrigin,
    service,
  };
}

function discoveredConversation(id: string) {
  return {
    backendConversationId: id,
    canonicalWorkspacePath: "/workspace",
    updatedAt: "2026-08-07T00:00:00.000Z",
    opaqueBindingDetail: `detail-${id}`,
    nativeAncestry: {
      method: "provider_native" as const,
      parentBackendConversationId: `parent-${id}`,
    },
  };
}

describe("BackendDiscoveryService scan policy", () => {
  it("inspects omitted bindings through their own profile within a shared discovery namespace", async () => {
    const current = fixture({
      nativeArchive: true, connectionProfileIds: ["connection-1", "connection-2"],
    });
    const bindings = ["archived", "deleted"].map((name): ConversationBindingRecord => ({
      tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
      applicationThreadId: `application-${name}`, backendInstanceId: "backend-1",
      connectionProfileId: "connection-2", executionEnvironmentId: "environment-1",
      backendConversationId: `native-${name}`, createdAt: 500,
    }));
    const inspect = vi.fn(async (input: NativeConversationArchiveInput): Promise<NativeConversationArchiveResult> => {
      expect(input.binding.connectionProfileId).toBe("connection-2");
      return { state: input.binding.backendConversationId === "native-archived" ? "archived" : "missing", changed: false };
    });
    const discovery = vi.spyOn(current.service.input.targets, "discovery");
    discovery.mockImplementation(async (_scope, input) => ({
      connection: { id: input.connectionProfileId, executionEnvironmentId: "environment-1", backendInstanceId: "backend-1" },
      workspace: { canonicalPath: "/workspace" },
      driver: { discover: current.discover, nativeArchive: input.connectionProfileId === "connection-2" ? inspect : current.nativeArchive },
    }) as never);
    current.discover.mockResolvedValue({ conversations: [] });
    current.listDiscoveryAbsenceCandidates.mockReturnValue(bindings);

    await expect(current.service.discoverWorkspace(
      scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal,
    )).resolves.toMatchObject({ completion: "complete", missingReconciliation: "completed" });
    expect(discovery.mock.calls).toEqual([
      [scope, { connectionProfileId: "connection-1", workspaceId: "workspace-1" }],
      [scope, { connectionProfileId: "connection-2", workspaceId: "workspace-1" }],
    ]);
    expect(current.nativeArchive).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect.mock.calls[0]![0].binding).toEqual({ ...bindings[0], createdAt: "1970-01-01T00:00:00.500Z" });
    expect(current.finishDiscovery.mock.calls[0]?.[5]).toEqual(new Set(["native-archived"]));
  });

  it.each(["unavailable", "wrong_target"])("does not reconcile missing threads when the candidate's profile is %s", async (failure) => {
    const current = fixture({ nativeArchive: true, connectionProfileIds: ["connection-1", "connection-2"] });
    vi.spyOn(current.service.input.targets, "discovery").mockImplementation(async (_scope, input) => {
      if (input.connectionProfileId === "connection-2" && failure === "unavailable") throw new Error("target_unavailable");
      return {
        connection: { id: input.connectionProfileId, backendInstanceId: "backend-1",
          executionEnvironmentId: input.connectionProfileId === "connection-2" ? "other-environment" : "environment-1" },
        workspace: { canonicalPath: "/workspace" },
        driver: { discover: current.discover, nativeArchive: current.nativeArchive },
      } as never;
    });
    current.discover.mockResolvedValue({ conversations: [] });
    current.listDiscoveryAbsenceCandidates.mockReturnValue([{
      tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
      applicationThreadId: "known-thread", backendInstanceId: "backend-1",
      connectionProfileId: "connection-2", executionEnvironmentId: "environment-1",
      backendConversationId: "known-native-thread", createdAt: 500,
    }]);
    await expect(current.service.discoverWorkspace(scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal))
      .resolves.toMatchObject({ completion: "partial", missingReconciliation: "not_performed", diagnostic: "provider_inspection_failed" });
    expect(current.nativeArchive).not.toHaveBeenCalled();
    expect(current.finishDiscovery).not.toHaveBeenCalled();
  });

  it.each(["archived", "active", "busy"] as const)(
    "preserves a known visible thread that passive native inspection proves %s",
    async (state) => {
      const current = fixture({ nativeArchive: true });
      const binding: ConversationBindingRecord = {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: "known-application-thread",
        backendInstanceId: "backend-1",
        connectionProfileId: "connection-1",
        executionEnvironmentId: "environment-1",
        backendConversationId: "known-native-thread",
        createdAt: 500,
      };
      current.discover.mockResolvedValue({ conversations: [] });
      current.listDiscoveryAbsenceCandidates.mockReturnValue([binding]);
      current.nativeArchive.mockResolvedValue({ state, changed: false });

      await expect(current.service.discoverWorkspace(
        scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal,
      )).resolves.toEqual({
        completion: "complete", missingReconciliation: "completed",
        pagesScanned: 1, conversationsSeen: 0,
      });

      expect(current.listDiscoveryAbsenceCandidates).toHaveBeenCalledWith(
        scope, "environment-1", "workspace-1", "backend-1", ["connection-1"],
      );
      expect(current.nativeArchive).toHaveBeenCalledExactlyOnceWith({
        scope, binding: { ...binding, createdAt: "1970-01-01T00:00:00.500Z" },
        workspace: { canonicalPath: "/workspace" }, action: "inspect", signal: neverAbortedSignal,
      });
      expect(current.finishDiscovery.mock.calls[0]?.[5]).toEqual(new Set(["known-native-thread"]));
      expect(current.createUnboundThread).not.toHaveBeenCalled();
      expect(current.markDiscoveredAvailable).not.toHaveBeenCalled();
    },
  );

  it("does not enumerate or import unknown native archives or probe local archives", async () => {
    const current = fixture({ nativeArchive: true });
    current.discover.mockResolvedValue({ conversations: [] });
    await current.service.discoverWorkspace(
      scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal,
    );
    expect(current.nativeArchive).not.toHaveBeenCalled();
    expect(current.createUnboundThread).not.toHaveBeenCalled();
    expect(current.finishDiscovery.mock.calls[0]?.[5]).toEqual(new Set());
  });

  it("does not inspect omitted bindings during bounded startup discovery", async () => {
    const current = fixture({ nativeArchive: true });
    current.discover.mockResolvedValue({ conversations: [] });
    await expect(current.service.discoverWorkspace(
      scope, "workspace-1", { kind: "bounded_recent", maximumPages: 1 }, neverAbortedSignal,
    )).resolves.toMatchObject({ missingReconciliation: "not_performed" });
    expect(current.listDiscoveryAbsenceCandidates).not.toHaveBeenCalled();
    expect(current.nativeArchive).not.toHaveBeenCalled();
  });

  it("does not make absence claims when cancelled during passive native inspection", async () => {
    const current = fixture({ nativeArchive: true });
    const controller = new AbortController();
    current.discover.mockResolvedValue({ conversations: [] });
    current.listDiscoveryAbsenceCandidates.mockReturnValue([{
      tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
      applicationThreadId: "known-application-thread", backendInstanceId: "backend-1",
      connectionProfileId: "connection-1", executionEnvironmentId: "environment-1",
      backendConversationId: "known-native-thread", createdAt: 500,
    }]);
    current.nativeArchive.mockImplementation(async () => {
      controller.abort(new Error("shutdown"));
      return { state: "missing", changed: false };
    });
    await expect(current.service.discoverWorkspace(
      scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, controller.signal,
    )).resolves.toMatchObject({
      completion: "partial", missingReconciliation: "not_performed", diagnostic: "cancelled",
    });
    expect(current.finishDiscovery).not.toHaveBeenCalled();
  });

  it.each(["missing", "unavailable", "disabled"] as const)(
    "makes absence claims only after a conclusive native inspection: %s",
    async (result) => {
      const current = fixture({ nativeArchive: true });
      current.discover.mockResolvedValue({ conversations: [] });
      current.listDiscoveryAbsenceCandidates.mockReturnValue([{
        tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
        applicationThreadId: "known-application-thread", backendInstanceId: "backend-1",
        connectionProfileId: "connection-1", executionEnvironmentId: "environment-1",
        backendConversationId: "known-native-thread", createdAt: 500,
      }]);
      if (result === "unavailable") current.nativeArchive.mockRejectedValue(new Error("offline"));
      else current.nativeArchive.mockResolvedValue({ state: result, changed: false });

      const scan = await current.service.discoverWorkspace(
        scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal,
      );
      if (result === "missing") {
        expect(scan.missingReconciliation).toBe("completed");
        expect(current.finishDiscovery.mock.calls[0]?.[5]).toEqual(new Set());
      } else {
        expect(scan).toMatchObject({
          completion: "partial", missingReconciliation: "not_performed",
          diagnostic: "provider_inspection_failed",
        });
        expect(current.finishDiscovery).not.toHaveBeenCalled();
      }
    },
  );

  it("never imports the reserved native child of an unfinished or aborted fork", async () => {
    const current = fixture({ reservedForkChildren: ["reserved-child"] });
    current.discover.mockResolvedValueOnce({
      conversations: [{ ...discoveredConversation("reserved-child"), nativeAncestry: undefined, title: "Source title" }],
    });
    await expect(current.service.discoverWorkspace(scope, "workspace-1", EXHAUSTIVE_DISCOVERY_SCAN, neverAbortedSignal))
      .resolves.toMatchObject({ completion: "complete", conversationsSeen: 1 });
    expect(current.isReservedForkChild).toHaveBeenCalledWith(scope, {
      backendInstanceId: "backend-1", backendConversationId: "reserved-child",
    });
    expect(current.createUnboundThread).not.toHaveBeenCalled();
    expect(current.onThreadChanged).not.toHaveBeenCalled();
  });

  it("keeps ignored-signal provider work owned, then returns partial without mutation", async () => {
    const current = fixture();
    let release!: (page: DiscoveredConversationPage) => void;
    current.discover.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const controller = new AbortController();

    const scan = current.service.discoverWorkspace(
      scope,
      "workspace-1",
      EXHAUSTIVE_DISCOVERY_SCAN,
      controller.signal,
    );
    await vi.waitFor(() => expect(current.discover).toHaveBeenCalledOnce());
    controller.abort(new Error("shutdown"));
    let settled = false;
    void scan.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    release({ conversations: [discoveredConversation("too-late")] });

    await expect(scan).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 0,
      conversationsSeen: 0,
      diagnostic: "cancelled",
    });
    expect(current.finishDiscovery).not.toHaveBeenCalled();
    expect(current.markDiscoveredAvailable).not.toHaveBeenCalled();
    expect(current.onThreadChanged).not.toHaveBeenCalled();
  });

  it("does not persist a page returned concurrently with cancellation", async () => {
    const current = fixture();
    const controller = new AbortController();
    current.discover.mockImplementation(async () => {
      controller.abort(new Error("shutdown"));
      return { conversations: [discoveredConversation("too-late")] };
    });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        controller.signal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 0,
      conversationsSeen: 0,
      diagnostic: "cancelled",
    });
    expect(current.markDiscoveredAvailable).not.toHaveBeenCalled();
    expect(current.finishDiscovery).not.toHaveBeenCalled();
    expect(current.onThreadChanged).not.toHaveBeenCalled();
  });

  it("stops a bounded recent scan at its page budget without marking unseen threads missing", async () => {
    const current = fixture();
    current.discover.mockResolvedValueOnce({
      conversations: [],
      nextCursor: "provider-private-next-page",
    });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        {
          kind: "bounded_recent",
          maximumPages: 1,
        },
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 1,
      conversationsSeen: 0,
    });
    expect(current.discover).toHaveBeenCalledOnce();
    expect(current.finishDiscovery).not.toHaveBeenCalled();
  });

  it("does not grant missing-thread authority to a bounded scan that reaches the terminal page", async () => {
    const current = fixture();
    current.discover.mockResolvedValueOnce({ conversations: [] });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        {
          kind: "bounded_recent",
          maximumPages: 1,
        },
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "complete",
      missingReconciliation: "not_performed",
      pagesScanned: 1,
      conversationsSeen: 0,
    });
    expect(current.finishDiscovery).not.toHaveBeenCalled();
  });

  it("finishes missing-thread reconciliation only after an exhaustive terminal page", async () => {
    const current = fixture();
    current.discover
      .mockResolvedValueOnce({
        conversations: [],
        nextCursor: "provider-private-next-page",
      })
      .mockResolvedValueOnce({ conversations: [] });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "complete",
      missingReconciliation: "completed",
      pagesScanned: 2,
      conversationsSeen: 0,
    });
    expect(current.discover.mock.calls[1]?.[0]).toMatchObject({
      cursor: "provider-private-next-page",
    });
    expect(current.finishDiscovery).toHaveBeenCalledOnce();
  });

  it("queues an exhaustive request behind an in-flight bounded scan instead of joining its partial result", async () => {
    const current = fixture();
    let releaseRecent!: (page: DiscoveredConversationPage) => void;
    current.discover
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRecent = resolve;
          }),
      )
      .mockResolvedValueOnce({ conversations: [] });

    const recent = current.service.discoverWorkspace(
      scope,
      "workspace-1",
      {
        kind: "bounded_recent",
        maximumPages: 1,
      },
      neverAbortedSignal,
    );
    const exhaustive = current.service.discoverWorkspace(
      scope,
      "workspace-1",
      EXHAUSTIVE_DISCOVERY_SCAN,
      neverAbortedSignal,
    );
    await vi.waitFor(() => expect(current.discover).toHaveBeenCalledOnce());

    releaseRecent({
      conversations: [],
      nextCursor: "provider-private-next-page",
    });
    await expect(recent).resolves.toMatchObject({ completion: "partial" });
    await expect(exhaustive).resolves.toMatchObject({ completion: "complete" });
    expect(current.discover).toHaveBeenCalledTimes(2);
    expect(current.finishDiscovery).toHaveBeenCalledOnce();
  });

  it("returns a partial result for repeated cursors and finalizes imported ancestry and notifications", async () => {
    const current = fixture();
    current.discover
      .mockResolvedValueOnce({
        conversations: [discoveredConversation("first")],
        nextCursor: "repeated",
      })
      .mockResolvedValueOnce({
        conversations: [discoveredConversation("second")],
        nextCursor: "repeated",
      });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 2,
      conversationsSeen: 2,
      diagnostic: "cursor_repeated",
    });
    expect(current.finishDiscovery).not.toHaveBeenCalled();
    expect(current.recordImportedNativeOrigin).toHaveBeenCalledTimes(2);
    expect(
      current.onThreadChanged.mock.calls.map(
        ([, applicationThreadId]) => applicationThreadId,
      ),
    ).toEqual(["application-first", "application-second"]);
  });

  it("returns a bounded partial result when a later provider page fails and notifies durable imports", async () => {
    const current = fixture();
    current.discover
      .mockResolvedValueOnce({
        conversations: [discoveredConversation("durable")],
        nextCursor: "provider-private-next-page",
      })
      .mockRejectedValueOnce(new Error("sensitive provider failure"));

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 1,
      conversationsSeen: 1,
      diagnostic: "provider_page_failed",
    });
    expect(current.finishDiscovery).not.toHaveBeenCalled();
    expect(current.recordImportedNativeOrigin).toHaveBeenCalledOnce();
    expect(current.onThreadChanged).toHaveBeenCalledWith(
      scope,
      "application-durable",
    );
  });

  it("returns a partial result when the first provider page fails", async () => {
    const current = fixture();
    current.discover.mockRejectedValueOnce(
      new Error("sensitive provider failure"),
    );

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        neverAbortedSignal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 0,
      conversationsSeen: 0,
      diagnostic: "provider_page_failed",
    });
    expect(current.discover).toHaveBeenCalledOnce();
    expect(current.finishDiscovery).not.toHaveBeenCalled();
    expect(current.markDiscoveredAvailable).not.toHaveBeenCalled();
    expect(current.onThreadChanged).not.toHaveBeenCalled();
  });

  it("does not request another page after cancellation during page persistence", async () => {
    const current = fixture();
    const controller = new AbortController();
    current.discover.mockResolvedValueOnce({
      conversations: [
        discoveredConversation("first"),
        discoveredConversation("second"),
      ],
      nextCursor: "must-not-fetch",
    });
    current.markDiscoveredAvailable.mockImplementationOnce(() => {
      controller.abort(new Error("shutdown"));
    });

    await expect(
      current.service.discoverWorkspace(
        scope,
        "workspace-1",
        EXHAUSTIVE_DISCOVERY_SCAN,
        controller.signal,
      ),
    ).resolves.toEqual({
      completion: "partial",
      missingReconciliation: "not_performed",
      pagesScanned: 1,
      conversationsSeen: 1,
      diagnostic: "cancelled",
    });
    expect(current.discover).toHaveBeenCalledOnce();
    expect(current.markDiscoveredAvailable).toHaveBeenCalledOnce();
    expect(current.finishDiscovery).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, MAXIMUM_BOUNDED_RECENT_DISCOVERY_PAGES + 1])(
    "rejects an invalid bounded page budget of %s",
    (maximumPages) => {
      const current = fixture();
      expect(() =>
        current.service.discoverWorkspace(
          scope,
          "workspace-1",
          {
            kind: "bounded_recent",
            maximumPages,
          },
          neverAbortedSignal,
        ),
      ).toThrow("backend_discovery_page_budget_invalid");
      expect(current.discover).not.toHaveBeenCalled();
    },
  );
});
