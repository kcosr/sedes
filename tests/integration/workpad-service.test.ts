import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { WorkpadService } from "../../src/server/domain/workpad-service.js";
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
  return { database, scope, repository: new WorkpadRepository(database) };
}

describe("Workpad committed change publications", () => {
  it("publishes document and draft changes, but never rejected or no-op document writes", async () => {
    const f = fixture();
    const publishWorkpadChange = vi.fn(async () => undefined);
    const service = new WorkpadService(f.repository, { publishWorkpadChange });
    try {
      const pad = await service.create(f.scope, { title: "Notes", content: "Before", scope: { kind: "global" } });
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, 0, "document");
      publishWorkpadChange.mockClear();
      await service.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "replace", content: "Before" } });
      await expect(service.update(f.scope, pad.id, { expectedRevision: 7, title: "Stale" })).rejects.toMatchObject({ code: "conflict" });
      await expect(service.update({ ...f.scope, principalId: "other" }, pad.id, { expectedRevision: 0, title: "Forbidden" })).rejects.toMatchObject({ code: "not_found" });
      expect(publishWorkpadChange).not.toHaveBeenCalled();
      const draft = await service.saveDraft(f.scope, pad.id, { expectedRevision: 0, baseRevision: 0, content: "After" });
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, draft.revision, "draft");
      publishWorkpadChange.mockClear();
      await expect(service.saveDraft(f.scope, pad.id, { expectedRevision: 0, baseRevision: 0, content: "Stale device" })).rejects.toMatchObject({ code: "draft_revision_conflict" });
      await expect(service.commitDraft(f.scope, pad.id, { expectedDraftRevision: draft.revision, expectedRevision: 7 })).rejects.toMatchObject({ code: "conflict" });
      expect(publishWorkpadChange).not.toHaveBeenCalled();
      const committed = await service.commitDraft(f.scope, pad.id, { expectedDraftRevision: draft.revision, expectedRevision: 0 });
      expect(publishWorkpadChange.mock.calls).toEqual([
        [f.scope, pad.id, committed.revision, "document"],
        [f.scope, pad.id, service.getDraft(f.scope, pad.id).revision, "draft"],
      ]);
      publishWorkpadChange.mockClear();
      const archived = await service.update(f.scope, pad.id, { expectedRevision: committed.revision, archived: true });
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, archived.revision, "document");
      const discarded = await service.discardDraft(f.scope, pad.id, service.getDraft(f.scope, pad.id).revision);
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, discarded.revision, "draft");
      publishWorkpadChange.mockClear();
      await expect(service.discardDraft({ ...f.scope, tenantId: "other" }, pad.id, discarded.revision)).rejects.toMatchObject({ code: "not_found" });
      expect(publishWorkpadChange).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it("returns committed writes without waiting for publication I/O", async () => {
    const f = fixture();
    const publishWorkpadChange = vi.fn(() => new Promise<void>(() => undefined));
    const service = new WorkpadService(f.repository, { publishWorkpadChange });
    try {
      await expect(service.create(f.scope, { title: "Notes", scope: { kind: "global" } })).resolves.toMatchObject({ revision: 0 });
      expect(publishWorkpadChange).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("retains committed success and retries failed publications independently for document and draft", async () => {
    const f = fixture();
    const publishWorkpadChange = vi.fn<(scope: unknown, id: string, revision: number, change: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const onRetryPending = vi.fn();
    const service = new WorkpadService(f.repository, { publishWorkpadChange }, onRetryPending);
    try {
      const pad = await service.create(f.scope, { title: "Notes", scope: { kind: "global" } }, undefined, 100);
      await service.saveDraft(f.scope, pad.id, { expectedRevision: 0, baseRevision: 0, content: "Draft" }, 200);
      expect(service.getNearestDeadline()).toBe(1_100);
      expect(onRetryPending).toHaveBeenCalledTimes(2);
      await service.reconcileDue(1_099);
      expect(publishWorkpadChange).toHaveBeenCalledTimes(2);
      await service.reconcileDue(1_100);
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, 0, "document");
      expect(service.getNearestDeadline()).toBe(1_200);
      await service.reconcileDue(1_200);
      expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, pad.id, 1, "draft");
      expect(service.getNearestDeadline()).toBeNull();
      expect(service.get(f.scope, pad.id).title).toBe("Notes");
      expect(service.getDraft(f.scope, pad.id).content).toBe("Draft");
    } finally { f.database.close(); }
  });
});

it("does not let an older in-flight success erase a newer publication retry", async () => {
  const f = fixture();
  let finishOlder!: () => void;
  const older = new Promise<void>(resolve => { finishOlder = resolve; });
  const publishWorkpadChange = vi.fn<(scope: unknown, id: string, revision: number, change: string) => Promise<void>>()
    .mockImplementationOnce(() => older)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const service = new WorkpadService(f.repository, { publishWorkpadChange });
  try {
    const first = service.publishWorkpadChange(f.scope, "pad", 1, "document", 100);
    await service.publishWorkpadChange(f.scope, "pad", 2, "document", 200);
    finishOlder();
    await first;
    expect(service.getNearestDeadline()).toBe(1_200);
    await service.reconcileDue(1_200);
    expect(publishWorkpadChange).toHaveBeenLastCalledWith(f.scope, "pad", 2, "document");
    expect(service.getNearestDeadline()).toBeNull();
  } finally { f.database.close(); }
});
