import { createHash } from "node:crypto";

import type { BackendItem } from "../../../shared/protocol/backend.js";
import {
  boundDisplayText,
  boundText,
} from "../../conversations/payload-policy.js";

const MAXIMUM_IDENTIFIER_BYTES = 1_024;
const MAXIMUM_RETAINED_PROGRESS_TOOL_NAMES = 16;

type CollaborationItem = Extract<
  BackendItem,
  { semanticKind: "collaboration" }
>;

interface GrokSubagentEventBase {
  readonly sessionId: string;
  readonly subagentId: string;
  readonly childSessionId: string;
}

interface GrokDurableSubagentEventBase extends GrokSubagentEventBase {
  readonly eventId: string;
  readonly replay: boolean;
  readonly promptId?: string;
}

export interface GrokSubagentSpawnedEvent extends GrokDurableSubagentEventBase {
  readonly kind: "spawned";
  readonly parentSessionId: string;
  readonly parentPromptId?: string;
  readonly subagentType: string;
  readonly description: string;
}

export interface GrokSubagentProgressEvent extends GrokSubagentEventBase {
  readonly kind: "progress";
  readonly replay: false;
  readonly parentSessionId: string;
  readonly durationMs: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly tokensUsed: number;
  readonly contextWindowTokens: number;
  readonly contextUsagePercent: number;
  readonly toolsUsed: readonly string[];
  readonly omittedToolCount: number;
  readonly errorCount: number;
}

export interface GrokSubagentFinishedEvent extends GrokDurableSubagentEventBase {
  readonly kind: "finished";
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly error?: string;
  readonly toolCalls: number;
  readonly turns: number;
  readonly durationMs: number;
  readonly tokensUsed: number;
  readonly output?: string;
  readonly willWake: boolean;
}

export type GrokSubagentEvent =
  | GrokSubagentSpawnedEvent
  | GrokSubagentProgressEvent
  | GrokSubagentFinishedEvent;

export interface GrokSubagentCollaborationProjection {
  /** Stable opaque identity; native subagent and child-session IDs stay private. */
  readonly activityId: string;
  readonly promptId: string;
  readonly item: Pick<
    CollaborationItem,
    "semanticKind" | "status" | "action" | "agentLabel" | "summary" | "error"
  >;
}

export type GrokSubagentReduction =
  | {
      readonly kind: "applied";
      readonly projection: GrokSubagentCollaborationProjection;
    }
  | {
      readonly kind: "ignored";
      readonly reason:
        "duplicate_or_regressive" | "missing_spawn" | "uncorrelated_spawn";
    }
  | {
      readonly kind: "invalid";
      readonly reason: "identity_mismatch";
    };

interface MutableSubagentState {
  readonly activityId: string;
  readonly sessionId: string;
  readonly subagentId: string;
  readonly childSessionId: string;
  readonly promptId: string;
  readonly agentLabel: string;
  readonly description: string;
  readonly subagentTypeDigest: string;
  readonly descriptionDigest: string;
  progressFrontier?: ProgressFrontier;
  terminal: boolean;
  projection: GrokSubagentCollaborationProjection;
}

interface ProgressFrontier {
  readonly durationMs: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly errorCount: number;
}

/**
 * Decodes the three reviewed Grok 1.x parent-side subagent update variants.
 * Unknown update variants are not this decoder's responsibility. Additive
 * source fields are projected away; every consumed field is closed and
 * runtime-validated. Cross-field child identity is deliberately validated by
 * the session-scoped reducer after this bounded parent-session route is known;
 * rejecting it here would turn one child's semantic contradiction into an ACP
 * connection-wide malformed-parameter failure.
 */
