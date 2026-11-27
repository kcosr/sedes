import { boundText, MAX_LIVE_PROGRESS_BYTES } from "../../src/server/conversations/payload-policy.js";
import { ClientControlService } from "../../src/server/domain/client-control-service.js";
import { TurnVoiceCompletion } from "../../src/server/domain/turn-voice-completion.js";
import { earlyReplyFrameSchema, earlyReplySessionSchema } from "../../src/shared/protocol/early-reply.js";
import { notificationSourceId, progressNotificationKey, turnNotificationKey } from "../../src/server/domain/notification-identity.js";
import { scriptDelivery } from "../support/notification-settings.js";
import { notificationAssistantResultMigration } from "../../src/server/db/migrations/103-notification-assistant-result.js";
import { notificationAssistantResultPhasesMigration } from "../../src/server/db/migrations/105-notification-assistant-result-phases.js";
import { notificationPhaseSelectionMigration } from "../../src/server/db/migrations/106-notification-phase-selection.js";
import { notificationDeliveryMigration } from "../../src/server/db/migrations/130-notification-delivery.js";
import { partialNotificationDeliveryMigration } from "../../src/server/db/migrations/139-partial-notification-delivery.js";
import { notificationPathlessScriptDeliveryMigration } from "../../src/server/db/migrations/132-notification-pathless-script-delivery.js";
import type { BoundedText } from "../../src/shared/protocol/payload.js";
import { createHash, randomUUID } from "node:crypto";
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
    turn: { id: "turn" }, progress: { phase: "provisional", itemId: "item", ...text },
  };
}
const voiceFrames = (frames: readonly string[]) => frames
  .filter(frame => frame.startsWith("event: notification\n"))
  .map(frame => voiceNotificationSchema.parse(JSON.parse(frame.split("\n")[1]!.slice("data: ".length))));
