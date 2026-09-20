import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  notificationSettingsSchema,
  type NotificationSettings,
  type UpdateNotificationSettingsRequest,
} from "../../../shared/protocol/notification.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> =
  Object.freeze({
    enabled: false,
    assistantResultPhases: [],
    scriptPath: "",
    arguments: [],
    timeoutSeconds: 30,
    events: [
      "turn.completed",
      "turn.failed",
      "thread.woke",
      "automation.started",
      "automation.failed",
    ],
    silenced: false,
    revision: 0,
  } satisfies NotificationSettings);
const MAX_CONSUMPTION_MARKERS = 10_000;
type Row = {
  configJson: string;
  silenced: number;
  revision: number;
  dispatchGeneration: number;
  eventStartAt: number;
  dedupBefore: number;
};
export type NotificationDispatchSettings = {
  readonly settings: NotificationSettings;
  readonly generation: number;
};

export class NotificationRepository {
  constructor(readonly database: Database.Database) {}

  assertScope(scope: RequestScope): void {
    if (
      !this.database
        .prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ?")
        .get(scope.tenantId, scope.principalId)
    ) {
      throw new DomainError(
        "not_found",
        "Notification settings are unavailable.",
      );
    }
  }

  read(scope: RequestScope): NotificationSettings {
    this.assertScope(scope);
    return this.#settings(this.#row(scope));
  }

  readDispatch(scope: RequestScope): NotificationDispatchSettings {
    this.assertScope(scope);
    const row = this.#row(scope);
    return {
      settings: this.#settings(row),
      generation: row?.dispatchGeneration ?? 0,
    };
  }

  update(
    scope: RequestScope,
    input: UpdateNotificationSettingsRequest,
    now: number,
  ): NotificationSettings {
    return this.database.transaction(() => {
      const current = this.read(scope);
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "conflict",
          "Notification settings changed before this update.",
        );
      }
      const { expectedRevision: _expectedRevision, ...config } = input;
      this.#ensure(scope, now);
      this.database
        .prepare(
          `UPDATE principal_notification_settings
        SET config_json = ?, revision = revision + 1,
            dispatch_generation = dispatch_generation + 1, event_start_at = max(event_start_at, ?)
        WHERE tenant_id = ? AND owner_principal_id = ?`,
        )
        .run(JSON.stringify(config), now, scope.tenantId, scope.principalId);
      return this.read(scope);
    })();
  }

  setSilenced(
    scope: RequestScope,
    silenced: boolean,
    now: number,
  ): NotificationSettings {
    return this.database.transaction(() => {
      const current = this.read(scope);
      if (current.silenced === silenced) return current;
      this.#ensure(scope, now);
      this.database
        .prepare(
          `UPDATE principal_notification_settings
        SET silenced = ?, dispatch_generation = dispatch_generation + 1,
            event_start_at = max(event_start_at, ?)
        WHERE tenant_id = ? AND owner_principal_id = ?`,
        )
        .run(silenced ? 1 : 0, now, scope.tenantId, scope.principalId);
      return this.read(scope);
    })();
  }

  /** Claim once, including muted/unselected events. No execution outcome is retained. */
  consume(
    scope: RequestScope,
    eventKey: string,
    occurredAt: number,
  ): NotificationDispatchSettings | null {
    return this.database.transaction(() => {
      this.assertScope(scope);
      const row = this.#row(scope);
      // A future configuration establishes a timestamp floor, so no unconfigured backlog is kept.
      if (
        !row ||
        occurredAt < row.eventStartAt ||
        occurredAt <= row.dedupBefore
      )
        return null;
      const hash = createHash("sha256").update(eventKey).digest("hex");
      const claimed = this.database
        .prepare(
          `INSERT OR IGNORE INTO notification_event_consumption
        (tenant_id, owner_principal_id, event_key, occurred_at) VALUES (?, ?, ?, ?)`,
        )
        .run(scope.tenantId, scope.principalId, hash, occurredAt);
      if (claimed.changes !== 1) return null;

      // Keep a bounded set and advance a timestamp floor before discarding old keys.
      // Very late observations below that floor are intentionally suppressed, never replayed.
      const cutoff = this.database
        .prepare(
          `SELECT occurred_at AS cutoff
        FROM notification_event_consumption WHERE tenant_id = ? AND owner_principal_id = ?
        ORDER BY occurred_at DESC LIMIT 1 OFFSET ?`,
        )
        .get(scope.tenantId, scope.principalId, MAX_CONSUMPTION_MARKERS) as
        { cutoff: number } | undefined;
      if (cutoff) {
        this.database
          .prepare(
            `UPDATE principal_notification_settings SET dedup_before = max(dedup_before, ?)
          WHERE tenant_id = ? AND owner_principal_id = ?`,
          )
          .run(cutoff.cutoff, scope.tenantId, scope.principalId);
        this.database
          .prepare(
            `DELETE FROM notification_event_consumption
          WHERE tenant_id = ? AND owner_principal_id = ? AND occurred_at <= ?`,
          )
          .run(scope.tenantId, scope.principalId, cutoff.cutoff);
      }
      return {
        settings: this.#settings(row),
        generation: row.dispatchGeneration,
      };
    })();
  }

  #row(scope: RequestScope): Row | undefined {
    return this.database
      .prepare(
        `SELECT config_json AS configJson, silenced, revision,
      dispatch_generation AS dispatchGeneration, event_start_at AS eventStartAt,
      dedup_before AS dedupBefore FROM principal_notification_settings
      WHERE tenant_id = ? AND owner_principal_id = ?`,
      )
      .get(scope.tenantId, scope.principalId) as Row | undefined;
  }

  #settings(row: Row | undefined): NotificationSettings {
    return notificationSettingsSchema.parse(
      row
        ? {
            ...JSON.parse(row.configJson),
            silenced: row.silenced === 1,
            revision: row.revision,
          }
        : DEFAULT_NOTIFICATION_SETTINGS,
    );
  }

  #ensure(scope: RequestScope, now: number): void {
    const {
      silenced: _silenced,
      revision: _revision,
      ...config
    } = DEFAULT_NOTIFICATION_SETTINGS;
    this.database
      .prepare(
        `INSERT OR IGNORE INTO principal_notification_settings
      (tenant_id, owner_principal_id, config_json, silenced, revision, dispatch_generation, event_start_at)
      VALUES (?, ?, ?, 0, 0, 0, ?)`,
      )
      .run(scope.tenantId, scope.principalId, JSON.stringify(config), now);
  }
}