export function decodeGrokSubagentEvent(
  value: unknown,
  input: { readonly replay: boolean },
): GrokSubagentEvent | undefined {
  if (!isRecord(value) || !isRecord(own(value, "update"))) return undefined;
  const update = own(value, "update") as Readonly<Record<string, unknown>>;
  const sessionId = identifier(own(value, "sessionId"));
  const updateKind = own(update, "sessionUpdate");
  if (!sessionId) return undefined;
  const subagentId = identifier(own(update, "subagent_id"));
  const childSessionId = identifier(own(update, "child_session_id"));
  if (!subagentId || !childSessionId) return undefined;
  const base = {
    sessionId,
    subagentId,
    childSessionId,
  } as const;

  if (updateKind === "subagent_spawned") {
    const metadata = durableMetadata(value, input.replay);
    if (!metadata) return undefined;
    const parentSessionId = identifier(own(update, "parent_session_id"));
    const parentPromptId = optionalIdentifier(own(update, "parent_prompt_id"));
    const metadataPromptId = metadata.promptId;
    const subagentType = text(own(update, "subagent_type"));
    const description = text(own(update, "description"));
    if (
      !parentSessionId ||
      parentPromptId === INVALID ||
      (metadataPromptId !== undefined && metadataPromptId !== parentPromptId) ||
      subagentType === undefined ||
      description === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      ...base,
      ...metadata,
      kind: "spawned",
      parentSessionId,
      ...(parentPromptId === undefined ? {} : { parentPromptId }),
      subagentType,
      description,
    });
  }

  if (updateKind === "subagent_progress") {
    // Grok progress is an ephemeral live-only sample. It is deliberately not
    // journaled and carries no event metadata or durable replay identity.
    if (input.replay || own(value, "_meta") !== undefined) return undefined;
    const parentSessionId = identifier(own(update, "parent_session_id"));
    const durationMs = unsignedInteger(own(update, "duration_ms"));
    const turnCount = unsignedInteger(own(update, "turn_count"));
    const toolCallCount = unsignedInteger(own(update, "tool_call_count"));
    const tokensUsed = unsignedInteger(own(update, "tokens_used"));
    const contextWindowTokens = unsignedInteger(
      own(update, "context_window_tokens"),
    );
    const contextUsagePercent = unsignedInteger(
      own(update, "context_usage_pct"),
    );
    const errorCount = unsignedInteger(own(update, "error_count"));
    const toolsUsed = stringArray(own(update, "tools_used"));
    if (
      !parentSessionId ||
      durationMs === undefined ||
      turnCount === undefined ||
      toolCallCount === undefined ||
      tokensUsed === undefined ||
      contextWindowTokens === undefined ||
      contextUsagePercent === undefined ||
      contextUsagePercent > 100 ||
      errorCount === undefined ||
      toolsUsed === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      ...base,
      kind: "progress",
      replay: false,
      parentSessionId,
      durationMs,
      turnCount,
      toolCallCount,
      tokensUsed,
      contextWindowTokens,
      contextUsagePercent,
      toolsUsed: toolsUsed.retained,
      omittedToolCount: toolsUsed.omitted,
      errorCount,
    });
  }

  if (updateKind === "subagent_finished") {
    const metadata = durableMetadata(value, input.replay);
    if (!metadata) return undefined;
    const outcome = own(update, "status");
    const error = optionalText(own(update, "error"));
    const output = optionalText(own(update, "output"));
    const toolCalls = unsignedInteger(own(update, "tool_calls"));
    const turns = unsignedInteger(own(update, "turns"));
    const durationMs = unsignedInteger(own(update, "duration_ms"));
    const tokensUsed =
      own(update, "tokens_used") === undefined
        ? 0
        : unsignedInteger(own(update, "tokens_used"));
    const willWake =
      own(update, "will_wake") === undefined ? false : own(update, "will_wake");
    if (
      (outcome !== "completed" &&
        outcome !== "failed" &&
        outcome !== "cancelled") ||
      error === INVALID ||
      output === INVALID ||
      toolCalls === undefined ||
      turns === undefined ||
      durationMs === undefined ||
      tokensUsed === undefined ||
      typeof willWake !== "boolean"
    ) {
      return undefined;
    }
    return Object.freeze({
      ...base,
      ...metadata,
      kind: "finished",
      outcome,
      ...(error === undefined ? {} : { error }),
      toolCalls,
      turns,
      durationMs,
      tokensUsed,
      ...(output === undefined ? {} : { output }),
      willWake,
    });
  }

  return undefined;
}

/**
 * Keeps only the latest bounded presentation state for each live subagent.
 * The owning history projector remains responsible for durable event identity
 * deduplication and conflict detection before it publishes reduced state.
 */
export class GrokSubagentReducer {
  readonly #nativeNamespaceKey: string;
  readonly #sessionId: string;
  readonly #states = new Map<string, MutableSubagentState>();

  constructor(input: {
    readonly nativeNamespaceKey: string;
    readonly sessionId: string;
  }) {
    if (!identifier(input.nativeNamespaceKey) || !identifier(input.sessionId)) {
      throw new Error("grok_subagent_scope_invalid");
    }
    this.#nativeNamespaceKey = input.nativeNamespaceKey;
    this.#sessionId = input.sessionId;
  }

