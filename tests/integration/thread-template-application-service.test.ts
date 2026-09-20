import { describe, expect, it, vi } from "vitest";
import { ThreadTemplateApplicationService } from "../../src/server/application/thread-template-application-service.js";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const agentId = "30000000-0000-4000-8000-000000000001";

describe("ThreadTemplateApplicationService", () => {
  it("persists only server-derived labels and refreshes them on update", async () => {
    const current = savedAgentDatabase();
    try {
      let labels = {
        capturedAgentName: "Server Agent",
        capturedWorkspaceName: "Server Workspace",
        capturedTargetName: "Server Target",
      };
      const assertDurableFences = vi.fn();
      const prepareThreadTemplateSelection = vi.fn(async (_scope, input) => ({
        ...input,
        ...labels,
        assertDurableFences,
      }));
      const service = new ThreadTemplateApplicationService({
        repository: new ThreadTemplateRepository(current.database),
        savedAgents: { prepareThreadTemplateSelection } as never,
        now: () => 1_000,
      });
      const created = await service.create(current.scope, {
        name: "Review",
        workspaceId,
        targetId: "local-primary",
        executionWorkspace: { kind: "direct" },
        agentId,
      });
      expect(created).toMatchObject(labels);
      expect(assertDurableFences).toHaveBeenCalledTimes(1);

      labels = {
        capturedAgentName: "Renamed Agent",
        capturedWorkspaceName: "Renamed Workspace",
        capturedTargetName: "Renamed Target",
      };
      const updated = await service.update(current.scope, created.id, {
        expectedRevision: 0,
        name: "Updated review",
      });
      expect(updated).toMatchObject({ ...labels, revision: 1 });
      expect(prepareThreadTemplateSelection).toHaveBeenLastCalledWith(
        current.scope,
        {
          workspaceId,
          targetId: "local-primary",
          executionWorkspace: { kind: "direct" },
          agentId,
        },
        undefined,
      );
    } finally {
      current.database.close();
    }
  });

  it("fails a stale reference fence without writing and still deletes drifted templates", async () => {
    const current = savedAgentDatabase();
    try {
      let failFence = false;
      let failPreparation = false;
      const repository = new ThreadTemplateRepository(current.database);
      const service = new ThreadTemplateApplicationService({
        repository,
        savedAgents: {
          prepareThreadTemplateSelection: vi.fn(async (_scope, input) => {
            if (failPreparation) throw new Error("agent_missing");
            return {
              ...input,
              capturedAgentName: "Reviewer",
              capturedWorkspaceName: "Sedes",
              capturedTargetName: "Local Pi",
              assertDurableFences: () => {
                if (failFence) throw new Error("agent_changed");
              },
            };
          }),
        } as never,
        now: () => 1_000,
      });
      failFence = true;
      await expect(
        service.create(current.scope, {
          name: "Stale",
          workspaceId,
          targetId: "local-primary",
          executionWorkspace: { kind: "direct" },
          agentId,
        }),
      ).rejects.toThrow("agent_changed");
      expect(
        repository.listPage(current.scope, { pageSize: 10 }).items,
      ).toEqual([]);

      failFence = false;
      const created = await service.create(current.scope, {
        name: "Can drift",
        workspaceId,
        targetId: "local-primary",
        executionWorkspace: { kind: "direct" },
        agentId,
      });
      failPreparation = true;
      await expect(
        service.update(current.scope, created.id, {
          expectedRevision: 0,
          name: "Cannot update without repair",
        }),
      ).rejects.toThrow("agent_missing");
      expect(service.delete(current.scope, created.id, 0)).toEqual({
        deleted: true,
        templateId: created.id,
      });
    } finally {
      current.database.close();
    }
  });
});
