import type {
  AgentConnectionProfile,
  DiscoveredConversationPage,
} from "../backends/contracts.js";
import type { DatabaseConversationTargetStore } from "./database-conversation-adapters.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ThreadLineageRepository } from "../db/repositories/thread-lineage-repository.js";
import { applicationTurnIdForBackendTurn } from "./conversation-projector.js";
import { DomainError } from "../domain/errors.js";

export interface DiscoveredBackendThreadPersistence {
  readonly database: InventoryRepository["database"];
  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void;
  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): unknown;
}

function discoveryKey(scope: RequestScope, workspaceId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${workspaceId}`;
}

export const MAXIMUM_BOUNDED_RECENT_DISCOVERY_PAGES = 100;

/**
 * A bounded scan imports a recent prefix without making absence claims.
 * An exhaustive scan starts at the provider's first page and owns its opaque
 * cursors until the terminal page proves the complete namespace was observed.
 */
export type BackendDiscoveryScanPolicy =
  | {
      readonly kind: "bounded_recent";
      readonly maximumPages: number;
    }
  | { readonly kind: "exhaustive" };

export const EXHAUSTIVE_DISCOVERY_SCAN = Object.freeze({
  kind: "exhaustive" as const,
});

/** Provider cursors remain private; callers receive only scan coverage. */
export type BackendDiscoveryScanResult = Readonly<{
  completion: "complete" | "partial";
  missingReconciliation: "completed" | "not_performed";
  pagesScanned: number;
  conversationsSeen: number;
  diagnostic?: "cursor_repeated" | "provider_page_failed" | "cancelled";
}>;

function validateScanPolicy(policy: BackendDiscoveryScanPolicy): void {
  if (
    policy.kind === "bounded_recent" &&
    (!Number.isSafeInteger(policy.maximumPages) ||
      policy.maximumPages <= 0 ||
      policy.maximumPages > MAXIMUM_BOUNDED_RECENT_DISCOVERY_PAGES)
  ) {
    throw new Error("backend_discovery_page_budget_invalid");
  }
}

function scanPolicyCovers(
  current: BackendDiscoveryScanPolicy,
  requested: BackendDiscoveryScanPolicy,
): boolean {
  return (
    current.kind === "exhaustive" ||
    (requested.kind === "bounded_recent" &&
      current.kind === "bounded_recent" &&
      current.maximumPages >= requested.maximumPages)
  );
}

/**
 * Imports and reconciles only conversations belonging to an explicitly added
 * workspace. Driver-native paths and opaque binding detail stop at the
 * backend persistence boundary.
 */
export class BackendDiscoveryService {
  readonly #inFlight = new Map<
    string,
    {
      readonly policy: BackendDiscoveryScanPolicy;
      readonly promise: Promise<BackendDiscoveryScanResult>;
    }
  >();

  constructor(
    readonly input: {
      readonly targets: Pick<DatabaseConversationTargetStore, "discovery">;
      readonly inventory: InventoryRepository;
      readonly bindings: ConversationBindingRepository;
      readonly lineage: ThreadLineageRepository;
      readonly forks: {
        reconcileDiscoveredFork(
          scope: RequestScope,
          input: {
            readonly applicationOperationId: string;
            readonly backendInstanceId: string;
            readonly connectionProfileIds: readonly string[];
            readonly executionEnvironmentId: string;
            readonly backendConversationId: string;
            readonly parentBackendConversationId: string;
            readonly sourceBackendTurnId?: string;
            readonly childIdentity:
              "application_reserved" | "provider_assigned";
            readonly creationRecovery:
              "idempotent" | "exactly_reconcilable" | "potentially_unknown";
            readonly method: "provider_native" | "provider_history_import";
            readonly opaqueBindingDetail: string;
          },
        ): Promise<string | undefined>;
      };
      readonly persistence: ReadonlyMap<
        string,
        DiscoveredBackendThreadPersistence
      >;
      readonly connectionProfileId: string;
      readonly connectionProfileIds?: readonly string[];
      readonly onThreadChanged?: (
        scope: RequestScope,
        applicationThreadId: string,
      ) => void | Promise<void>;
      readonly onAncestryReconciliationConflict: (
        scope: RequestScope,
        error: DomainError,
        childThreadId: string,
      ) => void;
      readonly onForkReconciliationError: (
        scope: RequestScope,
        error: DomainError,
        applicationOperationId: string,
      ) => void;
      readonly now?: () => number;
    },
  ) {
    if (
      input.inventory.database !== input.bindings.database ||
      input.inventory.database !== input.lineage.database ||
      [...input.persistence.values()].some(
        ({ database }) => database !== input.inventory.database,
      )
    ) {
      throw new Error("backend_discovery_database_mismatch");
    }
    const profileIds = input.connectionProfileIds ?? [
      input.connectionProfileId,
    ];
    if (
      profileIds.length === 0 ||
      !profileIds.includes(input.connectionProfileId) ||
      new Set(profileIds).size !== profileIds.length
    ) {
      throw new Error("backend_discovery_profile_scope_invalid");
    }
  }

  discoverWorkspace(
    scope: RequestScope,
    workspaceId: string,
    policy: BackendDiscoveryScanPolicy,
    signal: AbortSignal,
  ): Promise<BackendDiscoveryScanResult> {
    validateScanPolicy(policy);
    const key = discoveryKey(scope, workspaceId);
    const current = this.#inFlight.get(key);
    if (current) {
      if (scanPolicyCovers(current.policy, policy)) return current.promise;
      const continueWithRequestedScan = () =>
        this.discoverWorkspace(scope, workspaceId, policy, signal);
      return current.promise.then(
        continueWithRequestedScan,
        continueWithRequestedScan,
      );
    }
    const discovery = this.#discoverWorkspace(
      scope,
      workspaceId,
      policy,
      signal,
    );
    const tracked = discovery.finally(() => {
      if (this.#inFlight.get(key)?.promise === tracked) {
        this.#inFlight.delete(key);
      }
    });
    this.#inFlight.set(key, { policy, promise: tracked });
    return tracked;
  }

  async #discoverWorkspace(
    scope: RequestScope,
    workspaceId: string,
    policy: BackendDiscoveryScanPolicy,
    signal: AbortSignal,
  ): Promise<BackendDiscoveryScanResult> {
    if (signal.aborted) return cancelledResult(0, 0);
    const { input } = this;
    const workspaceRecord = input.inventory.getWorkspace(scope, workspaceId);
    const target = await input.targets
      .discovery(scope, {
        connectionProfileId: input.connectionProfileId,
        workspaceId,
      })
      .catch((error: unknown) => {
        if (signal.aborted) return undefined;
        throw error;
      });
    if (!target || signal.aborted) return cancelledResult(0, 0);
    if (
      target.connection.executionEnvironmentId !== workspaceRecord.environmentId
    ) {
      throw new Error("discovery_workspace_target_mismatch");
    }
    const persistence = input.persistence.get(
      target.connection.backendInstanceId,
    );
    if (!persistence) {
      throw new Error("backend_discovery_persistence_missing");
    }
    const seen = new Set<string>();
    const changed = new Set<string>();
    const ancestry = new Map<
      string,
      NonNullable<
        import("../backends/contracts.js").DiscoveredConversation["nativeAncestry"]
      >
    >();
    const discoveredBindingDetails = new Map<string, string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pagesScanned = 0;
    let scanFailure: BackendDiscoveryScanResult["diagnostic"];
    do {
      if (cursor) {
        if (cursors.has(cursor)) {
          scanFailure = "cursor_repeated";
          break;
        }
        cursors.add(cursor);
      }
      let page: DiscoveredConversationPage;
      try {
        page = await target.driver.discover({
          scope,
          workspace: target.workspace,
          signal,
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
      } catch {
        if (signal.aborted) {
          scanFailure = "cancelled";
          break;
        }
        scanFailure = "provider_page_failed";
        break;
      }
      if (signal.aborted) {
        scanFailure = "cancelled";
        break;
      }
      pagesScanned += 1;
      for (const discovered of page.conversations) {
        if (signal.aborted) {
          scanFailure = "cancelled";
          break;
        }
        if (
          discovered.canonicalWorkspacePath !== target.workspace.canonicalPath
        ) {
          continue;
        }
        seen.add(discovered.backendConversationId);
        discoveredBindingDetails.set(
          discovered.backendConversationId,
          discovered.opaqueBindingDetail,
        );
        if (discovered.nativeAncestry) {
          ancestry.set(
            discovered.backendConversationId,
            discovered.nativeAncestry,
          );
        }
        const updatedAt = Date.parse(discovered.updatedAt);
        if (!Number.isFinite(updatedAt)) {
          throw new Error("discovered_conversation_timestamp_invalid");
        }
        let recoveredFork: string | undefined;
        let forkReconciliationFailed = false;
        if (
          discovered.nativeAncestry?.applicationOperationId &&
          discovered.nativeAncestry.childIdentity &&
          discovered.nativeAncestry.creationRecovery
        ) {
          try {
            recoveredFork = await input.forks.reconcileDiscoveredFork(scope, {
              applicationOperationId:
                discovered.nativeAncestry.applicationOperationId,
              backendInstanceId: target.connection.backendInstanceId,
              connectionProfileIds: input.connectionProfileIds ?? [
                input.connectionProfileId,
              ],
              executionEnvironmentId: target.connection.executionEnvironmentId,
              backendConversationId: discovered.backendConversationId,
              parentBackendConversationId:
                discovered.nativeAncestry.parentBackendConversationId,
              ...(discovered.nativeAncestry.sourceBackendTurnId
                ? {
                    sourceBackendTurnId:
                      discovered.nativeAncestry.sourceBackendTurnId,
                  }
                : {}),
              childIdentity: discovered.nativeAncestry.childIdentity,
              creationRecovery: discovered.nativeAncestry.creationRecovery,
              method: discovered.nativeAncestry.method,
              opaqueBindingDetail: discovered.opaqueBindingDetail,
            });
            if (signal.aborted) {
              return cancelledResult(pagesScanned, seen.size);
            }
            if (!recoveredFork) {
              forkReconciliationFailed = true;
              input.onForkReconciliationError(
                scope,
                new DomainError(
                  "conflict",
                  "Authenticated fork evidence could not be reconciled.",
                ),
                discovered.nativeAncestry.applicationOperationId,
              );
            }
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            input.onForkReconciliationError(
              scope,
              error,
              discovered.nativeAncestry.applicationOperationId,
            );
            forkReconciliationFailed = true;
          }
        }
        const existing = recoveredFork
          ? { applicationThreadId: recoveredFork }
          : input.bindings.findByBackendConversation(
              scope,
              target.connection.backendInstanceId,
              discovered.backendConversationId,
            );
        if (!existing && forkReconciliationFailed) {
          // Exact application-authored evidence exists. Importing it as an
          // unrelated native thread after a failed reconciliation would
          // create a duplicate. An already-bound thread can still refresh
          // through the ordinary path above; otherwise isolate this record.
          continue;
        }
        if (existing) {
          if (signal.aborted) {
            return cancelledResult(pagesScanned, seen.size);
          }
          const aggregate = input.inventory.getThread(
            scope,
            existing.applicationThreadId,
          );
          if (
            aggregate.thread.workspaceId !== workspaceId ||
            aggregate.thread.environmentId !== workspaceRecord.environmentId
          ) {
            if (signal.aborted) {
              return cancelledResult(pagesScanned, seen.size);
            }
            input.inventory.quarantineDiscoveredConversations(
              scope,
              workspaceRecord.environmentId,
              target.connection.backendInstanceId,
              [discovered.backendConversationId],
              this.#now(),
            );
            changed.add(existing.applicationThreadId);
            continue;
          }
          if (signal.aborted) {
            return cancelledResult(pagesScanned, seen.size);
          }
          input.inventory.database.transaction(() => {
            this.#saveBoundBindingDetailSafely(
              scope,
              persistence,
              existing.applicationThreadId,
              discovered.opaqueBindingDetail,
            );
            input.inventory.markDiscoveredAvailable(
              scope,
              existing.applicationThreadId,
              {
                ...(discovered.title ? { title: discovered.title } : {}),
                updatedAt,
                now: this.#now(),
              },
            );
          })();
          changed.add(existing.applicationThreadId);
          continue;
        }
        const now = this.#now();
        let attemptedCreatedId: string | undefined;
        let createdId: string | undefined;
        try {
          if (signal.aborted) {
            return cancelledResult(pagesScanned, seen.size);
          }
          createdId = input.inventory.database.transaction(() => {
            const created = input.bindings.createUnboundThread(scope, {
              workspaceId,
              connectionProfileId: target.connection.id,
              title: discovered.title ?? "Untitled thread",
              now,
            });
            attemptedCreatedId = created.id;
            persistence.initializeThread(scope, created.id, target.connection);
            input.bindings.bindDiscoveredConversation(scope, created.id, {
              backendConversationId: discovered.backendConversationId,
              lastActivityAt: updatedAt,
              now,
            });
            persistence.saveBoundBindingDetail(
              scope,
              created.id,
              discovered.opaqueBindingDetail,
            );
            input.inventory.markDiscoveredAvailable(scope, created.id, {
              ...(discovered.title ? { title: discovered.title } : {}),
              updatedAt,
              now,
            });
            return created.id;
          })();
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "conflict") {
            throw error;
          }
          input.onAncestryReconciliationConflict(
            scope,
            error,
            attemptedCreatedId ?? discovered.backendConversationId,
          );
          continue;
        }
        changed.add(createdId);
      }
      if (scanFailure) break;
      cursor = page.nextCursor;
      if (
        cursor &&
        policy.kind === "bounded_recent" &&
        pagesScanned >= policy.maximumPages
      ) {
        break;
      }
    } while (cursor);
    if (signal.aborted) {
      return cancelledResult(pagesScanned, seen.size);
    }
    // A provider can enumerate a child before its parent, including across
    // pages. Re-run ancestry reconciliation only after every discovered
    // binding is durable so those relationships resolve in the same scan.
    const ancestryDepth = (
      backendConversationId: string,
      path: ReadonlySet<string> = new Set(),
    ): number => {
      if (path.has(backendConversationId) || path.size >= 100) return 0;
      const parent = ancestry.get(
        backendConversationId,
      )?.parentBackendConversationId;
      if (!parent || !ancestry.has(parent)) return 0;
      return (
        1 + ancestryDepth(parent, new Set([...path, backendConversationId]))
      );
    };
    for (const [backendConversationId, evidence] of [...ancestry].sort(
      ([left], [right]) => ancestryDepth(left) - ancestryDepth(right),
    )) {
      if (signal.aborted) return cancelledResult(pagesScanned, seen.size);
      const child = input.bindings.findByBackendConversation(
        scope,
        target.connection.backendInstanceId,
        backendConversationId,
      );
      if (child) {
        const opaqueBindingDetail = discoveredBindingDetails.get(
          backendConversationId,
        );
        if (
          opaqueBindingDetail &&
          !this.#saveBoundBindingDetailSafely(
            scope,
            persistence,
            child.applicationThreadId,
            opaqueBindingDetail,
          )
        ) {
          continue;
        }
        this.#reconcileNativeAncestrySafely(
          scope,
          workspaceId,
          target.connection.backendInstanceId,
          child.applicationThreadId,
          evidence,
        );
      }
    }
    if (
      !signal.aborted &&
      policy.kind === "exhaustive" &&
      cursor === undefined &&
      scanFailure === undefined
    ) {
      for (const missing of input.inventory.finishDiscovery(
        scope,
        workspaceRecord.environmentId,
        workspaceId,
        target.connection.backendInstanceId,
        input.connectionProfileIds ?? [input.connectionProfileId],
        seen,
        this.#now(),
      )) {
        changed.add(missing.thread.id);
      }
    }
    await Promise.all(
      [...changed].map((applicationThreadId) =>
        signal.aborted
          ? undefined
          : input.onThreadChanged?.(scope, applicationThreadId),
      ),
    );
    if (signal.aborted) return cancelledResult(pagesScanned, seen.size);
    return {
      completion:
        cursor === undefined && scanFailure === undefined
          ? "complete"
          : "partial",
      missingReconciliation:
        policy.kind === "exhaustive" &&
        cursor === undefined &&
        scanFailure === undefined
          ? "completed"
          : "not_performed",
      pagesScanned,
      conversationsSeen: seen.size,
      ...(scanFailure ? { diagnostic: scanFailure } : {}),
    };
  }

  #now(): number {
    return this.input.now?.() ?? Date.now();
  }

  #saveBoundBindingDetailSafely(
    scope: RequestScope,
    persistence: DiscoveredBackendThreadPersistence,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): boolean {
    try {
      persistence.saveBoundBindingDetail(
        scope,
        applicationThreadId,
        opaqueBindingDetail,
      );
      return true;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "conflict") {
        throw error;
      }
      this.input.onAncestryReconciliationConflict(
        scope,
        error,
        applicationThreadId,
      );
      return false;
    }
  }

  #reconcileNativeAncestrySafely(
    scope: RequestScope,
    workspaceId: string,
    backendInstanceId: string,
    childThreadId: string,
    evidence: NonNullable<
      import("../backends/contracts.js").DiscoveredConversation["nativeAncestry"]
    >,
  ): void {
    try {
      this.#reconcileNativeAncestry(
        scope,
        workspaceId,
        backendInstanceId,
        childThreadId,
        evidence,
      );
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "conflict") {
        throw error;
      }
      this.input.onAncestryReconciliationConflict(scope, error, childThreadId);
    }
  }

  #reconcileNativeAncestry(
    scope: RequestScope,
    workspaceId: string,
    backendInstanceId: string,
    childThreadId: string,
    evidence:
      | {
          readonly method: "provider_native" | "provider_history_import";
          readonly parentBackendConversationId: string;
          readonly sourceBackendTurnId?: string;
          readonly applicationOperationId?: string;
        }
      | undefined,
  ): void {
    if (!evidence) return;
    const current = this.input.lineage.findOrigin(scope, childThreadId);
    if (
      current &&
      (current.originKind !== "imported_native_fork" ||
        (current.sourceThreadState === "resolved" &&
          (current.sourceTurnState === "resolved" ||
            evidence.sourceBackendTurnId === undefined)))
    ) {
      return;
    }
    const parent = this.input.bindings.findByBackendConversation(
      scope,
      backendInstanceId,
      evidence.parentBackendConversationId,
    );
    if (!parent || parent.applicationThreadId === childThreadId) {
      this.input.lineage.recordImportedNativeOrigin(scope, {
        childThreadId,
        providerParentBackendConversationId:
          evidence.parentBackendConversationId,
        sourceTurnState: "unresolved",
        branchMethod: evidence.method,
        now: this.#now(),
      });
      return;
    }
    const aggregate = this.input.inventory.getThread(
      scope,
      parent.applicationThreadId,
    );
    const child = this.input.inventory.getThread(scope, childThreadId);
    if (
      aggregate.thread.workspaceId !== workspaceId ||
      aggregate.thread.backendInstanceId !== backendInstanceId ||
      aggregate.thread.environmentId !== child.thread.environmentId ||
      aggregate.thread.connectionProfileId !== child.thread.connectionProfileId
    ) {
      if (!current) {
        this.input.lineage.recordImportedNativeOrigin(scope, {
          childThreadId,
          providerParentBackendConversationId:
            evidence.parentBackendConversationId,
          sourceTurnState: "unresolved",
          branchMethod: evidence.method,
          now: this.#now(),
        });
      }
      return;
    }
    const source = {
      sourceThreadId: parent.applicationThreadId,
      sourceTurnState: evidence.sourceBackendTurnId
        ? ("resolved" as const)
        : ("unresolved" as const),
      ...(evidence.sourceBackendTurnId
        ? {
            sourceTurnId: applicationTurnIdForBackendTurn({
              backendInstanceId,
              sourceApplicationThreadId: parent.applicationThreadId,
              backendTurnId: evidence.sourceBackendTurnId,
            }),
          }
        : {}),
      now: this.#now(),
    };
    if (current) {
      this.input.lineage.reconcileImportedNativeSource(scope, childThreadId, {
        ...source,
        providerParentBackendConversationId:
          evidence.parentBackendConversationId,
      });
      return;
    }
    this.input.lineage.recordImportedNativeOrigin(scope, {
      childThreadId,
      providerParentBackendConversationId: evidence.parentBackendConversationId,
      ...source,
      branchMethod: evidence.method,
    });
  }
}

function cancelledResult(
  pagesScanned: number,
  conversationsSeen: number,
): BackendDiscoveryScanResult {
  return {
    completion: "partial",
    missingReconciliation: "not_performed",
    pagesScanned,
    conversationsSeen,
    diagnostic: "cancelled",
  };
}
