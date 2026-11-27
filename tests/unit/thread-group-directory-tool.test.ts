import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { createThreadGroupListToolDefinition } from "../../src/server/agent-tools/tools/thread-group-list-tool.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function caller(scope: RequestScope, revision = 1): TrustedToolInvocationContext {
  const defaults = {
    kind: "thread_agent", environmentId: "env", workspaceId: "workspace", projectId: "project", threadId: "thread",
  } as const;
  const policyIdentity = { ownerKind: "thread", ownerId: "thread", revision } as const;
  return {
    ...scope, defaults, policyIdentity,
    subject: { kind: "thread_agent", sourceThreadId: defaults.threadId, backendKind: "pi" },
    invocationId: "invocation", mutationId: "mutation", requestId: "request", adapter: "http",
    effectiveCapabilities: [], hasCapability: () => false, abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
    environmentAuthority: {
      id: "authority", callerKind: "thread_agent", defaults, policyIdentity,
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
      admittedEnvironmentIds: [defaults.environmentId], targetEnvironmentIds: [], resolvedResourceRefs: [],
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
      canonicalInputDigest: "input", authorityDigest: "authority",
    },
  };
}

describe("thread Group directory", () => {
  it("lists only this principal's Group IDs and names, including empty Groups", async () => {
    const { database, scope } = savedAgentDatabase();
    try {
      const insert = database.prepare(`INSERT INTO thread_groups
        (tenant_id, principal_id, id, name, name_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 0)`);
      function add(owner: RequestScope, name: string) {
        const id = randomUUID();
        insert.run(owner.tenantId, owner.principalId, id, name, name.toLocaleLowerCase("en-US"));
        return { id, name };
      }
      const second = add(scope, "Zulu Plan");
      const first = add(scope, "A Plan");
      add(scope, "Payroll");
      const foreign = { ...scope, principalId: "another-owner" };
      database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)")
        .run(foreign.tenantId, foreign.principalId);
      add(foreign, "Secret Plan");

      const tool = createThreadGroupListToolDefinition(new ThreadGroupRepository(database));
      const context = caller(scope);
      const registry = new AgentToolRegistry();
      registry.register(tool);
      expect(registry.validatesInput(tool.id, tool.schemaVersion, { pageSize: 101 })).toBe(false);
      expect(registry.validatesInput(tool.id, tool.schemaVersion, { principalId: foreign.principalId })).toBe(false);
      const input = { pageSize: 1, query: "ＰＬＡＮ" };
      const page = await tool.execute(input, context);
      expect(page).toEqual({ items: [first], nextCursor: expect.any(String) });
      if (!("nextCursor" in page) || !page.nextCursor) throw new Error("Expected continuation");
      const cursor = page.nextCursor;
      expect(await tool.execute({ ...input, cursor }, context)).toEqual({ items: [second] });
      expect(await tool.execute({ query: "secret" }, context)).toEqual({ items: [] });
      expect(await tool.execute({ query: "missing" }, context)).toEqual({ items: [] });
      expect(registry.validatesOutput(tool.id, tool.schemaVersion, page)).toBe(true);
      expect(registry.validatesOutput(tool.id, tool.schemaVersion, { items: [{ ...first, memberCount: 0 }] })).toBe(false);

      const invalidCursor = { code: "cursor_invalid" };
      await expect(tool.execute({ ...input, cursor: "broken" }, context)).rejects.toMatchObject(invalidCursor);
      await expect(tool.execute({ ...input, cursor, query: "roll" }, context)).rejects.toMatchObject(invalidCursor);
      await expect(tool.execute({ ...input, cursor, pageSize: 2 }, context)).rejects.toMatchObject(invalidCursor);
      await expect(tool.execute({ ...input, cursor }, caller(foreign))).rejects.toMatchObject(invalidCursor);
      await expect(tool.execute({ ...input, cursor }, caller(scope, 2))).rejects.toMatchObject(invalidCursor);
    } finally {
      database.close();
    }
  });
});
