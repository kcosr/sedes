import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import { TurnReplySpeechService } from "../../src/server/domain/turn-reply-speech-service.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";
import type { ClassifiedAssistantResult } from "../../src/shared/protocol/completion-result.js";
import type { NotificationAssistantResultPhase } from "../../src/shared/protocol/notification.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
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
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

/** Two owned threads and a second principal in the same tenant, migrated through `latestMigration`. */
function fixture(latestMigration = Number.POSITIVE_INFINITY) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp",
      displayName: "Temporary workspace",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const thread = (title: string, at: number) =>
    legacy.createThread(scope, { workspaceId: workspace.id, title }, at).thread.id;
  const threadId = thread("Replay", 200);
  const otherThreadId = thread("Other", 201);
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter((migration) => migration.version <= latestMigration),
  );
  importLegacyDatabaseConfigurationFixture(
    database,
    { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "turn-reply-speech" },
    400,
  );
  const foreign: RequestScope = { tenantId: scope.tenantId, principalId: randomUUID() };
  database
    .prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', ?)")
    .run(foreign.tenantId, foreign.principalId, 400);
  const completions = new SubmissionCompletionRepository(database);
  const notifications = new NotificationService({ repository: new NotificationRepository(database) });
  return {
    database,
    scope,
    foreign,
    threadId,
    otherThreadId,
    completions,
    notifications,
    replies: new TurnReplySpeechService({
      inventory: new InventoryRepository(database),
      completions,
      notifications,
    }),
  };
}

type Fixture = ReturnType<typeof fixture>;

/** Records one accepted operation and finalizes it as part of `turnId`, as authoritative completion does. */
function observe(
  current: Fixture,
  input: {
    readonly threadId?: string;
    readonly acceptedAt: number;
    readonly turnId?: string;
    readonly classifiedResult?: ClassifiedAssistantResult | null;
    readonly result?: string;
  },
): string {
  const threadId = input.threadId ?? current.threadId;
  const operationId = randomUUID();
  current.completions.recordAccepted(current.scope, threadId, {
    operationId,
    acceptedAt: input.acceptedAt,
    backendCorrelation: operationId,
  });
  if (input.turnId !== undefined) {
    current.completions.observeCompletion(current.scope, threadId, operationId, {
      completionIdentity: `completion-${operationId}`,
      observedAt: input.acceptedAt + 10,
      createAttention: false,
      finalized: {
        applicationTurnId: input.turnId,
        outcome: "completed",
        result: { text: input.result ?? "Whole reply" },
        classifiedResult: input.classifiedResult ?? null,
      },
    });
  }
  return operationId;
}

const classified = (final: string): ClassifiedAssistantResult => ({
  provisional: { text: `Before ${final}` },
  final: { text: final },
  unclassified: null,
});

function selectPhases(current: Fixture, assistantResultPhases: NotificationAssistantResultPhase[]) {
  const { silenced: _silenced, revision, ...settings } = current.notifications.read(current.scope);
  current.notifications.update(current.scope, { ...settings, assistantResultPhases, expectedRevision: revision });
}

describe("turn reply speech lookup", () => {
  it("returns the latest accepted classification of a steered turn and nothing outside its scope", () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-steered", classifiedResult: classified("First") });
      observe(current, { acceptedAt: 2_000, turnId: "turn-steered", classifiedResult: classified("Steered") });
      // A later observation without a classification, and one not yet finalized, never win.
      observe(current, { acceptedAt: 3_000, turnId: "turn-steered", classifiedResult: null });
      observe(current, { acceptedAt: 4_000 });
      observe(current, { acceptedAt: 5_000, turnId: "turn-legacy", classifiedResult: null });

      expect(current.completions.latestClassifiedResult(current.scope, current.threadId, "turn-steered"))
        .toEqual(classified("Steered"));
      expect(current.completions.latestClassifiedResult(current.scope, current.threadId, "turn-legacy")).toBeNull();
      expect(current.completions.latestClassifiedResult(current.scope, current.threadId, "turn-missing")).toBeNull();
      expect(current.completions.latestClassifiedResult(current.scope, current.otherThreadId, "turn-steered")).toBeNull();
      expect(current.completions.latestClassifiedResult(current.foreign, current.threadId, "turn-steered")).toBeNull();
      expect(current.completions.latestClassifiedResult(
        { tenantId: randomUUID(), principalId: current.scope.principalId }, current.threadId, "turn-steered",
      )).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("returns the latest accepted whole reply of a turn, classified or not, and nothing outside its scope", () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-steered", result: "First", classifiedResult: classified("First") });
      observe(current, { acceptedAt: 2_000, turnId: "turn-steered", result: "Steered" });
      observe(current, { acceptedAt: 3_000 });

      expect(current.completions.latestAssistantResult(current.scope, current.threadId, "turn-steered"))
        .toEqual({ text: "Steered" });
      expect(current.completions.latestAssistantResult(current.scope, current.threadId, "turn-missing")).toBeNull();
      expect(current.completions.latestAssistantResult(current.scope, current.otherThreadId, "turn-steered")).toBeNull();
      expect(current.completions.latestAssistantResult(current.foreign, current.threadId, "turn-steered")).toBeNull();
      expect(current.completions.latestAssistantResult(
        { tenantId: randomUUID(), principalId: current.scope.principalId }, current.threadId, "turn-steered",
      )).toBeNull();
    } finally {
      current.database.close();
    }
  });

  it("reports a corrupt stored classification as a conflict", () => {
    const current = fixture();
    try {
      const operationId = observe(current, { acceptedAt: 1_000, turnId: "turn-corrupt", classifiedResult: classified("Done") });
      current.database
        .prepare("UPDATE submission_completion_observations SET classified_result_json = ? WHERE operation_id = ?")
        .run(JSON.stringify({ final: { text: 1 } }), operationId);
      expect(() => current.completions.latestClassifiedResult(current.scope, current.threadId, "turn-corrupt"))
        .toThrow(expect.objectContaining({ code: "conflict", message: "The stored completion classification is invalid." }));
    } finally {
      current.database.close();
    }
  });

  it("serves both lookups from the turn index added by migration 137", () => {
    const lookups = ["classified_result_json", "assistant_result_json"].map((column) => `EXPLAIN QUERY PLAN
      SELECT ${column} FROM submission_completion_observations
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_turn_id = ?
        AND ${column} IS NOT NULL
      ORDER BY accepted_at DESC, operation_id DESC
      LIMIT 1`);
    const indexes = (current: Fixture) => (current.database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'submission_completion_observations'")
      .all() as { name: string }[]).map(({ name }) => name);
    const before = fixture(136);
    try {
      expect(indexes(before)).not.toContain("submission_completion_turn");
      applyDatabaseMigrations(before.database, backendNormalizedMigrations);
      expect(indexes(before)).toContain("submission_completion_turn");
    } finally {
      before.database.close();
    }
    const current = fixture();
    try {
      for (const lookup of lookups) {
        const plan = (current.database.prepare(lookup).all("t", "p", "thread", "turn") as { detail: string }[])
          .map(({ detail }) => detail)
          .join("\n");
        expect(plan).toContain("USING INDEX submission_completion_turn");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    } finally {
      current.database.close();
    }
  });
});

