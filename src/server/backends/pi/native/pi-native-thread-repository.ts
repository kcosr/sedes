import type Database from "better-sqlite3";
import { PiSessionClaims } from "../pi-session-claims.js";
import { DomainError } from "../../../domain/errors.js";
import type { RequestScope } from "../../../identity/identity-provider.js";

/** Pi-owned persistence for binding details, settings, and correlations. */
export type PiNativeThreadSettingsRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: string | null;
  readonly toolMode: "read_only" | "ask" | "full";
  readonly revision: number;
};

export type PiNativeBindingDetailsRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly opaqueBindingDetail: string;
  readonly nativeSessionPath: string;
};

export type PiNativeSubmissionDetailsRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly operationId: string;
  readonly creationAttemptId: string | null;
  readonly acceptedUserEntryId: string | null;
};

export interface PiNativeOperationRecord {
  readonly prepareAttempt: number;
  readonly dispatchStarted: boolean;
  readonly requestHash: string;
  readonly state: "prepared" | "sent" | "completed" | "unknown";
  readonly receiptJson: string | null;
}

const piThinkingLevels = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function validateThinkingLevel(value: string | null | undefined): void {
  if (value !== null && value !== undefined && !piThinkingLevels.has(value)) {
    throw new DomainError(
      "conflict",
      "The Pi thinking level is not supported.",
    );
  }
}

export class PiNativeThreadRepository {
  constructor(readonly database: Database.Database) {}

