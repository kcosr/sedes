import { describe, expect, it, vi } from "vitest";
import { DatabaseThreadApplicationRecoveryReader } from "../../src/server/conversations/database-conversation-adapters.js";
import type { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import type { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import type { ConversationLifecycleTargetResolver } from "../../src/server/conversations/conversation-lifecycle-service.js";
import type { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { formatThreadReferenceText, THREAD_REFERENCE_HEADER } from "../../src/shared/thread-references.js";

const references = [{ threadId: "616946aa-4574-41f7-bd70-d3a9edd56dbd", title: "Related thread" }];

describe("first-input recovery previews", () => {
  it.each([
    { body: "Summarize this work", expected: "Summarize this work" },
    { body: "", expected: "Referenced thread: Related thread" },
  ])("previews reference input as $expected without changing its delivery text", async ({ body, expected }) => {
    const initialInputText = formatThreadReferenceText(body, references);
    const attempt = {
      creationKind: "first_input", phase: "first_submission_started", initialInputText,
      provisionalBackendConversationId: "native-session", diagnostic: null,
      retryAnchor: null, backendCorrelation: null, acceptedAt: null,
    };
    const database = {};
    const reader = new DatabaseThreadApplicationRecoveryReader({
      creation: { database, findActiveForThread: vi.fn(() => attempt) } as unknown as ConversationCreationRepository,
      operations: { database } as unknown as ConversationOperationRepository,
      targets: {} as ConversationLifecycleTargetResolver,
      registry: {} as AgentBackendRegistry,
      forks: { readRecovery: vi.fn() },
    });
    const result = await reader.read({ tenantId: "tenant", principalId: "principal" }, "thread");
    expect(result).toMatchObject({ kind: "conversation_creation", promptPreview: { text: expected } });
    expect(result?.kind === "conversation_creation" && result.creationType === "first_input" && result.promptPreview?.text).not.toContain(THREAD_REFERENCE_HEADER);
    expect(attempt.initialInputText).toBe(initialInputText);
  });
});
