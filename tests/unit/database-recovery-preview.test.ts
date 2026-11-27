import { describe, expect, it, vi } from "vitest";
import { DatabaseThreadApplicationRecoveryReader } from "../../src/server/conversations/database-conversation-adapters.js";
import type { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import type { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import type { ConversationLifecycleTargetResolver } from "../../src/server/conversations/conversation-lifecycle-service.js";
import type { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { formatInlineThreadReferenceText, formatThreadReferenceText, THREAD_REFERENCE_HEADER } from "../../src/shared/thread-references.js";

const references = [{ threadId: "616946aa-4574-41f7-bd70-d3a9edd56dbd", title: "Related thread" }];

describe("first-input recovery previews", () => {
  it.each([
    { initialInputText: formatThreadReferenceText("Summarize this work", references), expected: "Summarize this work" },
    { initialInputText: formatThreadReferenceText("", references), expected: "Referenced thread: Related thread" },
    { initialInputText: formatInlineThreadReferenceText(["See ", references[0]!, " here."]), expected: "See Related thread here." },
  ])("previews reference input as $expected without changing its delivery text", async ({ initialInputText, expected }) => {
    const attempt = {
      creationKind: "first_input", sourceKind: "composer", phase: "first_submission_started", initialInputText,
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

describe("permission responses during recovery", () => {
  it.each([
    { creationKind: "first_input", phase: "first_submission_started", allowed: false },
    { creationKind: "first_input", phase: "recovery_required", allowed: false },
    { creationKind: "fork", phase: "recovery_required", allowed: false },
    { creationKind: "first_input", phase: "bound", allowed: true },
    { creationKind: undefined, phase: undefined, allowed: true },
  ] as const)("keeps $creationKind/$phase recovery authoritative ahead of an uncertain Steer", async ({ creationKind, phase, allowed }) => {
    const scope = { tenantId: "tenant", principalId: "principal" };
    const database = {};
    const creation = {
      database, findActiveForThread: vi.fn(() => creationKind ? { creationKind, phase } : undefined),
    };
    const operations = {
      database,
      findUncertainThreadOperation: vi.fn(() => ({ operationKind: "conversation_steer" })),
      hasUncertainNonSteerOperation: vi.fn(() => false),
    };
    const reader = new DatabaseThreadApplicationRecoveryReader({
      creation: creation as unknown as ConversationCreationRepository,
      operations: operations as unknown as ConversationOperationRepository,
      targets: {} as ConversationLifecycleTargetResolver,
      registry: {} as AgentBackendRegistry,
      forks: { readRecovery: vi.fn() },
    });

    await expect(reader.canRespondDuringRecovery(scope, "thread")).resolves.toBe(allowed);
    expect(creation.findActiveForThread).toHaveBeenCalledWith(scope, "thread");
    if (allowed) {
      expect(operations.findUncertainThreadOperation).toHaveBeenCalledWith(scope, "thread");
      expect(operations.hasUncertainNonSteerOperation).toHaveBeenCalledWith(scope, "thread");
      operations.hasUncertainNonSteerOperation.mockReturnValue(true);
      await expect(reader.canRespondDuringRecovery(scope, "thread")).resolves.toBe(false);
    } else {
      expect(operations.findUncertainThreadOperation).not.toHaveBeenCalled();
      expect(operations.hasUncertainNonSteerOperation).not.toHaveBeenCalled();
    }
  });
});
