import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("linked-worktree root persistence", () => {
  it("detects cross-workspace checkout overlap in both path directions and across principals", () => {
    const value = savedAgentDatabase();
    const { database, scope } = value;
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.listEnvironments(scope)[0]!;
      const workspace = inventory.upsertWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/worktrees/main",
        displayName: "Main",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 10,
      });
      const roots = new WorkspaceFileLinkedWorktreeRepository(database);
      expect(
        roots.hasOtherWorkspaceOverlap(
          scope,
          environment.id,
          workspace.id,
          workspace.canonicalPath,
        ),
      ).toBe(false);

      const template = database
        .prepare(
          `SELECT * FROM workspaces
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, workspace.id) as Record<
        string,
        unknown
      >;
      const insertWorkspace = (
        ownerPrincipalId: string,
        canonicalPath: string,
      ): string => {
        const id = randomUUID();
        const row = {
          ...template,
          owner_principal_id: ownerPrincipalId,
          id,
          canonical_path: canonicalPath,
          display_name: id,
        };
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO workspaces(${columns.join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`,
          )
          .run(...Object.values(row));
        return id;
      };

      // Environment IDs are principal-owned today. Disable the FK only while
      // constructing a cross-principal row to assert that this safety query
      // remains tenant/environment-wide if that ownership model expands.
      database.pragma("foreign_keys = OFF");
      for (const ownerPrincipalId of [scope.principalId, "other-principal"]) {
        for (const canonicalPath of [
          "/worktrees/feature/nested",
          "/worktrees",
        ]) {
          const otherWorkspaceId = insertWorkspace(
            ownerPrincipalId,
            canonicalPath,
          );
          expect(
            roots.hasOtherWorkspaceOverlap(
              scope,
              environment.id,
              workspace.id,
              "/worktrees/feature",
            ),
          ).toBe(true);
          database
            .prepare("DELETE FROM workspaces WHERE tenant_id = ? AND id = ?")
            .run(scope.tenantId, otherWorkspaceId);
        }
      }
      database.pragma("foreign_keys = ON");
    } finally {
      database.close();
    }
  });

  it("retains identities, honors incomplete discovery, and atomically clears stale preferences", () => {
    const value = savedAgentDatabase();
    const { database, scope } = value;
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.listEnvironments(scope)[0]!;
      const workspace = inventory.upsertWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/worktrees/main",
        displayName: "Main",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 10,
      });
      const profile = database
        .prepare(`SELECT id FROM agent_connection_profiles LIMIT 1`)
        .get() as { readonly id: string };
      const thread = new ConversationBindingRepository(
        database,
      ).createUnboundThread(scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Thread",
        now: 20,
      });
      const roots = new WorkspaceFileLinkedWorktreeRepository(database);
      const first = roots.reconcileDiscovery(
        scope,
        workspace.id,
        [
          {
            canonicalPath: "/worktrees/feature",
            canonicalCheckoutPath: "/worktrees/feature",
            canonicalGitDir: "/worktrees/main/.git/worktrees/feature",
            identityToken: "1".repeat(64),
            displayLabel: "feature",
            branchRef: "refs/heads/feature",
            headOid: "a".repeat(40),
            provenanceKind: "unmerged",
            aheadCount: 1,
            behindCount: 0,
          },
        ],
        { complete: true, now: 30 },
      ).roots[0]!;

      expect(
        inventory.setPreferredWorktree(scope, thread.id, {
          rootId: first.rootId,
          expectedRevision: 0,
          mutationId: randomUUID(),
          now: 40,
        }),
      ).toEqual({ preference: { rootId: first.rootId, revision: 1 } });

      expect(
        roots.reconcileDiscovery(scope, workspace.id, [], {
          complete: false,
          now: 50,
        }),
      ).toMatchObject({ tombstonedRootIds: [], clearedThreadIds: [] });
      expect(
        inventory.getInventory(scope, thread.id).preferredWorktreeRootId,
      ).toBe(first.rootId);

      const generationBeforeRemoval = (
        database
          .prepare(
            `SELECT inventory_generation AS generation
             FROM principal_generations
             WHERE tenant_id = ? AND principal_id = ?`,
          )
          .get(scope.tenantId, scope.principalId) as {
          readonly generation: number;
        }
      ).generation;

      const removed = roots.reconcileDiscovery(
        scope,
        workspace.id,
        [
          {
            canonicalPath: "/worktrees/feature",
            canonicalCheckoutPath: "/worktrees/feature",
            canonicalGitDir: "/worktrees/main/.git/worktrees/feature",
            identityToken: "2".repeat(64),
            displayLabel: "feature",
            branchRef: "refs/heads/feature",
            headOid: "b".repeat(40),
            provenanceKind: "unmerged",
            aheadCount: 1,
            behindCount: 0,
          },
        ],
        { complete: true, now: 60 },
      );
      expect(removed.tombstonedRootIds).toEqual([first.rootId]);
      expect(removed.clearedThreadIds).toEqual([thread.id]);
      expect(
        database
          .prepare(
            `SELECT inventory_generation AS generation
             FROM principal_generations
             WHERE tenant_id = ? AND principal_id = ?`,
          )
          .get(scope.tenantId, scope.principalId),
      ).toEqual({ generation: generationBeforeRemoval + 1 });
      expect(inventory.getInventory(scope, thread.id)).toMatchObject({
        preferredWorktreeRootId: null,
        preferredWorktreeRevision: 2,
      });
      expect(
        inventory.setPreferredWorktree(scope, thread.id, {
          rootId: null,
          expectedRevision: 2,
          mutationId: randomUUID(),
          now: 65,
        }),
      ).toEqual({ preference: { rootId: null, revision: 2 } });
      expect(roots.find(scope, workspace.id, first.rootId)).toMatchObject({
        availability: "unavailable",
        unavailableAt: 60,
      });

      const recreated = removed.roots[0]!;
      expect(recreated.rootId).not.toBe(first.rootId);
      expect(
        roots.list(scope, workspace.id, { includeUnavailable: true }),
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("clears a preferred root when an unbound thread moves workspaces", () => {
    const value = savedAgentDatabase();
    const { database, scope } = value;
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.listEnvironments(scope)[0]!;
      const source = inventory.upsertWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/worktrees/source",
        displayName: "Source",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 10,
      });
      const destination = inventory.upsertWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/worktrees/destination",
        displayName: "Destination",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 11,
      });
      const profile = database
        .prepare(`SELECT id FROM agent_connection_profiles LIMIT 1`)
        .get() as { readonly id: string };
      const bindings = new ConversationBindingRepository(database);
      const thread = bindings.createUnboundThread(scope, {
        workspaceId: source.id,
        connectionProfileId: profile.id,
        title: "Movable",
        now: 20,
      });
      const root = new WorkspaceFileLinkedWorktreeRepository(
        database,
      ).reconcileDiscovery(
        scope,
        source.id,
        [
          {
            canonicalPath: "/worktrees/feature",
            canonicalCheckoutPath: "/worktrees/feature",
            canonicalGitDir: "/worktrees/source/.git/worktrees/feature",
            identityToken: "3".repeat(64),
            displayLabel: "feature",
            branchRef: "refs/heads/feature",
            headOid: "a".repeat(40),
            provenanceKind: "unmerged",
            aheadCount: 1,
            behindCount: 0,
          },
        ],
        { complete: true, now: 30 },
      ).roots[0]!;
      inventory.setPreferredWorktree(scope, thread.id, {
        rootId: root.rootId,
        expectedRevision: 0,
        mutationId: randomUUID(),
        now: 40,
      });
      const move = {
        workspaceId: destination.id,
        expectedThreadRevision: 0,
        mutationId: randomUUID(),
        now: 50,
      };

      expect(
        bindings.moveUnboundThreadWorkspace(scope, thread.id, move),
      ).toMatchObject({ workspaceId: destination.id });
      expect(inventory.getInventory(scope, thread.id)).toMatchObject({
        preferredWorktreeRootId: null,
        preferredWorktreeRevision: 2,
      });
      bindings.moveUnboundThreadWorkspace(scope, thread.id, move);
      expect(inventory.getInventory(scope, thread.id)).toMatchObject({
        preferredWorktreeRootId: null,
        preferredWorktreeRevision: 2,
      });
    } finally {
      database.close();
    }
  });
});
