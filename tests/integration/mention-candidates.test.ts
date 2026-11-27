import { describe, expect, it } from "vitest";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { listMentionCandidateIds } from "../../src/server/application/mention-candidates.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

describe("human thread mention search", () => {
  it("searches all locations in the source project and only expands on request", () => {
    const { database, scope, ids, inventory, workspace, environment, bindings } = applicationSummaryFixture(3);
    const [source, parked, archived] = ids as [string, string, string];
    try {
      const location = (name: string, sameProject: boolean) => inventory.upsertWorkspace(scope, {
        environmentId: environment.id, canonicalPath: `/tmp/${name}`, displayName: name,
        project: sameProject ? { kind: "existing", projectId: workspace.projectId } : { kind: "new", name: "Outside" },
        available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 700,
      });
      const connectionProfileId = inventory.getThread(scope, source).thread.connectionProfileId;
      const thread = (workspaceId: string, id: string) => bindings.createUnboundThread(scope, {
        workspaceId, connectionProfileId, id, title: "Élodie and her notes", now: 800,
      }).id;
      const sibling = thread(location("Second folder", true).id, "10000000-0000-4000-8001-000000000001");
      const outside = thread(location("Remote folder", false).id, "10000000-0000-4000-8001-000000000002");
      database.prepare("UPDATE thread_principal_state SET inventory_state = ? WHERE thread_id = ?").run("archived", archived);
      database.prepare("UPDATE thread_principal_state SET inventory_state = ? WHERE thread_id = ?").run("parked", parked);
      expect(listMentionCandidateIds(database, scope, source, { scope: "project" }).ids).toEqual([sibling, parked]);
      for (const query of ["élodie", "second folder", "primary pi", "LOCAL", "summary SQL fixture"]) {
        expect(listMentionCandidateIds(database, scope, source, { scope: "project", query }).ids).toContain(sibling);
      }
      expect(listMentionCandidateIds(database, scope, source, { scope: "all", query: "élodie" }).ids).toEqual([sibling, outside]);
      expect(listMentionCandidateIds(database, scope, source, { scope: "all", query: "outside" }).ids).toEqual([outside]);
      expect(() => listMentionCandidateIds(database, { ...scope, principalId: "another" }, source, { scope: "all" })).toThrow("not found");
    } finally { database.close(); }
  });

  it("continues after draft autosave using the scoped search and activity/ID tuple", () => {
    const { database, scope, inventory, bindings, ids } = applicationSummaryFixture(36);
    const source = ids[35]!;
    try {
      const child = ids[2]!;
      bindings.bindDiscoveredConversation(scope, source, { backendConversationId: "parent-native", now: 900 });
      bindings.bindDiscoveredConversation(scope, child, { backendConversationId: "child-native", lastActivityAt: 301, now: 900 });
      new ThreadLineageRepository(database).recordImportedNativeOrigin(scope, {
        childThreadId: child, providerParentBackendConversationId: "parent-native", sourceThreadId: source,
        sourceTurnState: "unresolved", branchMethod: "provider_native", now: 900,
      });
      const first = listMentionCandidateIds(database, scope, source, { scope: "project" });
      expect(first.ids).toHaveLength(30);
      const cursor = first.nextCursor!;
      inventory.saveDraft(scope, source, {
        text: "Compare @", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [],
        expectedRevision: inventory.getDraft(scope, source).revision, now: 3_000,
      });
      const second = listMentionCandidateIds(database, scope, source, { scope: "project", cursor });
      expect([...first.ids, ...second.ids]).toEqual([...ids.slice(2, 35).reverse(), ids[0], ids[1]]);
      expect(second.ids).toContain(child);
      expect(second.nextCursor).toBeUndefined();
      expect(() => listMentionCandidateIds(database, scope, ids[0]!, { scope: "project", cursor })).toThrow("Restart");
      expect(() => listMentionCandidateIds(database, scope, source, { scope: "all", cursor })).toThrow("Restart");
      expect(() => listMentionCandidateIds(database, scope, source, { scope: "project", query: "other", cursor })).toThrow("Restart");
      database.prepare("UPDATE thread_principal_state SET inventory_state = 'archived' WHERE thread_id = ?").run(child);
      expect(listMentionCandidateIds(database, scope, source, { scope: "project", cursor }).ids).not.toContain(child);
    } finally { database.close(); }
  });
});
