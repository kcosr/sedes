import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { ClientControlToolService } from "../../src/server/agent-tools/tools/client-control-tools.js";
import type { ConversationInputRuntimeObservation } from "../../src/server/conversations/conversation-actor-manager.js";
import { ClientControlService } from "../../src/server/domain/client-control-service.js";
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
    readonly observedAt?: number;
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
      observedAt: input.observedAt ?? input.acceptedAt + 10,
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

  it("returns a thread's most recently completed turn with a reply, never a running one", () => {
    const current = fixture();
    try {
      expect(current.completions.latestReplyTurnId(current.scope, current.threadId)).toBeNull();
      // Completion time orders turns, whatever their acceptance order.
      observe(current, { acceptedAt: 1_000, observedAt: 9_000, turnId: "turn-late" });
      observe(current, { acceptedAt: 2_000, observedAt: 3_000, turnId: "turn-early" });
      // A running turn's accepted input has no finalized observation.
      observe(current, { acceptedAt: 10_000 });
      expect(current.completions.latestReplyTurnId(current.scope, current.threadId)).toBe("turn-late");
      // A steered turn completes all its observations together.
      observe(current, { acceptedAt: 11_000, observedAt: 20_000, turnId: "turn-steered" });
      observe(current, { acceptedAt: 12_000, observedAt: 20_000, turnId: "turn-steered" });
      expect(current.completions.latestReplyTurnId(current.scope, current.threadId)).toBe("turn-steered");
      // Equal completion times fall back to the later acceptance.
      observe(current, { acceptedAt: 14_000, observedAt: 30_000, turnId: "turn-accepted-later" });
      observe(current, { acceptedAt: 13_000, observedAt: 30_000, turnId: "turn-accepted-earlier" });
      expect(current.completions.latestReplyTurnId(current.scope, current.threadId)).toBe("turn-accepted-later");
      // A later turn that ended before producing assistant text is skipped.
      observe(current, { acceptedAt: 15_000, observedAt: 40_000, turnId: "turn-failed-empty", result: "" });
      observe(current, { acceptedAt: 16_000, observedAt: 50_000, turnId: "turn-failed-blank", result: " \n\t" });
      expect(current.completions.latestReplyTurnId(current.scope, current.threadId)).toBe("turn-accepted-later");

      expect(current.completions.latestReplyTurnId(current.scope, current.otherThreadId)).toBeNull();
      expect(current.completions.latestReplyTurnId(current.foreign, current.threadId)).toBeNull();
      expect(current.completions.latestReplyTurnId(
        { tenantId: randomUUID(), principalId: current.scope.principalId }, current.threadId,
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

  it("serves every lookup from the indexes added by migration 137", () => {
    const turnLookups = ["classified_result_json", "assistant_result_json"].map((column) => `EXPLAIN QUERY PLAN
      SELECT ${column} FROM submission_completion_observations
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ? AND application_turn_id = ?
        AND ${column} IS NOT NULL
      ORDER BY accepted_at DESC, operation_id DESC
      LIMIT 1`);
    const latestTurnLookup = `EXPLAIN QUERY PLAN
      SELECT application_turn_id FROM submission_completion_observations
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ?
        AND application_turn_id IS NOT NULL
        AND assistant_result_json IS NOT NULL
        AND trim(coalesce(json_extract(assistant_result_json, '$.text'), ''), char(32, 9, 10, 13)) <> ''
      ORDER BY completion_observed_at DESC, accepted_at DESC, operation_id DESC
      LIMIT 1`;
    const indexes = (current: Fixture) => (current.database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'submission_completion_observations'")
      .all() as { name: string }[]).map(({ name }) => name);
    const before = fixture(136);
    try {
      expect(indexes(before)).not.toContain("submission_completion_turn");
      expect(indexes(before)).not.toContain("submission_completion_latest_turn");
      applyDatabaseMigrations(before.database, backendNormalizedMigrations);
      expect(indexes(before)).toContain("submission_completion_turn");
      expect(indexes(before)).toContain("submission_completion_latest_turn");
    } finally {
      before.database.close();
    }
    const current = fixture();
    try {
      const plan = (lookup: string, ...parameters: string[]) => (current.database.prepare(lookup).all(...parameters) as { detail: string }[])
        .map(({ detail }) => detail)
        .join("\n");
      for (const lookup of turnLookups) {
        const turnPlan = plan(lookup, "t", "p", "thread", "turn");
        expect(turnPlan).toMatch(/USING INDEX submission_completion_turn \(/);
        expect(turnPlan).not.toContain("TEMP B-TREE");
      }
      const latestPlan = plan(latestTurnLookup, "t", "p", "thread");
      expect(latestPlan).toMatch(/USING INDEX submission_completion_latest_turn \(/);
      expect(latestPlan).not.toContain("TEMP B-TREE");
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
        for (const read of [
          () => current.replies.read(scope, threadId, "turn-1"),
          () => current.replies.latestReplyTurnId(scope, threadId),
        ]) {
          let error: unknown;
          try {
            read();
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(DomainError);
          expect(error).toMatchObject({ code: "not_found" });
        }
      }
    } finally {
      current.database.close();
    }
  });
});

describe("client.replay_turn over stored replies", () => {
  const services: ClientControlService[] = [];
  afterEach(() => { for (const service of services.splice(0)) service.close(); });
  const state = { runtime: { foreground: true, voiceReady: true, interactionActive: false }, settings: null };

  /** The source thread is running `runningTurnId` for `scope`; the tool reads the fixture's real repositories. */
  function replayTool(current: Fixture, runningTurnId: string, scope: RequestScope = current.scope) {
    const clients = new ClientControlService(); services.push(clients);
    const registered = clients.register(scope, undefined,
      { platform: "android", capabilities: { navigate: true, voice: true, voiceSettings: true }, state });
    const request = vi.spyOn(clients, "request")
      .mockImplementation(async (target) => ({ status: "applied", reason: "replay_queued", state, client: clients.describe(target) }));
    const authority = new DatabaseAgentToolSourceAuthority(current.database, new Uint8Array(32));
    const tools = new ClientControlToolService(clients, {
      observeInputRuntime: () => ({ authoritative: true, ownerGeneration: "owner", runState: "running", sourceTurnId: runningTurnId,
        activeTurnId: runningTurnId, sourceTurnStatus: "in_progress", settled: false, firstInput: { operationId: "running" } }) as ConversationInputRuntimeObservation,
    }, { originForTurn: () => ({ clientId: registered.clientId }) }, authority, current.replies);
    const environmentId = authority.resolveThread(current.scope, current.threadId)!.environmentId;
    const context = {
      tenantId: scope.tenantId, principalId: scope.principalId,
      subject: { kind: "thread_agent", sourceThreadId: current.threadId },
      clientTurn: { threadId: current.threadId, turnId: runningTurnId, ownerGeneration: "owner", clientId: registered.clientId },
      environmentAuthority: { admittedEnvironmentIds: [environmentId] }, abortSignal: new AbortController().signal,
    } as unknown as TrustedToolInvocationContext;
    const replay = async (input: Record<string, unknown>) => {
      await tools.execute("client.replay_turn", input, context);
      return request.mock.calls.at(-1)![1];
    };
    return { replay, request };
  }

  it("replays this thread's previous answer for {} while the source turn runs", async () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-earlier", classifiedResult: classified("Earlier") });
      // The previous turn was steered: its latest observation's classification is read.
      observe(current, { acceptedAt: 2_000, observedAt: 5_000, turnId: "turn-previous", classifiedResult: classified("Before the steer") });
      observe(current, { acceptedAt: 3_000, observedAt: 5_000, turnId: "turn-previous", classifiedResult: classified("Previous") });
      observe(current, { acceptedAt: 6_000 });
      const tool = replayTool(current, "turn-running");

      expect(await tool.replay({})).toMatchObject({ action: "replay_turn", sourceThreadId: current.threadId, sourceTurnId: "turn-running",
        threadId: current.threadId, threadTitle: "Replay", turnId: "turn-previous",
        assistantResult: { final: { text: "Previous" }, unclassified: null } });
      expect(await tool.replay({ threadId: current.threadId })).toMatchObject({ turnId: "turn-previous" });
      expect(await tool.replay({ turnId: "turn-earlier" }))
        .toMatchObject({ threadId: current.threadId, turnId: "turn-earlier", assistantResult: { final: { text: "Earlier" } } });
      await expect(tool.replay({ turnId: "turn-running" })).rejects.toMatchObject({ code: "invalid_input", message: "The turn has not ended." });
      await expect(tool.replay({ turnId: "turn-missing" }))
        .rejects.toMatchObject({ code: "not_found", message: "Sedes stored no reply for that turn; it may not have ended yet." });
    } finally {
      current.database.close();
    }
  });

  it("replays another thread's latest ended turn and finds nothing in a thread without replies", async () => {
    const current = fixture();
    try {
      const tool = replayTool(current, "turn-running");
      await expect(tool.replay({})).rejects.toMatchObject({ code: "not_found", message: "Sedes stored no reply for that thread; its turns may not have ended yet." });
      await expect(tool.replay({ threadId: current.otherThreadId }))
        .rejects.toMatchObject({ code: "not_found", message: "Sedes stored no reply for that thread; its turns may not have ended yet." });
      observe(current, { threadId: current.otherThreadId, acceptedAt: 1_000, turnId: "other-old", result: "Old" });
      observe(current, { threadId: current.otherThreadId, acceptedAt: 2_000, turnId: "other-latest", result: "Latest" });
      expect(await tool.replay({ threadId: current.otherThreadId })).toMatchObject({ threadId: current.otherThreadId,
        threadTitle: "Other", turnId: "other-latest", assistantResult: { unclassified: { text: "Latest" } } });
      // A later turn that ended without assistant text (a failure before any reply) is skipped by default…
      observe(current, { threadId: current.otherThreadId, acceptedAt: 3_000, turnId: "other-silent", result: " " });
      expect(await tool.replay({ threadId: current.otherThreadId })).toMatchObject({ turnId: "other-latest",
        assistantResult: { unclassified: { text: "Latest" } } });
      // …but naming it explicitly still reports that nothing is stored.
      await expect(tool.replay({ threadId: current.otherThreadId, turnId: "other-silent" })).rejects.toMatchObject({
        code: "not_found", message: "Sedes stored no reply for that turn; it may not have ended yet." });
      expect(tool.request).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("does not find unknown threads or another principal's threads, defaulted or explicit", async () => {
    const current = fixture();
    try {
      observe(current, { acceptedAt: 1_000, turnId: "turn-1" });
      observe(current, { threadId: current.otherThreadId, acceptedAt: 2_000, turnId: "other-1" });
      const own = replayTool(current, "turn-running");
      await expect(own.replay({ threadId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
      await expect(own.replay({ threadId: randomUUID(), turnId: "turn-1" })).rejects.toMatchObject({ code: "not_found" });
      expect(own.request).not.toHaveBeenCalled();
      // An agent of another principal resolves these thread ids in its own scope only.
      const foreign = replayTool(current, "turn-running", current.foreign);
      for (const input of [{}, { turnId: "turn-1" }, { threadId: current.otherThreadId }, { threadId: current.threadId, turnId: "turn-1" }]) {
        await expect(foreign.replay(input)).rejects.toMatchObject({ code: "not_found" });
      }
      expect(foreign.request).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });
});