  ingest(event: GrokSubagentEvent): GrokSubagentReduction {
    if (
      event.sessionId !== this.#sessionId ||
      event.subagentId !== event.childSessionId
    ) {
      return invalidIdentity();
    }
    const prior = this.#states.get(event.subagentId);
    if (event.kind === "spawned") {
      if (event.parentSessionId !== this.#sessionId) return invalidIdentity();
      if (!event.parentPromptId) {
        return { kind: "ignored", reason: "uncorrelated_spawn" };
      }
      if (prior) {
        return sameSpawn(prior, event)
          ? { kind: "ignored", reason: "duplicate_or_regressive" }
          : invalidIdentity();
      }
      const activityId = opaqueActivityId(
        this.#nativeNamespaceKey,
        this.#sessionId,
        event.subagentId,
      );
      const projection = collaborationProjection({
        activityId,
        promptId: event.parentPromptId,
        status: "streaming",
        action: "spawn",
        agentLabel: event.subagentType,
        summary: event.description,
      });
      this.#states.set(event.subagentId, {
        activityId,
        sessionId: event.sessionId,
        subagentId: event.subagentId,
        childSessionId: event.childSessionId,
        promptId: event.parentPromptId,
        agentLabel: projection.item.agentLabel?.text ?? "",
        description: projection.item.summary?.text ?? "",
        subagentTypeDigest: semanticTextDigest(event.subagentType),
        descriptionDigest: semanticTextDigest(event.description),
        terminal: false,
        projection,
      });
      return { kind: "applied", projection };
    }

    if (!prior) return { kind: "ignored", reason: "missing_spawn" };
    if (
      prior.sessionId !== event.sessionId ||
      prior.subagentId !== event.subagentId ||
      prior.childSessionId !== event.childSessionId ||
      (event.kind === "finished" &&
        event.promptId !== undefined &&
        event.promptId !== prior.promptId) ||
      (event.kind === "progress" && event.parentSessionId !== prior.sessionId)
    ) {
      return invalidIdentity();
    }
    if (prior.terminal) {
      return { kind: "ignored", reason: "duplicate_or_regressive" };
    }
    if (
      event.kind === "progress" &&
      duplicateOrRegressiveProgress(prior.progressFrontier, event)
    ) {
      return { kind: "ignored", reason: "duplicate_or_regressive" };
    }

    const projection =
      event.kind === "progress"
        ? collaborationProjection({
            activityId: prior.activityId,
            promptId: prior.promptId,
            status: "streaming",
            action: "status",
            agentLabel: prior.agentLabel,
            summary: progressSummary(event),
          })
        : finishedProjection(prior, event);
    prior.projection = projection;
    if (event.kind === "progress") {
      prior.progressFrontier = progressFrontier(event);
    }
    prior.terminal = event.kind === "finished";
    return { kind: "applied", projection };
  }

  projection(
    subagentId: string,
  ): GrokSubagentCollaborationProjection | undefined {
    return this.#states.get(subagentId)?.projection;
  }

  /** Releases private reducer state after its projected activity leaves scope. */
  release(subagentId: string): boolean {
    return this.#states.delete(subagentId);
  }

  /** Releases state by its safe opaque activity identity. */
  releaseActivity(activityId: string): boolean {
    for (const [subagentId, state] of this.#states) {
      if (state.activityId !== activityId) continue;
      this.#states.delete(subagentId);
      return true;
    }
    return false;
  }

  /** Count-only diagnostic; never exposes provider-private retained payloads. */
  get retainedStateCount(): number {
    return this.#states.size;
  }
}

