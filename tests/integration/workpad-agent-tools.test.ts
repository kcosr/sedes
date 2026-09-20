import { WorkpadService } from "../../src/server/domain/workpad-service.js";
import { WorkpadAgentToolService } from "../../src/server/agent-tools/tools/workpad-agent-tool-service.js";
import { createWorkpadToolDefinitions } from "../../src/server/agent-tools/tools/workpad-management-tools.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { AgentToolEnvironmentAuthorityResolver, createTrustedEnvironmentAuthorityGrant } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";

import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

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
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture(latestVersion = backendNormalizedMigrations.at(-1)!.version) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const firstWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-first",
      displayName: "Tasks first",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const secondWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-second",
      displayName: "Tasks second",
      availability: "available",
      trustState: "trusted",
    },
    110,
  );
  const firstThread = legacy.createThread(
    scope,
    { workspaceId: firstWorkspace.id, title: "First thread" },
    200,
  );
  const secondThread = legacy.createThread(
    scope,
    { workspaceId: secondWorkspace.id, title: "Second thread" },
    210,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= latestVersion,
    ),
  );
  return {
    database,
    scope,
    environmentId: environment.id,
    firstWorkspaceId: firstWorkspace.id,
    secondWorkspaceId: secondWorkspace.id,
    firstThreadId: firstThread.thread.id,
    secondThreadId: secondThread.thread.id,
    workpads: new WorkpadRepository(database),
  };
}


function toolsFixture() {
  const f = fixture();
  const authorityReader = new DatabaseAgentToolSourceAuthority(f.database, new Uint8Array(32).fill(7));
  const service = new WorkpadAgentToolService({ workpads: new WorkpadService(f.workpads, { publishWorkpadChange: async () => undefined }), authorityReader });
  const definitions = createWorkpadToolDefinitions(service);
  const registry = new AgentToolRegistry();
  definitions.forEach(definition => registry.register(definition));
  const defaults = { kind: "thread_agent" as const, threadId: f.firstThreadId, workspaceId: f.firstWorkspaceId, environmentId: f.environmentId };
  const policyIdentity = { ownerKind: "thread" as const, ownerId: f.firstThreadId, revision: 0 };
  const context = (id: string, input: unknown): TrustedToolInvocationContext => {
    const definition = definitions.find(definition => definition.id === id)!;
    const authority = new AgentToolEnvironmentAuthorityResolver(authorityReader).resolve({ tool: definition, input, scope: f.scope, defaults });
    return {
      ...f.scope, invocationId: "invocation", mutationId: "mutation", requestId: "request", adapter: "http",
      subject: { kind: "thread_agent", sourceThreadId: f.firstThreadId, backendKind: "pi" }, defaults, policyIdentity,
      environmentAuthority: createTrustedEnvironmentAuthorityGrant({ ...authority, tool: { id: definition.id, schemaVersion: definition.schemaVersion }, callerKind: "thread_agent", defaults, policyIdentity, admittedEnvironmentIds: [f.environmentId] }),
      effectiveCapabilities: [], hasCapability: () => false, abortSignal: new AbortController().signal, reportProgress: () => {},
    };
  };
  const invoke = async (id: string, input: unknown, override?: TrustedToolInvocationContext) => {
    expect(registry.validatesInput(id, 1, input)).toBe(true);
    const definition = definitions.find(definition => definition.id === id)!;
    const result = await definition.execute(input, override ?? context(id, input));
    expect(registry.validatesOutput(id, 1, result)).toBe(true);
    return result as any;
  };
  return { ...f, definitions, registry, invoke, context };
}

