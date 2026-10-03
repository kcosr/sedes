import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture() {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  return { database, scope, repository: new TaskRepository(database) };
}

describe("task service publication retry", () => {
  it("publishes a committed completed-task deletion and retries failed publication", async () => {
    const current = fixture();
    try {
      const created = current.repository.create(current.scope, {
        title: "Completed deletion",
        scope: { kind: "global" },
        mutationId: "create-completed-deletion",
        now: 1_000,
      });
      const completed = current.repository.update(current.scope, created.id, {
        completed: true,
        expectedRevision: created.revision,
        mutationId: "complete-deletion",
        now: 2_000,
      });
      const taskExistsAtPublication: boolean[] = [];
      const publishTaskChange = vi.fn(async (): Promise<void> => {
        taskExistsAtPublication.push(
          current.repository.find(current.scope, created.id) !== undefined,
        );
        if (publishTaskChange.mock.calls.length === 1) {
          throw new Error("publication_down");
        }
      });
      const onRetryPending = vi.fn();
      const service = new TaskService(
        current.repository,
        { publishTaskChange },
        onRetryPending,
      );

      await expect(
        service.removeCompleted(
          current.scope,
          created.id,
          completed.revision,
          3_000,
        ),
      ).resolves.toBeUndefined();
      expect(current.repository.find(current.scope, created.id)).toBeUndefined();
      expect(publishTaskChange).toHaveBeenCalledWith(current.scope, created.id);
      expect(taskExistsAtPublication).toEqual([false]);
      expect(onRetryPending).toHaveBeenCalledTimes(1);
      expect(service.getNearestDeadline()).toBe(4_000);

      await service.reconcileDue(3_999);
      expect(publishTaskChange).toHaveBeenCalledTimes(1);
      await service.reconcileDue(4_000);
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
      expect(taskExistsAtPublication).toEqual([false, false]);
      expect(service.getNearestDeadline()).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("does not publish a rejected completed-task deletion", async () => {
    const current = fixture();
    try {
      const created = current.repository.create(current.scope, {
        title: "Still open",
        scope: { kind: "global" },
        mutationId: "create-rejected-deletion",
        now: 1_000,
      });
      const publishTaskChange = vi.fn().mockResolvedValue(undefined);
      const service = new TaskService(current.repository, { publishTaskChange });
      await expect(
        service.removeCompleted(current.scope, created.id, created.revision, 2_000),
      ).rejects.toMatchObject({ code: "bad_request" });
      expect(current.repository.get(current.scope, created.id)).toEqual(created);
      expect(publishTaskChange).not.toHaveBeenCalled();
      expect(service.getNearestDeadline()).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("returns immediately after admitting a committed create publication", async () => {
    const current = fixture();
    try {
      const publishTaskChange = vi.fn(() => new Promise<void>(() => undefined));
      const service = new TaskService(current.repository, { publishTaskChange });
      await expect(
        service.create(
          current.scope,
          {
            mutationId: "11111111-1111-4111-8111-111111111119",
            title: "Owned handoff",
            scope: { kind: "global" },
          },
          1_000,
        ),
      ).resolves.toMatchObject({ title: "Owned handoff" });
      expect(publishTaskChange).toHaveBeenCalledTimes(1);
    } finally {
      current.database.close();
    }
  });

  it("clears a failed create retry when a later update publishes successfully", async () => {
    const current = fixture();
    try {
      const publishTaskChange = vi
        .fn<(scope: unknown, taskId: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("publication_down"))
        .mockResolvedValue(undefined);
      const onRetryPending = vi.fn();
      const service = new TaskService(
        current.repository,
        { publishTaskChange },
        onRetryPending,
      );

      const created = await service.create(
        current.scope,
        {
          mutationId: "11111111-1111-4111-8111-111111111120",
          title: "Clear stale retry",
          scope: { kind: "global" },
        },
        1_000,
      );
      expect(onRetryPending).toHaveBeenCalledTimes(1);
      expect(service.getNearestDeadline()).toBe(2_000);

      await service.update(
        current.scope,
        created.id,
        {
          mutationId: "11111111-1111-4111-8111-111111111121",
          expectedRevision: created.revision,
          details: "Published before the retry deadline",
        },
        1_500,
      );
      await Promise.resolve();
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
      expect(service.getNearestDeadline()).toBeNull();

      await service.reconcileDue(2_000);
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("returns the committed mutation and queues a retry when publication fails", async () => {
    const current = fixture();
    try {
      const publishTaskChange = vi
        .fn<(scope: unknown, taskId: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("publication_down"))
        .mockResolvedValue(undefined);
      const onRetryPending = vi.fn();
      const service = new TaskService(
        current.repository,
        { publishTaskChange },
        onRetryPending,
      );

      const created = await service.create(
        current.scope,
        {
          mutationId: "11111111-1111-4111-8111-111111111111",
          title: "Publish me eventually",
          scope: { kind: "global" },
        },
        1_000,
      );
      // The mutation committed; a publication failure must not fail the
      // request (a client retry would mint a fresh mutation id and create a
      // duplicate task).
      expect(created.title).toBe("Publish me eventually");
      expect(current.repository.list(current.scope)).toHaveLength(1);
      expect(onRetryPending).toHaveBeenCalledTimes(1);
      expect(service.getNearestDeadline()).toBe(2_000);

      // Not yet due: nothing is retried.
      await service.reconcileDue(1_500);
      expect(publishTaskChange).toHaveBeenCalledTimes(1);

      await service.reconcileDue(2_000);
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
      expect(publishTaskChange).toHaveBeenLastCalledWith(
        current.scope,
        created.id,
      );
      expect(service.getNearestDeadline()).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("survives a throwing retry-scheduling observer and stays scheduled", async () => {
    const current = fixture();
    try {
      const publishTaskChange = vi
        .fn<(scope: unknown, taskId: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("publication_down"))
        .mockResolvedValue(undefined);
      const onRetryPending = vi.fn(() => {
        throw new Error("scheduler_rearm_failed");
      });
      const service = new TaskService(
        current.repository,
        { publishTaskChange },
        onRetryPending,
      );

      const created = await service.create(
        current.scope,
        {
          mutationId: "33333333-3333-4333-8333-333333333333",
          title: "Scheduling observer down",
          scope: { kind: "global" },
        },
        1_000,
      );
      expect(created.title).toBe("Scheduling observer down");
      expect(onRetryPending).toHaveBeenCalledTimes(1);
      // The pending entry stays authoritative despite the observer failure.
      expect(service.getNearestDeadline()).toBe(2_000);
      await service.reconcileDue(2_000);
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
      expect(service.getNearestDeadline()).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("keeps rescheduling while publication keeps failing", async () => {
    const current = fixture();
    try {
      const publishTaskChange = vi
        .fn<(scope: unknown, taskId: string) => Promise<void>>()
        .mockRejectedValue(new Error("still_down"));
      const service = new TaskService(current.repository, {
        publishTaskChange,
      });

      await service.create(
        current.scope,
        {
          mutationId: "22222222-2222-4222-8222-222222222222",
          title: "Unlucky",
          scope: { kind: "global" },
        },
        1_000,
      );
      expect(service.getNearestDeadline()).toBe(2_000);
      await service.reconcileDue(2_000);
      expect(publishTaskChange).toHaveBeenCalledTimes(2);
      expect(service.getNearestDeadline()).toBe(3_000);
    } finally {
      current.database.close();
    }
  });
});
