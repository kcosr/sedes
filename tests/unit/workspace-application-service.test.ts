import { describe, expect, it, vi } from "vitest";
import { WorkspaceApplicationService } from "../../src/server/application/workspace-application-service.js";
import { DomainError } from "../../src/server/domain/errors.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const agentAuthority = {
  id: "environment-grant-1",
  callerKind: "thread_agent",
  defaults: {
    kind: "thread_agent",
    environmentId: "environment-source",
    workspaceId: "workspace-source",
    threadId: "thread-source",
  },
  policyIdentity: {
    ownerKind: "thread",
    ownerId: "thread-source",
    revision: 1,
  },
  admittedEnvironmentIds: ["environment-source", "environment-a"],
  targetEnvironmentIds: ["environment-a"],
  resolvedResourceRefs: [
    {
      kind: "environment",
      id: "environment-a",
      environmentId: "environment-a",
    },
  ],
  display: { targetEnvironmentLabels: [], resourceLabels: [] },
  canonicalInputDigest: "input-digest",
  authorityDigest: "authority-digest",
} as const;

function environment(
  id: string,
  label: string,
  availability: "available" | "unavailable" = "available",
  diagnosticCode = availability === "available" ? null : "ssh_unavailable",
) {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    id,
    kind: "ssh" as const,
    label,
    availability,
    diagnosticCode,
    revision: 3,
    configurationRevision: 5,
    configurationFingerprint: "private-configuration-fingerprint",
    operationsConfigurationRevision: 7,
    operationsConfigurationFingerprint: "private-operations-fingerprint",
  };
}

function fixture(overrides?: {
  readonly getEnvironment?: ReturnType<typeof vi.fn>;
  readonly listEnvironments?: ReturnType<typeof vi.fn>;
  readonly validateWorkspace?: ReturnType<typeof vi.fn>;
  readonly upsertWorkspace?: ReturnType<typeof vi.fn>;
  readonly discoverWorkspace?: ReturnType<typeof vi.fn>;
}) {
  const getEnvironment =
    overrides?.getEnvironment ??
    vi.fn(() => environment("environment-a", "Rocky 8"));
  const listEnvironments =
    overrides?.listEnvironments ??
    vi.fn(() => [
      environment("environment-z", "Zulu", "unavailable"),
      environment("environment-b", "Alpha"),
      environment("environment-a", "Alpha"),
      environment(
        "environment-first-use",
        "First use",
        "unavailable",
        "ssh_environment_not_validated",
      ),
    ]);
  const validateWorkspace =
    overrides?.validateWorkspace ??
    vi.fn(async () => ({
      canonicalPath: "/srv/projects/sedes",
      authorityRevision: 11,
      summary: {
        id: "provider-private-workspace-id",
        environmentId: "environment-a",
        displayName: "sedes",
        displayPath: "/srv/projects/sedes",
        availability: "available" as const,
        trustState: "trusted" as const,
        revision: 0,
      },
    }));
  const upsertWorkspace =
    overrides?.upsertWorkspace ??
    vi.fn(() => ({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      environmentId: "environment-a",
      id: "workspace-a",
      canonicalPath: "/srv/projects/sedes",
      displayName: "sedes",
      availability: "available" as const,
      trustState: "trusted" as const,
      revision: 0,
      environmentConfigurationRevision: 11,
      lastOpenedAt: 123,
      createdAt: 123,
      updatedAt: 123,
    }));
  const handoffAuthoritativeReplacement = vi.fn();
  const discoverWorkspace =
    overrides?.discoverWorkspace ?? vi.fn(async () => undefined);
  return {
    service: new WorkspaceApplicationService({
      inventory: {
        getEnvironment,
        listEnvironments,
        upsertWorkspace,
      } as never,
      execution: { validateWorkspace } as never,
      publications: { handoffAuthoritativeReplacement },
      discoverWorkspace: discoverWorkspace as never,
      now: () => 123,
    }),
    getEnvironment,
    listEnvironments,
    validateWorkspace,
    upsertWorkspace,
    handoffAuthoritativeReplacement,
    discoverWorkspace,
  };
}

