import { describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
  environmentAuthorityContinuationDigest,
  requireAdmittedEnvironment,
  requireAdmittedResource,
  type AgentToolEnvironmentAuthorityReader,
  type EnvironmentAuthorityResourceFact,
  type EnvironmentAuthorityTaskFact,
} from "../../src/server/agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";

const scope: RequestScope = {
  tenantId: "tenant-a",
  principalId: "principal-a",
};
const environments = [
  { id: "env-a", environmentId: "env-a", label: "Local" },
  { id: "env-b", environmentId: "env-b", label: "Build server" },
] as const;
const workspaces = new Map([
  [
    "workspace-a",
    { id: "workspace-a", environmentId: "env-a", label: "Alpha" },
  ],
  ["workspace-b", { id: "workspace-b", environmentId: "env-b", label: "Beta" }],
]);
const threads = new Map([
  [
    "thread-a",
    {
      id: "thread-a",
      environmentId: "env-a",
      workspaceId: "workspace-a",
      label: "Source",
    },
  ],
  [
    "thread-b",
    {
      id: "thread-b",
      environmentId: "env-b",
      workspaceId: "workspace-b",
      label: "Target",
    },
  ],
]);

const reader: AgentToolEnvironmentAuthorityReader = {
  resolveEnvironment: (_scope, id) =>
    environments.find((environment) => environment.id === id),
  resolveWorkspace: (_scope, id) => workspaces.get(id),
  resolveThread: (_scope, id) => threads.get(id),
  resolveThreadFamily: (_scope, id) =>
    id === "thread-b" ? [threads.get("thread-b")!] : undefined,
  resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: (_scope, id): EnvironmentAuthorityTaskFact | undefined =>
    id === "task-b"
      ? {
          id,
          revision: 4,
          scopeKind: "workspace",
          workspaceId: "workspace-b",
          environmentId: "env-b",
          label: "Remote task",
        }
      : undefined,
  listEnvironments: () => environments,
};

function request(id: string, input: unknown) {
  const tool = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.find(
    (entry) => entry.id === id,
  )!;
  return {
    tool,
    input,
    scope,
    defaults: {
      kind: "thread_agent" as const,
      environmentId: "env-a",
      workspaceId: "workspace-a",
      threadId: "thread-a",
    },
  };
}

const grantAuthority = {
  callerKind: "thread_agent" as const,
  defaults: {
    kind: "thread_agent" as const,
    environmentId: "env-a",
    workspaceId: "workspace-a",
    threadId: "thread-a",
  },
  policyIdentity: {
    ownerKind: "thread" as const,
    ownerId: "thread-a",
    revision: 7,
  },
};

