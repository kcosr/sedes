import { describe, expect, it, vi } from "vitest";
import { DatabaseExecutionTargetReader } from "../../src/server/application/execution-target-reader.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  BackendKind,
  ConnectionKind,
  ConversationBackendDriver,
} from "../../src/server/backends/contracts.js";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import type { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { EnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function instance(
  id: string,
  label: string,
  enabled = true,
  kind: BackendKind = "pi",
): AgentBackendInstance {
  return {
    id,
    tenantId: scope.tenantId,
    kind,
    label,
    enabled,
    configurationRevision: 0,
    protocolRelease: "0.86.0",
  };
}

function profile(
  id: string,
  templateId: string,
  backendInstanceId: string,
  label: string,
  kind: ConnectionKind = "pi_sdk",
): AgentConnectionProfile {
  return {
    id,
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    templateId,
    kind,
    backendInstanceId,
    executionEnvironmentId: "environment-1",
    label,
    enabled: true,
    configurationRevision: 0,
  };
}

function fixture(input?: {
  readonly unavailableProfileId?: string;
  readonly throwingProfileId?: string | "all";
  readonly disabledBackendId?: string;
  readonly disabledProfileId?: string;
  readonly creationUnsupportedBackendId?: string;
  readonly missingDefault?: boolean;
  readonly now?: () => number;
  readonly backendKind?: BackendKind;
  readonly connectionKind?: ConnectionKind;
  readonly environmentOperations?: ReadonlyMap<string, EnvironmentOperations>;
  readonly workspaceIsolationNetworkProfiles?: ReadonlyMap<
    string,
    readonly ("isolated" | "execution_host")[]
  >;
}) {
  const backendKind = input?.backendKind ?? "pi";
  const connectionKind = input?.connectionKind ?? "pi_sdk";
  const backends = [
    instance(
      "backend-z",
      "Zulu",
      input?.disabledBackendId !== "backend-z",
      backendKind,
    ),
    instance(
      "backend-a",
      "Alpha",
      input?.disabledBackendId !== "backend-a",
      backendKind,
    ),
  ];
  const profiles = [
    profile("profile-z", "target-z", "backend-z", "Local", connectionKind),
    profile("profile-a", "target-a", "backend-a", "Remote", connectionKind),
  ];
  const registry = new AgentBackendRegistry();
  const health = vi.fn(async (connection: AgentConnectionProfile) => {
    if (
      input?.throwingProfileId === "all" ||
      connection.id === input?.throwingProfileId
    ) {
      throw new Error("provider health failed");
    }
    return {
      available: connection.id !== input?.unavailableProfileId,
    };
  });
  for (const backend of backends) {
    const supportsConversationCreation =
      backend.id !== input?.creationUnsupportedBackendId;
    registry.register({
      scope,
      instance: backend,
      connectionKinds: [connectionKind],
      supportsConversationCreation,
      ...(supportsConversationCreation
        ? { creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY }
        : {}),
      create: (connection) =>
        ({
          instance: backend,
          connection,
          health: () => health(connection),
        }) as unknown as ConversationBackendDriver,
    });
  }
  const configuration = {
    listProfiles: vi.fn(() =>
      profiles.map((candidate) => ({
        ...candidate,
        enabled:
          candidate.id === input?.disabledProfileId
            ? (0 as const)
            : (1 as const),
      })),
    ),
    getBackend: vi.fn((_scope: RequestScope, id: string) => {
      const backend = backends.find((candidate) => candidate.id === id)!;
      return { ...backend, enabled: backend.enabled ? 1 : 0 } as const;
    }),
    getProfileByTemplate: vi.fn((_scope: RequestScope, templateId: string) => {
      if (input?.missingDefault) {
        throw new DomainError("not_found", "profile not found");
      }
      const candidate = profiles.find(
        (profile) => profile.templateId === templateId,
      );
      if (!candidate) {
        throw new DomainError("not_found", "profile not found");
      }
      return { ...candidate, enabled: 1 as const };
    }),
    getProfile: vi.fn((_scope: RequestScope, id: string) => {
      const candidate = profiles.find((profile) => profile.id === id);
      if (!candidate) {
        throw new DomainError("not_found", "profile not found");
      }
      return { ...candidate, enabled: 1 as const };
    }),
  } as unknown as BackendConfigurationRepository;
  const onHealthError = vi.fn();
  return {
    reader: new DatabaseExecutionTargetReader({
      configuration,
      registry,
      environmentOperations: input?.environmentOperations,
      workspaceIsolationNetworkProfiles:
        input?.workspaceIsolationNetworkProfiles,
      defaultTargetTemplateId: "target-z",
      now: input?.now,
      onHealthError,
    }),
    profiles,
    configuration,
    health,
    onHealthError,
  };
}

describe("execution-target catalog reader", () => {
  const workspaceOperation = {
    availability: "available" as const,
    implementation: "sidecar" as const,
    forWorkspace: vi.fn(() => {
      throw new Error(
        "passive target reads must not resolve workspace operations",
      );
    }),
  };
  const remoteOperations = {
    environmentId: "environment-1",
    environmentKind: "ssh" as const,
    environmentLabel: "Build host",
    workspaceTools: workspaceOperation,
    workspaceContext: workspaceOperation,
  } as unknown as EnvironmentOperations;

  it("shows missing runtime contributions as unavailable while retaining the catalog", async () => {
    const { reader, configuration } = fixture();
    const unavailable = new DatabaseExecutionTargetReader({
      configuration,
      registry: new AgentBackendRegistry(),
      defaultTargetTemplateId: "target-z",
    });
    const catalog = await unavailable.read(scope);
    expect(catalog.executionTargets).toHaveLength(2);
    expect(catalog.executionTargets.every(({ available }) => !available)).toBe(
      true,
    );
    expect(catalog.defaultTargetId).toBeNull();
    expect((await reader.read(scope)).defaultTargetId).toBe("profile-z");
  });

  it("changes the default and invalidates cached health after reconciliation", async () => {
    const { reader, health } = fixture();
    expect((await reader.read(scope)).defaultTargetId).toBe("profile-z");
    health.mockClear();
    await reader.read(scope);
    expect(health).not.toHaveBeenCalled();
    reader.setDefaultTargetTemplateId("target-a");
    expect((await reader.read(scope)).defaultTargetId).toBe("profile-a");
    expect(health).toHaveBeenCalledTimes(2);
    reader.setDefaultTargetTemplateId(null);
    expect((await reader.read(scope)).defaultTargetId).toBeNull();
  });

  it("does not cache a health response from a withdrawn runtime generation", async () => {
    const { reader, health } = fixture();
    let settle!: (value: { available: boolean }) => void;
    health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const pending = reader.read(scope);
    reader.invalidateHealth();
    settle({ available: true });
    expect(
      (await pending).executionTargets.find(({ id }) => id === "profile-z")
        ?.available,
    ).toBe(false);
    health.mockClear();
    await reader.read(scope);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("uses configured operations only for remote Pi static eligibility", async () => {
    const remotePi = fixture({
      environmentOperations: new Map([["environment-1", remoteOperations]]),
    });
    await expect(remotePi.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        { id: "profile-a", available: true },
        { id: "profile-z", available: true },
      ],
    });
    expect(
      remotePi.reader.environmentAvailabilityDisposition(scope, "profile-a"),
    ).toBe("active_preflight");
    expect(workspaceOperation.forWorkspace).not.toHaveBeenCalled();

    const missingOperations = fixture({
      environmentOperations: new Map([
        [
          "environment-1",
          {
            ...remoteOperations,
            workspaceContext: {
              availability: "unavailable",
              reason: "not_configured",
            },
          } as EnvironmentOperations,
        ],
      ]),
    });
    await expect(missingOperations.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        {
          id: "profile-a",
          available: false,
          unavailableReason: {
            text: "This target is not configured for remote workspace operations.",
          },
        },
        { id: "profile-z", available: false },
      ],
      defaultTargetId: null,
    });
    expect(missingOperations.health).not.toHaveBeenCalled();
  });

  it("keeps local Pi and non-consuming compiled backends on environment availability", async () => {
    const localOperations = {
      ...remoteOperations,
      environmentKind: "local" as const,
      workspaceTools: {
        ...workspaceOperation,
        implementation: "direct" as const,
      },
      workspaceContext: {
        ...workspaceOperation,
        implementation: "direct" as const,
      },
    } as unknown as EnvironmentOperations;
    const localPi = fixture({
      environmentOperations: new Map([["environment-1", localOperations]]),
    });
    expect(
      localPi.reader.environmentAvailabilityDisposition(scope, "profile-a"),
    ).toBe("requires_available_environment");

    for (const [backendKind, connectionKind] of [
      ["codex_app_server", "codex_app_server"],
      ["claude_agent_sdk", "claude_agent_sdk"],
      ["grok_build", "grok_acp"],
    ] as const) {
      const nonConsumer = fixture({
        backendKind,
        connectionKind,
        environmentOperations: new Map([["environment-1", remoteOperations]]),
      });
      await expect(nonConsumer.reader.read(scope)).resolves.toMatchObject({
        executionTargets: [
          { id: "profile-a", available: true },
          { id: "profile-z", available: true },
        ],
      });
      expect(
        nonConsumer.reader.environmentAvailabilityDisposition(
          scope,
          "profile-a",
        ),
      ).toBe("requires_available_environment");
    }
  });

  it("publishes the complete target catalog in deterministic display order with an opaque default", async () => {
    const { reader } = fixture();

    await expect(reader.read(scope)).resolves.toEqual({
      executionTargets: [
        {
          id: "profile-a",
          environmentId: "environment-1",
          label: { text: "Remote" },
          backend: { label: { text: "Alpha" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
        {
          id: "profile-z",
          environmentId: "environment-1",
          label: { text: "Local" },
          backend: { label: { text: "Zulu" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
      ],
      defaultTargetId: "profile-z",
    });
  });

  it("advertises isolated execution only for a preflighted local Pi backend", async () => {
    const localOperations = unavailableEnvironmentOperations({
      environmentId: "environment-1",
      environmentKind: "local",
      environmentLabel: "Local",
    });
    const { reader } = fixture({
      environmentOperations: new Map([["environment-1", localOperations]]),
      workspaceIsolationNetworkProfiles: new Map([["backend-a", ["isolated"]]]),
    });

    await expect(reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        {
          id: "profile-a",
          workspaceExecution: {
            kind: "selectable",
            default: { kind: "direct" },
            isolatedNetworkProfiles: ["isolated"],
          },
        },
        {
          id: "profile-z",
          workspaceExecution: { kind: "direct_only" },
        },
      ],
    });
  });

  it("advertises execution-host networking only when operator policy admits it", async () => {
    const localOperations = unavailableEnvironmentOperations({
      environmentId: "environment-1",
      environmentKind: "local",
      environmentLabel: "Local",
    });
    const { reader } = fixture({
      environmentOperations: new Map([["environment-1", localOperations]]),
      workspaceIsolationNetworkProfiles: new Map([
        ["backend-a", ["isolated", "execution_host"]],
      ]),
    });

    const result = await reader.read(scope);
    expect(
      result.executionTargets.find(({ id }) => id === "profile-a"),
    ).toMatchObject({
      workspaceExecution: {
        kind: "selectable",
        default: { kind: "direct" },
        isolatedNetworkProfiles: ["isolated", "execution_host"],
      },
    });
  });

  it("isolates health failures and rejects only an unavailable selection", async () => {
    const unhealthy = fixture({ unavailableProfileId: "profile-a" });
    await expect(unhealthy.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        {
          id: "profile-a",
          available: false,
          unavailableReason: { text: "This target is currently unavailable." },
        },
        { id: "profile-z", available: true },
      ],
    });
    await expect(
      unhealthy.reader.requireSelectable(scope, "profile-a"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      unhealthy.reader.requireAgentSelectable(scope, "profile-a"),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });

    const throwing = fixture({ throwingProfileId: "profile-a" });
    await expect(throwing.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        { id: "profile-a", available: false },
        { id: "profile-z", available: true },
      ],
    });
    await expect(
      throwing.reader.requireSelectable(scope, "profile-a"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(throwing.onHealthError).toHaveBeenCalledTimes(2);
  });

  it("publishes no default when the configured target becomes unavailable", async () => {
    const disabledDefault = fixture({ disabledBackendId: "backend-z" });
    await expect(disabledDefault.reader.read(scope)).resolves.toEqual({
      executionTargets: [
        {
          id: "profile-a",
          environmentId: "environment-1",
          label: { text: "Remote" },
          backend: { label: { text: "Alpha" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
        {
          id: "profile-z",
          environmentId: "environment-1",
          label: { text: "Local" },
          backend: { label: { text: "Zulu" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: false,
          unavailableReason: { text: "This backend is disabled." },
        },
      ],
      defaultTargetId: null,
    });

    const empty = fixture({ throwingProfileId: "all" });
    await expect(empty.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        { id: "profile-a", available: false },
        { id: "profile-z", available: false },
      ],
      defaultTargetId: null,
    });

    const missing = fixture({ missingDefault: true });
    await expect(missing.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [{ id: "profile-a" }, { id: "profile-z" }],
      defaultTargetId: null,
    });
  });

  it("retains disabled and import-only targets as unavailable", async () => {
    const current = fixture({
      creationUnsupportedBackendId: "backend-a",
    });

    await expect(current.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        {
          id: "profile-a",
          available: false,
          unavailableReason: {
            text: "This target does not support thread creation.",
          },
        },
        { id: "profile-z", available: true },
      ],
    });
    await expect(
      current.reader.requireSelectable(scope, "profile-a"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      current.reader.requireAgentSelectable(scope, "profile-a"),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(current.health).toHaveBeenCalledTimes(1);

    const disabled = fixture({ disabledProfileId: "profile-a" });
    await expect(disabled.reader.read(scope)).resolves.toMatchObject({
      executionTargets: [
        {
          id: "profile-a",
          available: false,
          unavailableReason: { text: "This target is disabled." },
        },
        { id: "profile-z", available: true },
      ],
    });
  });

  it("caches snapshot health briefly but rechecks an explicit selection", async () => {
    let now = 100;
    const current = fixture({ now: () => now });

    await current.reader.read(scope);
    await current.reader.read(scope);
    expect(current.health).toHaveBeenCalledTimes(2);

    await current.reader.requireSelectable(scope, "profile-z");
    expect(current.health).toHaveBeenCalledTimes(3);

    now = 5_101;
    await current.reader.read(scope);
    expect(current.health).toHaveBeenCalledTimes(5);
  });

  it("does not disguise unexpected repository failures as target absence", async () => {
    const current = fixture();
    vi.mocked(current.configuration.getBackend).mockImplementation(() => {
      throw new Error("database connection lost");
    });

    await expect(current.reader.read(scope)).rejects.toThrow(
      "database connection lost",
    );
  });

  it("keeps unknown agent target identifiers non-enumerating", async () => {
    const current = fixture();
    await expect(
      current.reader.requireAgentSelectable(scope, "unknown-profile"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
