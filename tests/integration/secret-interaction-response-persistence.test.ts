import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendError,
  type InteractionResponseInput,
} from "../../src/server/backends/contracts.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import type {
  ConversationActorEvent,
  ConversationActorListener,
} from "../../src/server/conversations/conversation-actor.js";
import {
  InteractionBroker,
  type InteractionConversation,
} from "../../src/server/conversations/interaction-broker.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import { threadAgentToolPolicyRepository } from "../support/thread-agent-tool-policy.js";
import {
  openOverlayDatabase,
  openOverlayDatabaseConnection,
} from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const directories: string[] = [];
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class QuestionnaireConversation implements InteractionConversation {
  listener?: ConversationActorListener;

  constructor(
    readonly secret: boolean,
    readonly respondImplementation: (
      input: InteractionResponseInput,
    ) => Promise<void>,
  ) {}

  subscribe(listener: ConversationActorListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  respond(input: InteractionResponseInput): Promise<void> {
    return this.respondImplementation(input);
  }

  async interruptForInteractionFailure(): Promise<void> {
    throw new Error("questionnaire_interaction_failure_interrupt_unexpected");
  }

  open(): void {
    this.listener?.({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "interaction_opened",
        interaction: {
          backendInteractionId: "codex-questionnaire-1",
          kind: "text_input",
          sourceLabel: { text: "Codex" },
          title: { text: "Secret" },
          openedAt: "2026-07-31T00:00:00.000Z",
          secret: this.secret,
          destructive: false,
          cancellable: false,
          multiline: false,
        },
      },
    } satisfies ConversationActorEvent);
  }
}

function storedMutationReceipts(
  database: ReturnType<typeof openOverlayDatabaseConnection>,
): {
  readonly mutationId: string;
  readonly requestFingerprint: string;
  readonly resultCode: string;
  readonly resultJson: string;
}[] {
  return database
    .prepare(
      `
        SELECT mutation_id AS mutationId,
          request_fingerprint AS requestFingerprint,
          result_code AS resultCode, result_json AS resultJson
        FROM mutation_receipts
      `,
    )
    .all() as {
    readonly mutationId: string;
    readonly requestFingerprint: string;
    readonly resultCode: string;
    readonly resultJson: string;
  }[];
}

function createSubject(input: {
  readonly secret?: boolean;
  readonly respond: (response: InteractionResponseInput) => Promise<void>;
}) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "sedes-secret-response-"),
  );
  directories.push(directory);
  const databasePath = path.join(directory, "overlay.sqlite");
  const database = openOverlayDatabase(databasePath);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: directory,
      displayName: "Secret interaction persistence",
      availability: "available",
      trustState: "trusted",
    },
    1,
  );
  const threadId = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Interaction persistence" },
    2,
  ).thread.id;
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 1,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const operations = new ConversationOperationRepository(database);
  const conversation = new QuestionnaireConversation(
    input.secret ?? true,
    input.respond,
  );
  const publisher = { opened: vi.fn(), resolved: vi.fn() };
  const broker = new InteractionBroker();
  broker.bind(scope, threadId, conversation, publisher);
  conversation.open();
  const interaction = broker.listPending(scope, threadId)[0];
  if (!interaction || interaction.kind !== "text_input") {
    throw new Error("expected interaction kind was not opened");
  }
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: new InventoryRepository(database),
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: { onAuthoritativeSettled: vi.fn() } as never,
    operations,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: {
      acquire: vi.fn(async () => ({
        actor: {
          reconcileInteractionResponse: vi.fn(async () => ({
            outcome: "not_applied",
          })),
        },
        release: vi.fn(),
      })),
    } as never,
    interactions: broker,
    presentation: {} as never,
    agentToolPolicies: threadAgentToolPolicyRepository(database),
    actionPersistence: new Map(),
    publishThreadSnapshot: vi.fn(async () => undefined),
  });
  return {
    broker,
    database,
    databasePath,
    gateway,
    interaction,
    operations,
    scope,
    threadId,
  };
}

function responseFingerprint(
  threadId: string,
  interactionId: string,
  response: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "conversation_interaction_response",
        threadId,
        interactionId,
        { kind: "text_input", value: response },
      ]),
    )
    .digest("hex");
}

function derivedDigests(
  threadId: string,
  interactionId: string,
  response: string,
): string[] {
  return [
    responseFingerprint(threadId, interactionId, response),
    createHash("sha256").update(response).digest("hex"),
    createHash("sha256")
      .update(JSON.stringify({ kind: "text_input", value: response }))
      .digest("hex"),
  ];
}