describe("WorkspaceApplicationService", () => {
  it("lists only bounded safe environment identity and availability in deterministic order", () => {
    const current = fixture();

    expect(current.service.listEnvironments(scope)).toEqual([
      { id: "environment-a", label: "Alpha", availability: "available" },
      { id: "environment-b", label: "Alpha", availability: "available" },
      {
        id: "environment-first-use",
        label: "First use",
        availability: "available",
      },
      { id: "environment-z", label: "Zulu", availability: "unavailable" },
    ]);
    expect(current.listEnvironments).toHaveBeenCalledWith(scope);
    expect(
      JSON.stringify(current.service.listEnvironments(scope)),
    ).not.toContain("fingerprint");
  });

  it("validates and records an existing environment path without exposing the native path", async () => {
    const current = fixture();

    await expect(
      current.service.openWorkspace(
        scope,
        {
          environmentId: "environment-a",
          path: "/srv/projects/sedes",
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      workspaceId: "workspace-a",
      environmentId: "environment-a",
      label: "sedes",
      availability: "available",
    });
    expect(current.getEnvironment).toHaveBeenCalledWith(scope, "environment-a");
    expect(current.validateWorkspace).toHaveBeenCalledWith(
      scope,
      "environment-a",
      "/srv/projects/sedes",
    );
    expect(current.upsertWorkspace).toHaveBeenCalledWith(scope, {
      restoreRemoved: true,
      environmentId: "environment-a",
      canonicalPath: "/srv/projects/sedes",
      displayName: "sedes",
      available: true,
      trustState: "trusted",
      environmentConfigurationRevision: 11,
      now: 123,
    });
    expect(current.handoffAuthoritativeReplacement).toHaveBeenCalledWith(scope);
    await vi.waitFor(() =>
      expect(current.discoverWorkspace).toHaveBeenCalledWith(
        scope,
        "workspace-a",
      ),
    );
  });

  it("requires agent environment authority before probing a workspace path", async () => {
    const denied = fixture();
    await expect(
      denied.service.openWorkspaceForAgent(
        scope,
        {
          environmentId: "environment-b",
          path: "/srv/projects/sedes",
        },
        agentAuthority,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(denied.getEnvironment).not.toHaveBeenCalled();
    expect(denied.validateWorkspace).not.toHaveBeenCalled();

    const admitted = fixture();
    await expect(
      admitted.service.openWorkspaceForAgent(
        scope,
        {
          environmentId: "environment-a",
          path: "/srv/projects/sedes",
        },
        agentAuthority,
      ),
    ).resolves.toMatchObject({ workspaceId: "workspace-a" });
    expect(admitted.validateWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps unknown environments non-enumerating and does not validate or mutate", async () => {
    const current = fixture({
      getEnvironment: vi.fn(() => {
        throw new DomainError(
          "not_found",
          "The execution environment was not found.",
        );
      }),
    });

    await expect(
      current.service.openWorkspace(scope, {
        environmentId: "foreign-environment",
        path: "/srv/projects/sedes",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(current.validateWorkspace).not.toHaveBeenCalled();
    expect(current.upsertWorkspace).not.toHaveBeenCalled();
    expect(current.handoffAuthoritativeReplacement).not.toHaveBeenCalled();
  });

  it("normalizes execution-root denial and availability failures before mutation", async () => {
    const outside = fixture({
      validateWorkspace: vi.fn(async () => {
        throw new Error("workspace_not_allowed");
      }),
    });
    await expect(
      outside.service.openWorkspace(scope, {
        environmentId: "environment-a",
        path: "/outside/project",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition", retryable: false });
    expect(outside.upsertWorkspace).not.toHaveBeenCalled();

    const unavailable = fixture({
      validateWorkspace: vi.fn(async () => {
        throw new Error("ssh_environment_unavailable");
      }),
    });
    await expect(
      unavailable.service.openWorkspace(scope, {
        environmentId: "environment-a",
        path: "/srv/projects/sedes",
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true });
    expect(unavailable.upsertWorkspace).not.toHaveBeenCalled();
  });

  it("fences cancellation and provider environment mismatches before the durable upsert", async () => {
    let finishValidation!: (value: unknown) => void;
    const validation = new Promise((resolve) => {
      finishValidation = resolve;
    });
    const cancelled = fixture({
      validateWorkspace: vi.fn(() => validation),
    });
    const controller = new AbortController();
    const opening = cancelled.service.openWorkspace(
      scope,
      { environmentId: "environment-a", path: "/srv/projects/sedes" },
      controller.signal,
    );
    controller.abort(new Error("caller_cancelled"));
    finishValidation({
      canonicalPath: "/srv/projects/sedes",
      authorityRevision: 11,
      summary: {
        environmentId: "environment-a",
        displayName: "sedes",
        availability: "available",
        trustState: "trusted",
      },
    });
    await expect(opening).rejects.toThrow("caller_cancelled");
    expect(cancelled.upsertWorkspace).not.toHaveBeenCalled();

    const mismatch = fixture({
      validateWorkspace: vi.fn(async () => ({
        canonicalPath: "/srv/projects/sedes",
        authorityRevision: 11,
        summary: {
          environmentId: "environment-b",
          displayName: "sedes",
          availability: "available",
          trustState: "trusted",
        },
      })),
    });
    await expect(
      mismatch.service.openWorkspace(scope, {
        environmentId: "environment-a",
        path: "/srv/projects/sedes",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mismatch.upsertWorkspace).not.toHaveBeenCalled();
  });

  it("does not negate a committed open when background discovery fails", async () => {
    const current = fixture({
      discoverWorkspace: vi.fn(async () => {
        throw new Error("discovery unavailable");
      }),
    });

    await expect(
      current.service.openWorkspace(scope, {
        environmentId: "environment-a",
        path: "/srv/projects/sedes",
      }),
    ).resolves.toMatchObject({ workspaceId: "workspace-a" });
    await vi.waitFor(() =>
      expect(current.discoverWorkspace).toHaveBeenCalled(),
    );
  });
});
