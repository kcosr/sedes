import { describe, expect, it } from "vitest";
import { createModelFailureRetryPolicy } from "../../src/server/backends/model-failure-retry.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { PrincipalApplicationPreferenceRepository } from "../../src/server/db/repositories/principal-application-preference-repository.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture() {
  const current = savedAgentDatabase(125);
  const inventory = new InventoryRepository(current.database);
  const environment = inventory.getLocalEnvironment(current.scope);
  const workspace = insertPreProjectWorkspace(current.database, current.scope, {
    environmentId: environment.id, canonicalPath: "/tmp/model-retry-policy", displayName: "Retry policy",
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  const profile = current.database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(current.database);
  const bound = [0, 1].map(index => {
    const thread = bindings.createUnboundThread(current.scope, {
      workspaceId: workspace.id, connectionProfileId: profile.id, title: `Retry ${index}`, now: 120,
    });
    const binding = bindings.bindDiscoveredConversation(current.scope, thread.id, { backendConversationId: `native-${index}`, now: 130 });
    return { ...binding, createdAt: new Date(binding.createdAt).toISOString() } satisfies ConversationBinding;
  });
  applyDatabaseMigrations(current.database, backendNormalizedMigrations);
  return { ...current, bindings: bound, policy: createModelFailureRetryPolicy(current.database, bound[0]!) };
}

describe("durable model-failure retry allowance", () => {
  it("allows one attempt across reconnects and restores it only for new successful feedback", () => {
    const current = fixture();
    try {
      expect(current.policy.enabled()).toBe(true);
      expect(current.policy.claim("failed-a")).toBe(true);
      const reattached = createModelFailureRetryPolicy(current.database, current.bindings[0]!);
      expect(reattached.claim("failed-a")).toBe(false);
      expect(reattached.claim("failed-b")).toBe(false);
      reattached.reset("response-1");
      expect(reattached.claim("failed-a")).toBe(false);
      expect(reattached.claim("failed-c")).toBe(true);
      reattached.reset("response-1");
      expect(reattached.claim("failed-d")).toBe(false);
      reattached.reset("response-2");
      expect(reattached.claim("failed-e")).toBe(true);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });

  it("does not let replayed accepted input restore an exhausted allowance", () => {
    const current = fixture();
    try {
      expect(current.policy.resetForInput(4)).toBe(true);
      expect(current.policy.claim("failed-a")).toBe(true);
      expect(current.policy.resetForInput(4)).toBe(false);
      expect(current.policy.resetForInput(3)).toBe(false);
      expect(current.policy.claim("failed-b")).toBe(false);
      expect(current.policy.resetForInput(5)).toBe(true);
      expect(current.policy.claim("failed-c")).toBe(true);
    } finally { current.database.close(); }
  });

  it("keeps thread budgets independent and reads the account switch at dispatch time", () => {
    const current = fixture();
    try {
      expect(current.policy.claim("same-failure")).toBe(true);
      expect(createModelFailureRetryPolicy(current.database, current.bindings[1]!).claim("same-failure")).toBe(true);
      const preferences = new PrincipalApplicationPreferenceRepository(current.database);
      preferences.update(current.scope, { showOpenAIComposerSkills: false, autoRetryModelFailures: false, expectedRevision: 0, now: 200 });
      expect(current.policy.enabled()).toBe(false);
      current.policy.reset("response-1");
      expect(current.policy.claim("failure-while-disabled")).toBe(false);
      preferences.update(current.scope, { showOpenAIComposerSkills: false, autoRetryModelFailures: true, expectedRevision: 1, now: 210 });
      expect(current.policy.claim("failure-after-enabling")).toBe(true);
    } finally { current.database.close(); }
  });

  it("does not carry old failure identities into a replacement conversation", () => {
    const current = fixture();
    try {
      expect(current.policy.claim("native-turn-1:failed")).toBe(true);
      current.database.prepare("UPDATE conversation_bindings SET backend_conversation_id = 'replacement' WHERE application_thread_id = ?")
        .run(current.bindings[0]!.applicationThreadId);
      const replacement = createModelFailureRetryPolicy(current.database, { ...current.bindings[0]!, backendConversationId: "replacement" });
      expect(replacement.resetForInput(1)).toBe(true);
      expect(replacement.claim("native-turn-1:failed")).toBe(true);
      expect(current.policy.enabled()).toBe(false);
    } finally { current.database.close(); }
  });

  it("denies foreign scope, replaced bindings, and archived threads", () => {
    const current = fixture();
    try {
      for (const override of [{ tenantId: "foreign" }, { ownerPrincipalId: "foreign" }, { backendConversationId: "replacement" }]) {
        const foreign = createModelFailureRetryPolicy(current.database, { ...current.bindings[0]!, ...override });
        expect(foreign.enabled()).toBe(false);
        expect(foreign.claim("failure")).toBe(false);
        foreign.reset("success");
        expect(foreign.resetForInput(1)).toBe(false);
      }
      expect(current.database.prepare("SELECT count(*) AS count FROM model_failure_retry_state").get()).toEqual({ count: 0 });
      current.database.prepare("UPDATE thread_principal_state SET inventory_state = 'archived'").run();
      expect(current.policy.enabled()).toBe(false);
      expect(current.policy.claim("failure")).toBe(false);
    } finally { current.database.close(); }
  });
});
