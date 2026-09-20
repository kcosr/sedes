import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  directThreadExecutionWorkspaceAllocator,
  SavedAgentApplicationService,
} from "../../src/server/application/saved-agent-application-service.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import type { SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import type { BackendKind } from "../../src/server/backends/contracts.js";
import {
  savedAgentBackendTypeIdSchema,
  type AgentToolBootstrapPolicy,
} from "../../src/shared/protocol/saved-agents.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const workspaceId = "10000000-0000-4000-8000-000000000001";
const environmentId = "environment-1";
const targetId = "target-1";
const backendInstanceId = "backend-1";
const backendTypeId = savedAgentBackendTypeIdSchema.parse("test-agent");

function adapter(backendKind: BackendKind): SavedAgentBackendAdapter {
  return {
    typeId: backendTypeId,
    backendKind,
    presentation: {
      typeId: backendTypeId,
      label: { text: "Test Agent" },
      brand: backendKind === "pi" ? "pi" : "codex",
    },
    overrideSchemaVersion: 1,
    validateOverrides: ({ overrides }) => ({
      backendTypeId,
      schemaVersion: 1,
      overrides,
    }),
    prepareResolutionContext: () => ({
      backendTypeId,
      schemaVersion: 1,
      value: {},
    }),
    resolve: () => ({
      backendTypeId,
      schemaVersion: 1,
      normalizedValues: [],
      value: {},
    }),
    describeEditor: () => ({
      backendTypeId,
      fields: [],
      canonicalOverrides: [],
    }),
    captureThreadConfiguration: () => {
      throw new Error("not_used");
    },
    assertThreadConfigurationCapture: () => {
      throw new Error("not_used");
    },
    initializeNewThread: () => undefined,
  };
}

function fixture(input: {
  readonly backendKind: BackendKind;
  readonly nativePresentation: boolean;
  readonly environmentKind?: "local" | "ssh";
  readonly eligibleToolIds?: ReadonlySet<string>;
}) {
  const database = new Database(":memory:");
  const profile = {
    id: targetId,
    backendInstanceId,
    executionEnvironmentId: environmentId,
    label: "Target",
    enabled: 1 as const,
    configurationRevision: 0,
    configurationFingerprint: "profile-fingerprint",
  };
  const backend = {
    id: backendInstanceId,
    kind: input.backendKind,
    enabled: 1 as const,
    configurationRevision: 0,
    configurationFingerprint: "backend-fingerprint",
  };
  const service = new SavedAgentApplicationService({
    agents: {} as never,
    repository: { database } as never,
    adapters: new SavedAgentBackendAdapterRegistry([
      { backendInstanceId, adapter: adapter(input.backendKind) },
    ]),
    configuration: {
      database,
      listProfiles: () => [profile],
      getProfile: () => profile,
      getBackend: () => backend,
    } as never,
    inventory: {
      database,
      getWorkspace: () => ({
        id: workspaceId,
        environmentId,
        revision: 0,
        environmentConfigurationRevision: 0,
      }),
      getEnvironment: () => ({ kind: input.environmentKind ?? "local" }),
    } as never,
    targets: {
      lifecycle: async () => ({
        connection: {
          ...profile,
          tenantId: scope.tenantId,
          ownerPrincipalId: scope.principalId,
          templateId: targetId,
          kind: input.backendKind === "pi" ? "pi_sdk" : "codex_app_server",
          enabled: true,
        },
        workspace: {
          canonicalPath: "/workspace",
          authorityRevision: 0,
          summary: {
            id: workspaceId,
            environmentId,
            displayName: "Workspace",
            displayPath: "/workspace",
            availability: "available" as const,
            trustState: "trusted" as const,
            revision: 0,
          },
        },
      }),
    } as never,
    targetHealth: {
      requireSelectable: async () => undefined,
      requireAgentSelectable: async () => undefined,
    } as never,
    registry: {
      driver: () => ({
        catalog: async () => ({
          models: [],
          commands: [],
          skills: [],
          notices: [],
        }),
      }),
    } as never,
    lifecycle: {} as never,
    toolPolicies: { database } as never,
    toolEligibility: {
      eligibleToolIds: input.eligibleToolIds ?? new Set(),
      presentationOptions: (_backendKind, environmentKind) =>
        input.nativePresentation
          ? environmentKind === "local"
            ? [
                { surface: "native", modes: ["progressive", "individual"] },
                { surface: "cli", modes: ["progressive", "individual"] },
              ]
            : [
                { surface: "native", modes: ["progressive", "individual"] },
              ]
          : [{ surface: "cli", modes: ["progressive", "individual"] }],
    },
    toolCatalog: { list: () => ({ groups: [] }) },
    executionWorkspaces: directThreadExecutionWorkspaceAllocator,
    publications: { handoffThreadChange: () => undefined },
  });
  return { database, service };
}

async function options(
  current: ReturnType<typeof fixture>,
  sedesTools: AgentToolBootstrapPolicy,
) {
  return current.service.options(scope, {
    workspaceId,
    targetId,
    overrides: [],
    sedesTools,
  });
}

describe("Saved Agent Sedes-tool policy resolution", () => {
  it("rejects a Sedes tool outside the canonical Saved Agent eligibility set", async () => {
    const current = fixture({ backendKind: "pi", nativePresentation: true });
    try {
      await expect(
        options(current, {
          enabled: true,
          enabledToolIds: ["not.saved-agent-eligible"],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      current.database.close();
    }
  });

  it("accepts an explicit CLI mode for a CLI-only Codex target", async () => {
    const current = fixture({
      backendKind: "codex_app_server",
      nativePresentation: false,
    });
    try {
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "cli", mode: "individual" },
          accessBoundary: "environment",
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          resolvedPolicy: {
            presentation: { surface: "cli", mode: "individual" },
          },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("allows an Agent when its configured CLI tools are unavailable in the target environment", async () => {
    const toolId = "task.list";
    const current = fixture({
      backendKind: "pi",
      nativePresentation: true,
      eligibleToolIds: new Set([toolId]),
    });
    try {
      await expect(
        options(current, {
          enabled: true,
          enabledToolIds: [toolId],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "unrestricted",
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          resolvedPolicy: {
            enabled: true,
            enabledToolIds: [toolId],
            presentation: { surface: "cli", mode: "progressive" },
            accessBoundary: "unrestricted",
          },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("advertises only native presentations and rejects CLI for an SSH Pi target", async () => {
    const current = fixture({
      backendKind: "pi",
      nativePresentation: true,
      environmentKind: "ssh",
    });
    try {
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          presentationOptions: [
            { surface: "native", modes: ["progressive", "individual"] },
          ],
          resolvedPolicy: expect.objectContaining({
            accessBoundary: "environment",
          }),
        },
      });
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      current.database.close();
    }
  });
});
