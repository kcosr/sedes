import { describe, expect, it, vi } from "vitest";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
  MAXIMUM_BOUNDED_RECENT_DISCOVERY_PAGES,
} from "../../src/server/conversations/backend-discovery-service.js";
import type { DiscoveredConversationPage } from "../../src/server/backends/contracts.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};
const neverAbortedSignal = new AbortController().signal;

function fixture(options: { readonly reservedForkChildren?: readonly string[] } = {}) {
  const database = {
    transaction: <Result>(operation: () => Result) => operation,
  };
  const discover =
    vi.fn<
      (input: {
        readonly cursor?: string;
      }) => Promise<DiscoveredConversationPage>
    >();
  const finishDiscovery = vi.fn(() => []);
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
        driver: { discover },
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
    onAncestryReconciliationConflict: () => undefined,
    onForkReconciliationError: () => undefined,
    onThreadChanged,
  });
  return {
    createUnboundThread,
    isReservedForkChild,
    discover,
    finishDiscovery,
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