function persistentStorageText(databasePath: string): {
  readonly logical: string;
  readonly raw: string;
} {
  const database = openOverlayDatabaseConnection(databasePath);
  let logical: string;
  try {
    const tables = database
      .prepare(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
      )
      .all() as { readonly name: string }[];
    const values: string[] = [];
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const rows = database.prepare(`SELECT * FROM ${quoted}`).all() as Record<
        string,
        unknown
      >[];
      values.push(name);
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          values.push(column);
          values.push(
            Buffer.isBuffer(value)
              ? value.toString("utf8")
              : JSON.stringify(value),
          );
        }
      }
    }
    logical = values.join("\n");
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  const raw = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(existsSync)
    .map((filename) => readFileSync(filename).toString("utf8"))
    .join("\n");
  return { logical, raw };
}

function expectAbsentFromPersistentStorage(
  databasePath: string,
  forbidden: readonly string[],
): void {
  const storage = persistentStorageText(databasePath);
  for (const value of forbidden) {
    expect(storage.logical).not.toContain(value);
    expect(storage.raw).not.toContain(value);
  }
}

describe("secret interaction response persistence", () => {
  it("keeps the response out of prepared, started, accepted, and reopened SQLite state", async () => {
    const secret = "123456";
    let rowsAtProviderBoundary: ReturnType<typeof storedMutationReceipts> = [];
    const subject = createSubject({
      respond: async () => {
        rowsAtProviderBoundary = storedMutationReceipts(subject.database);
      },
    });
    const digests = derivedDigests(
      subject.threadId,
      subject.interaction.id,
      secret,
    );

    await expect(
      subject.gateway.mutate(subject.scope, subject.threadId, {
        kind: "respond",
        operationId: "secret-response-success",
        interactionId: subject.interaction.id,
        response: { kind: "text_input", value: secret },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(rowsAtProviderBoundary).toEqual([]);
    expect(storedMutationReceipts(subject.database)).toEqual([]);
    await subject.broker.close();
    subject.database.close();

    expectAbsentFromPersistentStorage(subject.databasePath, [
      secret,
      ...digests,
    ]);
    const reopened = openOverlayDatabaseConnection(subject.databasePath);
    expect(
      new ConversationOperationRepository(
        reopened,
      ).listUncertainInteractionResponses(subject.scope),
    ).toEqual([]);
    reopened.close();
  });

  it("does not create recoverable state when the provider boundary is uncertain", async () => {
    const secret = "yes";
    let rowsAtProviderBoundary: ReturnType<typeof storedMutationReceipts> = [];
    const subject = createSubject({
      respond: async () => {
        rowsAtProviderBoundary = storedMutationReceipts(subject.database);
        throw new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "The secret response outcome is unknown.",
        });
      },
    });
    const digests = derivedDigests(
      subject.threadId,
      subject.interaction.id,
      secret,
    );

    await expect(
      subject.gateway.mutate(subject.scope, subject.threadId, {
        kind: "respond",
        operationId: "secret-response-unknown",
        interactionId: subject.interaction.id,
        response: { kind: "text_input", value: secret },
      }),
    ).resolves.toEqual({ status: "recovery_required", retryable: false });

    expect(rowsAtProviderBoundary).toEqual([]);
    expect(storedMutationReceipts(subject.database)).toEqual([]);
    expect(subject.broker.listPending(subject.scope, subject.threadId)).toEqual(
      [],
    );
    await subject.broker.close();
    subject.database.close();

    expectAbsentFromPersistentStorage(subject.databasePath, [
      secret,
      ...digests,
    ]);
    const reopened = openOverlayDatabaseConnection(subject.databasePath);
    expect(
      new ConversationOperationRepository(
        reopened,
      ).listUncertainInteractionResponses(subject.scope),
    ).toEqual([]);
    reopened.close();
  });

  it("detects the durable receipt and fingerprint retained for a non-secret response", async () => {
    const response = "ordinary durable response";
    const operationId = "00000000-0000-4000-8000-000000000002";
    const subject = createSubject({
      secret: false,
      respond: async (input) => {
        if (input.kind === "text_input") {
          throw new BackendError({
            category: "submission_unknown",
            retryable: false,
            crossedSubmissionBoundary: true,
            safeMessage: "The response outcome is unknown.",
          });
        }
      },
    });
    const fingerprint = responseFingerprint(
      subject.threadId,
      subject.interaction.id,
      response,
    );

    await expect(
      subject.gateway.mutate(subject.scope, subject.threadId, {
        kind: "respond",
        operationId,
        interactionId: subject.interaction.id,
        response: { kind: "text_input", value: response },
      }),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });

    expect(storedMutationReceipts(subject.database)).toEqual([
      expect.objectContaining({
        mutationId: operationId,
        requestFingerprint: fingerprint,
        resultCode: "uncertain",
        resultJson: expect.stringContaining(response),
      }),
    ]);
    await subject.broker.close();
    subject.database.close();

    const storage = persistentStorageText(subject.databasePath);
    expect(storage.logical).toContain(response);
    expect(storage.logical).toContain(fingerprint);
    expect(storage.raw).toContain(response);
    expect(storage.raw).toContain(fingerprint);
  });
});
