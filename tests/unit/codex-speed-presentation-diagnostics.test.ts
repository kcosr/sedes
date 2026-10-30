import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { CodexThreadPresentationProvider } from "../../src/server/backends/codex/codex-thread-presentation-provider.js";
import type { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import type { CodexSpeedSession } from "../../src/server/backends/codex/codex-speed-session.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import type { ThreadBackendPresentationProvider } from "../../src/server/conversations/database-thread-application-readers.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("records actual Speed presentation transitions without changing capabilities or repeating unchanged logs", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const scope = { tenantId: randomUUID(), principalId: randomUUID() };
  const applicationThreadId = randomUUID();
  const desired = { model: "fixture", reasoningEffort: "low", serviceTier: "standard" as const,
    sandboxMode: "read-only" as const, networkAccess: "disabled" as const, approvalPolicy: "never" as const, approvalReviewer: "user" as const };
  const database = { prepare: (sql: string) => ({ get: () => sql.includes("codex_speed_publications") ? undefined : { backingState: "bound" } }) } as unknown as Database.Database;
  const settings = { database, find: () => ({ tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId,
    desired, desiredRevision: 1, effective: null, effectiveDaemonGeneration: null, effectiveConfirmationState: "unconfirmed", revision: 1 }) } as unknown as CodexThreadExecutionSettingsRepository;
  let active = false;
  let controller: CodexSpeedSession | undefined = { diagnosticHandleId: randomUUID(),
    currentRun: () => active ? { target: null, startingSelection: null, requestedSelection: null, publicationState: "unknown" } : null,
    hasActiveNativeTurn: () => active } as CodexSpeedSession;
  const policy = { revision: 1, fastEnabled: true, ultrafastEnabled: true, availability: "available" as "available" | "unavailable" };
  const provider = new CodexThreadPresentationProvider({ settings,
    executionPolicy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"],
      allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    fastModeRuntime: { controller: () => controller, projection: () => policy },
  });
  const input: Parameters<ThreadBackendPresentationProvider["read"]>[0] = {
    scope, applicationThreadId,
    backend: { id: "backend", tenantId: scope.tenantId, kind: "codex_app_server", label: "Codex", enabled: true, configurationRevision: 1, protocolRelease: "0.166.0" },
    connection: { id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
      templateId: "codex-local", kind: "codex_app_server", backendInstanceId: "backend", executionEnvironmentId: "local",
      label: "Local", enabled: true, configurationRevision: 1 },
    workspace: { authorityRevision: 0, canonicalPath: "/workspace", summary: { id: "workspace", environmentId: "local",
      displayName: "Workspace", displayPath: "/workspace", availability: "available", trustState: "trusted", revision: 0 } },
    catalog: { models: [{ provider: "connection", id: "fixture", label: "Fixture", supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low", inputModalities: ["text"],
      serviceTiers: { offered: [{ selection: "fast" }], defaultSelection: "standard" } }], commands: [], skills: [], notices: [] },
    effectiveSettings: { model: { provider: "connection", id: "fixture" }, thinkingLevel: "low" },
  };
  const logs = () => output.mock.calls.flatMap(([line]) => typeof line === "string" && line.includes('"event":"codex_speed_presentation"')
    ? [JSON.parse(line.slice("[delivery-attachment] ".length)) as Record<string, unknown>] : []);
  const read = async () => (await provider.read(input)).providerFeatureCapabilities.find(({ ref }) => ref.featureId === "codex.fast_mode");
  expect(await read()).toMatchObject({ availability: "available" });
  expect(await read()).toMatchObject({ availability: "available" });
  expect(logs()).toHaveLength(1);
  expect(logs().at(-1)).toMatchObject({ reason: "eligible", handleId: controller.diagnosticHandleId });
  active = true;
  expect(await read()).toMatchObject({ availability: "read_only" });
  expect(logs().at(-1)).toMatchObject({ reason: "current_run_unavailable" });
  controller = undefined;
  expect(await read()).toMatchObject({ availability: "read_only" });
  expect(logs().at(-1)).toMatchObject({ reason: "controller_missing" });
  controller = { diagnosticHandleId: randomUUID(), currentRun: () => null, hasActiveNativeTurn: () => false } as unknown as CodexSpeedSession;
  policy.availability = "unavailable";
  expect(await read()).toMatchObject({ availability: "read_only" });
  expect(logs().at(-1)).toMatchObject({ reason: "policy_unavailable", policyAvailability: "unavailable" });
  policy.fastEnabled = false; policy.ultrafastEnabled = false;
  expect(await read()).toBeUndefined();
  expect(logs().at(-1)).toMatchObject({ reason: "no_offered_tiers", availability: "hidden" });
});
