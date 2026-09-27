import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeCliEnvironment } from "../../src/server/backends/opencode/opencode-cli-environment.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import type { AgentToolCliAvailability } from "../../src/server/backends/module.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture(availability: AgentToolCliAvailability = { availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/fixture/bin", inheritedPath: "/bin" }) {
  const f = createOpenCodeConversationFixture(); closes.push(f.dispose);
  f.database.exec(`CREATE TABLE conversation_creation_attempts (tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,
    backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,mutation_id TEXT,phase TEXT,
    backend_creation_correlation TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,
    source_kind TEXT,source_automation_id TEXT,source_automation_run_id TEXT,creation_kind TEXT,force_reset_at INTEGER)`);
  const issue = vi.fn(() => "exact-thread-reference");
  const policy = { enabled: true, presentation: { surface: "cli" as "cli" | "native", mode: "progressive" as "progressive" | "individual" },
    accessBoundary: "thread" as const, enabledToolIds: ["agent.context"] };
  const cli = new OpenCodeCliEnvironment({ availability, sourceCapabilities: { issue }, tools: { readPolicy: () => policy } });
  const seed = () => {
    f.context.settings.updateDesired(scope, threadID, { desired: { providerID: "provider", id: "model" }, expectedRevision: 0, now: 1 });
    f.context.settings.captureOperation(scope, { applicationThreadId: threadID, applicationOperationId: "creation", operationKind: "create", expectedRevision: 1, now: 1 });
    f.repository.reserveOperation(scope, { applicationThreadId: threadID, applicationOperationId: "creation", operationKind: "create",
      nativeSessionId: f.target.binding.backendConversationId, nativeInputId: null, connectionProfileId: f.context.connection.id,
      executionEnvironmentId: f.context.connection.executionEnvironmentId, requestFingerprint: "a".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, 1);
    f.repository.markDispatched(scope, threadID, "creation", "create", 2);
    f.repository.recordOutcome(scope, threadID, "creation", "create", { expected: "dispatched", disposition: "accepted", nativeEvidenceFingerprint: "b".repeat(64), now: 3 });
    f.database.prepare(`INSERT INTO conversation_creation_attempts VALUES (?,?,?,?,?,?,?,'bound',?,?,?,'composer',NULL,NULL,'first_input',NULL)`)
      .run(scope.tenantId, scope.principalId, threadID, f.context.instance.id, f.context.connection.id, f.context.connection.executionEnvironmentId,
        "creation", f.target.binding.backendConversationId, f.target.binding.backendConversationId, f.target.opaqueBindingDetail);
  };
  return { ...f, cli, issue, policy, seed };
}
describe("OpenCode CLI source admission and reusable creation provenance", () => {
  it("does not issue CLI authority for an imported root; Native/Progressive needs no thread shell credential", () => {
    const f = fixture();
    expect(f.repository.hasCreatedRoot(scope, threadID, f.target.binding.backendConversationId)).toBe(false);
    expect(() => f.cli.plan(f.context, f.target)).toThrow(); expect(f.issue).not.toHaveBeenCalled();
    f.policy.presentation.surface = "native";
    expect(f.cli.plan(f.context, f.target)).toBeUndefined(); expect(f.issue).not.toHaveBeenCalled();
  });
  it("issues only a CLI audience for exact accepted created-root authority", () => {
    const f = fixture(); f.seed();
    expect(f.repository.hasCreatedRoot(scope, threadID, f.target.binding.backendConversationId)).toBe(true);
    const plan = f.cli.plan(f.context, f.target)!;
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.cli.materialize(plan)).toEqual({ SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "exact-thread-reference", SEDES_AGENT_TOOL_CLI_MODE: "progressive" });
    expect(f.issue).toHaveBeenCalledWith({ scope, sourceThreadId: threadID, sourceWorkspaceId: f.target.workspace.summary.id,
      sourceEnvironmentId: f.context.connection.executionEnvironmentId, backendKind: "opencode" }, "management_http", "cli");
  });
  it.each(["reset", "attempt_target", "attempt_source", "attempt_detail", "snapshot", "receipt_namespace"])("rejects changed %s creation proof", mutation => {
    const f = fixture(); f.seed();
    if (mutation === "reset") f.database.exec("UPDATE conversation_creation_attempts SET force_reset_at=1");
    if (mutation === "attempt_target") f.database.exec("UPDATE conversation_creation_attempts SET connection_profile_id='foreign'");
    if (mutation === "attempt_source") f.database.exec("UPDATE conversation_creation_attempts SET source_kind='automation',source_automation_id='automation',source_automation_run_id='run'");
    if (mutation === "attempt_detail") f.database.exec("UPDATE conversation_creation_attempts SET provisional_opaque_binding_detail='{}'");
    if (mutation === "snapshot") f.database.exec("DELETE FROM opencode_operation_settings_snapshots");
    if (mutation === "receipt_namespace") f.database.exec("UPDATE opencode_operation_receipts SET native_namespace_key='foreign'");
    expect(f.repository.hasCreatedRoot(scope, threadID, f.target.binding.backendConversationId)).toBe(false);
    expect(() => f.cli.plan(f.context, f.target)).toThrow(); expect(f.issue).not.toHaveBeenCalled();
  });
  it("rejects wrong scope or session and does not use a managed remote CLI provider", () => {
    const acquire = vi.fn(); const f = fixture({ availability: "managed", provider: { acquire } }); f.seed();
    expect(() => f.repository.hasCreatedRoot({ ...scope, principalId: "foreign" }, threadID, f.target.binding.backendConversationId)).toThrow();
    expect(f.repository.hasCreatedRoot(scope, threadID, "ses_foreign")).toBe(false);
    expect(() => f.cli.plan(f.context, f.target)).toThrow(); expect(acquire).not.toHaveBeenCalled(); expect(f.issue).not.toHaveBeenCalled();
  });
});
