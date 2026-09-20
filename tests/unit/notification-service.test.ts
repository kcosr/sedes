import { notificationAssistantResultMigration } from "../../src/server/db/migrations/103-notification-assistant-result.js";
import { notificationAssistantResultPhasesMigration } from "../../src/server/db/migrations/105-notification-assistant-result-phases.js";
import { notificationPhaseSelectionMigration } from "../../src/server/db/migrations/106-notification-phase-selection.js";
import type { BoundedText } from "../../src/shared/protocol/payload.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationEventKindSchema,
  notificationSettingsSchema,
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
  type NotificationEventPayload,
  type NotificationAssistantResultPhase,
  type NotificationTestResult,
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
  events: ["turn.completed"] as const,
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
function enable(service: NotificationService) {
  return service.update(scope, { ...config, events: [...config.events] });
}
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe("notification settings and passive hooks", () => {
  it.each([true, false])("migrates the old master setting %s to effective phase selections without changing principal state", (included) => {
    const { service, database, repository } = fixture();
    expect(service.read(scope)).toMatchObject({ assistantResultPhases: [] });
    expect(service.read(scope)).not.toHaveProperty("includeAssistantResult");
    service.update(scope, {
      ...config, events: [...config.events], assistantResultPhases: ["provisional", "final"],
    });
    service.setSilenced(scope, true);
    repository.update(other, { ...config, events: ["turn.failed"], assistantResultPhases: [] }, 1234);
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
      assistantResultPhases: [], silenced: false, events: ["turn.failed"],
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
    repository.update(other, { ...config, events: ["turn.failed"] }, 1234);
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
    expect(repository.read(other)).toMatchObject({ assistantResultPhases: [], silenced: false, events: ["turn.failed"] });
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
      events: [...config.events],
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
      ...config, events: [...config.events],
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
    service.update(scope, { ...config, events: [...config.events], assistantResultPhases: ["final"] });
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
      ...config, events: [...config.events], assistantResultPhases: [],
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
        events: [kind],
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
        events: [...config.events],
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
      ...config, events: [...config.events], assistantResultPhases: ["provisional", "final", "unclassified"],
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
      events: [...config.events],
      assistantResultPhases: ["final"],
    });
    const metadata = event();
    const overhead = Buffer.byteLength(
      JSON.stringify({
        ...metadata,
        message: "",
        schemaVersion: 3,
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
      events: [...config.events],
      assistantResultPhases: ["final"],
    });
    service.emit(scope, event(), "pending", { provisional: null, final: { text: "Private response" }, unclassified: null });
    service.update(scope, {
      ...config,
      events: [...config.events],
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
      ...config, events: [...config.events], assistantResultPhases: ["final"],
    });
    const result = {
      provisional: { text: "Progress" }, final: { text: "Done" }, unclassified: null,
    };
    service.emit(scope, event(), "queued-selection", result);
    // A repository-level update also invalidates pending work in the service.
    repository.update(scope, {
      ...config, expectedRevision: 1, events: [...config.events],
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

  it("accepts every notification category together without changing existing defaults", () => {
    const { service } = fixture();
    expect(service.read(scope).events).not.toContain("question.requested");
    const events = [...notificationEventKindSchema.options];
    expect(service.update(scope, { ...config, events }).events).toEqual(events);
    expect(
      updateNotificationSettingsRequestSchema.safeParse({
        ...config,
        events: ["question.requested", "question.requested"],
      }).success,
    ).toBe(false);
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
      service.update(wrong, { ...config, events: [...config.events] }),
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
      events: [...config.events],
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
        events: [...config.events],
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
    repository.update(scope, { ...config, events: [...config.events] }, 1000);
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
        schemaVersion: 3,
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
      events: [...config.events],
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