  #assertNativeThread(scope: RequestScope, applicationThreadId: string): void {
    const row = this.database.prepare(`SELECT 1 FROM application_threads AS thread
      JOIN agent_backend_instances AS backend ON backend.tenant_id = thread.tenant_id
        AND backend.id = thread.backend_instance_id
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?
        AND backend.kind = 'pi_native'`).get(scope.tenantId, scope.principalId, applicationThreadId);
    if (!row) throw new DomainError("not_found", "The Pi thread was not found.");
  }

  prepareOperation(scope: RequestScope, applicationThreadId: string, input: {
    readonly operationId: string;
    readonly kind: "submission" | "action" | "interrupt";
    readonly requestHash: string;
  }): PiNativeOperationRecord {
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
      throw new DomainError("bad_request", "The Pi operation request hash is invalid.");
    }
    return this.database.transaction(() => {
      // Requiring native settings also rejects wrong-scope or wrong-backend callers.
      this.getSettings(scope, applicationThreadId);
      this.database.prepare(`INSERT INTO pi_native_operations
        (tenant_id, owner_principal_id, application_thread_id, operation_id,
         operation_kind, request_hash, state)
        VALUES (?, ?, ?, ?, ?, ?, 'prepared')
        ON CONFLICT (tenant_id, owner_principal_id, application_thread_id, operation_id)
        DO NOTHING`).run(scope.tenantId,
          scope.principalId, applicationThreadId, input.operationId, input.kind,
          input.requestHash);
      const row = this.database.prepare(`SELECT operation_kind AS kind,
        request_hash AS requestHash
        FROM pi_native_operations WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND operation_id = ?`).get(scope.tenantId,
            scope.principalId, applicationThreadId, input.operationId) as { readonly kind: string; readonly requestHash: string };
      if (row.requestHash !== input.requestHash || row.kind !== input.kind) {
        throw new DomainError("conflict", "The Pi operation identity was reused with different input.");
      }
      return this.getOperation(scope, applicationThreadId, input.operationId)!;
    })();
  }

  getOperation(scope: RequestScope, applicationThreadId: string, operationId: string): PiNativeOperationRecord | undefined {
    const row = this.database.prepare(`SELECT request_hash AS requestHash,
      state, prepare_attempt AS prepareAttempt, dispatch_started AS dispatchStarted, receipt_json AS receiptJson FROM pi_native_operations
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
        AND operation_id = ?`).get(scope.tenantId, scope.principalId,
          applicationThreadId, operationId) as (Omit<PiNativeOperationRecord, "dispatchStarted"> & { readonly dispatchStarted: number }) | undefined;
    return row ? { ...row, dispatchStarted: row.dispatchStarted === 1 } : undefined;
  }

  /** Persist before the prompt/steer request can leave this process. */
  markSubmissionDispatched(scope: RequestScope, applicationThreadId: string, operationId: string,
    requestHash: string, prepareAttempt: number): PiNativeOperationRecord {
    return this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE pi_native_operations SET dispatch_started = 1
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
          AND operation_id = ? AND operation_kind = 'submission' AND request_hash = ?
          AND state = 'sent' AND receipt_json IS NULL AND prepare_attempt = ?`).run(scope.tenantId, scope.principalId,
            applicationThreadId, operationId, requestHash, prepareAttempt);
      if (result.changes !== 1) throw new DomainError("conflict", "The Pi submission cannot cross its dispatch boundary.");
      return this.getOperation(scope, applicationThreadId, operationId)!;
    })();
  }

  completeOperation(scope: RequestScope, applicationThreadId: string, operationId: string, input: {
    readonly state: PiNativeOperationRecord["state"];
    readonly receiptJson?: string;
  }): PiNativeOperationRecord {
    return this.database.transaction(() => {
      const current = this.getOperation(scope, applicationThreadId, operationId);
      if (!current) throw new DomainError("not_found", "The Pi operation was not found.");
      if (current.state === "completed") {
        if (input.state !== "completed" || current.receiptJson !== (input.receiptJson ?? null))
          throw new DomainError("conflict", "The completed Pi operation has a different result.");
        return current;
      }
      if (input.state === "prepared" && current.state !== "prepared")
        throw new DomainError("conflict", "The Pi operation cannot return to an unsent state.");
      if (input.receiptJson !== undefined) JSON.parse(input.receiptJson);
      this.database.prepare(`UPDATE pi_native_operations SET state = ?, receipt_json = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
          AND operation_id = ?`).run(input.state, input.receiptJson ?? null,
            scope.tenantId, scope.principalId, applicationThreadId, operationId);
      return this.getOperation(scope, applicationThreadId, operationId)!;
    })();
  }

  /** Only the caller holding positive non-dispatch evidence may use this transition. */
  resetUnsentOperation(scope: RequestScope, applicationThreadId: string, operationId: string, requestHash: string, prepareAttempt: number): PiNativeOperationRecord {
    return this.database.transaction(() => {
      const result = this.database.prepare(`UPDATE pi_native_operations SET state = 'prepared', prepare_attempt = prepare_attempt + 1
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
          AND operation_id = ? AND operation_kind = 'submission' AND request_hash = ?
          AND state = 'sent' AND dispatch_started = 0 AND receipt_json IS NULL AND prepare_attempt = ?`).run(scope.tenantId, scope.principalId,
            applicationThreadId, operationId, requestHash, prepareAttempt);
      if (result.changes !== 1) throw new DomainError("conflict", "The Pi operation cannot return to an unsent state.");
      return this.getOperation(scope, applicationThreadId, operationId)!;
    })();
  }

  initializeSettings(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly modelProvider?: string;
      readonly modelId?: string;
      readonly thinkingLevel?: string;
      readonly toolMode: "read_only" | "ask" | "full";
    },
  ): PiNativeThreadSettingsRecord {
    if ((input.modelProvider === undefined) !== (input.modelId === undefined)) {
      throw new DomainError(
        "conflict",
        "Model provider and model ID must be set or omitted together.",
      );
    }
    validateThinkingLevel(input.thinkingLevel);
    this.database
      .prepare(
        `
          INSERT INTO pi_native_thread_settings(
            tenant_id, owner_principal_id, application_thread_id,
            model_provider, model_id, thinking_level, tool_mode, revision
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (tenant_id, owner_principal_id, application_thread_id)
          DO NOTHING
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.modelProvider ?? null,
        input.modelId ?? null,
        input.thinkingLevel ?? null,
        input.toolMode,
      );
    return this.getSettings(scope, applicationThreadId);
  }

  initializeForkSettings(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly modelProvider?: string;
      readonly modelId?: string;
      readonly thinkingLevel?: string;
      readonly toolMode: "read_only" | "ask" | "full";
    },
  ): PiNativeThreadSettingsRecord {
    const settings = this.initializeSettings(scope, applicationThreadId, input);
    if (
      settings.modelProvider !== (input.modelProvider ?? null) ||
      settings.modelId !== (input.modelId ?? null) ||
      settings.thinkingLevel !== (input.thinkingLevel ?? null) ||
      settings.toolMode !== input.toolMode
    ) {
      throw new DomainError(
        "conflict",
        "The Pi fork settings were already initialized differently.",
      );
    }
    return settings;
  }

  getBindingDetails(
    scope: RequestScope,
    applicationThreadId: string,
  ): PiNativeBindingDetailsRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT detail.tenant_id AS tenantId,
            detail.owner_principal_id AS ownerPrincipalId,
            detail.application_thread_id AS applicationThreadId,
            detail.backend_instance_id AS backendInstanceId,
            detail.execution_environment_id AS executionEnvironmentId,
            binding.backend_conversation_id AS backendConversationId,
            detail.opaque_binding_detail AS opaqueBindingDetail,
            detail.native_session_path AS nativeSessionPath
          FROM pi_native_binding_details AS detail
          JOIN conversation_bindings AS binding
            ON binding.tenant_id = detail.tenant_id
            AND binding.owner_principal_id = detail.owner_principal_id
            AND binding.application_thread_id = detail.application_thread_id
          WHERE detail.tenant_id = ? AND detail.owner_principal_id = ?
            AND detail.application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      PiNativeBindingDetailsRecord | undefined;
  }

  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    return this.getBindingDetails(scope, applicationThreadId)
      ?.opaqueBindingDetail;
  }

  saveBindingDetails(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly backendConversationId: string;
      readonly opaqueBindingDetail: string;
      readonly nativeSessionPath: string;
    },
  ): PiNativeBindingDetailsRecord {
    return this.database.transaction(() => {
      new PiSessionClaims(this.database).claimBound(scope, applicationThreadId,
        { sessionId: input.backendConversationId, sessionFile: input.nativeSessionPath });
      this.#assertNativeThread(scope, applicationThreadId);
      const existing = this.getBindingDetails(scope, applicationThreadId);
      if (existing) {
        if (existing.opaqueBindingDetail !== input.opaqueBindingDetail) {
          throw new DomainError(
            "conflict",
            "The Pi binding already has different opaque binding details.",
          );
        }
        if (
          existing.nativeSessionPath !== input.nativeSessionPath ||
          existing.backendConversationId !== input.backendConversationId
        ) {
          throw new DomainError(
            "conflict",
            "The Pi binding already has different opaque binding details.",
          );
        }
        return existing;
      }
      const binding = this.database
        .prepare(
          `
            SELECT backend_instance_id AS backendInstanceId,
              execution_environment_id AS executionEnvironmentId,
              backend_conversation_id AS backendConversationId
            FROM conversation_bindings
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId) as
        | {
            backendInstanceId: string;
            executionEnvironmentId: string;
            backendConversationId: string;
          }
        | undefined;
      if (!binding) {
        throw new DomainError(
          "not_found",
          "The conversation binding was not found.",
        );
      }
      if (binding.backendConversationId !== input.backendConversationId) {
        throw new DomainError(
          "conflict",
          "The Pi opaque binding identity does not match the conversation binding.",
        );
      }
      try {
        this.database
          .prepare(
            `
              INSERT INTO pi_native_binding_details(
                tenant_id, owner_principal_id, application_thread_id,
                backend_instance_id, execution_environment_id,
                opaque_binding_detail, native_session_path
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            applicationThreadId,
            binding.backendInstanceId,
            binding.executionEnvironmentId,
            input.opaqueBindingDetail,
            input.nativeSessionPath,
          );
      } catch (error) {
        if (piOwnershipConstraint(error)) {
          throw new DomainError(
            "conflict",
            "This backend conversation is already attached to another thread.",
            false,
            { cause: error },
          );
        }
        throw error;
      }
      return this.getBindingDetails(scope, applicationThreadId)!;
    })();
  }

  getSettings(
    scope: RequestScope,
    applicationThreadId: string,
  ): PiNativeThreadSettingsRecord {
    const row = this.database
      .prepare(
        `
          SELECT tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            application_thread_id AS applicationThreadId,
            model_provider AS modelProvider,
            model_id AS modelId,
            thinking_level AS thinkingLevel,
            tool_mode AS toolMode,
            revision
          FROM pi_native_thread_settings
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      PiNativeThreadSettingsRecord | undefined;
    if (!row) throw new DomainError("not_found", "Pi settings were not found.");
    return row;
  }

  updateSettings(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly modelProvider: string | null;
      readonly modelId: string | null;
      readonly thinkingLevel: string | null;
      readonly toolMode: "read_only" | "ask" | "full";
    },
  ): PiNativeThreadSettingsRecord {
    if ((input.modelProvider === null) !== (input.modelId === null)) {
      throw new DomainError(
        "conflict",
        "Model provider and model ID must be set or cleared together.",
      );
    }
    validateThinkingLevel(input.thinkingLevel);
    const result = this.database
      .prepare(
        `
          UPDATE pi_native_thread_settings
          SET model_provider = ?, model_id = ?, thinking_level = ?,
            tool_mode = ?, revision = revision + 1
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = ?
        `,
      )
      .run(
        input.modelProvider,
        input.modelId,
        input.thinkingLevel,
        input.toolMode,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "Pi settings changed or were not found.",
      );
    }
    return this.getSettings(scope, applicationThreadId);
  }

  /**
   * Overwrite the backend-owned axes (model, thinking) from the attached
   * session's observed effective settings. Tool access is Sedes-owned
   * policy and is deliberately not touched. The revision compare-and-set
   * keeps an exactly concurrent explicit selection safe; the next
   * observation retries because the live session remains the authority.
   */
  syncObservedSettings(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly modelProvider: string;
      readonly modelId: string;
      readonly thinkingLevel: string;
    },
  ): void {
    validateThinkingLevel(input.thinkingLevel);
    const result = this.database
      .prepare(
        `
          UPDATE pi_native_thread_settings
          SET model_provider = ?, model_id = ?, thinking_level = ?,
            revision = revision + 1
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = ?
        `,
      )
      .run(
        input.modelProvider,
        input.modelId,
        input.thinkingLevel,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "Pi settings changed or were not found.",
      );
    }
  }

  /**
   * Adopt the attached session's observed model/thinking only after the
   * Sedes thread is bound. A reserved or creating Pi session still carries
   * Pi's own default/session-resolved axes and is not authoritative over the
   * user's durable draft selections; first-send initialization applies those
   * selections before the thread becomes bound.
   */
  syncObservedSettingsForBoundThread(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly modelProvider: string;
      readonly modelId: string;
      readonly thinkingLevel: string;
    },
  ): boolean {
    const target = this.database
      .prepare(
        `
          SELECT backing_state AS backingState
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | { readonly backingState: string }
      | undefined;
    if (!target) {
      throw new DomainError(
        "conflict",
        "Pi settings changed or were not found.",
      );
    }
    if (target.backingState !== "bound") return false;
    const current = this.getSettings(scope, applicationThreadId);
    if (
      current.modelProvider === input.modelProvider &&
      current.modelId === input.modelId &&
      current.thinkingLevel === null
    ) {
      // A Sedes model action deliberately clears the durable effort because
      // Pi may clamp the live session to a model-specific value. Keep that
      // staged state unresolved until an explicit thinking-level action
      // establishes the desired tuple.
      return false;
    }
    if (
      current.modelProvider === input.modelProvider &&
      current.modelId === input.modelId &&
      current.thinkingLevel === input.thinkingLevel
    ) {
      return false;
    }
    this.syncObservedSettings(scope, applicationThreadId, {
      expectedRevision: current.revision,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
    });
    return true;
  }

  createSubmissionDetails(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly operationId: string;
      readonly creationAttemptId?: string;
    },
  ): PiNativeSubmissionDetailsRecord {
    this.#assertNativeThread(scope, applicationThreadId);
    return this.database.transaction(() => {
      const existing = this.findSubmissionDetails(
        scope,
        applicationThreadId,
        input.operationId,
      );
      if (existing) {
        if (existing.creationAttemptId !== (input.creationAttemptId ?? null)) {
          throw new DomainError(
            "conflict",
            "The Pi operation ID was reused with different submission details.",
          );
        }
        return existing;
      }
      this.database
        .prepare(
          `
            INSERT INTO pi_native_submission_details(
              tenant_id, owner_principal_id, application_thread_id,
              operation_id, creation_attempt_id
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.operationId,
          input.creationAttemptId ?? null,
        );
      return this.getSubmissionDetails(
        scope,
        applicationThreadId,
        input.operationId,
      );
    })();
  }

  recordAcceptedUserEntry(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
    acceptedUserEntryId: string,
  ): PiNativeSubmissionDetailsRecord {
    const result = this.database
      .prepare(
        `
          UPDATE pi_native_submission_details
          SET accepted_user_entry_id = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND operation_id = ?
            AND (
              accepted_user_entry_id IS NULL OR accepted_user_entry_id = ?
            )
        `,
      )
      .run(
        acceptedUserEntryId,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        operationId,
        acceptedUserEntryId,
      );
    if (result.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The Pi submission is missing or has a different accepted entry.",
      );
    }
    return this.getSubmissionDetails(scope, applicationThreadId, operationId);
  }

  getSubmissionDetails(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
  ): PiNativeSubmissionDetailsRecord {
    const row = this.findSubmissionDetails(
      scope,
      applicationThreadId,
      operationId,
    );
    if (!row) {
      throw new DomainError(
        "not_found",
        "Pi submission details were not found.",
      );
    }
    return row;
  }

  findSubmissionDetails(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
  ): PiNativeSubmissionDetailsRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT tenant_id AS tenantId,
            owner_principal_id AS ownerPrincipalId,
            application_thread_id AS applicationThreadId,
            operation_id AS operationId,
            creation_attempt_id AS creationAttemptId,
            accepted_user_entry_id AS acceptedUserEntryId
          FROM pi_native_submission_details
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND operation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        operationId,
      ) as PiNativeSubmissionDetailsRecord | undefined;
  }
}

function piOwnershipConstraint(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    /pi_native_binding_details[^\n]*native_session_path/i.test(message)
  );
}