describe("agent-tool environment authority", () => {
  it("declares an explicit disposition for the complete canonical catalog", () => {
    expect(CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES).toHaveLength(37);
    expect(
      CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.every(
        ({ environmentAuthority }) => environmentAuthority.kind.length > 0,
      ),
    ).toBe(true);
  });

  it("resolves direct resources without reading their domain contents", () => {
    const plan = new AgentToolEnvironmentAuthorityResolver(reader).resolve(
      request("thread.messages", { threadId: "thread-b", pageSize: 10 }),
    );
    expect(plan.targetEnvironmentIds).toEqual(["env-b"]);
    expect(plan.resolvedResourceRefs).toEqual([
      {
        kind: "thread",
        id: "thread-b",
        environmentId: "env-b",
        workspaceId: "workspace-b",
        label: "Target",
      },
    ]);
    expect(plan.canonicalInputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("defaults each supported direct resource to the matching source identifier", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    const resolve = (resource: "environment" | "workspace" | "thread") =>
      resolver.resolve({
        ...request("thread.status", {}),
        tool: {
          id: `example.default_${resource}`,
          schemaVersion: 1,
          environmentAuthority: {
            kind: "direct_resource" as const,
            resource,
            defaultToSource: true,
          },
        },
      });

    expect(resolve("environment").resolvedResourceRefs[0]?.id).toBe("env-a");
    expect(resolve("workspace").resolvedResourceRefs[0]?.id).toBe(
      "workspace-a",
    );
    expect(resolve("thread").resolvedResourceRefs[0]?.id).toBe("thread-a");
  });

  it("never defaults task authority to an unrelated source identifier", () => {
    expect(() =>
      new AgentToolEnvironmentAuthorityResolver(reader).resolve({
        ...request("task.get", {}),
        tool: {
          id: "example.invalid_task_default",
          schemaVersion: 1,
          environmentAuthority: {
            kind: "direct_resource",
            resource: "task",
            defaultToSource: true,
          } as never,
        },
      }),
    ).toThrow(/configured caller default/);
  });

  it("sorts and deduplicates broad target environments deterministically", () => {
    const reversedReader: AgentToolEnvironmentAuthorityReader = {
      ...reader,
      listEnvironments: () => [...environments].reverse(),
    };
    const plan = new AgentToolEnvironmentAuthorityResolver(
      reversedReader,
    ).resolve(
      request("workspace.list", {
        scope: { kind: "all_allowed_environments" },
      }),
    );
    expect(plan.targetEnvironmentIds).toEqual(["env-a", "env-b"]);
    expect(plan.resolvedResourceRefs.map(({ id }) => id)).toEqual([
      "env-a",
      "env-b",
    ]);
  });

  it("limits principal-client global task subtrees to allowed environments", () => {
    const plan = new AgentToolEnvironmentAuthorityResolver(reader).resolve({
      ...request("task.list", {
        scope: { kind: "global" },
        scopeMode: "subtree",
      }),
      defaults: {
        kind: "principal_client",
        environmentId: "env-a",
      },
      admittedEnvironmentIds: ["env-a"],
    });

    expect(plan.targetEnvironmentIds).toEqual(["env-a"]);
    expect(plan.resolvedResourceRefs).toEqual([
      {
        kind: "environment",
        id: "env-a",
        environmentId: "env-a",
        label: "Local",
      },
    ]);
  });

  it("resolves omitted task workspace and thread identifiers to the source", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(
      resolver.resolve(
        request("task.list", {
          scope: { kind: "workspace" },
          scopeMode: "exact",
        }),
      ).resolvedResourceRefs,
    ).toEqual([
      {
        kind: "workspace",
        id: "workspace-a",
        environmentId: "env-a",
        label: "Alpha",
      },
    ]);
    expect(
      resolver.resolve(
        request("task.create", {
          title: "Source thread task",
          scope: { kind: "thread" },
        }),
      ).resolvedResourceRefs,
    ).toEqual([
      {
        kind: "thread",
        id: "thread-a",
        environmentId: "env-a",
        workspaceId: "workspace-a",
        label: "Source",
      },
    ]);
    expect(
      resolver.resolve(
        request("task.update", {
          taskId: "task-b",
          expectedRevision: 4,
          scope: { kind: "workspace" },
        }),
      ).resolvedResourceRefs,
    ).toContainEqual({
      kind: "workspace",
      id: "workspace-a",
      environmentId: "env-a",
      label: "Alpha",
    });
  });

  it("keeps installation-directory and neutral commands environment empty", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(
      resolver.resolve(request("environment.list", {})).targetEnvironmentIds,
    ).toEqual([]);
    expect(
      resolver.resolve(request("saved_agent.get", { agentId: "agent-a" }))
        .targetEnvironmentIds,
    ).toEqual([]);
  });

  it("keeps descriptive saved Agent updates neutral and resolves configuration authoring context", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(
      resolver.resolve(
        request("saved_agent.update", {
          agentId: "agent-a",
          expectedRevision: 2,
          name: "Renamed",
        }),
      ).targetEnvironmentIds,
    ).toEqual([]);
    expect(
      resolver.resolve(
        request("saved_agent.update", {
          agentId: "agent-a",
          expectedRevision: 2,
          authoringContext: {
            workspaceId: "workspace-b",
            targetId: "target-b",
          },
          sedesTools: null,
        }),
      ).targetEnvironmentIds,
    ).toEqual(["env-b"]);
  });

  it("fails closed for missing and corrupt resource authority", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    let missing: unknown;
    try {
      resolver.resolve(request("thread.status", { threadId: "missing" }));
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({ code: "not_found" });
    const corrupt: AgentToolEnvironmentAuthorityReader = {
      ...reader,
      resolveThreadFamily: () => [
        threads.get("thread-a")!,
        threads.get("thread-b")!,
      ],
    };
    expect(() =>
      new AgentToolEnvironmentAuthorityResolver(corrupt).resolve(
        request("thread.archive", {
          threadId: "thread-a",
          includeDescendants: true,
        }),
      ),
    ).toThrow(/unavailable/);
  });

  it("resolves only the direct archive target unless descendants are requested", () => {
    const corrupt: AgentToolEnvironmentAuthorityReader = {
      ...reader,
      resolveThreadFamily: () => [
        threads.get("thread-a")!,
        threads.get("thread-b")!,
      ],
    };
    const resolver = new AgentToolEnvironmentAuthorityResolver(corrupt);
    expect(
      resolver.resolve(
        request("thread.archive", {
          threadId: "thread-a",
          includeDescendants: false,
        }),
      ).resolvedResourceRefs,
    ).toEqual([
      {
        kind: "thread",
        id: "thread-a",
        environmentId: "env-a",
        workspaceId: "workspace-a",
        label: "Source",
      },
    ]);
    expect(() =>
      resolver.resolve(
        request("thread.archive", {
          threadId: "thread-a",
          includeDescendants: true,
        }),
      ),
    ).toThrow(/unavailable/);
  });

  it("fails closed when an archive family crosses workspaces in one environment", () => {
    const corrupt: AgentToolEnvironmentAuthorityReader = {
      ...reader,
      resolveThreadFamily: () => [
        threads.get("thread-a")!,
        {
          id: "thread-child",
          environmentId: "env-a",
          workspaceId: "workspace-other",
          label: "Corrupt child",
        },
      ],
    };
    expect(() =>
      new AgentToolEnvironmentAuthorityResolver(corrupt).resolve(
        request("thread.archive", {
          threadId: "thread-a",
          includeDescendants: true,
        }),
      ),
    ).toThrow(/unavailable/);
  });

  it("binds family authority and grant matching to the resolved workspace", () => {
    const family = [
      threads.get("thread-a")!,
      {
        id: "thread-child",
        environmentId: "env-a",
        workspaceId: "workspace-a",
        label: "Child",
      },
    ];
    const admitted = new AgentToolEnvironmentAuthorityResolver({
      ...reader,
      resolveThreadFamily: () => family,
    }).resolve(
      request("thread.archive", {
        threadId: "thread-a",
        includeDescendants: true,
      }),
    );
    const moved = new AgentToolEnvironmentAuthorityResolver({
      ...reader,
      resolveThreadFamily: () =>
        family.map((member) => ({
          ...member,
          workspaceId: "workspace-other",
        })),
    }).resolve(
      request("thread.archive", {
        threadId: "thread-a",
        includeDescendants: true,
      }),
    );
    expect(moved.authorityDigest).not.toBe(admitted.authorityDigest);

    const grant = createTrustedEnvironmentAuthorityGrant({
      ...admitted,
      tool: { id: "thread.archive", schemaVersion: 1 },
      ...grantAuthority,
      admittedEnvironmentIds: ["env-a"],
    });
    expect(() =>
      requireAdmittedResource(grant, {
        kind: "thread_family",
        id: "thread-child",
        environmentId: "env-a",
        workspaceId: "workspace-other",
      }),
    ).toThrow(/unavailable/);
  });

  it("enforces the exact admitted environment and resource set", () => {
    const resolved = new AgentToolEnvironmentAuthorityResolver(reader).resolve(
      request("task.get", { taskId: "task-b" }),
    );
    const grant = createTrustedEnvironmentAuthorityGrant({
      ...resolved,
      tool: { id: "task.get", schemaVersion: 1 },
      ...grantAuthority,
      admittedEnvironmentIds: ["env-a", ...resolved.targetEnvironmentIds],
    });
    expect(() => requireAdmittedEnvironment(grant, "env-b")).not.toThrow();
    expect(() => requireAdmittedEnvironment(grant, "env-c")).toThrow(
      /unavailable/,
    );
    expect(() =>
      requireAdmittedResource(grant, resolved.resolvedResourceRefs[0]!),
    ).not.toThrow();
    expect(() =>
      requireAdmittedResource(grant, {
        kind: "task",
        id: "task-c",
        environmentId: "env-b",
        revision: 4,
      }),
    ).toThrow(/unavailable/);
  });

  it("binds trusted grant digests to caller, policy, admission, and input", () => {
    const resolved = new AgentToolEnvironmentAuthorityResolver(reader).resolve(
      request("task.get", { taskId: "task-b" }),
    );
    const create = (
      overrides: Partial<
        Parameters<typeof createTrustedEnvironmentAuthorityGrant>[0]
      > = {},
    ) =>
      createTrustedEnvironmentAuthorityGrant({
        ...resolved,
        tool: { id: "task.get", schemaVersion: 1 },
        ...grantAuthority,
        admittedEnvironmentIds: ["env-a", "env-b"],
        ...overrides,
      });
    const baseline = create();

    expect(
      create({
        policyIdentity: {
          ...grantAuthority.policyIdentity,
          revision: 8,
        },
      }).authorityDigest,
    ).not.toBe(baseline.authorityDigest);
    expect(
      create({ admittedEnvironmentIds: ["env-a", "env-b", "env-c"] })
        .authorityDigest,
    ).not.toBe(baseline.authorityDigest);
    expect(
      create({ canonicalInputDigest: "changed-input-digest" }).authorityDigest,
    ).not.toBe(baseline.authorityDigest);
    expect(
      create({
        callerKind: "principal_client",
        defaults: {
          kind: "principal_client",
          environmentId: "env-a",
        },
        policyIdentity: {
          ownerKind: "principal_client",
          ownerId: "client-1",
          revision: 7,
          credentialGeneration: 1,
        },
      }).authorityDigest,
    ).not.toBe(baseline.authorityDigest);
  });

  it("binds continuation digests to stable tool and authority facts only", () => {
    const resolved = new AgentToolEnvironmentAuthorityResolver(reader).resolve(
      request("task.get", { taskId: "task-b" }),
    );
    const create = (
      overrides: Partial<
        Parameters<typeof createTrustedEnvironmentAuthorityGrant>[0]
      > = {},
    ) =>
      createTrustedEnvironmentAuthorityGrant({
        ...resolved,
        tool: { id: "task.get", schemaVersion: 1 },
        ...grantAuthority,
        admittedEnvironmentIds: ["env-a", "env-b"],
        ...overrides,
      });
    const tool = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.find(
      (entry) => entry.id === "task.get",
    )!;
    const baselineGrant = create();
    const baseline = environmentAuthorityContinuationDigest(
      baselineGrant,
      tool,
    );
    const nextInvocation = create({
      canonicalInputDigest: "cursor-bearing-input-digest",
    });

    expect(nextInvocation.id).not.toBe(baselineGrant.id);
    expect(nextInvocation.authorityDigest).not.toBe(
      baselineGrant.authorityDigest,
    );
    expect(environmentAuthorityContinuationDigest(nextInvocation, tool)).toBe(
      baseline,
    );
    expect(
      environmentAuthorityContinuationDigest(
        create({ admittedEnvironmentIds: ["env-a", "env-b", "env-c"] }),
        tool,
      ),
    ).not.toBe(baseline);
    expect(
      environmentAuthorityContinuationDigest(
        create({
          policyIdentity: { ...grantAuthority.policyIdentity, revision: 8 },
        }),
        tool,
      ),
    ).not.toBe(baseline);
    expect(
      environmentAuthorityContinuationDigest(baselineGrant, {
        id: tool.id,
        schemaVersion: 2,
      }),
    ).not.toBe(baseline);
    const presentationChangedTool = {
      ...tool,
      description: "presentation metadata is not authority",
    };
    expect(
      environmentAuthorityContinuationDigest(
        baselineGrant,
        presentationChangedTool,
      ),
    ).toBe(baseline);
  });

  it("binds task transition authority to the current task revision", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    const admitted = resolver.resolve(
      request("task.update", {
        taskId: "task-b",
        expectedRevision: 4,
        scope: { kind: "workspace", workspaceId: "workspace-a" },
      }),
    );
    expect(admitted.resolvedResourceRefs).toContainEqual({
      kind: "task",
      id: "task-b",
      environmentId: "env-b",
      revision: 4,
      label: "Remote task",
    });
    const changedReader: AgentToolEnvironmentAuthorityReader = {
      ...reader,
      resolveSavedAgent: (_scope, id) => ({ id, revision: 0 }),
  resolveWorkpad: () => undefined,
  resolveTask: (_scope, id) =>
        id === "task-b"
          ? {
              ...reader.resolveTask(scope, id)!,
              revision: 5,
            }
          : undefined,
    };
    const changed = new AgentToolEnvironmentAuthorityResolver(
      changedReader,
    ).resolve(
      request("task.update", {
        taskId: "task-b",
        expectedRevision: 4,
        scope: { kind: "workspace", workspaceId: "workspace-a" },
      }),
    );
    expect(changed.authorityDigest).not.toBe(admitted.authorityDigest);

    const grant = createTrustedEnvironmentAuthorityGrant({
      ...admitted,
      tool: { id: "task.update", schemaVersion: 1 },
      ...grantAuthority,
      admittedEnvironmentIds: ["env-a", ...admitted.targetEnvironmentIds],
    });
    expect(() =>
      requireAdmittedResource(grant, {
        kind: "task",
        id: "task-b",
        environmentId: "env-b",
        revision: 5,
      }),
    ).toThrow(/unavailable/);
  });
});
