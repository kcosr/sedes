import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { createConfigurationAdminFixture } from "../e2e/configuration-admin-fixture.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";

const document: ConfigurationDocument = {
  executionEnvironments: [{ id: "019196f7-a0a8-7bc4-a89b-8cf013978405", kind: "local", label: "Local", workspaceRoots: ["/tmp"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
  backends: [], targets: [], defaultTargetId: null, webSearch: null,
};

describe("scripted configuration administration fixture", () => {
  it("retains a scripted unknown receipt until a scoped confirmed Stop settles it", async () => {
    const database = openOverlayDatabaseConnection(":memory:");
    try {
      initializeEmptyBackendNormalizedDatabase(database);
      const fixture = initializeDatabaseConfigurationFixture(database, document, { sourceLabel: "configuration-fixture-test" });
      const onReconciled = vi.fn(async (scope: typeof fixture.scope) => {
        expect(scope).toEqual(fixture.scope);
      });
      const service = await createConfigurationAdminFixture({ ...fixture, initial: fixture.repository.get(fixture.scope), provisionedConfiguration: document, activeResources: async () => 0, onReconciled });
      expect(onReconciled).toHaveBeenCalledTimes(1);
      const remoteId = randomUUID();
      const next = structuredClone(document);
      next.executionEnvironments.push({ id: remoteId, kind: "ssh", label: "Uncertain fixture", hostAlias: "e2e-unknown-lifecycle", workspaceRoots: ["/work"], operations: { kind: "none" } });
      await service.save(fixture.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: next });
      expect(onReconciled).toHaveBeenCalledTimes(2);
      const runtime = (await service.get(fixture.scope)).runtimes.find(entry => entry.resourceId === remoteId)!;
      const mutationId = randomUUID();
      const original = await service.lifecycle(fixture.scope, { mutationId, expectedRevision: 1, resourceKind: "environment", resourceId: remoteId, action: "connect", expectedIncarnation: runtime.incarnation, impactToken: null });
      expect(original.state).toBe("unknown");
      expect((await service.get(fixture.scope)).runtimes.find(entry => entry.resourceId === remoteId)?.lifecycleOperation).toMatchObject({ mutationId, state: "unknown" });
      const impact = await service.impact(fixture.scope, { resourceKind: "environment", resourceId: remoteId, action: "stop", expectedRevision: 2 });
      expect(impact.interruptions).toHaveLength(1);
      const stopped = await service.lifecycle(fixture.scope, { mutationId: randomUUID(), expectedRevision: 2, resourceKind: "environment", resourceId: remoteId, action: "stop", expectedIncarnation: runtime.incarnation, impactToken: impact.token });
      expect(stopped).toMatchObject({ state: "applied", runtime: { connectionState: "stopped", activeResources: 0 } });
      expect((await service.lifecycleReceipt(fixture.scope, mutationId)).state).toBe("rejected");
      expect((await service.get(fixture.scope)).runtimes.find(entry => entry.resourceId === remoteId)?.lifecycleOperation).toBeUndefined();
    } finally { database.close(); }
  });

  it("reports new SSH connection failure and preserves explicit disconnect across recreation", async () => {
    const database = openOverlayDatabaseConnection(":memory:");
    try {
      initializeEmptyBackendNormalizedDatabase(database);
      const fixture = initializeDatabaseConfigurationFixture(database, document, { sourceLabel: "configuration-fixture-test" });
      const published: ReturnType<typeof fixture.repository.get>[] = [];
      const onReconciled = async (scope: typeof fixture.scope) => {
        expect(scope).toEqual(fixture.scope);
        published.push(fixture.repository.get(scope));
      };
      const create = () => createConfigurationAdminFixture({ ...fixture, initial: fixture.repository.get(fixture.scope), provisionedConfiguration: document, activeResources: async () => 0, onReconciled });
      const service = await create();
      expect((await service.get(fixture.scope)).runtimes[0]?.applyState).toBe("applied");
      const next = structuredClone(document);
      const remoteId = randomUUID();
      next.executionEnvironments.push({ id: remoteId, kind: "ssh", label: "Unavailable fixture", hostAlias: "e2e-unreachable", workspaceRoots: ["/work"], operations: { kind: "none" } });
      await service.save(fixture.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: next });
      expect(published).toHaveLength(2);
      expect(published[1]?.configuration).toEqual(next);
      expect(published[1]?.runtimes.find(runtime => runtime.resourceId === remoteId)).toMatchObject({ applyState: "unavailable", effectiveRevision: null });
      const saved = await service.get(fixture.scope);
      expect(saved.runtimes.find(runtime => runtime.resourceId === remoteId)).toMatchObject({ applyState: "unavailable", effectiveRevision: null, supportedActions: ["connect", "disconnect"] });
      const connected = await service.lifecycle(fixture.scope, { mutationId: randomUUID(), expectedRevision: 1, resourceKind: "environment", resourceId: remoteId, action: "connect", expectedIncarnation: null, impactToken: null });
      expect(connected).toMatchObject({ state: "unavailable", runtime: { connectionState: "unreachable", effectiveRevision: null } });
      await service.lifecycle(fixture.scope, { mutationId: randomUUID(), expectedRevision: 2, resourceKind: "environment", resourceId: remoteId, action: "disconnect", expectedIncarnation: null, impactToken: null });
      const recreated = await create();
      expect((await recreated.get(fixture.scope)).runtimes.find(runtime => runtime.resourceId === remoteId)).toMatchObject({ preference: "disconnected", connectionState: "disconnected", effectiveRevision: null, applyState: "unavailable" });
    } finally { database.close(); }
  });
});
