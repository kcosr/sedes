import { createHash } from "node:crypto";
import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  BackendConversationEvent,
  BackendItem,
} from "../../../shared/protocol/backend.js";
import type {
  AgentToolInvocationCorrelation,
  OperationPhase,
} from "../../../shared/protocol/payload.js";
import {
  authenticatedPiAgentToolInvocationNativeToolName,
  authenticatedAgentToolCorrelation,
  isPiAgentToolInvocationMarkerType,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "./pi-agent-tool-invocation-marker.js";
import {
  PiToolIdentityCatalog,
  type PiToolIdentity,
} from "./pi-tool-identities.js";
import { PiToolSemanticMapperRegistry } from "./pi-tool-mappers.js";
import {
  authenticatedPiToolIdentityNativeToolName,
  findPiToolCallAssistantEntryId,
  isPiToolIdentityMarkerType,
  readPiToolIdentityMarker,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";

interface ActiveAssistantStream {
  readonly epoch: string;
  readonly backendTurnId: string;
  readonly sourceOrderBase: number;
  readonly startedAt: string;
  assistantEnded: boolean;
  nextFallbackOrder: number;
}

interface PendingPiToolCall {
  readonly assistantStreamEpoch: string;
  readonly contentIndex: number;
  readonly provisionalItemId: string;
  readonly sourceOrder: number;
  toolCallId?: string;
  toolName?: string;
  identity?: PiToolIdentity;
  partialArguments: unknown;
  completeArguments?: unknown;
  partialResult?: unknown;
  finalResult?: unknown;
  agentToolInvocation?: AgentToolInvocationCorrelation;
  phase:
    | "arguments_streaming"
    | "arguments_complete"
    | "preflight_or_executing"
    | "result_streaming"
    | "completed"
    | "failed"
    | "interrupted";
  published: boolean;
  startedAt: string;
  completedAt?: string;
}

export interface PiAssistantStreamStart {
  readonly streamEpoch: string;
  readonly backendTurnId: string;
  readonly sourceOrderBase?: number;
  readonly startedAt?: string;
}

export interface PiLiveToolProjectorOptions {
  readonly identities: PiToolIdentityCatalog;
  readonly mapper?: PiToolSemanticMapperRegistry;
  readonly now?: () => string;
  readonly maximumPendingCalls?: number;
}

const phaseRank: Readonly<Record<OperationPhase, number>> = {
  arguments_streaming: 0,
  arguments_complete: 1,
  preflight_or_executing: 2,
  result_streaming: 3,
  completed: 4,
  failed: 4,
  interrupted: 4,
};

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasOwnData(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor;
}

function contentAt(partial: unknown, contentIndex: number): unknown {
  const content = own(partial, "content");
  return Array.isArray(content) ? content[contentIndex] : undefined;
}

function toolBlock(
  partial: unknown,
  contentIndex: number,
): {
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
} {
  const block = contentAt(partial, contentIndex);
  if (own(block, "type") !== "toolCall") {
    return {};
  }
  const id = own(block, "id");
  const name = own(block, "name");
  return {
    ...(typeof id === "string" && id.length > 0 ? { id } : {}),
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    ...(hasOwnData(block, "arguments")
      ? { arguments: own(block, "arguments") }
      : {}),
  };
}

function unknownIdentity(toolName: string): PiToolIdentity {
  return {
    registrationId: `pi:live-extension:${encodeURIComponent(toolName)}`,
    origin: "extension",
    displayName: toolName || "tool",
  };
}

function safeIdPart(value: string): string {
  if (value.length <= 180 && /^[A-Za-z0-9._-]+$/.test(value)) {
    return value;
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function terminal(phase: OperationPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

export class PiLiveToolProjector {
  readonly #identities: PiToolIdentityCatalog;
  readonly #mapper: PiToolSemanticMapperRegistry;
  readonly #now: () => string;
  readonly #maximumPendingCalls: number;
  readonly #byContentIndex = new Map<number, PendingPiToolCall>();
  readonly #byCallId = new Map<string, PendingPiToolCall>();
  #stream?: ActiveAssistantStream;
  #invalidated = false;

  constructor(options: PiLiveToolProjectorOptions) {
    this.#identities = options.identities;
    this.#mapper = options.mapper ?? new PiToolSemanticMapperRegistry();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maximumPendingCalls = options.maximumPendingCalls ?? 128;
    if (
      !Number.isSafeInteger(this.#maximumPendingCalls) ||
      this.#maximumPendingCalls <= 0
    ) {
      throw new Error("pi_live_tool_pending_limit_invalid");
    }
  }

  beginAssistantStream(
    input: PiAssistantStreamStart,
  ): readonly BackendConversationEvent[] {
    if (
      !input.streamEpoch ||
      !input.backendTurnId ||
      !Number.isSafeInteger(input.sourceOrderBase ?? 0) ||
      (input.sourceOrderBase ?? 0) < 0 ||
      (input.sourceOrderBase ?? 0) > Number.MAX_SAFE_INTEGER - 1_000
    ) {
      throw new Error("pi_live_tool_stream_invalid");
    }
    if (
      this.#stream &&
      [...this.#byContentIndex.values()].some(({ phase }) => !terminal(phase))
    ) {
      return this.#invalidate("contradictory_state");
    }
    this.reset();
    this.#stream = {
      epoch: input.streamEpoch,
      backendTurnId: input.backendTurnId,
      sourceOrderBase: input.sourceOrderBase ?? 0,
      startedAt: input.startedAt ?? this.#now(),
      assistantEnded: false,
      nextFallbackOrder: input.sourceOrderBase ?? 0,
    };
    return [];
  }

  consume(event: AgentSessionEvent): readonly BackendConversationEvent[] {
    if (this.#invalidated) {
      return [];
    }
    if (!this.#stream) {
      return this.#isRelevant(event)
        ? this.#invalidate("contradictory_state")
        : [];
    }
    if (event.type === "message_update") {
      if (event.message.role !== "assistant") {
        return [];
      }
      const nested = event.assistantMessageEvent;
      switch (nested.type) {
        case "toolcall_start":
          return this.#argumentStart(nested.contentIndex, nested.partial);
        case "toolcall_delta":
          return this.#argumentDelta(nested.contentIndex, nested.partial);
        case "toolcall_end":
          return this.#argumentEnd(nested.contentIndex, nested.toolCall);
        default:
          return [];
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.#stream.assistantEnded = true;
      return [];
    }
    if (event.type === "tool_execution_start") {
      return this.#executionStart(event.toolCallId, event.toolName, event.args);
    }
    if (event.type === "tool_execution_update") {
      return this.#executionUpdate(
        event.toolCallId,
        event.toolName,
        event.args,
        event.partialResult,
      );
    }
    if (event.type === "tool_execution_end") {
      return this.#executionEnd(
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
      );
    }
    return [];
  }

  consumeAgentToolInvocationMarkers(
    entries: readonly SessionEntry[],
    authentication: PiToolIdentityAuthentication,
  ): readonly BackendConversationEvent[] {
    if (this.#invalidated || !this.#stream) {
      return [];
    }
    const events: BackendConversationEvent[] = [];
    for (const pending of this.#byContentIndex.values()) {
      if (!pending.toolCallId || !pending.toolName) {
        continue;
      }
      const assistantEntryId = findPiToolCallAssistantEntryId(
        entries,
        pending.toolCallId,
        pending.toolName,
      );
      if (!assistantEntryId) {
        continue;
      }
      let identity = pending.identity;
      if (pending.toolName.startsWith("harness_")) {
        const identityCandidates = entries.flatMap((entry) => {
          if (
            entry.type !== "custom" ||
            !isPiToolIdentityMarkerType(entry.customType)
          ) {
            return [];
          }
          const result = readPiToolIdentityMarker(entry, authentication);
          return result.status === "authenticated" &&
            result.marker.assistantEntryId === assistantEntryId &&
            result.marker.toolCallId === pending.toolCallId &&
            authenticatedPiToolIdentityNativeToolName(entry, authentication) ===
              pending.toolName
            ? [result.marker]
            : [];
        });
        identity =
          identityCandidates.length === 1
            ? identityCandidates[0]!.identity
            : undefined;
      }
      if (
        identity?.origin !== "sedes_agent_tool" &&
        (identity?.origin !== "sedes_agent_tool_gateway" ||
          pending.toolName === "sedes_catalog" ||
          pending.toolName === "harness_catalog")
      ) {
        continue;
      }
      const candidates = entries.flatMap((entry) => {
        if (
          entry.type !== "custom" ||
          !isPiAgentToolInvocationMarkerType(entry.customType)
        ) {
          return [];
        }
        const result = readPiAgentToolInvocationMarker(entry, authentication);
        const candidateAssistantEntryId =
          result.status === "authenticated"
            ? result.marker.assistantEntryId
            : own(entry.data, "assistantEntryId");
        const candidateToolCallId =
          result.status === "authenticated"
            ? result.marker.toolCallId
            : own(entry.data, "toolCallId");
        return candidateAssistantEntryId === assistantEntryId &&
          candidateToolCallId === pending.toolCallId &&
          (result.status !== "authenticated" ||
            authenticatedPiAgentToolInvocationNativeToolName(
              entry,
              authentication,
            ) === pending.toolName)
          ? [result]
          : [];
      });
      const marker =
        candidates.length === 1 && candidates[0]!.status === "authenticated"
          ? candidates[0]!.marker
          : undefined;
      const correlation = marker
        ? authenticatedAgentToolCorrelation(marker, identity, marker.toolName)
        : undefined;
      if (!correlation) {
        if (pending.agentToolInvocation && pending.published) {
          return this.#invalidate("ambiguous_correlation");
        }
        pending.agentToolInvocation = undefined;
        continue;
      }
      if (
        pending.agentToolInvocation?.toolId === correlation.toolId &&
        pending.agentToolInvocation.schemaVersion ===
          correlation.schemaVersion &&
        pending.agentToolInvocation.invocationId === correlation.invocationId
      ) {
        continue;
      }
      if (pending.agentToolInvocation || terminal(pending.phase)) {
        return this.#invalidate("ambiguous_correlation");
      }
      pending.agentToolInvocation = correlation;
      pending.identity = identity;
      if (pending.published) {
        events.push({
          type: "item_updated",
          item: this.#map(pending, "streaming"),
        });
      }
    }
    return events;
  }

  interruptActive(): readonly BackendConversationEvent[] {
    if (this.#invalidated) {
      return [];
    }
    const events: BackendConversationEvent[] = [];
    for (const pending of this.#byContentIndex.values()) {
      if (terminal(pending.phase)) {
        continue;
      }
      pending.phase = "interrupted";
      pending.completedAt = this.#now();
      if (!pending.identity) {
        return this.#invalidate("ambiguous_correlation");
      }
      const item = this.#map(pending, "interrupted");
      if (!pending.published) {
        pending.published = true;
        events.push({ type: "item_started", item });
      }
      events.push({
        type: "item_completed",
        item: {
          ...item,
          error: {
            category: "interrupted",
            message: { text: "Tool execution was interrupted." },
            code: "pi_tool_interrupted",
          },
        },
      });
    }
    return events;
  }

  settlementCheck(): readonly BackendConversationEvent[] {
    if (this.#invalidated) {
      return [];
    }
    return [...this.#byContentIndex.values()].some(
      ({ phase }) => !terminal(phase),
    )
      ? this.#invalidate("persistence_pending")
      : [];
  }

  reset(): void {
    this.#byContentIndex.clear();
    this.#byCallId.clear();
    this.#stream = undefined;
    this.#invalidated = false;
  }

  #argumentStart(
    contentIndex: number,
    partial: unknown,
  ): readonly BackendConversationEvent[] {
    if (this.#stream!.assistantEnded) {
      return this.#invalidate("contradictory_state");
    }
    if (!this.#validContentIndex(contentIndex)) {
      return this.#invalidate("contradictory_state");
    }
    if (this.#byContentIndex.has(contentIndex)) {
      return this.#invalidate("ambiguous_correlation");
    }
    if (this.#byContentIndex.size >= this.#maximumPendingCalls) {
      return this.#invalidate("buffer_overflow");
    }
    const block = toolBlock(partial, contentIndex);
    const pending = this.#newPending(contentIndex, block.arguments);
    this.#byContentIndex.set(contentIndex, pending);
    const correlation = this.#applyIdentity(pending, block.name, block.id);
    if (correlation) {
      return correlation;
    }
    return this.#publish(pending, "item_started");
  }

  #argumentDelta(
    contentIndex: number,
    partial: unknown,
  ): readonly BackendConversationEvent[] {
    if (this.#stream!.assistantEnded) {
      return this.#invalidate("contradictory_state");
    }
    const pending = this.#byContentIndex.get(contentIndex);
    if (!pending || terminal(pending.phase)) {
      return this.#invalidate("contradictory_state");
    }
    if (phaseRank[pending.phase] > phaseRank.arguments_streaming) {
      return this.#invalidate("contradictory_state");
    }
    const block = toolBlock(partial, contentIndex);
    const correlation = this.#applyIdentity(pending, block.name, block.id);
    if (correlation) {
      return correlation;
    }
    pending.partialArguments = block.arguments;
    return this.#publish(
      pending,
      pending.published ? "item_updated" : "item_started",
    );
  }

  #argumentEnd(
    contentIndex: number,
    toolCall: unknown,
  ): readonly BackendConversationEvent[] {
    if (this.#stream!.assistantEnded) {
      return this.#invalidate("contradictory_state");
    }
    let pending = this.#byContentIndex.get(contentIndex);
    if (!pending) {
      if (!this.#validContentIndex(contentIndex)) {
        return this.#invalidate("contradictory_state");
      }
      if (this.#byContentIndex.size >= this.#maximumPendingCalls) {
        return this.#invalidate("buffer_overflow");
      }
      pending = this.#newPending(contentIndex, own(toolCall, "arguments"));
      this.#byContentIndex.set(contentIndex, pending);
    }
    if (phaseRank[pending.phase] > phaseRank.arguments_complete) {
      return this.#invalidate("contradictory_state");
    }
    const name = own(toolCall, "name");
    const id = own(toolCall, "id");
    if (typeof name !== "string" || !name || typeof id !== "string" || !id) {
      return this.#invalidate("contradictory_state");
    }
    const correlation = this.#applyIdentity(pending, name, id);
    if (correlation) {
      return correlation;
    }
    pending.completeArguments = own(toolCall, "arguments");
    pending.partialArguments = pending.completeArguments;
    pending.phase = "arguments_complete";
    return this.#publish(
      pending,
      pending.published ? "item_updated" : "item_started",
    );
  }

  #executionStart(
    callId: string,
    toolName: string,
    args: unknown,
  ): readonly BackendConversationEvent[] {
    if (!callId || !toolName) {
      return this.#invalidate("contradictory_state");
    }
    let pending = this.#byCallId.get(callId);
    if (!pending) {
      if (this.#byContentIndex.size >= this.#maximumPendingCalls) {
        return this.#invalidate("buffer_overflow");
      }
      const contentIndex = this.#nextFallbackContentIndex();
      pending = this.#newPending(contentIndex, args, callId);
      this.#byContentIndex.set(contentIndex, pending);
      const correlation = this.#applyIdentity(pending, toolName, callId);
      if (correlation) {
        return correlation;
      }
    }
    if (
      pending.toolName !== toolName ||
      phaseRank[pending.phase] > phaseRank.preflight_or_executing
    ) {
      return this.#invalidate("contradictory_state");
    }
    pending.completeArguments = args;
    pending.partialArguments = args;
    pending.phase = "preflight_or_executing";
    return this.#publish(
      pending,
      pending.published ? "item_updated" : "item_started",
    );
  }

  #executionUpdate(
    callId: string,
    toolName: string,
    args: unknown,
    partialResult: unknown,
  ): readonly BackendConversationEvent[] {
    const pending = this.#byCallId.get(callId);
    if (
      !pending ||
      pending.toolName !== toolName ||
      terminal(pending.phase) ||
      phaseRank[pending.phase] < phaseRank.preflight_or_executing
    ) {
      return this.#invalidate("contradictory_state");
    }
    pending.completeArguments = args;
    pending.partialArguments = args;
    pending.partialResult = partialResult;
    pending.phase = "result_streaming";
    return this.#publish(
      pending,
      pending.published ? "item_updated" : "item_started",
    );
  }

  #executionEnd(
    callId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): readonly BackendConversationEvent[] {
    const pending = this.#byCallId.get(callId);
    if (!pending || pending.toolName !== toolName || terminal(pending.phase)) {
      return this.#invalidate("contradictory_state");
    }
    pending.finalResult = result;
    pending.partialResult = result;
    pending.phase = isError ? "failed" : "completed";
    pending.completedAt = this.#now();
    let item = this.#map(pending, pending.phase);
    if (isError) {
      item = {
        ...item,
        error: {
          category: "internal",
          message: {
            text: "The tool did not complete successfully.",
          },
          code: "pi_tool_failed",
        },
      };
    }
    const events: BackendConversationEvent[] = [];
    if (!pending.published) {
      pending.published = true;
      events.push({ type: "item_started", item });
    }
    events.push({ type: "item_completed", item });
    return events;
  }

  #newPending(
    contentIndex: number,
    partialArguments: unknown,
    callId?: string,
  ): PendingPiToolCall {
    const stream = this.#stream!;
    const sourceOrder = stream.sourceOrderBase + contentIndex;
    stream.nextFallbackOrder = Math.max(
      stream.nextFallbackOrder,
      sourceOrder + 1,
    );
    return {
      assistantStreamEpoch: stream.epoch,
      contentIndex,
      provisionalItemId: `live:${safeIdPart(stream.epoch)}:${contentIndex}`,
      sourceOrder,
      ...(callId ? { toolCallId: callId } : {}),
      partialArguments,
      phase: "arguments_streaming",
      published: false,
      startedAt: stream.startedAt,
    };
  }

  #nextFallbackContentIndex(): number {
    const stream = this.#stream!;
    const contentIndex = Math.max(
      0,
      stream.nextFallbackOrder - stream.sourceOrderBase,
    );
    stream.nextFallbackOrder += 1;
    return contentIndex;
  }

  #applyIdentity(
    pending: PendingPiToolCall,
    toolName: string | undefined,
    callId: string | undefined,
  ): readonly BackendConversationEvent[] | undefined {
    if (toolName) {
      if (pending.toolName && pending.toolName !== toolName) {
        return this.#invalidate("contradictory_state");
      }
      pending.toolName = toolName;
      pending.identity ??=
        this.#identities.get(toolName) ?? unknownIdentity(toolName);
    }
    if (callId) {
      if (pending.toolCallId && pending.toolCallId !== callId) {
        return this.#invalidate("contradictory_state");
      }
      const existing = this.#byCallId.get(callId);
      if (existing && existing !== pending) {
        return this.#invalidate("ambiguous_correlation");
      }
      pending.toolCallId = callId;
      this.#byCallId.set(callId, pending);
    }
    return undefined;
  }

  #publish(
    pending: PendingPiToolCall,
    type: "item_started" | "item_updated",
  ): readonly BackendConversationEvent[] {
    if (!pending.identity) {
      return [];
    }
    const item = this.#map(pending, "streaming");
    pending.published = true;
    return [{ type, item }];
  }

  #map(pending: PendingPiToolCall, status: BackendItem["status"]): BackendItem {
    return this.#mapper.map({
      backendItemId: pending.provisionalItemId,
      backendTurnId: this.#stream!.backendTurnId,
      sourceOrder: pending.sourceOrder,
      status,
      phase: pending.phase,
      startedAt: pending.startedAt,
      ...(pending.completedAt ? { completedAt: pending.completedAt } : {}),
      identity: pending.identity!,
      ...(pending.agentToolInvocation
        ? { agentToolInvocation: pending.agentToolInvocation }
        : {}),
      arguments: pending.completeArguments ?? pending.partialArguments,
      result: pending.finalResult ?? pending.partialResult,
      isError: pending.phase === "failed",
    });
  }

  #invalidate(
    reason:
      | "buffer_overflow"
      | "persistence_pending"
      | "ambiguous_correlation"
      | "contradictory_state",
  ): readonly BackendConversationEvent[] {
    if (this.#invalidated) {
      return [];
    }
    this.#invalidated = true;
    return [{ type: "resnapshot_required", reason }];
  }

  #validContentIndex(contentIndex: number): boolean {
    return (
      Number.isSafeInteger(contentIndex) &&
      contentIndex >= 0 &&
      contentIndex < 1_000
    );
  }

  #isRelevant(event: AgentSessionEvent): boolean {
    return (
      (event.type === "message_update" &&
        event.message.role === "assistant" &&
        event.assistantMessageEvent.type.startsWith("toolcall_")) ||
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    );
  }
}