describe("turn reply speech service", () => {
  it("selects the stored classification by the principal's current completion phases", () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-1", classifiedResult: classified("Done") });
      // Fresh settings select Final and Unclassified; notification enablement is irrelevant.
      expect(current.notifications.read(current.scope)).toMatchObject({ enabled: false });
      expect(current.replies.read(current.scope, current.threadId, "turn-1"))
        .toEqual({ assistantResult: { final: { text: "Done" }, unclassified: null } });
      selectPhases(current, ["provisional"]);
      expect(current.replies.read(current.scope, current.threadId, "turn-1"))
        .toEqual({ assistantResult: { provisional: { text: "Before Done" } } });
      expect(current.replies.read(current.scope, current.threadId, "turn-missing")).toEqual({ assistantResult: null });
    } finally {
      current.database.close();
    }
  });

  it("falls back to the stored whole reply when the selection has no text or nothing was classified", () => {
    const current = fixture();
    try {
      const whole = { assistantResult: { unclassified: { text: "Whole reply" } } };
      observe(current, { acceptedAt: 1_000, turnId: "turn-1", classifiedResult: classified("Done") });
      observe(current, { acceptedAt: 2_000, turnId: "turn-blank", classifiedResult: { provisional: { text: "Working." }, final: { text: " \n " }, unclassified: null } });
      // Turns completed before classification existed stored only the whole reply.
      observe(current, { acceptedAt: 3_000, turnId: "turn-legacy", classifiedResult: null });
      observe(current, { acceptedAt: 4_000, turnId: "turn-silent", result: "  ", classifiedResult: { provisional: null, final: { text: "" }, unclassified: null } });
      observe(current, { acceptedAt: 5_000, turnId: "turn-silent-legacy", result: "", classifiedResult: null });

      expect(current.replies.read(current.scope, current.threadId, "turn-blank")).toEqual(whole);
      expect(current.replies.read(current.scope, current.threadId, "turn-legacy")).toEqual(whole);
      selectPhases(current, ["provisional", "final"]);
      expect(current.replies.read(current.scope, current.threadId, "turn-blank"))
        .toEqual({ assistantResult: { provisional: { text: "Working." }, final: { text: " \n " } } });
      selectPhases(current, []);
      expect(current.replies.read(current.scope, current.threadId, "turn-1")).toEqual(whole);
      // Null now means Sedes stored no reply text at all.
      for (const turnId of ["turn-silent", "turn-silent-legacy", "turn-missing"]) {
        expect(current.replies.read(current.scope, current.threadId, turnId)).toEqual({ assistantResult: null });
      }
    } finally {
      current.database.close();
    }
  });

  it("fits the selected reply beside a caller's envelope", () => {
    const current = fixture();
    try {
      const long = "é".repeat(30_000);
      observe(current, { acceptedAt: 1_000, turnId: "turn-long", result: long, classifiedResult: null });
      const envelope = { padding: "x".repeat(10_000) };
      const selected = current.replies.select(current.scope, current.threadId, "turn-long", envelope);
      expect(Buffer.byteLength(JSON.stringify({ ...envelope, assistantResult: selected }), "utf8")).toBeLessThanOrEqual(65_536);
      expect(selected).toMatchObject({ unclassified: { truncation: { truncated: true, reason: "byte_limit" } } });
      expect(current.replies.read(current.scope, current.threadId, "turn-long"))
        .toEqual({ assistantResult: { unclassified: { text: long } } });
    } finally {
      current.database.close();
    }
  });

  it("denies unknown and wrong-scope threads without a fallback", () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-1", classifiedResult: classified("Done") });
      for (const [scope, threadId] of [
        [current.foreign, current.threadId],
        [current.scope, randomUUID()],
      ] as const) {
        let error: unknown;
        try {
          current.replies.read(scope, threadId, "turn-1");
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(DomainError);
        expect(error).toMatchObject({ code: "not_found" });
      }
    } finally {
      current.database.close();
    }
  });
});
