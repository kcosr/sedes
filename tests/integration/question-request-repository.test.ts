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
const payload = {
  questions: [{ title: "Choose a color", options: ["Red", "Blue"] }],
};

describe("QuestionRequestRepository", () => {
  it("records authoritative mixed resolutions across reload without inventing historical dismissal", () => {
    const { database, scope, threadId, inventory, repository } = fixture();
    repository.remember(scope, threadId, "historical", 350);
    const request = repository.admit(scope, threadId, "mixed", { questions: [
      { title: "One?", options: null }, { title: "Two?", options: null },
    ] }, 400)!;
    expect(repository.resolveAnswers(scope, threadId, request.id, 1, [0])).toBe(true);
    expect(repository.statuses(scope, threadId, ["mixed"]).statuses[0]?.questions).toEqual([
      { index: 0, status: "answered" }, { index: 1, status: "pending" },
    ]);
    expect(repository.dismiss(scope, threadId, request.id, 1)).toBe(false);
    expect(repository.dismiss(scope, threadId, request.id, 2)).toBe(true);
    const reloaded = new QuestionRequestRepository(database, inventory);
    expect(reloaded.statuses(scope, threadId, ["mixed", "historical", "unknown"])).toEqual({
      revision: 3, statuses: [
        { sourceItemId: "historical", questions: [] },
        { sourceItemId: "mixed", questions: [
          { index: 0, status: "answered" }, { index: 1, status: "dismissed" },
        ] },
      ],
    });
    expect(() => reloaded.statuses({ ...scope, principalId: "other" }, threadId, ["mixed"])).toThrow();
    expect(() => reloaded.statuses(scope, threadId, Array(101).fill("mixed"))).toThrow();
    expect(reloaded.statuses(scope, threadId, ["a".repeat(512)]).statuses).toEqual([]);
  });

  it("migrates legacy null rows as unknown while retaining indexed pending entries", () => {
    const { database, scope, threadId, inventory, repository } = fixture(89);
    repository.remember(scope, threadId, "legacy-null", 350);
    repository.admit(scope, threadId, "legacy-pending", payload, 400);
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    const upgraded = new QuestionRequestRepository(database, inventory);
    expect(upgraded.statuses(scope, threadId, ["legacy-null", "legacy-pending"]).statuses).toEqual([
      { sourceItemId: "legacy-null", questions: [] },
      { sourceItemId: "legacy-pending", questions: [{ index: 0, status: "pending" }] },
    ]);
  });

  it("rolls resolution evidence back with failed reply admission", () => {
    const { database, scope, threadId, repository } = fixture();
    const request = repository.admit(scope, threadId, "rollback", payload, 400)!;
    expect(() => database.transaction(() => {
      repository.resolveAnswers(scope, threadId, request.id, 1, [0]);
      throw new Error("admission failed");
    })()).toThrow("admission failed");
    expect(repository.statuses(scope, threadId, ["rollback"])).toEqual({ revision: 1,
      statuses: [{ sourceItemId: "rollback", questions: [{ index: 0, status: "pending" }] }],
    });
  });

  it("keeps same-timestamp requests in admission order", () => {
    const { database, scope, threadId, repository } = fixture();
    const first = repository.admit(scope, threadId, "first", payload, 400)!;
    const second = repository.admit(scope, threadId, "second", payload, 400)!;
    const third = repository.admit(scope, threadId, "third", payload, 400)!;
    const rename = database.prepare(
      "UPDATE question_requests SET id = ? WHERE id = ?",
    );
    rename.run("z", first.id);
    rename.run("m", second.id);
    rename.run("a", third.id);
    expect(
      repository.list(scope, threadId).requests.map((request) => request.id),
    ).toEqual(["z", "m", "a"]);
  });

  it("resolves original question indices with revision CAS and preserves pending answers across restart", () => {
    const { database, scope, threadId, inventory, repository } = fixture();
    const request = repository.admit(
      scope,
      threadId,
      "partial",
      {
        questions: [
          { title: "First?", options: ["Yes", "No"] },
          { title: "Second?", options: null },
          { title: "Third?", options: null },
        ],
      },
      400,
    )!;
    expect(request.questions.map((question) => question.index)).toEqual([
      0, 1, 2,
    ]);
    expect(repository.resolveAnswers(scope, threadId, request.id, 1, [])).toBe(
      false,
    );
    expect(
      repository.resolveAnswers(scope, threadId, request.id, 1, [1, 1]),
    ).toBe(false);
    expect(repository.resolveAnswers(scope, threadId, request.id, 1, [3])).toBe(
      false,
    );
    expect(repository.resolveAnswers(scope, threadId, request.id, 1, [1])).toBe(
      true,
    );
    const restarted = new QuestionRequestRepository(database, inventory);
    expect(restarted.get(scope, threadId, request.id)).toMatchObject({
      revision: 2,
      questions: [
        { index: 0, title: "First?" },
        { index: 2, title: "Third?" },
      ],
    });
    expect(restarted.dismiss(scope, threadId, request.id, 1)).toBe(false);
    expect(restarted.resolveAnswers(scope, threadId, request.id, 1, [0])).toBe(
      false,
    );
    expect(() =>
      database.transaction(() => {
        expect(
          restarted.resolveAnswers(scope, threadId, request.id, 2, [0]),
        ).toBe(true);
        throw new Error("enqueue failed");
      })(),
    ).toThrow("enqueue failed");
    expect(restarted.get(scope, threadId, request.id)?.revision).toBe(2);
    expect(
      restarted.resolveAnswers(scope, threadId, request.id, 2, [0, 2]),
    ).toBe(true);
    expect(restarted.list(scope, threadId)).toEqual({
      revision: 3,
      requests: [],
    });
    expect(
      restarted.admit(scope, threadId, "partial", payload, 500),
    ).toBeUndefined();
  });

  it("migrates pending batches to original indices while preserving resolved tombstones", () => {
    const { database, scope, threadId, repository } = fixture(88);
    database
      .prepare(
        `INSERT INTO question_requests
      (tenant_id, principal_id, thread_id, id, source_item_id, created_at, payload_json)
      VALUES (?, ?, ?, 'existing', 'source', 400, ?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        JSON.stringify({
          questions: [
            { title: "First?", options: ["Yes", "No"] },
            { title: "Second?", options: null },
          ],
        }),
      );
    repository.remember(scope, threadId, "resolved", 400);
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    expect(repository.get(scope, threadId, "existing")).toMatchObject({
      revision: 1,
      questions: [
        { index: 0, title: "First?", options: ["Yes", "No"] },
        { index: 1, title: "Second?", options: null },
      ],
    });
    expect(
      repository.admit(scope, threadId, "resolved", payload, 500),
    ).toBeUndefined();
  });

  it("durably deduplicates admission and advances collection revisions only on visible changes", () => {
    const { database, scope, threadId, inventory, repository } = fixture();
    expect(repository.list(scope, threadId)).toEqual({
      revision: 0,
      requests: [],
    });
    const request = repository.admit(scope, threadId, "item-1", payload, 400)!;
    expect(request).toMatchObject({
      sourceItemId: "item-1",
      threadId,
      revision: 1,
      createdAt: new Date(400).toISOString(),
      ...payload,
    });
    const restarted = new QuestionRequestRepository(database, inventory);
    expect(
      restarted.admit(scope, threadId, "item-1", payload, 500),
    ).toBeUndefined();
    expect(restarted.list(scope, threadId)).toEqual({
      revision: 1,
      requests: [request],
    });
    expect(restarted.dismiss(scope, threadId, request.id, 2)).toBe(false);
    expect(restarted.dismiss(scope, threadId, request.id, 1)).toBe(true);
    expect(restarted.dismiss(scope, threadId, request.id, 1)).toBe(false);
    expect(restarted.get(scope, threadId, request.id)).toBeUndefined();
    expect(
      restarted.admit(scope, threadId, "item-1", payload, 600),
    ).toBeUndefined();
    expect(restarted.list(scope, threadId)).toEqual({
      revision: 2,
      requests: [],
    });
    expect(
      database.prepare("SELECT payload_json FROM question_requests").get(),
    ).toEqual({ payload_json: null });
  });

  it("rejects malformed payloads durably without retaining their text", () => {
    const { database, scope, threadId, repository } = fixture();
    expect(
      repository.admit(scope, threadId, "invalid", { questions: [] }, 400),
    ).toBeUndefined();
    expect(
      repository.admit(scope, threadId, "invalid", payload, 500),
    ).toBeUndefined();
    expect(repository.list(scope, threadId)).toEqual({
      revision: 0,
      requests: [],
    });
    expect(
      database.prepare("SELECT payload_json FROM question_requests").get(),
    ).toEqual({ payload_json: null });
  });

  it("remembers historical items without clearing existing pending requests", () => {
    const { scope, threadId, repository } = fixture();
    repository.remember(scope, threadId, "historical", 400);
    expect(
      repository.admit(scope, threadId, "historical", payload, 500),
    ).toBeUndefined();
    const pending = repository.admit(scope, threadId, "new", payload, 500)!;
    repository.remember(scope, threadId, "new", 600);
    expect(repository.list(scope, threadId)).toEqual({
      revision: 1,
      requests: [pending],
    });
  });

  it("rolls back resolution and its revision together with an outer reply transaction", () => {
    const { database, scope, threadId, repository } = fixture();
    const request = repository.admit(scope, threadId, "item", payload, 400)!;
    expect(() =>
      database.transaction(() => {
        expect(repository.dismiss(scope, threadId, request.id, 1)).toBe(true);
        throw new Error("enqueue failed");
      })(),
    ).toThrow("enqueue failed");
    expect(repository.list(scope, threadId)).toEqual({
      revision: 1,
      requests: [request],
    });
  });

  it("denies all access in another tenant, principal, or thread", () => {
    const { scope, threadId, repository } = fixture();
    const request = repository.admit(scope, threadId, "item", payload, 400)!;
    for (const [otherScope, otherThread] of [
      [{ ...scope, tenantId: "other" }, threadId],
      [{ ...scope, principalId: "other" }, threadId],
      [scope, "other-thread"],
    ] as const) {
      for (const operation of [
        () => repository.list(otherScope, otherThread),
        () => repository.get(otherScope, otherThread, request.id),
        () => repository.admit(otherScope, otherThread, "item", payload, 500),
        () => repository.remember(otherScope, otherThread, "item", 500),
        () => repository.dismiss(otherScope, otherThread, request.id, 1),
        () => repository.dismiss(otherScope, otherThread, request.id, 1),
      ])
        expect(operation).toThrow(
          expect.objectContaining({ code: "not_found" }),
        );
    }
    expect(repository.list(scope, threadId)).toEqual({
      revision: 1,
      requests: [request],
    });
  });

  it("bounds pending payloads without evicting questions or admitting overflow after replay", () => {
    const { scope, threadId, repository } = fixture();
    for (let index = 0; index < 100; index++) {
      expect(
        repository.admit(
          scope,
          threadId,
          `item-${index}`,
          payload,
          400 + index,
        ),
      ).toBeDefined();
    }
    expect(
      repository.admit(scope, threadId, "overflow", payload, 600),
    ).toBeUndefined();
    const list = repository.list(scope, threadId);
    expect(list.requests).toHaveLength(100);
    repository.dismiss(scope, threadId, list.requests[0]!.id, 1);
    expect(
      repository.admit(scope, threadId, "overflow", payload, 700),
    ).toBeUndefined();
    expect(
      repository.admit(scope, threadId, "later", payload, 800),
    ).toBeDefined();
    expect(repository.list(scope, threadId).revision).toBe(102);
  });
});

function serviceFixture() {
  const current = fixture();
  new ConversationBindingRepository(
    current.database,
  ).bindDiscoveredConversation(current.scope, current.threadId, {
    backendConversationId: "question-session",
    now: 400,
  });
  const queue = new QueuedInputRepository(current.database);
  const dispatchAdmitted = vi.fn(async () => undefined);
  const publish = vi.fn();
  const onOpened = vi.fn();
  const withConversation = vi.fn(async () => {
    throw new Error("runtime unavailable");
  });
  const service = new QuestionRequestService({
    repository: current.repository,
    inventory: current.inventory,
    queue,
    dispatch: { dispatchAdmitted },
    gateway: { withConversation },
    publish,
    onOpened,
  });
  return { ...current, queue, dispatchAdmitted, publish, onOpened, withConversation, service };
}

describe("QuestionRequestService", () => {
  it("notifies once for new questions and never reopens historical or dismissed identities", () => {
    const { scope, threadId, service, publish, onOpened } = serviceFixture();
    service.remember(scope, threadId, "historical");
    service.observe(scope, threadId, "historical", payload);
    service.observe(scope, threadId, "new", payload);
    service.observe(scope, threadId, "new", payload);
    const request = service.list(scope, threadId).requests[0]!;
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(scope, request);
    expect(publish).toHaveBeenCalledExactlyOnceWith(scope, threadId, {
      revision: 1,
      requests: [request],
    });
    service.dismiss(scope, threadId, request.id, { revision: 1 });
    service.observe(scope, threadId, "new", payload);
    expect(service.list(scope, threadId)).toEqual({
      revision: 2,
      requests: [],
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("queues a normal reply atomically, preserves the composer, and deduplicates equal retries", async () => {
    const { scope, threadId, service, inventory, queue, dispatchAdmitted } =
      serviceFixture();
    inventory.saveDraft(scope, threadId, {
      text: "Unrelated unfinished prompt",
      expectedRevision: 0,
      now: 500,
      attachmentIds: [],
      contextExcerpts: [],
      taskReferenceIds: [],
    });
    const draft = inventory.getDraft(scope, threadId);
    service.observe(scope, threadId, "new", payload);
    const request = service.list(scope, threadId).requests[0]!;
    const response = {
      revision: 1 as const,
      answers: [{ questionIndex: 0, answer: "Blue, please" }],
    };
    expect(
      await service.respond(scope, threadId, request.id, response),
    ).toMatchObject({ revision: 2, requests: [], deliveryOperationId: `question:${request.id}:1`, queuedInput: { inputOrigin: { kind: "question_response" }, state: "pending" } });
    expect(queue.list(scope, threadId)).toHaveLength(1);
    expect(queue.list(scope, threadId)[0]).toMatchObject({
      text: "User responded to a question:\nQuestion: Choose a color\nAnswer: Blue, please",
      inputOrigin: {
        kind: "question_response",
        requestId: request.id,
        sourceItemId: "new",
        answers: [
          {
            questionIndex: 0,
            question: "Choose a color",
            answer: "Blue, please",
          },
        ],
      },
      triggerKind: "user",
      state: "pending",
    });
    expect(inventory.getDraft(scope, threadId)).toEqual(draft);
    expect(dispatchAdmitted).toHaveBeenCalledWith(scope, threadId);
    expect(
      await service.respond(scope, threadId, request.id, response),
    ).toMatchObject({ revision: 2, requests: [], deliveryOperationId: `question:${request.id}:1`, queuedInput: { inputOrigin: { kind: "question_response" }, state: "pending" } });
    expect(queue.list(scope, threadId)).toHaveLength(1);
    await expect(
      service.respond(scope, threadId, request.id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Red instead" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(queue.list(scope, threadId)).toHaveLength(1);
  });

  it("returns the original operation without a pending receipt when an accepted reply is retried", async () => {
    const { scope, threadId, service, queue } = serviceFixture();
    service.observe(scope, threadId, "receipt-replay", payload);
    const request = service.list(scope, threadId).requests[0]!;
    const response = { revision: 1, answers: [{ questionIndex: 0, answer: "Blue" }] };
    const admitted = await service.respond(scope, threadId, request.id, response);
    expect(admitted.queuedInput?.id).toBeDefined();
    const claimed = queue.claimHead(scope, threadId, "retry-anchor", Date.now())!;
    queue.markAccepted(scope, threadId, claimed.id, { expectedState: "dispatching", acceptedAt: Date.now() });
    const replay = await service.respond(scope, threadId, request.id, response);
    expect(replay).toEqual({ revision: 2, requests: [], deliveryOperationId: admitted.deliveryOperationId, queuedInput: null, deliveryState: "accepted" });
  });

  it.each([
    "missing", "stale", "missing-index", "archived", "snoozed", "unavailable",
  ] as const)("rejects %s replies before runtime acquisition", async (invalid) => {
    const {
      scope, threadId, service, inventory, queue, withConversation,
      dispatchAdmitted,
    } = serviceFixture();
    service.observe(scope, threadId, "preflight", payload);
    const request = service.list(scope, threadId).requests[0]!;
    const before = inventory.getThread(scope, threadId);
    if (invalid === "archived" || invalid === "snoozed") {
      vi.spyOn(inventory, "getThread").mockReturnValue({
        ...before,
        inventory: { ...before.inventory, inventoryState: invalid },
      });
    } else if (invalid === "unavailable") {
      vi.spyOn(inventory, "getThread").mockReturnValue({
        ...before,
        thread: { ...before.thread, availability: "environment_unavailable" },
      });
    }
    await expect(service.respond(
      scope,
      threadId,
      invalid === "missing" ? "missing" : request.id,
      {
        revision: invalid === "stale" ? 2 : 1,
        answers: [{
          questionIndex: invalid === "missing-index" ? 1 : 0,
          answer: "Blue",
        }],
      },
    )).rejects.toMatchObject({
      code: ["missing", "stale", "missing-index"].includes(invalid)
        ? "conflict" : "invalid_transition",
    });
    expect(withConversation).not.toHaveBeenCalled();
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(queue.list(scope, threadId)).toEqual([]);
    expect(service.list(scope, threadId).requests).toEqual([request]);
  });

  it("revalidates question authority after delivery planning", async () => {
    const {
      scope, threadId, service, queue, repository, withConversation,
      dispatchAdmitted,
    } = serviceFixture();
    service.observe(scope, threadId, "preflight-race", payload);
    const request = service.list(scope, threadId).requests[0]!;
    withConversation.mockImplementationOnce(async () => {
      repository.dismiss(scope, threadId, request.id, request.revision);
      throw new Error("runtime unavailable");
    });
    await expect(service.respond(scope, threadId, request.id, {
      revision: 1,
      answers: [{ questionIndex: 0, answer: "Blue" }],
    })).rejects.toMatchObject({ code: "conflict" });
    expect(withConversation).toHaveBeenCalledTimes(1);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(queue.list(scope, threadId)).toEqual([]);
  });

  it("rejects oversized assembled replies without resolving questions and accepts the exact queue byte limit", async () => {
    const { scope, threadId, service, queue, dispatchAdmitted, withConversation } =
      serviceFixture();
    const questions = Array.from({ length: 4 }, (_, index) => ({
      title: `Q${index}`,
      options: null,
    }));
    service.observe(scope, threadId, "large-batch", { questions });
    const before = service.list(scope, threadId);
    const request = before.requests[0]!;
    const answers = questions.map((_, questionIndex) => ({
      questionIndex,
      answer: "é".repeat(8192),
    }));
    await expect(
      service.respond(scope, threadId, request.id, {
        revision: request.revision,
        answers,
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "The combined reply is too large. Send fewer answers at a time.",
    });
    expect(service.list(scope, threadId)).toEqual(before);
    expect(queue.list(scope, threadId)).toEqual([]);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
    expect(withConversation).not.toHaveBeenCalled();

    const labels =
      "User responded to a question:\n" +
      questions.map(({ title }) => `Question: ${title}\nAnswer: `).join("\n\n");
    answers[3]!.answer = "a".repeat(
      65536 - Buffer.byteLength(labels, "utf8") - 3 * 16384,
    );
    await service.respond(scope, threadId, request.id, {
      revision: request.revision,
      answers,
    });
    expect(service.list(scope, threadId).requests).toEqual([]);
    expect(queue.list(scope, threadId)).toHaveLength(1);
    expect(
      Buffer.byteLength(queue.list(scope, threadId)[0]!.text, "utf8"),
    ).toBe(65536);
  });

  it("sends individual answers with stable indices and preserves unanswered siblings across restart and retries", async () => {
    const { database, scope, threadId, service, inventory, queue } =
      serviceFixture();
    service.observe(scope, threadId, "batch", {
      questions: [
        { title: "Region?", options: ["EU", "US"] },
        { title: "Anything else?", options: null },
      ],
    });
    const request = service.list(scope, threadId).requests[0]!;
    const first = {
      revision: 1,
      answers: [{ questionIndex: 0, answer: "EU" }],
    };
    await service.respond(scope, threadId, request.id, first);
    const remaining = new QuestionRequestRepository(database, inventory).get(
      scope,
      threadId,
      request.id,
    )!;
    expect(remaining).toMatchObject({
      revision: 2,
      questions: [{ index: 1, title: "Anything else?" }],
    });
    expect(remaining.questions).toHaveLength(1);
    expect(() =>
      service.dismiss(scope, threadId, request.id, { revision: 1 }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    await expect(
      service.respond(scope, threadId, request.id, {
        revision: 1,
        answers: [{ questionIndex: 1, answer: "Changed" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await service.respond(scope, threadId, request.id, first);
    expect(queue.list(scope, threadId)).toHaveLength(1);
    await expect(
      service.respond(scope, threadId, request.id, {
        revision: 2,
        answers: [{ questionIndex: 0, answer: "US" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await service.respond(scope, threadId, request.id, {
      revision: 2,
      answers: [{ questionIndex: 1, answer: "Keep logs" }],
    });
    expect(service.list(scope, threadId).requests).toEqual([]);
    expect(queue.list(scope, threadId)).toHaveLength(2);
    expect(queue.list(scope, threadId)[1]!.inputOrigin).toEqual({
      kind: "question_response",
      requestId: request.id,
      sourceItemId: "batch",
      answers: [
        { questionIndex: 1, question: "Anything else?", answer: "Keep logs" },
      ],
    });
    await service.respond(scope, threadId, request.id, first);
    expect(queue.list(scope, threadId)).toHaveLength(2);
  });

  it("rejects duplicate, missing, empty and client-authored question answers before admission", async () => {
    const { scope, threadId, service, queue } = serviceFixture();
    service.observe(scope, threadId, "batch", payload);
    const request = service.list(scope, threadId).requests[0]!;
    for (const input of [
      { revision: 1, answers: [] },
      {
        revision: 1,
        answers: [
          { questionIndex: 0, answer: "Blue" },
          { questionIndex: 0, answer: "Red" },
        ],
      },
      { revision: 1, answers: [{ questionIndex: 0, answer: " " }] },
      {
        revision: 1,
        answers: [
          { questionIndex: 0, question: "Forged title", answer: "Blue" },
        ],
      },
      { revision: 1, text: "Legacy answer" },
    ]) {
      await expect(
        service.respond(
          scope,
          threadId,
          request.id,
          input as Parameters<typeof service.respond>[3],
        ),
      ).rejects.toThrow();
    }
    expect(queue.list(scope, threadId)).toEqual([]);
    expect(service.list(scope, threadId).requests).toEqual([request]);
  });

  it("rolls back queue admission when resolution loses its compare-and-swap", async () => {
    const { scope, threadId, service, repository, queue, dispatchAdmitted } =
      serviceFixture();
    service.observe(scope, threadId, "new", payload);
    const before = service.list(scope, threadId);
    const resolution = vi
      .spyOn(repository, "resolveAnswers")
      .mockReturnValueOnce(false);
    await expect(
      service.respond(scope, threadId, before.requests[0]!.id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Blue" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    resolution.mockRestore();
    expect(queue.list(scope, threadId)).toEqual([]);
    expect(service.list(scope, threadId)).toEqual(before);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
  });

  it("denies a response or dismissal from another principal", async () => {
    const { scope, threadId, service, queue } = serviceFixture();
    service.observe(scope, threadId, "new", payload);
    const before = service.list(scope, threadId);
    const id = before.requests[0]!.id;
    const other = { ...scope, principalId: "other" };
    await expect(
      service.respond(other, threadId, id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Blue" }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(() => service.dismiss(other, threadId, id, { revision: 1 })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(service.list(scope, threadId)).toEqual(before);
    expect(queue.list(scope, threadId)).toEqual([]);
  });

  it("serializes both send-dismiss race orderings without duplicate input", async () => {
    const { scope, threadId, service, queue } = serviceFixture();
    service.observe(scope, threadId, "dismiss-first", payload);
    const dismissed = service.list(scope, threadId).requests[0]!;
    service.dismiss(scope, threadId, dismissed.id, { revision: 1 });
    await expect(
      service.respond(scope, threadId, dismissed.id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Blue" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(queue.list(scope, threadId)).toEqual([]);
    service.observe(scope, threadId, "send-first", payload);
    const sent = service.list(scope, threadId).requests[0]!;
    const sending = service.respond(scope, threadId, sent.id, {
      revision: 1,
      answers: [{ questionIndex: 0, answer: "Red" }],
    });
    await sending;
    expect(service.dismiss(scope, threadId, sent.id, { revision: 1 })).toEqual({
      revision: 4,
      requests: [],
    });
    expect(queue.list(scope, threadId)).toHaveLength(1);
    expect(queue.list(scope, threadId)[0]!.text).toBe(
      "User responded to a question:\nQuestion: Choose a color\nAnswer: Red",
    );
  });

  it("preserves pending questions when the thread cannot accept input", async () => {
    const { database, scope, threadId, service, queue, dispatchAdmitted } =
      serviceFixture();
    service.observe(scope, threadId, "new", payload);
    const before = service.list(scope, threadId);
    database
      .prepare(
        "UPDATE application_threads SET availability = 'environment_unavailable' WHERE id = ?",
      )
      .run(threadId);
    await expect(
      service.respond(scope, threadId, before.requests[0]!.id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Blue" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(service.list(scope, threadId)).toEqual(before);
    expect(queue.list(scope, threadId)).toEqual([]);
    expect(dispatchAdmitted).not.toHaveBeenCalled();
  });

  it("keeps accepted replies authoritative if dispatch or publication fails", async () => {
    const { scope, threadId, service, queue, dispatchAdmitted, publish } =
      serviceFixture();
    service.observe(scope, threadId, "new", payload);
    const request = service.list(scope, threadId).requests[0]!;
    publish.mockImplementation(() => {
      throw new Error("stream unavailable");
    });
    dispatchAdmitted.mockRejectedValueOnce(new Error("runtime unavailable"));
    expect(
      await service.respond(scope, threadId, request.id, {
        revision: 1,
        answers: [{ questionIndex: 0, answer: "Blue" }],
      }),
    ).toMatchObject({ revision: 2, requests: [], deliveryOperationId: `question:${request.id}:1`, queuedInput: { inputOrigin: { kind: "question_response" }, state: "pending" } });
    expect(queue.list(scope, threadId)).toHaveLength(1);
    expect(service.list(scope, threadId).requests).toEqual([]);
  });
});
