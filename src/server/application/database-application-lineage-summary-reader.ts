import type { RequestScope } from "../identity/identity-provider.js";
import type { NormalizedThreadLineageFamily } from "../../shared/protocol/application.js";
import type { ThreadLineageRepository } from "../db/repositories/thread-lineage-repository.js";
import type { ApplicationLineageSummaryReader } from "./application-snapshot-service.js";

export class DatabaseApplicationLineageSummaryReader implements ApplicationLineageSummaryReader {
  constructor(readonly lineage: ThreadLineageRepository) {}

  list(scope: RequestScope, childThreadIds: readonly string[]) {
    const bootstrapThreadIds = new Set(childThreadIds);
    const origins = this.lineage
      .listOrigins(scope, childThreadIds)
      .filter(({ originState }) => originState === "committed");
    const placements = this.lineage.listPlacements(
      scope,
      origins.map(({ childThreadId }) => childThreadId),
    );
    const lineageFamilies: NormalizedThreadLineageFamily[] = [];
    for (let offset = 0; offset < childThreadIds.length; offset += 100) {
      lineageFamilies.push(
        ...this.lineage.countDescendants(
          scope,
          childThreadIds.slice(offset, offset + 100),
        ),
      );
    }
    return {
      forkOrigins: origins.map((origin) => ({
        childThreadId: origin.childThreadId,
        // A bounded bootstrap may omit an older parent. Keep the child usable
        // as a provenance-bearing effective root without leaking a dangling
        // application identifier; the paged descendant API retains the exact
        // durable edge.
        sourceThreadId:
          origin.sourceThreadId && bootstrapThreadIds.has(origin.sourceThreadId)
            ? origin.sourceThreadId
            : null,
        sourceTurnId:
          origin.sourceThreadId && bootstrapThreadIds.has(origin.sourceThreadId)
            ? origin.sourceTurnId
            : null,
        sourceTurnCompletedAt:
          origin.sourceThreadId &&
          bootstrapThreadIds.has(origin.sourceThreadId) &&
          origin.sourceTurnCompletedAt !== null
            ? new Date(origin.sourceTurnCompletedAt).toISOString()
            : null,
        boundaryKind: origin.boundaryKind,
        originKind: origin.originKind,
        initiatingAgentThreadId: origin.initiatingAgentThreadId,
        initiatingToolClientId: origin.initiatingToolClientId,
        branchMethod: origin.branchMethod,
        createdAt: new Date(origin.createdAt).toISOString(),
      })),
      lineagePlacements: placements.map((placement) => ({
        childThreadId: placement.childThreadId,
        mode: placement.placementMode,
        revision: placement.revision,
        updatedAt: new Date(placement.updatedAt).toISOString(),
      })),
      lineageFamilies,
    };
  }
}