function enable(service: NotificationService) {
  return service.update(scope, { ...config, delivery: config.delivery });
}
/** These synthetic turn events are observed at user-input revision zero. */
function emitFresh(service: NotificationService, ...args: Parameters<NotificationService["emit"]>) {
  if (args[1].event.startsWith("turn.") && args[7] === undefined) {
    args[7] = { userInputRevision: 0, superseded: false };
  }
  return service.emit(...args);
}
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("notification settings and passive hooks", () => {
  it("reports only native streams actually handed a voice event in the same scope", async () => {
    const { service } = fixture(); enable(service);
    service.subscribe(scope, () => {}); // Ordinary browser/WebView: no playback barrier.
    const oldStream = randomUUID(), newStream = randomUUID();
    service.subscribe(scope, () => {}, service.reserveVoiceStream(scope, oldStream));
    service.subscribe(scope, () => {}, service.reserveVoiceStream(scope, newStream));
    service.subscribe(other, () => {}, service.reserveVoiceStream(other, randomUUID()));
    const publication = await emitFresh(service, scope, event(), "stream-deliveries", "live");
    expect(publication?.sourceEventId).toBe(createHash("sha256").update("stream-deliveries").digest("hex"));
    expect(publication?.voiceStreamIds).toEqual([oldStream, newStream]);
  });

  it("never reports late, removed, failed, or synchronously closed streams as playback barriers", async () => {
    const { service } = fixture(); enable(service);
    service.subscribe(scope, () => {});
    let remove!: () => void;
    remove = service.subscribe(scope, frame => { if (frame.startsWith("event: notification\n")) remove(); },
      service.reserveVoiceStream(scope, randomUUID()));
    service.subscribe(scope, frame => { if (frame.startsWith("event: notification\n")) throw new Error("closed"); },
      service.reserveVoiceStream(scope, randomUUID()));
    const disconnect = service.subscribe(scope, () => {}, service.reserveVoiceStream(scope, randomUUID()));
    const watermark = service.captureSubscriberWatermark();
    let settle!: (target: undefined) => void;
    const publication = emitFresh(service, scope, event(), "ending-streams", "live", undefined,
      () => ({ settlement: new Promise(resolve => { settle = resolve; }) }), watermark);
    disconnect();
    service.subscribe(scope, () => {}, service.reserveVoiceStream(scope, randomUUID()));
    settle(undefined);
    expect((await publication)?.voiceStreamIds).toEqual([]);
  });

  it("bounds native stream admission per principal without truncating delivery receipts", async () => {
    const { service, database } = fixture(); enable(service);
    const foreign = { ...scope, principalId: "foreign" };
    database.prepare("INSERT INTO principals VALUES (?, ?)").run(foreign.tenantId, foreign.principalId);
    service.subscribe(scope, () => {});
    const streams = Array.from({ length: 128 }, () => service.reserveVoiceStream(scope, randomUUID()));
    expect(() => service.reserveVoiceStream(scope, randomUUID())).toThrow("capacity");
    for (const stream of streams) service.subscribe(scope, () => {}, stream);
    expect((await emitFresh(service, scope, event(), "all-native-streams", "live"))?.voiceStreamIds).toEqual(streams.map(stream => stream.voiceStreamId));
    const otherStream = service.reserveVoiceStream(other, randomUUID());
    expect(() => service.subscribe(scope, () => {}, otherStream)).toThrow("reservation");
    service.subscribe(other, () => {}, otherStream);
    const foreignStream = service.reserveVoiceStream(foreign, randomUUID());
    expect(() => service.subscribe(scope, () => {}, foreignStream)).toThrow("reservation");
    service.subscribe(foreign, () => {}, foreignStream);
    expect(() => service.subscribe(other, () => {}, otherStream)).toThrow("reservation");
    streams[0]!.release(); streams[0]!.release();
    const replacement = service.reserveVoiceStream(scope, randomUUID());
    expect(() => service.reserveVoiceStream(scope, randomUUID())).toThrow("capacity");
    const unsubscribe = service.subscribe(scope, () => {}, replacement);
    unsubscribe(); unsubscribe();
    service.reserveVoiceStream(scope, randomUUID()).release();
    await service.close();
    expect(() => service.reserveVoiceStream(scope, randomUUID())).toThrow("capacity");
  });

  it("releases failed and closed native streams without reviving an old reservation", () => {
    const { service } = fixture();
    const released = service.reserveVoiceStream(scope, randomUUID());
    released.release();
    expect(() => service.subscribe(scope, () => {}, released)).toThrow("reservation");
    const failed = service.reserveVoiceStream(scope, randomUUID());
    service.subscribe(scope, () => { throw new Error("stream closed"); }, failed);
    expect(() => service.subscribe(scope, () => {}, failed)).toThrow("reservation");
    const active = service.reserveVoiceStream(scope, randomUUID());
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame), active);
    active.release();
    service.setSilenced(scope, true);
    expect(frames).toHaveLength(1);
  });

  it("suppresses superseded turn voice without suppressing scripts or invoking recognition context", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { service, executor } = fixture();
      enable(service);
      const frames: string[] = [];
      service.subscribe(scope, frame => frames.push(frame));
      const context = vi.fn(() => ({}));
      const captured = { userInputRevision: 4, superseded: true };
      await service.emit(scope, event(), "superseded-turn", "live", undefined, context, undefined, captured);
      await service.emit(scope, event(), "superseded-turn", "live", undefined, context, undefined, captured);
      await flush();
      expect(executor).toHaveBeenCalledOnce();
      expect(voiceFrames(frames)).toEqual([]);
      expect(context).not.toHaveBeenCalled();
      const records = diagnostics.mock.calls.map(([line]) => JSON.parse(String(line).slice("[delivery-voice] ".length)));
      expect(records).toContainEqual(expect.objectContaining({ event: "voice_decision", suppressionReason: "superseded_by_input" }));
    } finally { diagnostics.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("retains freshness authority on announce-only turns without a recognition target", async () => {
    const { service } = fixture();
    enable(service);
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    await service.emit(scope, event(), "announce-only", "live", undefined, () => ({}), undefined,
      { userInputRevision: 12, superseded: false });
    const [voice] = voiceFrames(frames);
    expect(voice).toMatchObject({ userInputRevision: 12, payload: { event: "turn.completed" } });
    expect(voice).not.toHaveProperty("recognitionTarget");
  });

  it("fails turn voice closed when the early freshness capture is unavailable while retaining its script", async () => {
    const { service, executor } = fixture();
    enable(service);
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    await service.emit(scope, event(), "uncaptured-turn", "live");
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(voiceFrames(frames)).toEqual([]);
  });

  it.each(["turn.progress", "turn.partial"] as const)("suppresses superseded %s voice while retaining its independent script", async kind => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery([kind]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    const payload: NotificationEventPayload = kind === "turn.progress" ? progress() : {
      ...progress(), event: kind, progress: { phase: "partial", itemId: "partial", text: "An early answer" },
    };
    await service.emit(scope, payload, "superseded-progress", "live", undefined, undefined, undefined,
      { userInputRevision: 2, superseded: true });
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(voiceFrames(frames)).toEqual([]);
  });

  it("requires a safe integer freshness revision on turn envelopes and forbids it on attention notices", () => {
    const turn = { payload: { ...event(), schemaVersion: 5, notificationId: "notification" },
      sourceEventId: "source", generation: 1, voice: "speak", userInputRevision: 0 };
    expect(voiceNotificationSchema.safeParse(turn).success).toBe(true);
    const { userInputRevision: _revision, ...missing } = turn;
    expect(voiceNotificationSchema.safeParse(missing).success).toBe(false);
    for (const userInputRevision of [-1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(voiceNotificationSchema.safeParse({ ...turn, userInputRevision }).success).toBe(false);
    }
    expect(voiceNotificationSchema.safeParse({ ...turn, userInputRevision: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    const attention = { ...missing, payload: { ...turn.payload, event: "input.requested", turn: undefined,
      interaction: { id: "interaction", kind: "text_input" } } };
    expect(voiceNotificationSchema.safeParse(attention).success).toBe(true);
    expect(voiceNotificationSchema.safeParse({ ...attention, userInputRevision: 0 }).success).toBe(false);
    const recognitionTarget = { threadId: "thread", activityToken: "token", sourceTurnId: "turn" };
    expect(voiceNotificationSchema.safeParse({ ...turn, recognitionTarget }).success).toBe(true);
    expect(voiceNotificationSchema.safeParse({ ...turn, recognitionTarget: { ...recognitionTarget, threadId: "foreign-thread" } }).success).toBe(false);
  });

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
    database.exec(partialNotificationDeliveryMigration.sql);
    const settings = repository.read(scope);
    expect(settings).toMatchObject({ enabled: true, silenced: true, assistantResultPhases: ["provisional"],
      scriptPath: script.scriptPath, arguments: script.arguments, revision: 3 });
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
    database.exec(partialNotificationDeliveryMigration.sql);
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
    emitFresh(service, scope, event(), "voice-only", "live");
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
    emitFresh(service, scope, event(1002), "muted", "live");
    service.setSilenced(scope, false);
    emitFresh(service, scope, event(1002), "muted", "live");
    expect(first.filter(frame => frame.startsWith("event: notification\n"))).toHaveLength(1);
  });

  it.each(["completed", "failed", "interrupted"] as const)(
    "claims recovered %s for scripts without speaking it or a later duplicate",
    async outcome => {
      const { service, executor } = fixture();
      const frames: string[] = [];
      service.subscribe(scope, frame => frames.push(frame));
      service.update(scope, { ...config, delivery: scriptDelivery([`turn.${outcome}`]) });
      const recovered: NotificationEventPayload = {
        ...event(), event: `turn.${outcome}`, turn: { id: "turn", outcome },
      };
      const context = vi.fn(() => ({}));
      await emitFresh(service, scope, recovered, "recovered", "recovered", undefined, context);
      await flush();
      expect(executor).toHaveBeenCalledOnce();
      expect(voiceFrames(frames)).toHaveLength(0);
      expect(context).not.toHaveBeenCalled();
      await emitFresh(service, scope, recovered, "recovered", "live", undefined, context);
      await flush();
      expect(executor).toHaveBeenCalledOnce();
      expect(voiceFrames(frames)).toHaveLength(0);
      expect(context).not.toHaveBeenCalled();
      await emitFresh(service, scope, recovered, "new-live", "live", undefined, context);
      expect(voiceFrames(frames)).toHaveLength(1);
      expect(context).toHaveBeenCalledOnce();
    },
  );

  it("does not defer offline live notifications for a reconnect", async () => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery([]) });
    const context = vi.fn(() => ({}));
    await emitFresh(service, scope, event(), "offline", "live", undefined, context);
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    await emitFresh(service, scope, event(), "offline", "live", undefined, context);
    expect(voiceFrames(frames)).toHaveLength(0);
    expect(context).not.toHaveBeenCalled();
    await emitFresh(service, scope, event(), "online", "live", undefined, context);
    expect(voiceFrames(frames)).toHaveLength(1);
    expect(executor).not.toHaveBeenCalled();
  });

  it("restricts completion speech to the captured audience while publishing policy to later streams", async () => {
    const { service } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery([]) });
    const earlier: string[] = [], later: string[] = [];
    service.subscribe(scope, frame => earlier.push(frame));
    const watermark = service.captureSubscriberWatermark();
    service.subscribe(scope, frame => later.push(frame));

    await emitFresh(service, scope, event(), "captured-audience", "live", undefined, undefined, watermark);
    expect(voiceFrames(earlier)).toHaveLength(1);
    expect(voiceFrames(later)).toHaveLength(0);
    expect(later).toHaveLength(1);
    expect(later[0]).toContain("event: notification_policy\n");

    service.setSilenced(scope, true);
    expect(later).toHaveLength(2);
    expect(later[1]).toContain("event: notification_policy\n");
    expect(later[1]).toContain('"silenced":true');
  });

  it("delivers unwatermarked progress to every current same-scope stream", async () => {
    const { service } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery([]) });
    const earlier: string[] = [], later: string[] = [], unrelated: string[] = [];
    service.subscribe(scope, frame => earlier.push(frame));
    service.captureSubscriberWatermark();
    service.subscribe(scope, frame => later.push(frame));
    service.subscribe(other, frame => unrelated.push(frame));

    await emitFresh(service, scope, progress(), "unwatermarked-progress", "live");
    expect(voiceFrames(earlier)).toHaveLength(1);
    expect(voiceFrames(later)).toHaveLength(1);
    expect(voiceFrames(unrelated)).toHaveLength(0);
  });

  it("treats a zero audience watermark as no recipients and diagnoses the suppression", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { service } = fixture();
      service.update(scope, { ...config, delivery: scriptDelivery([]) });
      const watermark = service.captureSubscriberWatermark();
      expect(watermark).toBe(0);
      const frames: string[] = [];
      service.subscribe(scope, frame => frames.push(frame));
      const context = vi.fn(() => ({}));

      await emitFresh(service, scope, event(), "empty-audience", "live", undefined, context, watermark);
      expect(voiceFrames(frames)).toHaveLength(0);
      expect(context).not.toHaveBeenCalled();
      const records = output.mock.calls.map(([line]) => JSON.parse(String(line).slice("[delivery-voice] ".length)));
      expect(records).toContainEqual(expect.objectContaining({
        event: "voice_decision", provenance: "live", claimed: true,
        applicationStreamCount: 1, recipientCount: 0, suppressionReason: "no_recipients",
      }));
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("diagnoses recovered suppression and listener delivery without exporting content", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { service } = fixture();
      service.update(scope, { ...config, delivery: scriptDelivery([]) });
      service.subscribe(scope, () => {});
      await emitFresh(service, scope, { ...event(), message: "private text" }, "private event key", "recovered");
      await emitFresh(service, scope, event(), "live event key", "live");
      const records = output.mock.calls.map(([line]) => JSON.parse(String(line).slice("[delivery-voice] ".length)));
      expect(records).toContainEqual(expect.objectContaining({
        event: "voice_decision", provenance: "recovered", claimed: true,
        suppressionReason: "recovered", applicationStreamCount: 1, recipientCount: 0,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        event: "voice_published", attemptedCount: 1, deliveredCount: 1,
      }));
      expect(JSON.stringify(records)).not.toMatch(/private text|private event key|live event key/);
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("delivers voice independently of script saturation and isolates subscribers by principal", async () => {
    let finish!: (result: NotificationTestResult) => void;
    const pending = new Promise<NotificationTestResult>(resolve => { finish = resolve; });
    const { service, executor } = fixture(vi.fn<typeof executeNotificationScript>().mockReturnValue(pending));
    enable(service);
    const speech = vi.fn(), wrongScope = vi.fn();
    service.subscribe(scope, speech);
    service.subscribe(other, wrongScope);
    for (let index = 0; index < 100; index++) emitFresh(service, scope, event(1001 + index), `burst-${index}`, "live");
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
    emitFresh(service, scope, event(), "deferred", "live", undefined, () => ({ settlement }));
    disconnect();
    service.subscribe(scope, later);
    settle({ threadId: "thread", activityToken: "original-token", sourceTurnId: "turn" });
    await flush();
    expect(retained).toHaveBeenCalledTimes(2);
    expect(retained.mock.calls[1]![0]).toContain('"activityToken":"original-token"');
    expect(departed).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    let settleOld!: (target: VoiceRecognitionTarget | undefined) => void;
    emitFresh(service, scope, event(1003), "obsolete", "live", undefined, () => ({ settlement: new Promise(resolve => { settleOld = resolve; }) }));
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
    emitFresh(service, scope, event(), "after-repair", "live");
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
    emitFresh(service, scope, progress(), "progress-key", "live", undefined, context);
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    const payload = executor.mock.calls[0]![0].payload;
    expect(payload).toEqual({ ...progress(), schemaVersion: 5, notificationId: expect.any(String) });
    expect(notificationPayloadSchema.parse(payload)).toEqual(payload);
    expect(voiceFrames(frames)).toEqual([{
      payload, voice: "speak", generation: expect.any(Number), origin: { clientId: "phone" }, userInputRevision: 0,
      sourceEventId: createHash("sha256").update("progress-key").digest("hex"),
    }]);
    expect(context).toHaveBeenCalledOnce();
  });

  it("delivers a partial answer once while completion and automatic listening remain separate", async () => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: { ...scriptDelivery(["turn.completed"]), "turn.partial": { script: true, voice: "speak" } },
      assistantResultPhases: ["partial", "final"] });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    const partial: NotificationEventPayload = { ...progress(), event: "turn.partial",
      progress: { phase: "partial", itemId: "partial-1", text: "First substantive answer." } };
    emitFresh(service, scope, partial, "partial-item", "live");
    emitFresh(service, scope, partial, "partial-item", "live");
    await flush();
    expect(executor).toHaveBeenCalledOnce();
    expect(voiceFrames(frames)).toEqual([expect.objectContaining({ voice: "speak",
      payload: expect.objectContaining({ event: "turn.partial", progress: partial.progress }) })]);
    expect(voiceFrames(frames)[0]).not.toHaveProperty("recognitionTarget");
    expect(executor.mock.calls[0]![0].payload).not.toHaveProperty("assistantResult");
    const result = { provisional: null, partial: { text: "First substantive answer." }, final: { text: "Finished." }, unclassified: null };
    emitFresh(service, scope, event(1002), "completion", "live", result);
    await flush();
    expect(executor).toHaveBeenCalledTimes(2);
    expect(voiceFrames(frames).map(frame => frame.payload.event)).toEqual(["turn.partial", "turn.completed"]);
    expect(executor.mock.calls[1]![0].payload.assistantResult).toEqual({ partial: result.partial, final: result.final });
    const reconnected: string[] = [];
    service.subscribe(scope, frame => reconnected.push(frame));
    emitFresh(service, scope, partial, "partial-item", "live");
    emitFresh(service, scope, event(1002), "completion", "recovered", result);
    await flush();
    expect(executor).toHaveBeenCalledTimes(2);
    expect(voiceFrames(reconnected)).toEqual([]);
  });

  it("controls Partial independently of Turn progress and keeps disabled events consumed", async () => {
    const { service, executor } = fixture();
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    const partial: NotificationEventPayload = { ...progress(), event: "turn.partial",
      progress: { phase: "partial", itemId: "partial-1", text: "Answer so far." } };
    expect(service.read(scope).delivery["turn.partial"]).toEqual({ script: false, voice: "none" });
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    emitFresh(service, scope, partial, "disabled-partial", "live");
    emitFresh(service, scope, progress(), "enabled-progress", "live");
    await flush();
    expect(executor.mock.calls.map(call => call[0].payload.event)).toEqual(["turn.progress"]);
    expect(voiceFrames(frames).map(frame => frame.payload.event)).toEqual(["turn.progress"]);
    service.update(scope, { ...config, expectedRevision: 1, delivery: {
      ...scriptDelivery([]), "turn.progress": { script: false, voice: "none" }, "turn.partial": { script: true, voice: "speak" },
    } });
    emitFresh(service, scope, partial, "disabled-partial", "live");
    emitFresh(service, scope, progress(), "now-disabled-progress", "live");
    emitFresh(service, scope, partial, "enabled-partial", "live");
    await flush();
    expect(executor.mock.calls.map(call => call[0].payload.event)).toEqual(["turn.progress", "turn.partial"]);
    expect(voiceFrames(frames).map(frame => frame.payload.event)).toEqual(["turn.progress", "turn.partial"]);
  });

  it.each([["turn.progress", "provisional"], ["turn.partial", "partial"]] as const)("requires matching live response phase for %s", (event, phase) => {
    const payload = { ...progress(), event, notificationId: "notice", schemaVersion: 5,
      progress: { phase, itemId: "item", text: "Response" } };
    expect(notificationPayloadSchema.safeParse(payload).success).toBe(true);
    expect(notificationPayloadSchema.safeParse({ ...payload, progress: { ...payload.progress, phase: phase === "partial" ? "provisional" : "partial" } }).success).toBe(false);
    expect(notificationPayloadSchema.safeParse({ ...payload, progress: undefined }).success).toBe(false);
    expect(notificationPayloadSchema.safeParse({ ...payload, event: "turn.completed" }).success).toBe(false);
    const voice = { payload, voice: "speak", sourceEventId: "event", generation: 1, userInputRevision: 0 };
    expect(voiceNotificationSchema.safeParse(voice).success).toBe(true);
    expect(voiceNotificationSchema.safeParse({ ...voice, voice: "speakThenListen" }).success).toBe(false);
  });

  it.each([
    { text: "\u0000".repeat(8_000) + "tail" },
    { text: "😀\"\n".repeat(2_000), truncation: { truncated: true as const, reason: "byte_limit" as const, retainedBytes: 8_192, originalBytes: 40_000 } },
  ])("shortens oversized progress text on both channels instead of dropping it %#", async (source) => {
    const { service, executor } = fixture();
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    emitFresh(service, scope, { ...progress(source), message: "m".repeat(50_000) }, "large-progress", "live");
    await flush();
    const payload = executor.mock.calls[0]![0].payload;
    const text = payload.progress!.text;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(65_536);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeGreaterThan(1);
    expect(source.text.startsWith(text.slice(0, -1))).toBe(true);
    expect(payload.progress).toEqual({ phase: "provisional", itemId: "item", text, truncation: {
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
    emitFresh(service, scope, { ...progress(), message: "m".repeat(65_536) }, "oversized-metadata", "live");
    await flush();
    expect(executor).not.toHaveBeenCalled();
    expect(voiceFrames(frames)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an invalid voice envelope", payload: { ...progress(), progress: { phase: "provisional" as const, itemId: "i".repeat(513), text: "Update" } }, context: undefined },
    { name: "a failed context capture", payload: progress(), context: () => { throw new Error("activity unavailable"); } },
  ])("keeps script delivery when voice fails on $name", async ({ payload, context }) => {
    const onError = vi.fn();
    const { service, executor } = fixture(undefined, onError);
    service.update(scope, { ...config, delivery: scriptDelivery(["turn.progress"]) });
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    emitFresh(service, scope, payload, "voice-failure", "live", undefined, context);
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
      get partial(): BoundedText { throw new Error("must not read partial"); },
      get provisional(): BoundedText { throw new Error("must not read provisional"); },
      get final(): BoundedText { throw new Error("must not read final"); },
      get unclassified(): BoundedText { throw new Error("must not read unclassified"); },
    };
    const voiceOnly = { ...config, scriptPath: "", assistantResultPhases: ["final"] as NotificationAssistantResultPhase[], delivery: scriptDelivery([]) };
    service.update(scope, { ...voiceOnly, enabled: false });
    emitFresh(service, scope, event(1001), "disabled", "live", unread, context);
    service.update(scope, { ...voiceOnly, expectedRevision: 1 });
    emitFresh(service, scope, event(1002), "no-recipient", "live", unread, context);
    const frames: string[] = [];
    service.subscribe(scope, frame => frames.push(frame));
    service.update(scope, { ...voiceOnly, expectedRevision: 2, delivery: { ...scriptDelivery([]), "turn.completed": { script: false, voice: "none" } } });
    emitFresh(service, scope, event(1003), "voice-none", "live", unread, context);
    service.update(scope, { ...voiceOnly, expectedRevision: 3 });
    service.setSilenced(scope, true);
    emitFresh(service, scope, event(1004), "silenced", "live", unread, context);
    service.setSilenced(scope, false);
    emitFresh(service, scope, event(1004), "silenced", "live", unread, context);
    expect(context).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    service.update(scope, { ...voiceOnly, expectedRevision: 4, assistantResultPhases: [] });
    emitFresh(service, scope, event(1005), "admitted", "live", unread, context);
    emitFresh(service, scope, event(1005), "admitted", "live", unread, context);
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
    for (const assistantResultPhases of [[], ["final"], ["partial"], ["provisional", "partial", "final", "unclassified"]]) {
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
      partial: null, provisional: null, unclassified: null,
      get final(): BoundedText {
        throw new Error("must not inspect response");
      },
    };
    emitFresh(service, scope, event(), "opt-out", "live", result);
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
    const classified = { partial: null, provisional: null, final: result, unclassified: null };
    emitFresh(service, scope, event(), "included", "live", classified);
    await flush();
    expect(executor.mock.calls[0]![0].payload.assistantResult).toEqual(
      { final: result },
    );
    expect(executor.mock.calls[0]![0].payload.assistantResult).not.toBe(
      classified,
    );
  });

  it.each<NotificationAssistantResultPhase[]>([
    ["provisional"], ["partial"], ["final"], ["unclassified"],
    ["provisional", "final"], ["final", "unclassified"],
    ["provisional", "partial", "final", "unclassified"], [],
  ])("sends only selected phase keys %j, preserving selected null", async (...assistantResultPhases) => {
    const { service, executor } = fixture();
    service.update(scope, {
      ...config, delivery: config.delivery,
      assistantResultPhases,
    });
    const result = { partial: { text: "Partial answer" }, provisional: { text: "Progress" }, final: null, unclassified: { text: "Unknown" } };
    emitFresh(service, scope, event(), "selection", "live", result);
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
      get partial(): BoundedText { throw new Error("must not read partial"); },
      get provisional(): BoundedText { throw new Error("must not read provisional"); },
      final,
      get unclassified(): BoundedText { throw new Error("must not read unclassified"); },
    };
    emitFresh(service, scope, event(), "selected-only", "live", result);
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
      get partial(): BoundedText { throw new Error("must not read partial"); },
      get provisional(): BoundedText { throw new Error("must not inspect"); },
      get final(): BoundedText { throw new Error("must not inspect"); },
      get unclassified(): BoundedText { throw new Error("must not inspect"); },
    };
    emitFresh(service, scope, event(), "empty-selection", "live", result);
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
      emitFresh(service, scope, { ...event(), event: kind }, "other-kind", "live", {
        partial: null, provisional: null, final: { text: "Private response" }, unclassified: null,
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
      emitFresh(service,
        scope,
        { ...event(), message: "m".repeat(45_000) },
        "large-response", "live",
        { partial: null, provisional: null, final: source, unclassified: null },
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
    emitFresh(service, scope, { ...event(), message: "m".repeat(60_000) }, "priority", "live", {
      partial: { text: "Substantive answer" }, final: { text: "Final answer" }, provisional: { text: "p".repeat(10_000) }, unclassified: { text: "u".repeat(10_000) },
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
        schemaVersion: 5,
        notificationId: "0".repeat(36),
      }),
    );
    emitFresh(service,
      scope,
      { ...metadata, message: "m".repeat(65_536 - overhead) },
      "full-metadata", "live",
      { partial: null, provisional: null, final: { text: "Response" }, unclassified: null },
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
    emitFresh(service, scope, event(), "pending", "live", { partial: null, provisional: null, final: { text: "Private response" }, unclassified: null });
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      expectedRevision: 1,
    });
    await flush();
    expect(executor).not.toHaveBeenCalled();
    emitFresh(service, scope, event(1002), "new", "live", { partial: null, provisional: null, final: { text: "Private response" }, unclassified: null });
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
      partial: null, provisional: { text: "Progress" }, final: { text: "Done" }, unclassified: null,
    };
    emitFresh(service, scope, event(), "queued-selection", "live", result);
    // A repository-level update also invalidates pending work in the service.
    repository.update(scope, {
      ...config, expectedRevision: 1, delivery: config.delivery,
      assistantResultPhases: ["provisional"],
    }, 1000);
    await flush();
    expect(executor).not.toHaveBeenCalled();
    emitFresh(service, scope, event(), "queued-selection", "live", result);
    emitFresh(service, scope, event(1002), "new-selection", "live", result);
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
    for (const kind of ["turn.progress", "turn.partial", "approval.requested", "input.requested", "question.requested"] as const) {
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
    emitFresh(service, scope, event(), "one", "live");
    emitFresh(service, scope, event(), "one", "live");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toMatchObject({
      ...script,
      cwd: process.cwd(),
      payload: {
        ...event(),
        schemaVersion: 5,
        notificationId: expect.any(String),
      },
    });
    emitFresh(service, scope, event(), "one", "live");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("suppresses historical events, muted events and pending work without a resume backlog", async () => {
    const { service, executor, setNow } = fixture();
    enable(service);
    emitFresh(service, scope, event(999), "historical", "live");
    emitFresh(service, scope, event(1001), "pending", "live");
    service.setSilenced(scope, true);
    emitFresh(service, scope, event(1002), "muted", "live");
    setNow(1003);
    service.setSilenced(scope, false);
    await flush();
    emitFresh(service, scope, event(1002), "muted", "live");
    emitFresh(service, scope, event(1001), "pending", "live");
    await flush();
    expect(executor).not.toHaveBeenCalled();
    emitFresh(service, scope, event(1004), "new", "live");
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("discards pending work on config edits and never sends events to a replacement script", async () => {
    const { service, executor } = fixture();
    enable(service);
    emitFresh(service, scope, event(), "old", "live");
    service.update(scope, {
      ...config,
      delivery: config.delivery,
      expectedRevision: 1,
      scriptPath: "/replacement",
    });
    await flush();
    expect(executor).not.toHaveBeenCalled();
    emitFresh(service, scope, event(), "old", "live");
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
      emitFresh(service, scope, event(), String(index), "live");
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
      emitFresh(service,
        { tenantId: "missing", principalId: "missing" },
        event(),
        "wrong-scope", "live",
      ),
    ).not.toThrow();
    emitFresh(service, scope, event(), "failed", "live");
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

describe("early reply publication", () => {
  const threadId = randomUUID();
  const source = {event: "turn.completed" as const, applicationTurnId: "turn", applicationItemId: "item", backendCorrelations: ["operation"]};
  const eventKey = turnNotificationKey(threadId, source.applicationTurnId);
  const authority = {threadTitle: "Example", userInputRevision: 2, fresh: () => true, admitted: () => true};
  const opening = "First sentence. Another word";
  const outgoing = (frames: string[], name: string) => frames.filter(frame => frame.startsWith(`event: ${name}\n`))
    .map(frame => JSON.parse(frame.split("\n")[1]!.slice(6)));
  function native(service: NotificationService, enabled = true, who = scope) {
    const frames: string[] = [];
    const reservation = service.reserveVoiceStream(who, randomUUID(), {enabled, revision: 1});
    service.subscribe(who, frame => frames.push(frame), reservation);
    expect(frames.map(frame => frame.split("\n")[0])).toEqual(["event: notification_policy", "event: voice_early_session"]);
    const session = earlyReplySessionSchema.parse(outgoing(frames, "voice_early_session")[0]);
    return {
      id: reservation.voiceStreamId,
      update: (enabled: boolean, revision: number) => service.updateEarlyInterest(who, session.voiceStreamId, {token: session.token, enabled, revision}),
      replies: () => outgoing(frames, "voice_early_reply").map(frame => earlyReplyFrameSchema.parse(frame)),
      frames,
    };
  }
  function enableEarly(service: NotificationService) {
    service.update(scope, {...config, assistantResultPhases: ["final", "unclassified"]});
  }
  it("freezes opted-in native recipients, preserves a contiguous per-recipient sequence, and shares the ordinary terminal ID", async () => {
    const {service, executor} = fixture();
    enableEarly(service);
    const ready = native(service), optsOut = native(service), optsInLate = native(service, false), foreign = native(service, true, other);
    const browser: string[] = [];
    service.subscribe(scope, frame => browser.push(frame));
    const origin = {clientId: randomUUID()};
    const reply = service.captureEarlyReply(scope, threadId, source, () => ({...authority, origin}))!;
    const late = native(service);
    optsInLate.update(true, 2);
    reply.observe(opening, []);
    optsOut.update(false, 2);
    optsOut.update(true, 3);
    reply.observe(opening + " ends. Next sentence", []);
    reply.finish("item_done", opening + " ends. Next sentence", []);
    expect(ready.replies()).toMatchObject([
      {kind: "begin", event: "turn.completed", seq: 0, rawStart: 0, rawEnd: 15, text: "First sentence.", userInputRevision: 2, origin},
      {kind: "append", seq: 1, rawStart: 15, text: " Another word ends."},
      {kind: "append", seq: 2, text: " Next sentence"}, {kind: "yield", seq: 3, reason: "item_done"},
    ]);
    expect(optsOut.replies()).toMatchObject([{kind: "begin", seq: 0}, {kind: "yield", seq: 1, reason: "observation_ended"}]);
    for (const listener of [optsInLate, late, foreign]) expect(listener.replies()).toEqual([]);
    expect(browser).toHaveLength(1);
    expect(executor).not.toHaveBeenCalled();
    const receipt = await emitFresh(service, scope, {...event(), thread: {id: threadId, title: "Example"}}, eventKey, "live");
    expect(receipt?.sourceEventId).toBe(ready.replies()[0]!.replyId);
    expect(receipt?.voiceStreamIds).toEqual([ready.id, optsOut.id, optsInLate.id, late.id]);
    service.finishEarlyReply(scope, threadId, source.applicationTurnId, receipt);
    expect(ready.replies()).toHaveLength(4);
    expect(voiceFrames(browser)[0]?.sourceEventId).toBe(notificationSourceId(eventKey));
  });
  it("uses the progress item policy independently of completion phases and scripts", async () => {
    const {service, executor} = fixture();
    const delivery = scriptDelivery(["turn.progress"]);
    delivery["turn.completed"].voice = "none";
    service.update(scope, {...config, assistantResultPhases: [], delivery});
    const listener = native(service), offline = native(service, false);
    const capture = vi.fn(() => authority);
    expect(service.captureEarlyReply(scope, threadId, source, capture)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    const commentary = {...source, event: "turn.progress" as const};
    const early = service.captureEarlyReply(scope, threadId, commentary, capture)!;
    early.observe(opening, ["provisional", "unclassified"]);
    early.finish("item_done", opening, []);
    const key = progressNotificationKey(threadId, source.applicationTurnId, source.applicationItemId);
    const replyId = notificationSourceId(key);
    expect(listener.replies()).toMatchObject([
      {kind: "begin", event: "turn.progress", replyId, itemId: "item"}, {kind: "append", text: " Another word"}, {kind: "yield", replyId},
    ]);
    expect(offline.replies()).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
    const event = {...progress({text: opening}), thread: {id: threadId, title: authority.threadTitle}};
    const publication = emitFresh(service, scope, event, key, "live");
    service.finishEarlyProgress(scope, threadId, source.applicationTurnId, source.applicationItemId, publication);
    expect((await publication)?.voiceStreamIds).toEqual([listener.id, offline.id]);
    await flush();
    for (const device of [listener, offline]) expect(voiceFrames(device.frames)).toMatchObject([
      {sourceEventId: replyId, voice: "speak", payload: {event: "turn.progress", progress: {text: opening}}},
    ]);
    expect(executor).toHaveBeenCalledOnce();
    const nextDelivery = scriptDelivery([]);
    nextDelivery["turn.progress"].voice = "none";
    service.update(scope, {...config, assistantResultPhases: ["final"], delivery: nextDelivery, expectedRevision: 1});
    expect(service.captureEarlyReply(scope, threadId, {...commentary, applicationItemId: "other"}, capture)).toBeUndefined();
    expect(service.captureEarlyReply(scope, threadId, source, capture)).toBeDefined();
  });

  it("never speaks past the authoritative progress prefix when a later delta requires truncation", () => {
    const {service} = fixture();
    enableEarly(service);
    const listener = native(service);
    const group = service.captureEarlyReply(scope, threadId, {...source, event: "turn.progress"}, () => authority)!;
    const start = "Opening. ";
    const body = start + "a".repeat(MAX_LIVE_PROGRESS_BYTES - start.length - 3) + ".\n\n";
    group.observe(body, []);
    group.observe(body + "The rest.", []);
    const frames = listener.replies();
    const spoken = frames.flatMap(frame => frame.kind === "begin" || frame.kind === "append" ? [frame.text] : []).join("");
    expect(spoken).toBe("Opening.");
    expect(frames.at(-1)).toMatchObject({kind: "yield", reason: "limit"});
    expect(boundText(body + "The rest.", MAX_LIVE_PROGRESS_BYTES).text.startsWith(spoken)).toBe(true);
  });

  it("settles overlapping commentary, abandoned items and the final reply independently", async () => {
    const {service} = fixture();
    enableEarly(service);
    const device = native(service);
    const key = (itemId: string) => progressNotificationKey(threadId, source.applicationTurnId, itemId);
    const openProgress = (itemId: string) => {
      const group = service.captureEarlyReply(scope, threadId, {...source, event: "turn.progress", applicationItemId: itemId}, () => authority)!;
      group.observe(opening, []);
      return group;
    };
    const first = openProgress("p1");
    first.finish("item_done", opening, []);
    const next = openProgress("p2");
    next.finish("item_done", opening, []);
    const abandoned = openProgress("revised");
    abandoned.finish("source_changed");
    const final = service.captureEarlyReply(scope, threadId, source, () => authority)!;
    final.observe(opening, []);
    const progressPayload = (id: string) => ({
      ...progress(), thread: {id: threadId, title: "Example"},
      progress: {itemId: id, phase: "provisional" as const, text: opening},
    });
    let release!: (value: undefined) => void;
    const pending = new Promise<undefined>(resolve => { release = resolve; });
    const firstDecision = emitFresh(service, scope, progressPayload("p1"), key("p1"), "live", undefined, () => ({settlement: pending}));
    service.finishEarlyProgress(scope, threadId, "turn", "p1", firstDecision);
    // A later callback without an eligible recipient cannot override the first claim.
    service.finishEarlyProgress(scope, threadId, "turn", "p1");
    service.finishEarlyProgress(scope, threadId, "turn", "p1", emitFresh(service, scope, progressPayload("p1"), key("p1"), "live"));
    const nextDecision = emitFresh(service, scope, progressPayload("p2"), key("p2"), "live");
    service.finishEarlyProgress(scope, threadId, "turn", "p2", nextDecision);
    await nextDecision;
    final.finish("item_done", opening, []);
    const finalDecision = await emitFresh(service, scope, {...event(), thread: {id: threadId, title: "Example"}}, eventKey, "live");
    service.finishEarlyReply(scope, threadId, "turn", finalDecision);
    expect(device.replies().filter(frame => frame.kind === "cancel")).toMatchObject([
      {itemId: "revised", reason: "source_changed"}, {itemId: "revised", reason: "publication_suppressed"},
    ]);
    release(undefined);
    await firstDecision;
    await flush();
    expect(voiceFrames(device.frames).map(notice => notice.sourceEventId)).toEqual(
      [key("p2"), eventKey, key("p1")].map(notificationSourceId));
    expect(device.replies().filter(frame => frame.kind === "begin").map(frame => frame.replyId)).toEqual(
      [key("p1"), key("p2"), key("revised"), eventKey].map(notificationSourceId));
    service.finishEarlyProgress(scope, threadId, "turn", "p1");
    expect(device.replies().filter(frame => frame.kind === "cancel")).toHaveLength(2);
  });

  it("cancels stale commentary during playback and preserves the later ordinary decision per recipient", async () => {
    const {service, executor} = fixture();
    enableEarly(service);
    const ready = native(service);
    const fresh = vi.fn(() => true);
    const group = service.captureEarlyReply(scope, threadId, {...source, event: "turn.progress"}, () => ({...authority, fresh}))!;
    group.observe(opening, []);
    fresh.mockReturnValue(false);
    service.checkEarlyReplyFreshness(scope, threadId);
    group.observe(opening + " ends. Next.", []);
    const key = progressNotificationKey(threadId, "turn", "item");
    const payload = {...progress(), thread: {id: threadId, title: "Example"}};
    const publication = service.emit(scope, payload, key, "live", undefined, undefined, undefined,
      {userInputRevision: authority.userInputRevision, superseded: true});
    service.finishEarlyProgress(scope, threadId, "turn", "item", publication);
    await publication;
    await flush();
    expect(ready.replies()).toMatchObject([
      {kind: "begin"}, {kind: "cancel", reason: "superseded"}, {kind: "cancel", reason: "publication_suppressed"},
    ]);
    expect(voiceFrames(ready.frames)).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
  });

  it("closes a skipped commentary only for its opening recipient and still allows a reclassified partial answer", async () => {
    const {service} = fixture();
    const delivery = scriptDelivery([]);
    delivery["turn.partial"].voice = "speak";
    service.update(scope, {...config, delivery});
    const listener = native(service);
    const early = service.captureEarlyReply(scope, threadId, {...source, event: "turn.progress"}, () => authority)!;
    early.observe(opening, []);
    early.finish("source_changed");
    service.finishEarlyProgress(scope, threadId, "turn", "item");
    service.finishEarlyProgress(scope, threadId, "turn", "item");
    const late = native(service);
    const key = progressNotificationKey(threadId, "turn", "item");
    const payload: NotificationEventPayload = {...progress(), event: "turn.partial", thread: {id: threadId, title: "Example"},
      progress: {phase: "partial", itemId: "item", text: "Actual partial answer."}};
    const receipt = await emitFresh(service, scope, payload, key, "live");
    expect(receipt?.voiceStreamIds).toEqual([listener.id, late.id]);
    expect(listener.replies().map(frame => frame.kind)).toEqual(["begin", "cancel", "cancel"]);
    expect(voiceFrames(listener.frames)).toMatchObject([{payload: {event: "turn.partial"}}]);
  });

  it.each(["winner", "unclaimed"] as const)("settles an actual opened steered reply and its control receipt once (%s)", async scenario => {
    const {service, executor} = fixture();
    enableEarly(service);
    const controls = new ClientControlService();
    disposals.push(() => controls.close());
    const barrier = vi.spyOn(controls, "observeNotification");
    const complete = vi.spyOn(controls, "complete");
    const coordinator = new TurnVoiceCompletion(service, controls);
    const opened = native(service);
    const correlations = ["unanchored", "anchored", "repeated"];
    const early = service.captureEarlyReply(scope, threadId, {...source, backendCorrelations: correlations}, () => authority)!;
    early.observe(opening, []);
    early.finish("item_done", opening, []);
    const resolve = (backendCorrelation: string) => coordinator.observe(scope, threadId, {
      backendCorrelation, backendCorrelations: correlations, applicationTurnId: source.applicationTurnId,
      backendTurnId: "backend", completionIdentity: "backend:completed", outcome: "completed",
      result: {text: opening}, classifiedResult: null, provenance: "live",
    });
    const payload: NotificationEventPayload = {...event(), thread: {id: threadId, title: "Example"}};
    let release!: (target: undefined) => void;
    const settlement = new Promise<undefined>(resolve => { release = resolve; });
    const publish = vi.fn(() => emitFresh(service, scope, payload, eventKey, "live", undefined, () => ({settlement})));
    const loser = vi.fn();
    resolve(correlations[0]!)();
    expect(barrier).not.toHaveBeenCalled();
    if (scenario === "winner") {
      resolve(correlations[1]!)(publish);
      resolve(correlations[2]!)(loser);
      resolve(correlations[1]!)(loser);
    } else {
      resolve(correlations[1]!)();
      resolve(correlations[2]!)();
    }
    expect(opened.replies().map(frame => frame.kind)).toEqual(["begin", "append", "yield"]);
    expect(voiceFrames(opened.frames)).toEqual([]);
    expect(loser).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(barrier).toHaveBeenCalledOnce();
    release(undefined);
    const receipt = await barrier.mock.calls[0]![3];
    if (scenario === "winner") {
      expect(publish).toHaveBeenCalledOnce();
      expect(receipt).toEqual({sourceEventId: opened.replies()[0]!.replyId, voiceStreamIds: [opened.id]});
      expect(voiceFrames(opened.frames)).toHaveLength(1);
      expect(opened.replies().map(frame => frame.kind)).toEqual(["begin", "append", "yield"]);
      expect(executor).toHaveBeenCalledOnce();
    } else {
      expect(receipt).toBeUndefined();
      expect(executor).not.toHaveBeenCalled();
      expect(opened.replies()).toMatchObject([{kind: "begin"}, {kind: "append"}, {kind: "yield"}, {kind: "cancel", reason: "publication_suppressed"}]);
      const otherRecipient = native(service);
      resolve(correlations[1]!)(publish);
      await vi.waitFor(() => expect(voiceFrames(otherRecipient.frames)).toHaveLength(1));
      expect(voiceFrames(opened.frames)).toEqual([]);
      expect(opened.replies()).toHaveLength(4);
      expect(complete).toHaveBeenCalledOnce();
      expect(barrier).toHaveBeenCalledOnce();
    }
  });

  it("retires a yielded scanner on expiry and still confirms terminal suppression for its reservation only", async () => {
    const {service} = fixture();
    enableEarly(service);
    const listener = native(service);
    vi.useFakeTimers();
    try {
      const reply = service.captureEarlyReply(scope, threadId, source, () => authority)!;
      reply.observe(opening, []);
      vi.advanceTimersByTime(60_000);
      expect(listener.replies().at(-1)).toMatchObject({seq: 1, kind: "yield", reason: "stall"});
      vi.advanceTimersByTime(540_000);
      expect(listener.replies().at(-1)).toMatchObject({seq: 2, kind: "cancel", reason: "expired"});
      service.finishEarlyReply(scope, threadId, source.applicationTurnId, undefined);
      expect(listener.replies().at(-1)).toMatchObject({seq: 3, kind: "cancel", reason: "publication_suppressed"});
      service.finishEarlyReply(scope, threadId, source.applicationTurnId, undefined);
      expect(listener.replies()).toHaveLength(4);
      const late = native(service);
      const receipt = await emitFresh(service, scope, {...event(), thread: {id: threadId, title: "Example"}}, eventKey, "live");
      expect(receipt?.voiceStreamIds).toEqual([late.id]);
    } finally { vi.useRealTimers(); }
  });
  it("requires Final policy, initial phase order and continuing freshness and correlation", () => {
    const {service} = fixture();
    const listener = native(service);
    const capture = vi.fn(() => authority);
    expect(service.captureEarlyReply(scope, threadId, source, capture)).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    enableEarly(service);
    const blocked = service.captureEarlyReply(scope, threadId, source, capture)!;
    blocked.observe(opening, ["unclassified"]);
    expect(listener.replies()).toEqual([]);
    const admitted = vi.fn().mockReturnValue(true);
    const read = service.captureEarlyReply(scope, threadId, source, () => ({...authority, admitted}))!;
    read.observe("", []);
    admitted.mockReturnValue(false);
    read.observe(opening, []);
    expect(listener.replies()).toEqual([]);
    const fresh = vi.fn().mockReturnValue(true);
    const live = service.captureEarlyReply(scope, threadId, source, () => ({...authority, fresh}))!;
    live.observe(opening, []);
    fresh.mockReturnValue(false);
    service.checkEarlyReplyFreshness(scope, threadId);
    live.observe(opening + " ends. More words.", []);
    expect(listener.replies()).toMatchObject([{kind: "begin"}, {kind: "cancel", reason: "superseded"}]);
  });
  it("bounds open turns, releases disconnected observers, and leaves room for definitive suppression at the frame limit", () => {
    const {service} = fixture();
    enableEarly(service);
    const stale = service.reserveVoiceStream(scope, randomUUID(), {enabled: true, revision: 1});
    service.subscribe(scope, () => {}, stale);
    for (let index = 0; index < 64; index++) {
      const captured = service.captureEarlyReply(scope, threadId, {...source, applicationTurnId: String(index)}, () => authority);
      expect(captured).toBeDefined();
    }
    expect(service.captureEarlyReply(scope, threadId, source, () => authority)).toBeUndefined();
    stale.release();
    const listener = native(service);
    const captured = service.captureEarlyReply(scope, threadId, source, () => authority)!;
    captured.observe("Alpha. ".repeat(300) + "More text.", []);
    expect(listener.replies().at(-1)).toMatchObject({kind: "yield", reason: "limit"});
    service.setSilenced(scope, true);
    service.finishEarlyReply(scope, threadId, source.applicationTurnId, undefined);
    expect(listener.replies().slice(-2)).toMatchObject([
      {kind: "cancel", seq: 255, reason: "policy_changed"}, {kind: "cancel", seq: 256, reason: "publication_suppressed"},
    ]);
  });
  it("revokes buffered speech when policy changes after a markup yield", () => {
    const {service} = fixture();
    enableEarly(service);
    const listener = native(service);
    const reply = service.captureEarlyReply(scope, threadId, source, () => authority)!;
    reply.observe(opening + " **bold**", []);
    service.setSilenced(scope, true);
    expect(listener.replies()).toMatchObject([{kind: "begin"}, {kind: "yield", reason: "markup"}, {kind: "cancel", reason: "policy_changed"}]);
  });
});
