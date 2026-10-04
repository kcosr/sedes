import { scriptDelivery } from "../support/notification-settings.js";
import { notificationAssistantResultMigration } from "../../src/server/db/migrations/103-notification-assistant-result.js";
import { notificationAssistantResultPhasesMigration } from "../../src/server/db/migrations/105-notification-assistant-result-phases.js";
import { notificationPhaseSelectionMigration } from "../../src/server/db/migrations/106-notification-phase-selection.js";
import { notificationDeliveryMigration } from "../../src/server/db/migrations/130-notification-delivery.js";
import { notificationPathlessScriptDeliveryMigration } from "../../src/server/db/migrations/132-notification-pathless-script-delivery.js";
import type { BoundedText } from "../../src/shared/protocol/payload.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationEventKindSchema,
  notificationPayloadSchema,
  notificationSettingsSchema,
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
  voiceNotificationSchema,
  type NotificationEventPayload,
  type NotificationAssistantResultPhase,
  type NotificationTestResult,
  type VoiceRecognitionTarget,
} from "../../src/shared/protocol/notification.js";
import { notificationSettingsMigration } from "../../src/server/db/migrations/087-notification-settings.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import type { executeNotificationScript } from "../../src/server/runtime/notification-script-executor.js";

const scope = { tenantId: "tenant", principalId: "owner" };
const other = { tenantId: "other", principalId: "owner" };
const script = {
  scriptPath: "/usr/local/bin/notify",
  arguments: ["literal argument"],
  timeoutSeconds: 30,
};
const config = {
  ...script,
  enabled: true,
  assistantResultPhases: [] as NotificationAssistantResultPhase[],
  delivery: scriptDelivery(["turn.completed"]),
  expectedRevision: 0,
};
const success: NotificationTestResult = {
  success: true,
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  error: null,
};
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function fixture(
  executor = vi
    .fn<typeof executeNotificationScript>()
    .mockResolvedValue(success),
  onError?: (message: string) => void,
) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE principals(tenant_id TEXT, id TEXT, PRIMARY KEY (tenant_id, id));
    INSERT INTO principals VALUES ('tenant','owner'), ('other','owner');`);
  database.exec(notificationSettingsMigration.sql);
  const repository = new NotificationRepository(database);
  let now = 1000;
  const service = new NotificationService({
    repository,
    executor,
    now: () => now,
    ...(onError ? { onError } : {}),
  });
  disposals.push(
    () => {
      database.close();
    },
    () => service.close(),
  );
  return {
    database,
    repository,
    executor,
    service,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function event(at = 1001): NotificationEventPayload {
  return {
    event: "turn.completed",
    occurredAt: new Date(at).toISOString(),
    title: "Agent finished",
    message: "Example",
    thread: { id: "thread", title: "Example" },
    turn: { id: "turn", outcome: "completed" },
  };
}
function progress(text: BoundedText = { text: "Checking the build." }, at = 1001): NotificationEventPayload {
  return {
    event: "turn.progress", occurredAt: new Date(at).toISOString(), title: "Agent progress", message: "Example",
    thread: { id: "thread", title: "Example" }, workspace: { id: "workspace", name: "Workspace" },
    turn: { id: "turn" }, progress: { itemId: "item", ...text },
  };
}
const voiceFrames = (frames: readonly string[]) => frames
  .filter(frame => frame.startsWith("event: notification\n"))
  .map(frame => voiceNotificationSchema.parse(JSON.parse(frame.split("\n")[1]!.slice("data: ".length))));
function enable(service: NotificationService) {
  return service.update(scope, { ...config, delivery: config.delivery });
}
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("notification settings and passive hooks", () => {
  it("migrates script selections without changing existing phases, silence or event consumption", () => {
    const { service, database, repository } = fixture();
    enable(service);
    service.setSilenced(scope, true);
    repository.consume(scope, "already-consumed", 1001);
    const { delivery: _delivery, expectedRevision: _revision, ...old } = config;
    database.prepare("UPDATE principal_notification_settings SET config_json = ?").run(JSON.stringify({
      ...old, events: ["turn.completed", "question.requested"], assistantResultPhases: ["provisional"],
    }));
    database.exec(notificationDeliveryMigration.sql);
    const settings = repository.read(scope);
    expect(settings).toMatchObject({ enabled: true, silenced: true, assistantResultPhases: ["provisional"],
      scriptPath: script.scriptPath, arguments: script.arguments, revision: 2 });
    expect(settings).not.toHaveProperty("events");
    expect(settings.delivery).toEqual(scriptDelivery(["turn.completed", "question.requested"]));
    expect(repository.consume(scope, "already-consumed", 1001)).toBeNull();
  });

  it("clears migrated script selections only from disabled settings without a script path", () => {
    const { service, database, repository } = fixture();
    const relative = { tenantId: "tenant", principalId: "relative" };
    const enabledRow = { tenantId: "tenant", principalId: "enabled" };
    database.exec("INSERT INTO principals VALUES ('tenant','relative'), ('tenant','enabled');");
    const { delivery: _delivery, expectedRevision: _revision, ...old } = config;
    const rows = [
      { target: scope, values: { enabled: false, scriptPath: "" } },
      { target: other, values: { enabled: false, scriptPath: script.scriptPath } },
      { target: relative, values: { enabled: false, scriptPath: "notify.sh" } },
      // Raw state only: it isolates the enabled predicate from the path predicate.
      { target: enabledRow, values: { enabled: true, scriptPath: "" } },
    ];
    for (const { target, values } of rows) {
      service.update(target, { ...config, enabled: false, delivery: scriptDelivery([]) });
      database.prepare(`UPDATE principal_notification_settings SET config_json = ?
        WHERE tenant_id = ? AND owner_principal_id = ?`).run(JSON.stringify({
        ...old, ...values, events: ["turn.completed", "question.requested"],
      }), target.tenantId, target.principalId);
    }
    database.exec(notificationDeliveryMigration.sql);
    const raw = (target: typeof scope) => database.prepare(`SELECT config_json AS configJson, revision,
      dispatch_generation AS generation FROM principal_notification_settings
      WHERE tenant_id = ? AND owner_principal_id = ?`).get(target.tenantId, target.principalId) as
      { configJson: string; revision: number; generation: number };
    const before = new Map(rows.map(({ target }) => [target, raw(target)]));
    const migrated = repository.read(scope);
    expect(migrated.delivery).toEqual(scriptDelivery(["turn.completed", "question.requested"]));
    const { silenced: _silenced, revision, ...voiceOnly } = migrated;
    // The defect: a voice-only enable of the migrated, pathless settings is rejected.
    expect(() => service.update(scope, { ...voiceOnly, enabled: true, expectedRevision: revision }))
      .toThrow("Enabled script delivery requires an absolute script path.");

    database.exec(notificationPathlessScriptDeliveryMigration.sql);
    const repaired = raw(scope);
    expect(repaired).toMatchObject({ revision: before.get(scope)!.revision + 1, generation: before.get(scope)!.generation + 1 });
    const settings = repository.read(scope);
    expect(settings.delivery).toEqual(scriptDelivery([]));
    expect({ ...settings, delivery: undefined, revision: undefined })
      .toEqual({ ...migrated, delivery: undefined, revision: undefined });
    for (const { target } of rows.slice(1)) expect(raw(target)).toEqual(before.get(target));
    const { silenced: _after, revision: current, ...repairedConfig } = settings;
    expect(service.update(scope, { ...repairedConfig, enabled: true, expectedRevision: current }))
      .toMatchObject({ enabled: true, scriptPath: "", delivery: scriptDelivery([]) });
  });

  it("supports voice-only policy, sends policy before speech, and never replays speech", () => {
    const { service, executor } = fixture();
    const first: string[] = [];
    service.subscribe(scope, frame => first.push(frame));
    expect(first[0]).toContain("event: notification_policy\n");
    service.update(scope, { ...config, scriptPath: "", delivery: scriptDelivery([]) });
    service.emit(scope, event(), "voice-only");
    expect(first.map(frame => frame.split("\n")[0])).toEqual([
      "event: notification_policy", "event: notification_policy", "event: notification",
    ]);
    expect(first.join("")).not.toMatch(/^id:/m);
    const later = vi.fn();
    service.subscribe(scope, later);
    expect(later).toHaveBeenCalledOnce();
    expect(later.mock.calls[0]![0]).toContain("event: notification_policy");
    expect(executor).not.toHaveBeenCalled();
    service.setSilenced(scope, true);
    service.emit(scope, event(1002), "muted");
    service.setSilenced(scope, false);
    service.emit(scope, event(1002), "muted");
    expect(first.filter(frame => frame.startsWith("event: notification\n"))).toHaveLength(1);
  });

  it("delivers voice independently of script saturation and isolates subscribers by principal", async () => {
    let finish!: (result: NotificationTestResult) => void;
    const pending = new Promise<NotificationTestResult>(resolve => { finish = resolve; });
    const { service, executor } = fixture(vi.fn<typeof executeNotificationScript>().mockReturnValue(pending));
    enable(service);
    const speech = vi.fn(), wrongScope = vi.fn();
    service.subscribe(scope, speech);
    service.subscribe(other, wrongScope);
    for (let index = 0; index < 100; index++) service.emit(scope, event(1001 + index), `burst-${index}`);
    await flush();
    expect(speech).toHaveBeenCalledTimes(101);
    expect(wrongScope).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledTimes(4);
    const closing = service.close();
    finish(success);
    await closing;
  });

  it("fixes delayed recipients at emission, removes disconnected recipients, and invalidates old policy", async () => {
    const { service } = fixture();
    enable(service);
    const retained = vi.fn(), departed = vi.fn(), later = vi.fn();
    service.subscribe(scope, retained);
    const disconnect = service.subscribe(scope, departed);
    let settle!: (target: VoiceRecognitionTarget | undefined) => void;
    const settlement = new Promise<VoiceRecognitionTarget | undefined>(resolve => { settle = resolve; });
    service.emit(scope, event(), "deferred", undefined, () => ({ settlement }));
    disconnect();
    service.subscribe(scope, later);
    settle({ threadId: "thread", activityToken: "original-token", sourceTurnId: "turn" });
    await flush();
    expect(retained).toHaveBeenCalledTimes(2);
    expect(retained.mock.calls[1]![0]).toContain('"activityToken":"original-token"');
    expect(departed).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    let settleOld!: (target: VoiceRecognitionTarget | undefined) => void;
    service.emit(scope, event(1003), "obsolete", undefined, () => ({ settlement: new Promise(resolve => { settleOld = resolve; }) }));
    service.setSilenced(scope, true);
    settleOld({ threadId: "thread", activityToken: "obsolete" });
    await flush();
    expect(retained).toHaveBeenCalledTimes(3); // Only the new policy.
  });

  it("opens no voice lane when policy cannot be read, and a later readable policy does not admit that stream", async () => {
    const onError = vi.fn();
    const { service, database, executor } = fixture(undefined, onError);
    enable(service);
    const saved = (database.prepare("SELECT config_json AS config FROM principal_notification_settings").get() as { config: string }).config;
    database.prepare("UPDATE principal_notification_settings SET config_json = json_remove(config_json, '$.delivery')").run();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(scope, listener);
    expect(listener).not.toHaveBeenCalled();
    expect(onError.mock.calls).toEqual([["Notification policy could not be read; voice notifications are unavailable on this stream."]]);
    expect(() => unsubscribe()).not.toThrow();
    database.prepare("UPDATE principal_notification_settings SET config_json = ?").run(saved);
    service.emit(scope, event(), "after-repair");
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers turn.progress through payload validation, the voice frame and the script", async () => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    const context = vi.fn(() => ({ origin: { clientId: "phone" } }));
    service.emit(scope, progress(), "progress-key", undefined, context);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    const payload = executor.mock.calls[0]![0].payload;
    expect(payload).toEqual({ ...progress(), schemaVersion: 4, notificationId: expect.any(String) });
    expect(notificationPayloadSchema.parse(payload)).toEqual(payload);
    expect(voiceFrames(frames)).toEqual([{
      payload, voice: "speak", generation: expect.any(Number), origin: { clientId: "phone" },
      sourceEventId: createHash("sha256").update("progress-key").digest("hex"),
    }]);
    expect(context).toHaveBeenCalledOnce();
  });

  it.each([
    { text: "\u0000".repeat(8_000) + "tail" },
    { text: "😀\"\n".repeat(2_000), truncation: { truncated: true as const, reason: "byte_limit" as const, retainedBytes: 8_192, originalBytes: 40_000 } },
  ])("shortens oversized progress text on both channels instead of dropping it %#", async (source) => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    service.emit(scope, { ...progress(source), message: "m".repeat(50_000) }, "large-progress");
    await flush();
    const payload = executor.mock.calls[0]![0].payload;
    const text = payload.progress!.text;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(65_536);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeGreaterThan(1);
    expect(source.text.startsWith(text.slice(0, -1))).toBe(true);
    expect(payload.progress).toEqual({ itemId: "item", text, truncation: {
      ...source.truncation, truncated: true, reason: "byte_limit", retainedBytes: Buffer.byteLength(text),
    } });
    expect(voiceFrames(frames).map(frame => frame.payload)).toEqual([payload]);
  });

  it("drops progress whose metadata alone exceeds the payload budget", async () => {
    const onError = vi.fn();
    const { service, executor } = fixture(undefined, onError);
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    service.emit(scope, { ...progress(), message: "m".repeat(65_536) }, "oversized-metadata");
    await flush();
    expect(executor).not.toHaveBeenCalled();
    expect(voiceFrames(frames)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an invalid voice envelope", payload: { ...progress(), progress: { itemId: "i".repeat(513), text: "Update" } }, context: undefined },
    { name: "a failed context capture", payload: progress(), context: () => { throw new Error("activity unavailable"); } },
  ])("keeps script delivery when voice fails on $name", async ({ payload, context }) => {
    const onError = vi.fn();
    const { service, executor } = fixture(undefined, onError);
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    service.emit(scope, payload, "voice-failure", undefined, context);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload.progress).toEqual(payload.progress);
    expect(voiceFrames(frames)).toEqual([]);
    expect(onError.mock.calls).toEqual([["Voice notification could not be processed."]]);
  });

  it("captures voice context and copies results only after dedup, policy and recipient checks admit delivery", async () => {
    const onError = vi.fn();
    const { service, executor } = fixture(undefined, onError);
    const context = vi.fn(() => ({}));
    const unread = {
      get provisional(): BoundedText { throw new Error("must not read provisional"); },
      get final(): BoundedText { throw new Error("must not read final"); },
      get unclassified(): BoundedText { throw new Error("must not read unclassified"); },
    };
    const voiceOnly = { ...config, scriptPath: "", assistantResultPhases: ["final"] as NotificationAssistantResultPhase[], delivery: scriptDelivery([]) };
    service.update(scope, { ...voiceOnly, enabled: false });
    service.emit(scope, event(1001), "disabled", unread, context);
    service.update(scope, { ...voiceOnly, expectedRevision: 1 });
    service.emit(scope, event(1002), "no-recipient", unread, context);
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    service.update(scope, { ...voiceOnly, expectedRevision: 2, delivery: { ...scriptDelivery([]), "turn.completed": { script: false, voice: "none" } } });
    service.emit(scope, event(1003), "voice-none", unread, context);
    service.update(scope, { ...voiceOnly, expectedRevision: 3 });
    service.setSilenced(scope, true);
    service.emit(scope, event(1004), "silenced", unread, context);
    service.setSilenced(scope, false);
    service.emit(scope, event(1004), "silenced", unread, context);
    expect(context).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    service.update(scope, { ...voiceOnly, expectedRevision: 4, assistantResultPhases: [] });
    service.emit(scope, event(1005), "admitted", unread, context);
    service.emit(scope, event(1005), "admitted", unread, context);
    await flush();
    expect(context).toHaveBeenCalledOnce();
    expect(voiceFrames(frames).map(frame => frame.voice)).toEqual(["speakThenListen"]);
    expect(executor).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("advances policy generation on restart even when saved settings have not changed", () => {
    const { service, repository, database } = fixture();
    enable(service);
    const old = repository.readDispatch(scope);
    const restarted = new NotificationRepository(database).readDispatch(scope);
    expect(restarted.generation).toBeGreaterThan(old.generation);
    expect(restarted.settings).toEqual(old.settings);
  });
  it.each([true, false])("migrates the old master setting %s to effective phase selections without changing principal state", (included) => {
    const { service, database, repository } = fixture();
    expect(service.read(scope)).toMatchObject({ assistantResultPhases: ["final", "unclassified"] });
    expect(service.read(scope)).not.toHaveProperty("includeAssistantResult");
    service.update(scope, {
      ...config, delivery: config.delivery, assistantResultPhases: ["provisional", "final"],
    });
    service.setSilenced(scope, true);
    repository.update(other, { ...config, delivery: scriptDelivery(["turn.failed"]), assistantResultPhases: [] }, 1234);
    database.prepare(`UPDATE principal_notification_settings
      SET config_json = json_set(config_json, '$.includeAssistantResult', json(?))`).run(JSON.stringify(included));
    const readRows = () => database.prepare(
      "SELECT * FROM principal_notification_settings ORDER BY tenant_id",
    ).all() as Array<{ config_json: string }>;
    const before = readRows();
    database.exec(notificationPhaseSelectionMigration.sql);
    expect(readRows()).toEqual(before.map(row => {
      const { includeAssistantResult: removed, ...saved } = JSON.parse(row.config_json);
      return {
        ...row,
        config_json: JSON.stringify({ ...saved, assistantResultPhases: removed ? saved.assistantResultPhases : [] }),
      };
    }));
    expect(repository.read(scope)).toMatchObject({
      assistantResultPhases: included ? ["provisional", "final"] : [], silenced: true, revision: 1,
    });
    expect(repository.read(other)).toMatchObject({
      assistantResultPhases: [], silenced: false, delivery: scriptDelivery(["turn.failed"]),
    });
  });

  it("accepts any unique phase selection including none and rejects obsolete or invalid shapes", () => {
    for (const assistantResultPhases of [[], ["final"], ["provisional", "final", "unclassified"]]) {
      expect(updateNotificationSettingsRequestSchema.safeParse({ ...config, assistantResultPhases }).success).toBe(true);
    }
    for (const assistantResultPhases of [["final", "final"], ["other"], "final", ["provisional", "final", "unclassified", "final"]]) {
      expect(updateNotificationSettingsRequestSchema.safeParse({ ...config, assistantResultPhases }).success).toBe(false);
    }
    for (const includeAssistantResult of [true, false]) {
      expect(updateNotificationSettingsRequestSchema.safeParse({ ...config, includeAssistantResult }).success).toBe(false);
      const { expectedRevision: _revision, ...settings } = config;
      expect(notificationSettingsSchema.safeParse({ ...settings, includeAssistantResult, revision: 0, silenced: false }).success).toBe(false);
    }
    const { assistantResultPhases: _removed, ...oldConfig } = config;
    expect(updateNotificationSettingsRequestSchema.safeParse(oldConfig).success).toBe(false);
  });

  it("migrates pre-payload preferences through historical migrations to metadata only", () => {
    const { service, database, repository } = fixture();
    enable(service);
    service.setSilenced(scope, true);
    repository.update(other, { ...config, delivery: scriptDelivery(["turn.failed"]) }, 1234);
    database.exec(`UPDATE principal_notification_settings
      SET config_json = json_remove(config_json, '$.assistantResultPhases')`);
    const before = database.prepare(
      "SELECT * FROM principal_notification_settings ORDER BY tenant_id",
    ).all() as Array<{ config_json: string }>;
    database.exec(notificationAssistantResultMigration.sql);
    database.exec(notificationAssistantResultPhasesMigration.sql);
    database.exec(notificationPhaseSelectionMigration.sql);
    const after = database.prepare(
      "SELECT * FROM principal_notification_settings ORDER BY tenant_id",
    ).all();
    expect(after).toEqual(before.map(row => ({
      ...row,
      config_json: JSON.stringify({ ...JSON.parse(row.config_json), assistantResultPhases: [] }),
    })));
    expect(repository.read(scope)).toMatchObject({ assistantResultPhases: [], silenced: true, revision: 1 });
    expect(repository.read(other)).toMatchObject({ assistantResultPhases: [], silenced: false, delivery: scriptDelivery(["turn.failed"]) });
  });

  it.each([true, false])("migrates pre-selection preferences with payload enabled %s to their prior effective output", (included) => {
    const { service, database, repository } = fixture();
    enable(service);
    database.prepare(`UPDATE principal_notification_settings SET config_json = json_set(
      json_remove(config_json, '$.assistantResultPhases'), '$.includeAssistantResult', json(?))`).run(JSON.stringify(included));
    database.exec(notificationAssistantResultPhasesMigration.sql);
    database.exec(notificationPhaseSelectionMigration.sql);
    expect(repository.read(scope).assistantResultPhases).toEqual(included ? ["final"] : []);
    expect(repository.read(scope)).not.toHaveProperty("includeAssistantResult");
  });

  it("does not read response text while opted out and preserves metadata delivery", async () => {
    const { service, executor } = fixture();
    enable(service);
    const result = {
      provisional: null, unclassified: null,
      get final(): BoundedText {
        throw new Error("must not inspect response");
      },
    };
    service.emit(scope, event(), "opt-out", result);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload).not.toHaveProperty(
      "assistantResult",
    );
  });

  it.each([
    { text: "Progress.\n\nDone." },
    { text: "" },
    {
      text: "Already shortened…",
      truncation: {
        truncated: true as const,
        retainedBytes: 20,
        reason: "byte_limit" as const,
        originalBytes: 40_000,
      },
    },
  ])("includes a detached opted-in result %j", async (result) => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      assistantResultPhases: ["final"],
    });
    const classified = { provisional: null, final: result, unclassified: null };
    service.emit(scope, event(), "included", classified);
    await flush();
    expect(executor.mock.calls[0]![0].payload.assistantResult).toEqual(
      { final: result },
    );
    expect(executor.mock.calls[0]![0].payload.assistantResult).not.toBe(
      classified,
    );
  });

  it.each<NotificationAssistantResultPhase[]>([
    ["provisional"], ["final"], ["unclassified"],
    ["provisional", "final"], ["final", "unclassified"],
    ["provisional", "final", "unclassified"], [],
  ])("sends only selected phase keys %j, preserving selected null", async (...assistantResultPhases) => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config, delivery: config.delivery,
      assistantResultPhases,
    });
    const result = { provisional: { text: "Progress" }, final: null, unclassified: { text: "Unknown" } };
    service.emit(scope, event(), "selection", result);
    await flush();
    const payload = executor.mock.calls[0]![0].payload;
    if (assistantResultPhases.length === 0) {
      expect(payload).not.toHaveProperty("assistantResult");
    } else {
      expect(payload.assistantResult).toEqual(Object.fromEntries(
        assistantResultPhases.map(phase => [phase, result[phase]]),
      ));
    }
  });

  it("never reads unselected sections and snapshots only the selected text", async () => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: config.delivery, assistantResultPhases: ["final"] });
    const final = { text: "Final answer" };
    const result = {
      get provisional(): BoundedText { throw new Error("must not read provisional"); },
      final,
      get unclassified(): BoundedText { throw new Error("must not read unclassified"); },
    };
    service.emit(scope, event(), "selected-only", result);
    final.text = "Changed after completion";
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload.assistantResult).toEqual({ final: { text: "Final answer" } });
  });

  it("does not inspect any sections when phase selection is empty", async () => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config, delivery: config.delivery, assistantResultPhases: [],
    });
    const result = {
      get provisional(): BoundedText { throw new Error("must not inspect"); },
      get final(): BoundedText { throw new Error("must not inspect"); },
      get unclassified(): BoundedText { throw new Error("must not inspect"); },
    };
    service.emit(scope, event(), "empty-selection", result);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload).not.toHaveProperty("assistantResult");
  });

  it.each(["turn.failed", "turn.interrupted", "question.requested"] as const)(
    "never includes response text for %s",
    async (kind) => {
      const { service, executor } = fixture();
      service.update(scope, {
        ...config,
        delivery: scriptDelivery([kind]),
        assistantResultPhases: ["final"],
      });
      service.emit(scope, { ...event(), event: kind }, "other-kind", {
        provisional: null, final: { text: "Private response" }, unclassified: null,
      });
      await flush();
      expect(executor.mock.calls[0]![0].payload).not.toHaveProperty(
        "assistantResult",
      );
      await service.test(scope, script);
      expect(executor.mock.calls[1]![0].payload).not.toHaveProperty(
        "assistantResult",
      );
    },
  );

  it.each(["\u0000😀".repeat(3000), '\\"\n😀'.repeat(2300)])(
    "fits escaped response JSON without splitting Unicode",
    async (text) => {
      const { service, executor } = fixture();
      service.update(scope, {
        ...config,
        delivery: config.delivery,
        assistantResultPhases: ["final"],
      });
      const source: BoundedText = {
        text,
        truncation: {
          truncated: true,
          reason: "byte_limit",
          retainedBytes: Buffer.byteLength(text),
          originalBytes: 90_000,
        },
      };
      service.emit(
        scope,
        { ...event(), message: "m".repeat(45_000) },
        "large-response",
        { provisional: null, final: source, unclassified: null },
      );
      await flush();
      expect(executor).toHaveBeenCalledOnce();
      const payload = executor.mock.calls[0]![0].payload;
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
        65_536,
      );
      expect(payload.assistantResult!.final!.text).not.toBe(text);
      expect(
        new TextDecoder().decode(
          new TextEncoder().encode(payload.assistantResult!.final!.text),
        ),
      ).toBe(payload.assistantResult!.final!.text);
      expect(payload.assistantResult!.final!.text.endsWith("…")).toBe(true);
      expect(
        text.startsWith(payload.assistantResult!.final!.text.slice(0, -1)),
      ).toBe(true);
      expect(payload.assistantResult!.final!.truncation).toEqual({
        truncated: true,
        reason: "byte_limit",
        originalBytes: 90_000,
        retainedBytes: Buffer.byteLength(payload.assistantResult!.final!.text),
      });
      expect(source.text).toBe(text);
    },
  );

  it("discards provisional and unclassified bytes before shortening final text", async () => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config, delivery: config.delivery, assistantResultPhases: ["provisional", "final", "unclassified"],
    });
    service.emit(scope, { ...event(), message: "m".repeat(60_000) }, "priority", {
      final: { text: "Final answer" }, provisional: { text: "p".repeat(10_000) }, unclassified: { text: "u".repeat(10_000) },
    });
    await flush();
    const payload = executor.mock.calls[0]![0].payload;
    expect(payload.assistantResult?.final).toEqual({ text: "Final answer" });
    expect(payload.assistantResult?.unclassified).toMatchObject({ text: "", truncation: { truncated: true } });
    expect(payload.assistantResult?.provisional?.truncation?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(65_536);
  });

  it("retains metadata when there is no room for an assistant result envelope", async () => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      assistantResultPhases: ["final"],
    });
    const metadata = event();
    const overhead = Buffer.byteLength(
      JSON.stringify({
        ...metadata,
        message: "",
        schemaVersion: 4,
        notificationId: "0".repeat(36),
      }),
    );
    service.emit(
      scope,
      { ...metadata, message: "m".repeat(65_536 - overhead) },
      "full-metadata",
      { provisional: null, final: { text: "Response" }, unclassified: null },
    );
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload).not.toHaveProperty(
      "assistantResult",
    );
  });

  it("drops pending opted-in responses when the preference changes", async () => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      assistantResultPhases: ["final"],
    });
    service.emit(scope, event(), "pending", { provisional: null, final: { text: "Private response" }, unclassified: null });
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      expectedRevision: 1,
    });
    await flush();
    expect(executor).not.toHaveBeenCalled();
    service.emit(scope, event(1002), "new", { provisional: null, final: { text: "Private response" }, unclassified: null });
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload).not.toHaveProperty(
      "assistantResult",
    );
  });

  it("invalidates queued selections by generation without replaying consumed events", async () => {
    const { service, executor, repository } = fixture();
    service.update(scope, {
      ...config, delivery: config.delivery, assistantResultPhases: ["final"],
    });
    const result = {
      provisional: { text: "Progress" }, final: { text: "Done" }, unclassified: null,
    };
    service.emit(scope, event(), "queued-selection", result);
    // A repository-level update also invalidates pending work in the service.
    repository.update(scope, {
      ...config, expectedRevision: 1, delivery: config.delivery,
      assistantResultPhases: ["provisional"],
    }, 1000);
    await flush();
    expect(executor).not.toHaveBeenCalled();
    service.emit(scope, event(), "queued-selection", result);
    service.emit(scope, event(1002), "new-selection", result);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0].payload.assistantResult).toEqual({
      provisional: { text: "Progress" },
    });
  });

  it("requires a complete delivery map and rejects automatic listening for progress and forms", () => {
    const { service } = fixture();
    expect(Object.values(service.read(scope).delivery).every(entry => !entry.script)).toBe(true);
    const delivery = scriptDelivery(notificationEventKindSchema.options);
    expect(service.update(scope, { ...config, delivery }).delivery).toEqual(delivery);
    expect(updateNotificationSettingsRequestSchema.safeParse({ ...config, events: ["turn.completed"] }).success).toBe(false);
    for (const kind of ["turn.progress", "approval.requested", "input.requested", "question.requested"] as const) {
      expect(updateNotificationSettingsRequestSchema.safeParse({ ...config,
        delivery: { ...delivery, [kind]: { script: true, voice: "speakThenListen" } },
      }).success).toBe(false);
    }
  });

  it("keeps principal state isolated and rejects unknown authority", async () => {
    const { service, executor } = fixture();
    enable(service);
    service.setSilenced(scope, true);
    expect(service.read(other)).toMatchObject({
      enabled: false,
      silenced: false,
      revision: 0,
    });
    const wrong = { tenantId: "tenant", principalId: "unknown" };
    expect(() => service.read(wrong)).toThrow("unavailable");
    expect(() =>
      service.update(wrong, { ...config, delivery: config.delivery }),
    ).toThrow("unavailable");
    await expect(service.test(wrong, script)).rejects.toThrow("unavailable");
    expect(executor).not.toHaveBeenCalled();
  });

  it("persists configuration and silence independently with optimistic config revision", () => {
    const { service } = fixture();
    expect(enable(service).revision).toBe(1);
    expect(service.setSilenced(scope, true)).toMatchObject({
      revision: 1,
      silenced: true,
    });
    const next = service.update(scope, {
      ...config,
      delivery: config.delivery,
      expectedRevision: 1,
      scriptPath: "/new/script",
    });
    expect(next).toMatchObject({
      revision: 2,
      silenced: true,
      scriptPath: "/new/script",
    });
    expect(() =>
      service.update(scope, {
        ...config,
        delivery: config.delivery,
        expectedRevision: 1,
      }),
    ).toThrow("changed");
  });

  it("persists consumed identities across database reopen without any delivery rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "sedes-notifications-"));
    disposals.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, "state.db");
    let database = new Database(filename);
    database.exec(
      `CREATE TABLE principals(tenant_id TEXT, id TEXT, PRIMARY KEY(tenant_id,id)); INSERT INTO principals VALUES ('tenant','owner');`,
    );
    database.exec(notificationSettingsMigration.sql);
    let repository = new NotificationRepository(database);
    repository.update(scope, { ...config, delivery: config.delivery }, 1000);
    repository.setSilenced(scope, true, 1001);
    expect(repository.consume(scope, "event", 1002)).not.toBeNull();
    database.close();
    database = new Database(filename);
    disposals.push(() => {
      database.close();
    });
    repository = new NotificationRepository(database);
    expect(repository.read(scope)).toMatchObject({
      enabled: true,
      silenced: true,
      revision: 1,
    });
    expect(repository.consume(scope, "event", 1002)).toBeNull();
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%notification%'",
        )
        .all(),
    ).toEqual([
      { name: "principal_notification_settings" },
      { name: "notification_event_consumption" },
    ]);
  });

  it("invokes once per event without retries, even after failed execution", async () => {
    const executor = vi
      .fn<typeof executeNotificationScript>()
      .mockResolvedValue({ ...success, success: false, exitCode: 1 });
    const { service } = fixture(executor);
    enable(service);
    service.emit(scope, event(), "one");
    service.emit(scope, event(), "one");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toMatchObject({
      ...script,
      cwd: process.cwd(),
      payload: {
        ...event(),
        schemaVersion: 4,
        notificationId: expect.any(String),
      },
    });
    service.emit(scope, event(), "one");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("suppresses historical events, muted events and pending work without a resume backlog", async () => {
    const { service, executor, setNow } = fixture();
    enable(service);
    service.emit(scope, event(999), "historical");
    service.emit(scope, event(1001), "pending");
    service.setSilenced(scope, true);
    service.emit(scope, event(1002), "muted");
    setNow(1003);
    service.setSilenced(scope, false);
    await flush();
    service.emit(scope, event(1002), "muted");
    service.emit(scope, event(1001), "pending");
    await flush();
    expect(executor).not.toHaveBeenCalled();
    service.emit(scope, event(1004), "new");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("discards pending work on config edits and never sends events to a replacement script", async () => {
    const { service, executor } = fixture();
    enable(service);
    service.emit(scope, event(), "old");
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      expectedRevision: 1,
      scriptPath: "/replacement",
    });
    await flush();
    expect(executor).not.toHaveBeenCalled();
    service.emit(scope, event(), "old");
    await flush();
    expect(executor).not.toHaveBeenCalled();
  });

  it("bounds active work and drops queued work on silence while closing active children", async () => {
    const executor = vi
      .fn<typeof executeNotificationScript>()
      .mockImplementation(
        ({ signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => resolve({ ...success, success: false }),
              { once: true },
            );
          }),
      );
    const { service } = fixture(executor);
    enable(service);
    for (let index = 0; index < 100; index += 1)
      service.emit(scope, event(), String(index));
    await flush();
    expect(executor).toHaveBeenCalledTimes(4);
    service.setSilenced(scope, true);
    service.setSilenced(scope, false);
    await service.close();
    expect(executor).toHaveBeenCalledTimes(4);
    expect(executor.mock.calls.every(([input]) => input.signal?.aborted)).toBe(
      true,
    );
  });

  it("tests unsaved script settings explicitly while disabled and silenced", async () => {
    const { service, executor } = fixture();
    service.setSilenced(scope, true);
    expect(executor).not.toHaveBeenCalled();
    expect(await service.test(scope, script)).toEqual(success);
    expect(executor.mock.calls[0]![0].payload.event).toBe("notification.test");
    expect(service.read(scope)).toMatchObject({
      enabled: false,
      scriptPath: "",
      silenced: true,
    });
  });

  it("bounds consumed markers and suppresses replay below the retired timestamp floor", () => {
    const { repository, database, service } = fixture();
    enable(service);
    const insert = database.prepare(`INSERT INTO notification_event_consumption
      (tenant_id, owner_principal_id, event_key, occurred_at) VALUES ('tenant', 'owner', ?, ?)`);
    database.transaction(() => {
      for (let index = 0; index < 10_000; index += 1)
        insert.run(String(index), index + 1001);
    })();
    expect(repository.consume(scope, "new", 20_000)).not.toBeNull();
    expect(
      database
        .prepare("SELECT count(*) AS count FROM notification_event_consumption")
        .get(),
    ).toEqual({ count: 10_000 });
    expect(repository.consume(scope, "retired", 1001)).toBeNull();
    expect(repository.consume(scope, "new", 20_000)).toBeNull();
  });

  it("isolates failures in optional diagnostics from conversation hooks", async () => {
    const { repository } = fixture();
    const executor = vi
      .fn<typeof executeNotificationScript>()
      .mockRejectedValue(new Error("private script error"));
    const onError = vi.fn(() => {
      throw new Error("logging unavailable");
    });
    const service = new NotificationService({
      repository,
      executor,
      onError,
      now: () => 1000,
    });
    disposals.push(() => service.close());
    enable(service);
    expect(() =>
      service.emit(
        { tenantId: "missing", principalId: "missing" },
        event(),
        "wrong-scope",
      ),
    ).not.toThrow();
    service.emit(scope, event(), "failed");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls).toEqual([
      ["Notification event could not be processed."],
      ["Notification script did not complete successfully."],
    ]);
  });

  it("validates strict script contracts without accepting shell strings as executable paths", () => {
    expect(
      updateNotificationSettingsRequestSchema.safeParse({
        ...config,
        scriptPath: "notify",
      }).success,
    ).toBe(false);
    expect(
      testNotificationRequestSchema.safeParse({ ...script, scriptPath: "" })
        .success,
    ).toBe(false);
    expect(
      testNotificationRequestSchema.safeParse({
        ...script,
        arguments: ["bad\0argument"],
      }).success,
    ).toBe(false);
    expect(
      testNotificationRequestSchema.safeParse({
        ...script,
        timeoutSeconds: 301,
      }).success,
    ).toBe(false);
    expect(
      updateNotificationSettingsRequestSchema.safeParse({
        ...config,
        tenantId: "other",
      }).success,
    ).toBe(false);
    expect(
      notificationSettingsSchema.safeParse({
        ...config,
        silenced: false,
        revision: 0,
      }).success,
    ).toBe(false);
  });
});
