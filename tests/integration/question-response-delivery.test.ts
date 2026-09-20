import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QuestionRequestService } from "../../src/server/domain/question-request-service.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function fixture(version = Number.POSITIVE_INFINITY) {
  const database = openOverlayDatabase(":memory:");
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/question-requests",
      displayName: "Questions",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const threadId = legacy.createThread(
    scope,
    { workspaceId: workspace.id },
    200,
  ).thread.id;
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= version,
    ),
  );
  const inventory = new InventoryRepository(database);
  return {
    database,
    scope,
    threadId,
    inventory,
    repository: new QuestionRequestRepository(database, inventory),
  };
}

describe("question response delivery intent", () => {
  it.each([
    {
      state: "blocked active",
      settled: false,
      target: "turn-1",
      expected: "queue",
    },
    { state: "active", settled: false, target: "turn-1", expected: "steer" },
    { state: "idle", settled: true, target: null, expected: "submit" },
    {
      state: "unsupported active",
      settled: false,
      target: null,
      expected: "queue",
    },
  ])(
    "admits $state replies as $expected without changing the draft",
    async ({ state, settled, target, expected }) => {
      const { database, scope, threadId, inventory, repository } = fixture();
      new ConversationBindingRepository(database).bindDiscoveredConversation(
        scope,
        threadId,
        {
          backendConversationId: "question-session",
          now: 400,
        },
      );
      const queue = new QueuedInputRepository(database);
      if (state === "blocked active") {
        queue.enqueue(scope, threadId, {
          mutationId: "prior-answer",
          text: "Earlier queued answer",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          now: 500,
          source: {
            kind: "question_response",
            resolvedDeliveryMode: "queue",
            expectedThreadRevision: inventory.getThread(scope, threadId).thread
              .revision,
            inputOrigin: {
              kind: "question_response",
              requestId: "prior",
              sourceItemId: "prior-item",
              answers: [
                { questionIndex: 0, question: "Earlier?", answer: "Yes" },
              ],
            },
          },
        });
      }
      const withConversation = vi.fn(async (_scope, _id, operation) =>
        operation({
          authoritativelySettled: settled,
          steerTarget: async () => (target ? { kind: "turn", turnId: target } : null),
        }),
      );
      const service = new QuestionRequestService({
        repository,
        inventory,
        queue,
        gateway: { withConversation },
        dispatch: { dispatchAdmitted: vi.fn(async () => undefined) },
        publish: () => undefined,
        onOpened: () => undefined,
      });
      service.observe(scope, threadId, "sample", {
        questions: [{ title: "Which?", options: ["One", "Two"] }],
      });
      const request = service.list(scope, threadId).requests[0]!;
      const input = {
        revision: request.revision,
        answers: [{ questionIndex: 0, answer: "One" }],
      };
      await service.respond(scope, threadId, request.id, input);
      const item = queue.list(scope, threadId).at(-1)!;
      expect(item.resolvedDeliveryMode).toBe(expected);
      expect(item.resolvedSteerTarget).toEqual(
        expected === "steer" ? { kind: "turn", turnId: target } : null,
      );
      expect(item.inputOrigin?.kind).toBe("question_response");
      expect(item.requestedDraftRevision).toBeNull();
      await service.respond(scope, threadId, request.id, input);
      expect(withConversation).toHaveBeenCalledTimes(1);
      expect(queue.list(scope, threadId)).toHaveLength(
        state === "blocked active" ? 2 : 1,
      );
    },
  );
});
