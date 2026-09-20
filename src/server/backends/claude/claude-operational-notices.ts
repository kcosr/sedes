import type { RuntimeNotice } from "../../../shared/protocol/conversation.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";

const MAXIMUM_RETAINED_NOTICE_IDS = 256;
const MAXIMUM_NATIVE_IDENTIFIER_BYTES = 512;
const MAXIMUM_INFORMATIONAL_BYTES = 128 * 1_024;
const MAXIMUM_API_RETRIES = 100;
const MAXIMUM_RETRY_DELAY_MS = 60 * 60 * 1_000;

const API_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);

/**
 * Projects a deliberately transient subset of Claude operational telemetry.
 * These notices are never transcript, turn-terminal, fork, or recovery
 * evidence. Task, tool-progress, background-task, and child-session messages
 * intentionally remain outside this presentation-only rail.
 */
export class ClaudeOperationalNoticeProjector {
  readonly #sessionId: string;
  readonly #retainedIds = new Set<string>();
  readonly #retainedIdOrder: string[] = [];

  constructor(sessionId: string) {
    if (!boundedIdentifier(sessionId)) {
      throw new Error("claude_operational_notice_session_invalid");
    }
    this.#sessionId = sessionId;
  }

  project(
    message: unknown,
    now: number | (() => number),
  ): RuntimeNotice | undefined {
    if (!isPlainRecord(message)) return undefined;
    const uuid = ownString(message, "uuid");
    const sessionId = ownString(message, "session_id");
    if (
      !boundedNoticeUuid(uuid) ||
      sessionId !== this.#sessionId ||
      !boundedIdentifier(sessionId)
    ) {
      return undefined;
    }

    const projected = projectMessage(message, uuid, now);
    if (!projected || this.#retainedIds.has(projected.id)) return undefined;
    this.#retainedIds.add(projected.id);
    this.#retainedIdOrder.push(projected.id);
    while (this.#retainedIdOrder.length > MAXIMUM_RETAINED_NOTICE_IDS) {
      const released = this.#retainedIdOrder.shift();
      if (released !== undefined) this.#retainedIds.delete(released);
    }
    return projected;
  }
}

function projectMessage(
  message: Readonly<Record<string, unknown>>,
  uuid: string,
  now: number | (() => number),
): RuntimeNotice | undefined {
  const type = ownString(message, "type");
  const subtype = ownString(message, "subtype");
  if (type === "system" && subtype === "api_retry") {
    return projectApiRetry(message, uuid, now);
  }
  if (type === "rate_limit_event" && subtype === undefined) {
    return projectRateLimit(message, uuid, now);
  }
  if (type === "system" && subtype === "informational") {
    return projectInformational(message, uuid, now);
  }
  return undefined;
}

function projectApiRetry(
  message: Readonly<Record<string, unknown>>,
  uuid: string,
  now: number | (() => number),
): RuntimeNotice | undefined {
  const attempt = ownNumber(message, "attempt");
  const maximum = ownNumber(message, "max_retries");
  const delayMs = ownNumber(message, "retry_delay_ms");
  const error = ownString(message, "error");
  const errorStatus = ownValue(message, "error_status");
  if (
    !safeIntegerBetween(attempt, 1, MAXIMUM_API_RETRIES) ||
    !safeIntegerBetween(maximum, attempt, MAXIMUM_API_RETRIES) ||
    !safeIntegerBetween(delayMs, 0, MAXIMUM_RETRY_DELAY_MS) ||
    error === undefined ||
    !API_ERRORS.has(error) ||
    !(errorStatus === null || safeIntegerBetween(errorStatus, 100, 599))
  ) {
    return undefined;
  }
  const delaySeconds = Math.ceil(delayMs / 1_000);
  return notice(
    uuid,
    attempt === maximum ? "warning" : "info",
    `Claude API request failed (${error}); retrying ${attempt}/${maximum}${
      delaySeconds > 0 ? ` in ${delaySeconds}s` : ""
    }.`,
    now,
  );
}

function projectRateLimit(
  message: Readonly<Record<string, unknown>>,
  uuid: string,
  now: number | (() => number),
): RuntimeNotice | undefined {
  const info = ownValue(message, "rate_limit_info");
  if (!isPlainRecord(info)) return undefined;
  const status = ownString(info, "status");
  if (status === "allowed") return undefined;
  if (status === "allowed_warning") {
    return notice(
      uuid,
      "warning",
      "Claude usage is approaching its current limit.",
      now,
    );
  }
  if (status === "rejected") {
    return notice(
      uuid,
      "error",
      "Claude usage is currently limited; new requests may be rejected.",
      now,
    );
  }
  return undefined;
}

function projectInformational(
  message: Readonly<Record<string, unknown>>,
  uuid: string,
  now: number | (() => number),
): RuntimeNotice | undefined {
  const content = ownString(message, "content");
  const level = ownString(message, "level");
  const preventContinuation = ownValue(message, "prevent_continuation");
  const toolUseId = ownValue(message, "tool_use_id");
  if (
    content === undefined ||
    content.trim().length === 0 ||
    Buffer.byteLength(content, "utf8") > MAXIMUM_INFORMATIONAL_BYTES ||
    !new Set(["info", "notice", "suggestion", "warning"]).has(level ?? "") ||
    !(
      preventContinuation === undefined ||
      typeof preventContinuation === "boolean"
    ) ||
    !(
      toolUseId === undefined ||
      (typeof toolUseId === "string" && boundedIdentifier(toolUseId))
    )
  ) {
    return undefined;
  }
  // SDK `info` is transcript-mode chatter. Sedes has no transcript-mode
  // operational rail, so intentionally suppress it rather than persisting it.
  if (level === "info") return undefined;
  return notice(
    uuid,
    level === "warning" || preventContinuation === true ? "warning" : "info",
    content,
    now,
  );
}

function notice(
  uuid: string,
  tone: RuntimeNotice["tone"],
  message: string,
  now: number | (() => number),
): RuntimeNotice | undefined {
  const timestamp = typeof now === "function" ? now() : now;
  if (!validTimestamp(timestamp)) return undefined;
  return {
    id: `claude-notice:${uuid}`,
    tone,
    message: boundDisplayText(message),
    createdAt: new Date(timestamp).toISOString(),
  };
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function safeIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_NATIVE_IDENTIFIER_BYTES &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_NATIVE_IDENTIFIER_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedNoticeUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(
  value: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const candidate = ownValue(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}

function ownNumber(
  value: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined {
  const candidate = ownValue(value, field);
  return typeof candidate === "number" ? candidate : undefined;
}
