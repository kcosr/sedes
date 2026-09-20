import { describe, expect, it, vi } from "vitest";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  type AgentThreadWorktreeService,
  createThreadWorktreeClearToolDefinition,
  createThreadWorktreeListToolDefinition,
  createThreadWorktreeSetToolDefinition,
} from "../../src/server/agent-tools/tools/thread-worktree-tools.js";

function service(): AgentThreadWorktreeService {
  return {
    list: vi.fn(
      async (): Promise<
        Awaited<ReturnType<AgentThreadWorktreeService["list"]>>
      > => ({
        worktrees: [
          { rootId: "primary", kind: "primary", displayLabel: "sedes" },
          {
            rootId: "linked-1",
            kind: "linked_worktree",
            displayLabel: "sedes-feature",
            branch: "feature/worktrees",
            head: "0123456789abcdef",
          },
        ],
        preference: { rootId: "linked-1", revision: 3 },
      }),
    ),
    set: vi.fn(async (_scope, _context, input) => ({
      rootId: input.rootId,
      revision: input.expectedRevision + 1,
    })),
    clear: vi.fn(async (_scope, _context, input) => ({
      rootId: null,
      revision: input.expectedRevision + 1,
    })),
  };
}

function context(): TrustedToolInvocationContext {
  return {
    invocationId: "invocation-1",
    mutationId: "mutation-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    subject: {
      kind: "thread_agent",
      sourceThreadId: "thread-1",
      backendKind: "codex_app_server",
    },
    defaults: {
      kind: "thread_agent",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    },
    policyIdentity: {
      ownerKind: "thread",
      ownerId: "thread-1",
      revision: 2,
    },
    adapter: "cli",
    effectiveCapabilities: [],
    hasCapability: () => false,
    environmentAuthority: {
      id: "grant-1",
      callerKind: "thread_agent",
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: "thread-1",
        revision: 2,
      },
      admittedEnvironmentIds: ["environment-1"],
      targetEnvironmentIds: ["environment-1"],
      resolvedResourceRefs: [
        {
          kind: "thread",
          id: "thread-1",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
        },
      ],
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
    },
    requestId: "request-1",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

describe("Thread worktree agent tools", () => {
  it("registers closed source-thread-only contracts and CLI commands", () => {
    const value = service();
    const definitions = [
      createThreadWorktreeListToolDefinition(value),
      createThreadWorktreeSetToolDefinition(value),
      createThreadWorktreeClearToolDefinition(value),
    ];
    const registry = new AgentToolRegistry();
    definitions.forEach((definition) => registry.register(definition));

    expect(
      definitions.map(
        ({ id, schemaVersion, callerEligibility, environmentAuthority }) => ({
          id,
          schemaVersion,
          callerEligibility,
          environmentAuthority,
        }),
      ),
    ).toEqual([
      {
        id: "thread.worktree_list",
        schemaVersion: 1,
        callerEligibility: ["thread_agent"],
        environmentAuthority: { kind: "source_only" },
      },
      {
        id: "thread.worktree_set",
        schemaVersion: 1,
        callerEligibility: ["thread_agent"],
        environmentAuthority: { kind: "source_only" },
      },
      {
        id: "thread.worktree_clear",
        schemaVersion: 1,
        callerEligibility: ["thread_agent"],
        environmentAuthority: { kind: "source_only" },
      },
    ]);
    expect(definitions.map(({ adapters }) => adapters.cli?.command)).toEqual([
      "thread.worktree_list",
      "thread.worktree_set",
      "thread.worktree_clear",
    ]);
    expect(registry.validatesInput("thread.worktree_list", 1, {})).toBe(true);
    expect(
      registry.validatesInput("thread.worktree_set", 1, {
        rootId: "linked-1",
        expectedRevision: 3,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.worktree_set", 1, {
        rootId: "linked-1",
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.worktree_clear", 1, {
        expectedRevision: -1,
      }),
    ).toBe(false);
  });

  it("derives every target identity from the trusted source context", async () => {
    const value = service();
    const trusted = context();

    await expect(
      createThreadWorktreeListToolDefinition(value).execute({}, trusted),
    ).resolves.toMatchObject({
      preference: { rootId: "linked-1", revision: 3 },
    });
    await expect(
      createThreadWorktreeSetToolDefinition(value).execute(
        { rootId: "linked-2", expectedRevision: 3 },
        trusted,
      ),
    ).resolves.toEqual({
      preference: { rootId: "linked-2", revision: 4 },
    });
    await expect(
      createThreadWorktreeClearToolDefinition(value).execute(
        { expectedRevision: 4 },
        trusted,
      ),
    ).resolves.toEqual({ preference: { rootId: null, revision: 5 } });

    const expectedScope = { tenantId: "tenant-1", principalId: "principal-1" };
    const expectedContext = expect.objectContaining({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      environmentId: "environment-1",
      environmentAuthority: trusted.environmentAuthority,
      signal: trusted.abortSignal,
    });
    expect(value.list).toHaveBeenCalledWith(expectedScope, expectedContext);
    expect(value.set).toHaveBeenCalledWith(expectedScope, expectedContext, {
      rootId: "linked-2",
      expectedRevision: 3,
    });
    expect(value.clear).toHaveBeenCalledWith(expectedScope, expectedContext, {
      expectedRevision: 4,
    });
  });

  it("is discoverable by thread agents but absent for principal Tool clients", () => {
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      threadWorktrees: service(),
    });
    expect(
      canonical
        .catalogSummaries("cli", "thread_agent")
        .filter(({ id }) => id.startsWith("thread.worktree_"))
        .map(({ id }) => id),
    ).toEqual([
      "thread.worktree_list",
      "thread.worktree_set",
      "thread.worktree_clear",
    ]);
    expect(
      canonical
        .catalogSummaries("cli", "principal_client")
        .some(({ id }) => id.startsWith("thread.worktree_")),
    ).toBe(false);
  });

  it("rejects a caller context that is not the exact source thread", async () => {
    const trusted = context();
    const forged = {
      ...trusted,
      defaults: { ...trusted.defaults, threadId: "other-thread" },
    } as TrustedToolInvocationContext;

    await expect(
      createThreadWorktreeListToolDefinition(service()).execute({}, forged),
    ).rejects.toThrow(/agent_context_mismatch/);
  });
});