function collaborationProjection(input: {
  readonly activityId: string;
  readonly promptId: string;
  readonly status: CollaborationItem["status"];
  readonly action: CollaborationItem["action"];
  readonly agentLabel: string;
  readonly summary: string;
  readonly error?: CollaborationItem["error"];
}): GrokSubagentCollaborationProjection {
  return Object.freeze({
    activityId: input.activityId,
    promptId: input.promptId,
    item: Object.freeze({
      semanticKind: "collaboration" as const,
      status: input.status,
      action: input.action,
      agentLabel: boundDisplayText(input.agentLabel),
      summary: boundText(input.summary),
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
  });
}

function finishedProjection(
  state: MutableSubagentState,
  event: GrokSubagentFinishedEvent,
): GrokSubagentCollaborationProjection {
  const summary =
    event.outcome === "completed"
      ? (event.output ?? `${state.description} completed.`)
      : event.outcome === "failed"
        ? (event.error ?? `${state.description} failed.`)
        : `${state.description} was cancelled.`;
  return collaborationProjection({
    activityId: state.activityId,
    promptId: state.promptId,
    status:
      event.outcome === "completed"
        ? "completed"
        : event.outcome === "failed"
          ? "failed"
          : "interrupted",
    action: "result",
    agentLabel: state.agentLabel,
    summary,
    ...(event.outcome === "completed"
      ? {}
      : {
          error: {
            category:
              event.outcome === "failed"
                ? ("internal" as const)
                : ("interrupted" as const),
            message: boundDisplayText(summary),
            code:
              event.outcome === "failed"
                ? "grok_subagent_failed"
                : "grok_subagent_cancelled",
          },
        }),
  });
}

function progressSummary(event: GrokSubagentProgressEvent): string {
  const omittedTools =
    event.omittedToolCount === 0 ? "" : `, +${event.omittedToolCount} more`;
  const tools =
    event.toolsUsed.length === 0
      ? ""
      : ` · tools: ${event.toolsUsed.join(", ")}${omittedTools}`;
  const errors = event.errorCount === 0 ? "" : ` · errors: ${event.errorCount}`;
  return `Working · ${event.turnCount} turns · ${event.toolCallCount} tool calls · ${event.durationMs} ms${tools}${errors}`;
}

function progressFrontier(event: GrokSubagentProgressEvent): ProgressFrontier {
  return Object.freeze({
    durationMs: event.durationMs,
    turnCount: event.turnCount,
    toolCallCount: event.toolCallCount,
    errorCount: event.errorCount,
  });
}

function duplicateOrRegressiveProgress(
  prior: ProgressFrontier | undefined,
  event: GrokSubagentProgressEvent,
): boolean {
  if (!prior) return false;
  const current = progressFrontier(event);
  const keys = [
    "durationMs",
    "turnCount",
    "toolCallCount",
    "errorCount",
  ] as const;
  if (keys.some((key) => current[key] < prior[key])) return true;
  return keys.every((key) => current[key] === prior[key]);
}

function sameSpawn(
  state: MutableSubagentState,
  event: GrokSubagentSpawnedEvent,
): boolean {
  return (
    state.sessionId === event.sessionId &&
    state.childSessionId === event.childSessionId &&
    state.promptId === event.parentPromptId &&
    state.subagentTypeDigest === semanticTextDigest(event.subagentType) &&
    state.descriptionDigest === semanticTextDigest(event.description)
  );
}

function semanticTextDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function opaqueActivityId(
  namespace: string,
  sessionId: string,
  subagentId: string,
): string {
  const domain = "grok-activity";
  return `${domain}:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify([namespace, sessionId, subagentId]))
    .digest("hex")}`;
}

function invalidIdentity(): GrokSubagentReduction {
  return { kind: "invalid", reason: "identity_mismatch" };
}

const INVALID = Symbol("invalid");

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function durableMetadata(
  value: Readonly<Record<string, unknown>>,
  replay: boolean,
):
  | {
      readonly eventId: string;
      readonly replay: boolean;
      readonly promptId?: string;
    }
  | undefined {
  const metadata = own(value, "_meta");
  if (!isRecord(metadata)) return undefined;
  const eventId = identifier(own(metadata, "eventId"));
  const isReplay = own(metadata, "isReplay");
  const promptId = optionalIdentifier(own(metadata, "promptId"));
  if (
    !eventId ||
    promptId === INVALID ||
    (isReplay !== undefined && isReplay !== true) ||
    (isReplay === true) !== replay
  ) {
    return undefined;
  }
  return Object.freeze({
    eventId,
    replay,
    ...(promptId === undefined ? {} : { promptId }),
  });
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAXIMUM_IDENTIFIER_BYTES
    ? value
    : undefined;
}

function optionalIdentifier(
  value: unknown,
): string | undefined | typeof INVALID {
  return value === undefined ? undefined : (identifier(value) ?? INVALID);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalText(value: unknown): string | undefined | typeof INVALID {
  return value === undefined || value === null
    ? undefined
    : (text(value) ?? INVALID);
}

function unsignedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function stringArray(
  value: unknown,
):
  | { readonly retained: readonly string[]; readonly omitted: number }
  | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return undefined;
    if (result.length < MAXIMUM_RETAINED_PROGRESS_TOOL_NAMES) {
      result.push(boundDisplayText(candidate).text);
    }
  }
  return Object.freeze({
    retained: Object.freeze(result),
    omitted: value.length - result.length,
  });
}