describe("canonical Workpad tools", () => {
  it("creates, reads and edits across threads with trusted attribution and atomic expected revisions", async () => {
    const f = toolsFixture();
    try {
      const created = await f.invoke("workpad.create", { title: "Integration", scope: { kind: "thread", threadId: f.secondThreadId }, content: "Use a 30-minute timeout." });
      expect(created.workpad.author).toMatchObject({ kind: "agent", threadId: f.firstThreadId, name: "First thread" });
      expect(created.workpad.attribution).toBeUndefined();
      const workpadId = created.workpad.id;
      const updated = await f.invoke("workpad.update", { workpadId, expectedRevision: 0, edit: { kind: "patch", edits: [{ oldText: "30-minute", newText: "15-minute" }] } });
      expect(updated.workpad.content).toBe("Use a 15-minute timeout.");
      await expect(f.invoke("workpad.update", { workpadId, expectedRevision: 0, edit: { kind: "replace", content: "Stale" } })).rejects.toMatchObject({ code: "conflict" });
      const old = await f.invoke("workpad.get", { workpadId, revision: 0 });
      expect(old.workpad.content).toBe("Use a 30-minute timeout.");
      const history = await f.invoke("workpad.revisions", { workpadId, limit: 1 });
      expect(history.items[0].revision).toBe(1);
      expect(history.items[0].content).toBeUndefined();
      expect((await f.invoke("workpad.revisions", { workpadId, limit: 1, cursor: history.nextCursor })).items[0].revision).toBe(0);
      const appended = await f.invoke("workpad.update", { workpadId, expectedRevision: 1, edit: { kind: "append", text: "\nVerified." }, scope: { kind: "global" } });
      expect(appended.workpad.content).toContain("Verified.");
      expect(appended.workpad.scope).toEqual({ kind: "global" });
      await f.invoke("workpad.update", { workpadId, expectedRevision: 2, archived: true });
      const archived = await f.invoke("workpad.list", { scope: { kind: "global" }, scopeMode: "exact", archived: true });
      expect(archived.items.map((item: any) => item.id)).toEqual([workpadId]);
      await f.invoke("workpad.update", { workpadId, expectedRevision: 3, archived: false });
    } finally { f.database.close(); }
  });

  it("fences stale admitted authority and applies current scope to historical reads", async () => {
    const f = toolsFixture();
    try {
      const { workpad } = await f.invoke("workpad.create", { title: "Scoped", scope: { kind: "thread" }, content: "Private" });
      const read = { workpadId: workpad.id, revision: 0 };
      const stale = f.context("workpad.get", read);
      await f.invoke("workpad.update", { workpadId: workpad.id, expectedRevision: 0, scope: { kind: "global" } });
      await expect(f.invoke("workpad.get", read, stale)).rejects.toMatchObject({ code: "permission_denied" });
      expect((await f.invoke("workpad.get", read)).workpad.content).toBe("Private");
      const denied = f.context("workpad.get", read);
      await expect(f.invoke("workpad.get", read, { ...denied, principalId: "unrelated" })).rejects.toMatchObject({ code: "not_found" });
    } finally { f.database.close(); }
  });

  it("bounds search cursors to query and authority, and rejects caller supplied attribution", async () => {
    const f = toolsFixture();
    try {
      for (let n = 0; n < 3; n++) await f.invoke("workpad.create", { title: `API ${n}`, scope: { kind: "global" }, content: "Integration contract" });
      const input = { scope: { kind: "global" }, scopeMode: "subtree", query: "contract", limit: 1 };
      const page = await f.invoke("workpad.list", input);
      expect(page.items).toHaveLength(1);
      expect((await f.invoke("workpad.list", { ...input, cursor: page.nextCursor })).items[0].id).not.toBe(page.items[0].id);
      await expect(f.invoke("workpad.list", { ...input, query: "other", cursor: page.nextCursor })).rejects.toMatchObject({ code: "cursor_invalid" });
      expect(f.registry.validatesInput("workpad.create", 1, { title: "Fake", scope: { kind: "global" }, author: { kind: "user" } })).toBe(false);
      expect(f.registry.validatesInput("workpad.update", 1, { workpadId: "x", expectedRevision: 0, edit: { kind: "patch", edits: [{ oldText: "", newText: "x" }] } })).toBe(false);
      expect(f.registry.validatesInput("workpad.create", 1, { title: "Long", scope: { kind: "global" }, content: "x".repeat(262145) })).toBe(false);
    } finally { f.database.close(); }
  });
});
