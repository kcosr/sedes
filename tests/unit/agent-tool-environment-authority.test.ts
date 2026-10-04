import { describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  AgentToolEnvironmentAuthorityResolver,
  createTrustedEnvironmentAuthorityGrant,
  currentScopedResourceRefs,
  environmentAuthorityContinuationDigest,
  grantProjectAccessCaller,
  reachesOutsideEveryEnvironment,
  requireAdmittedEnvironment,
  requireAdmittedResource,
  requireAdmittedResources,
  requireExactScopeQuery,
  scopeAuthorityRefs,
  type AgentToolEnvironmentAuthorityReader,
  type EnvironmentAuthorityProjectFact,
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

/** Member environments host an active location; a removed project is absent. */
const projects = new Map<string, EnvironmentAuthorityProjectFact>([
  ["project-a", { id: "project-a", membershipRevision: 3, memberEnvironmentIds: ["env-a"], label: "Alpha project" }],
  ["project-b", { id: "project-b", membershipRevision: 5, memberEnvironmentIds: ["env-b"], label: "Beta project" }],
  ["project-ab", { id: "project-ab", membershipRevision: 2, memberEnvironmentIds: ["env-a", "env-b"], label: "Both" }],
  ["project-bc", { id: "project-bc", membershipRevision: 4, memberEnvironmentIds: ["env-b", "env-c"], label: "Remote pair" }],
  ["project-empty", { id: "project-empty", membershipRevision: 1, memberEnvironmentIds: [], label: "Empty" }],
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
          scopeKind: "thread",
          threadId: "thread-b",
          environmentId: "env-b",
          label: "Remote task",
        }
      : id.startsWith("task-of-")
        ? {
            id,
            revision: 6,
            scopeKind: "project",
            projectId: id.slice("task-of-".length),
            label: "Project task",
          }
        : undefined,
  resolveProject: (_scope, id) => projects.get(id),
  resolveWorkspaceProject: (_scope, id) =>
    id === "workspace-a" ? "project-a" : id === "workspace-b" ? "project-b" : undefined,
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
      projectId: "project-a",
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
    projectId: "project-a",
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
    expect(CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES).toHaveLength(43);
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

  it("resolves omitted task project and thread identifiers to the source", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(
      resolver.resolve(
        request("task.list", {
          scope: { kind: "project" },
          scopeMode: "exact",
        }),
      ).resolvedResourceRefs,
    ).toEqual([
      {
        kind: "project",
        id: "project-a",
        environmentId: "env-a",
        revision: 3,
        label: "Alpha project",
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
          scope: { kind: "project" },
        }),
      ).resolvedResourceRefs,
    ).toContainEqual({
      kind: "project",
      id: "project-a",
      environmentId: "env-a",
      revision: 3,
      label: "Alpha project",
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
        schemaVersion: tool.schemaVersion + 1,
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

  it("resolves task deletion to the current task environment and revision", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    const resolved = resolver.resolve(request("task.delete", { taskId: "task-b", expectedRevision: 4 }));
    expect(resolved.targetEnvironmentIds).toEqual(["env-b"]);
    expect(resolved.resolvedResourceRefs).toContainEqual({
      kind: "task", id: "task-b", threadId: "thread-b", environmentId: "env-b", revision: 4, label: "Remote task",
    });
    expect(() => resolver.resolve(request("task.delete", { taskId: "missing", expectedRevision: 0 }))).toThrow();
  });

  it("binds task transition authority to the current task revision", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    const admitted = resolver.resolve(
      request("task.update", {
        taskId: "task-b",
        expectedRevision: 4,
        scope: { kind: "project", projectId: "project-a" },
      }),
    );
    expect(admitted.resolvedResourceRefs).toContainEqual({
      kind: "task",
      id: "task-b",
      threadId: "thread-b",
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
        scope: { kind: "project", projectId: "project-a" },
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

describe("project access", () => {
  const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
  const toolClient = (
    allowlist: readonly string[],
    defaults: { readonly environmentId?: string; readonly projectId?: string } = {},
  ) => ({
    kind: "principal_client" as const,
    environmentId: defaults.environmentId ?? "env-a",
    ...(defaults.projectId ? { projectId: defaults.projectId } : {}),
    allowlist,
  });
  const resolveFor = (
    caller: ReturnType<typeof toolClient> | "thread_agent",
    id: string,
    input: unknown,
  ) => {
    const base = request(id, input);
    if (caller === "thread_agent") return resolver.resolve(base);
    const { allowlist, ...defaults } = caller;
    return resolver.resolve({
      ...base,
      defaults,
      admittedEnvironmentIds: allowlist,
    });
  };
  const exactList = (projectId: string) => ({
    scope: { kind: "project", projectId },
    scopeMode: "exact",
  });
  const projectRef = (id: string, environmentId?: string) => ({
    kind: "project",
    id,
    revision: projects.get(id)!.membershipRevision,
    ...(environmentId ? { environmentId } : {}),
    label: projects.get(id)!.label,
  });

  it("puts a thread agent on a member environment inside the project", () => {
    for (const projectId of ["project-a", "project-ab"]) {
      const resolved = resolveFor("thread_agent", "task.list", exactList(projectId));
      expect(resolved.resolvedResourceRefs).toEqual([projectRef(projectId, "env-a")]);
      expect(resolved.targetEnvironmentIds).toEqual(["env-a"]);
      expect(reachesOutsideEveryEnvironment(resolved)).toBe(false);
    }
  });

  it("targets every member environment for a thread agent outside the project", () => {
    const resolved = resolveFor("thread_agent", "task.list", exactList("project-bc"));
    expect(resolved.resolvedResourceRefs).toEqual([
      projectRef("project-bc", "env-b"),
      projectRef("project-bc", "env-c"),
    ]);
    // The approval prompt names every member environment.
    expect(resolved.targetEnvironmentIds).toEqual(["env-b", "env-c"]);
    expect(resolved.display.targetEnvironmentLabels).toEqual(["Build server", "env-c"]);
  });

  it("marks an empty project outside every environment and denies Tool clients", () => {
    const resolved = resolveFor("thread_agent", "task.list", exactList("project-empty"));
    expect(resolved.resolvedResourceRefs).toEqual([projectRef("project-empty")]);
    expect(resolved.targetEnvironmentIds).toEqual([]);
    expect(reachesOutsideEveryEnvironment(resolved)).toBe(true);
    expect(() =>
      resolveFor(toolClient(["env-a", "env-b"]), "task.list", exactList("project-empty")),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect(
      reachesOutsideEveryEnvironment(
        resolveFor("thread_agent", "task.get", { taskId: "task-of-project-empty" }),
      ),
    ).toBe(true);
  });

  it("does not find a removed project", () => {
    for (const caller of ["thread_agent", toolClient(["env-a"])] as const) {
      expect(() => resolveFor(caller, "task.list", exactList("project-removed"))).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
      expect(() =>
        resolveFor(caller, "task.get", { taskId: "task-of-project-removed" }),
      ).toThrow(expect.objectContaining({ code: "not_found" }));
    }
  });

  it("lets a Tool client use its default environment or its lowest allowlisted member", () => {
    expect(
      resolveFor(toolClient(["env-a", "env-b"]), "task.list", exactList("project-ab"))
        .resolvedResourceRefs,
    ).toEqual([projectRef("project-ab", "env-a")]);
    // ANY: one allowlisted member suffices for an exact project query.
    expect(
      resolveFor(toolClient(["env-a", "env-c", "env-b"]), "task.list", exactList("project-bc"))
        .resolvedResourceRefs,
    ).toEqual([projectRef("project-bc", "env-b")]);
    expect(
      resolveFor(toolClient(["env-c"], { environmentId: "env-c" }), "task.list", exactList("project-bc"))
        .resolvedResourceRefs,
    ).toEqual([projectRef("project-bc", "env-c")]);
    expect(() =>
      resolveFor(toolClient(["env-a"]), "task.list", exactList("project-bc")),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
  });

  it("spans every member environment for subtree lists", () => {
    const subtree = { scope: { kind: "project", projectId: "project-ab" }, scopeMode: "subtree" };
    expect(resolveFor("thread_agent", "task.list", subtree).targetEnvironmentIds).toEqual([
      "env-a",
      "env-b",
    ]);
    expect(
      resolveFor(toolClient(["env-a"]), "workpad.list", subtree).targetEnvironmentIds,
    ).toEqual(["env-a", "env-b"]);
  });

  it("defaults to the caller's project and requires one", () => {
    expect(
      resolveFor("thread_agent", "task.create", { title: "T", scope: { kind: "project" } })
        .resolvedResourceRefs,
    ).toEqual([projectRef("project-a", "env-a")]);
    expect(() =>
      resolveFor(toolClient(["env-a"]), "task.create", { title: "T", scope: { kind: "project" } }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(
      resolveFor(toolClient(["env-a"], { projectId: "project-ab" }), "task.create", {
        title: "T",
        scope: { kind: "project" },
      }).resolvedResourceRefs,
    ).toEqual([projectRef("project-ab", "env-a")]);
  });

  it("binds a project resource to its project's membership revision", () => {
    const admitted = resolveFor("thread_agent", "task.get", { taskId: "task-of-project-ab" });
    expect(admitted.resolvedResourceRefs).toEqual([
      projectRef("project-ab", "env-a"),
      {
        kind: "task",
        id: "task-of-project-ab",
        revision: 6,
        environmentId: "env-a",
        label: "Project task",
      },
    ]);
    const grant = createTrustedEnvironmentAuthorityGrant({
      ...admitted,
      tool: { id: "task.get", schemaVersion: 2 },
      ...grantAuthority,
      admittedEnvironmentIds: ["env-a", ...admitted.targetEnvironmentIds],
    });
    const current = (membershipRevision: number): AgentToolEnvironmentAuthorityReader => ({
      ...reader,
      resolveProject: (_scope, id) =>
        id === "project-ab" ? { ...projects.get(id)!, membershipRevision } : projects.get(id),
    });
    const caller = grantProjectAccessCaller(grant);
    expect(() =>
      requireAdmittedResources(
        grant,
        currentScopedResourceRefs(current(2), scope, "task", "task-of-project-ab", caller),
      ),
    ).not.toThrow();
    // A location edit before execution changes the project's refs.
    expect(() =>
      requireAdmittedResources(
        grant,
        currentScopedResourceRefs(current(3), scope, "task", "task-of-project-ab", caller),
      ),
    ).toThrow(/unavailable/);
    const moved = new AgentToolEnvironmentAuthorityResolver(current(3)).resolve(
      request("task.get", { taskId: "task-of-project-ab" }),
    );
    expect(moved.authorityDigest).not.toBe(admitted.authorityDigest);
  });

  it("binds the caller's project into the authority digest", () => {
    const base = request("task.list", { scope: { kind: "global" }, scopeMode: "exact" });
    const first = resolver.resolve(base);
    const moved = resolver.resolve({
      ...base,
      defaults: { ...base.defaults, projectId: "project-ab" },
    });
    expect(moved.targetEnvironmentIds).toEqual(first.targetEnvironmentIds);
    expect(moved.authorityDigest).not.toBe(first.authorityDigest);
  });

  it("authorizes a project named by workspace.open as a project ref", () => {
    const resolved = resolveFor("thread_agent", "workspace.open", {
      environmentId: "env-a",
      path: "/srv/new",
      projectId: "project-b",
    });
    expect(resolved.resolvedResourceRefs).toEqual([
      { kind: "environment", id: "env-a", environmentId: "env-a", label: "Local" },
      projectRef("project-b", "env-b"),
    ]);
    // An agent on env-a needs approval to attach its directory to a project hosted only on env-b.
    expect(resolved.targetEnvironmentIds).toEqual(["env-a", "env-b"]);
    expect(() =>
      resolveFor(toolClient(["env-a"]), "workspace.open", {
        environmentId: "env-a",
        path: "/srv/new",
        projectId: "project-b",
      }),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect(
      resolveFor("thread_agent", "workspace.open", { environmentId: "env-a", path: "/srv/new" })
        .targetEnvironmentIds,
    ).toEqual(["env-a"]);
    // Restoring a location of a project with no active location reaches
    // outside every environment: thread agents ask, Tool clients are denied.
    const empty = resolveFor("thread_agent", "workspace.open", {
      environmentId: "env-a",
      path: "/srv/removed",
      projectId: "project-empty",
    });
    expect(empty.resolvedResourceRefs).toEqual([
      { kind: "environment", id: "env-a", environmentId: "env-a", label: "Local" },
      projectRef("project-empty"),
    ]);
    expect(reachesOutsideEveryEnvironment(empty)).toBe(true);
    expect(() =>
      resolveFor(toolClient(["env-a", "env-b"]), "workspace.open", {
        environmentId: "env-a",
        path: "/srv/removed",
        projectId: "project-empty",
      }),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
  });

  it("rechecks list queries against exactly the admitted environments", () => {
    const admitted = resolveFor("thread_agent", "task.list", exactList("project-ab"));
    const grant = createTrustedEnvironmentAuthorityGrant({
      ...admitted,
      tool: { id: "task.list", schemaVersion: 4 },
      ...grantAuthority,
      admittedEnvironmentIds: ["env-a"],
    });
    const caller = grantProjectAccessCaller(grant);
    expect(() =>
      requireExactScopeQuery(
        grant,
        scopeAuthorityRefs(reader, scope, { kind: "project", projectId: "project-ab" }, caller, "exact"),
      ),
    ).not.toThrow();
    expect(() =>
      requireExactScopeQuery(
        grant,
        scopeAuthorityRefs(reader, scope, { kind: "project", projectId: "project-ab" }, caller, "subtree"),
      ),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() =>
      requireExactScopeQuery(
        grant,
        scopeAuthorityRefs(reader, scope, { kind: "project", projectId: "project-a" }, caller, "exact"),
      ),
    ).toThrow(/unavailable/);
  });
});
