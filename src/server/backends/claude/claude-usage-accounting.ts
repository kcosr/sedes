import { nativeUsageMoney } from "../../usage/native-money.js";
import { createHash } from "node:crypto";
import type { SDKResultMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendTurn } from "../../../shared/protocol/backend.js";
import type { UsageModel } from "../../../shared/protocol/usage-accounting.js";
import type { ConversationBinding } from "../contracts.js";
import { claudeResultUserMessageIds } from "./claude-result-lifecycle.js";
import { usageTokens, type UsageCapture, type UsageFact, type UsageObservation, type UsageSink } from "../../usage/contracts.js";

function sum(...values: (number | null | undefined)[]): number | null {
  if (values.some((v) => v === null || v === undefined)) return null;
  return values.reduce<number>((total, value) => total + value!, 0);
}
function count(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number") throw new Error("invalid_native_usage_count");
  return value;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const NORMALIZATION = "claude-agent-sdk-0.3.274/usage-v1";
const baseFact = {
  coverageDomain: "claude_main_loop", costs: [], models: [], basis: ["sdk_normalized"], providerPresence: "unknown",
  quality: "partial", reasons: ["main_loop_only"], activity: "model",
} as const;

/**
 * Pipeline totals replace a complete map for one query incarnation. A resumed
 * or forked query's totals continue from those its transcript saved, so its
 * series counts only the increase over its first result (see
 * `ClaudeUsageAccounting.admitQuery`). The
 * `claude-agent-sdk-0.3.274/usage-v1` normalization and its provenance label
 * are persisted evidence identifiers; SDK 0.3.283 did not change them.
 * `reasoningEffort` is the handle-confirmed effort when the result arrived, for
 * the confirmed `model`; other models in the pipeline (helpers, subagents) are
 * not attributed that effort.
 */
export function claudePipelineObservation(message: SDKResultMessage, reasoningEffort: string | null = null, model: string | null = null): UsageObservation | undefined {
  if ("startup_failure_reason" in message && message.startup_failure_reason) return;
  const facts: UsageFact[] = Object.entries(message.modelUsage).map(([model, usage]) => ({
    ...baseFact, id: `model:${model}`, kind: "cumulative", coverageDomain: "claude_query_pipeline",
    sessionContribution: "checkpoint", quality: "complete", reasons: [], turn: null,
    tokens: usageTokens({input: sum(usage.inputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens),
      uncachedInput: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens,
      cacheWrite: usage.cacheCreationInputTokens, reasoning: usage.thinkingTokens}), models: [{provider: usage.provider ?? null, model}],
    pricing: {canonicalModel: usage.canonicalModel ?? null, basis: usage.costBasis ?? null,
      components: typeof usage.costUSD === "number" ? [{kind: "model_total", amount: nativeUsageMoney(usage.costUSD), currency: "USD"}] : []},
  }));
  // SDK summary is an alternative to the per-model costs, never their addition.
  facts.push({...baseFact, id: "query_cost", kind: "cumulative", coverageDomain: "claude_query_pipeline",
    sessionContribution: "checkpoint", quality: "complete", reasons: [], tokens: {}, turn: null,
    costs: [{amount: nativeUsageMoney(message.total_cost_usd), currency: "USD", kind: "estimated", provenance: "Claude Agent SDK 0.3.274 cumulative query estimate"}]});
  return {id: `${message.uuid}:pipeline`, revision: "1", order: message.result_index === undefined ? null : String(message.result_index),
    provenance: "live", occurredAt: null, replaceCheckpoint: true, facts, attribution: {model: model ? {provider: null, model} : null, reasoningEffort}};
}
/**
 * The result of Sedes' startup message. It is sent with `shouldQuery: false`,
 * so a result that consumed only it and ran no model turn reports exactly the
 * totals the query started from: zero for a new session, and the transcript's
 * saved totals for a resumed or forked one.
 */
export function claudeStartupResult(message: SDKResultMessage, startupMessageUuid: string): boolean {
  const ids = claudeResultUserMessageIds(message), usage = message.usage;
  return ids.length === 1 && ids[0] === startupMessageUuid && message.subtype === "success" && !message.is_error && message.num_turns === 0 &&
    [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].every((value) => !value);
}
export function claudeTurnObservation(message: SDKResultMessage, backendTurnId: string, models: readonly UsageModel[] = []): UsageObservation | undefined {
  if ("startup_failure_reason" in message && message.startup_failure_reason) return;
  const usage = message.usage;
  return {id: `${message.uuid}:main_loop`, revision: "1", order: message.result_index === undefined ? null : String(message.result_index),
    provenance: "live", occurredAt: null, replaceCheckpoint: false,
    facts: [{...baseFact, id: `${backendTurnId}:result`, kind: "turn_aggregate", sessionContribution: "none", models,
      tokens: usageTokens({input: sum(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens),
        uncachedInput: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens}),
      turn: {backendTurnId, scope: "main_loop", contribution: "checkpoint"}}]};
}
export function claudeMessageObservation(message: SessionMessage, backendTurnId: string, provenance: "live" | "history"): UsageObservation | undefined {
  if (message.type !== "assistant" || message.parent_tool_use_id || message.parent_agent_id) return;
  const payload = record(message.message); const usage = record(payload?.usage);
  // Claude Code writes `<synthetic>` rows (resume closures, API errors) without a model request.
  if (!payload || !usage || payload.stop_reason === null || payload.model === "<synthetic>") return;
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
  // Anthropic message ID survives history transport and split content blocks.
  const nativeId = typeof payload.id === "string" ? payload.id : message.uuid;
  const fact: UsageFact = {...baseFact, id: `${nativeId}:message`, kind: "operation", sessionContribution: "none",
    basis: ["provider_reported"], providerPresence: "reported", reasons: ["main_loop_only", "history_partial"],
    tokens: usageTokens({input: sum(input, cacheRead, cacheWrite), uncachedInput: input, output, cacheRead, cacheWrite}),
    models: typeof payload.model === "string" ? [{provider: null, model: payload.model}] : [],
    turn: {backendTurnId, scope: "main_loop", contribution: "additive"}};
  return {id: `${nativeId}:message`, revision: createHash("sha256").update(JSON.stringify(fact)).digest("hex"), order: null,
    provenance, occurredAt: null, replaceCheckpoint: false, facts: [fact]};
}

export class ClaudeUsageAccounting {
  readonly #sink: UsageSink;
  readonly #binding: ConversationBinding;
  readonly #namespace: string;
  readonly #history: UsageCapture;
  readonly #models = new Map<string, Map<string, UsageModel>>();
  readonly #committedMessages = new Map<string, string>();
  readonly #launch: "new" | "resume";
  #query: UsageCapture | undefined;
  #epoch: string | undefined;
  #deliveryCommitted = true;
  beginDelivery(): void { this.#deliveryCommitted = true; }
  get deliveryCommitted(): boolean { return this.#deliveryCommitted; }
  /** `launch` is how this handle starts its query when none is retained to reattach to. */
  constructor(input: {sink: UsageSink; binding: ConversationBinding; nativeNamespace: string; launch: "new" | "resume"}) {
    this.#sink = input.sink; this.#binding = input.binding; this.#namespace = input.nativeNamespace; this.#launch = input.launch;
    this.#history = input.sink.open({binding: input.binding, nativeNamespace: input.nativeNamespace,
      nativeSession: input.binding.backendConversationId, normalizationVersion: NORMALIZATION, epoch: "history", initialBaseline: "unknown"});
  }
  registerTurns(turns: readonly BackendTurn[], inherited?: Parameters<UsageCapture["registerTurns"]>[1]): void { this.#history.registerTurns(turns, inherited); this.#query?.registerTurns(turns, inherited); }
  /**
   * `epoch` is the query's startup message identity. A new launch counts from
   * zero. A resumed or forked query continues the totals its transcript saved,
   * and a reattached one started wherever its launch did, so their series
   * opens at the first result with that result as its reported baseline. The
   * startup message's own result is exact; any other first result leaves
   * earlier work in the query unattributable (`unknown_baseline`) rather than
   * counting it again. A reopened series keeps the baseline it began with.
   */
  admitQuery(epoch: string | undefined, reattached: boolean): void {
    if (!epoch) { this.#history.gap("unknown_baseline"); return; }
    if (this.#epoch === epoch) return;
    this.#epoch = epoch;
    this.#query = !reattached && this.#launch === "new" ? this.#open(epoch, "proven_zero") : undefined;
  }
  #open(epoch: string, initialBaseline: "proven_zero" | "unknown", reportedBaseline?: UsageObservation): UsageCapture {
    return this.#sink.open({binding: this.#binding, nativeNamespace: this.#namespace, nativeSession: this.#binding.backendConversationId,
      normalizationVersion: NORMALIZATION, epoch, initialBaseline, ...(reportedBaseline ? {reportedBaseline} : {})});
  }
  message(message: SessionMessage, backendTurnId: string, provenance: "live" | "history"): void {
    this.messages([{message, backendTurnId}], provenance);
  }
  messages(messages: readonly {message: SessionMessage; backendTurnId: string}[], provenance: "live" | "history"): void {
    let batch: UsageObservation[] = [];
    const flush = (): void => {
      if (!batch.length) return;
      if (this.#history.capture(batch)) {
        for (const observation of batch) this.#committedMessages.set(observation.id, observation.revision);
      } else this.#deliveryCommitted = false;
      batch = [];
    };
    for (const {message, backendTurnId} of messages) {
      try {
        const observation = claudeMessageObservation(message, backendTurnId, provenance);
        if (!observation) continue;
        let models = this.#models.get(backendTurnId);
        if (!models) { models = new Map(); this.#models.set(backendTurnId, models); }
        for (const model of observation.facts[0]!.models) models.set(JSON.stringify(model), model);
        if (this.#committedMessages.get(observation.id) === observation.revision) continue;
        batch.push(observation);
        if (batch.length === 64) flush();
      } catch { this.#history.gap("invalid_evidence"); }
    }
    flush();
  }
  pipeline(message: SDKResultMessage, reasoningEffort: string | null = null, model: string | null = null): void {
    try {
      const observation = claudePipelineObservation(message, reasoningEffort, model);
      if (!observation) { this.#query?.gap("capture_gap"); return; }
      if (!this.#epoch) { this.#history.gap("unknown_baseline"); return; }
      if (!this.#query) {
        const {attribution: _attribution, ...start} = observation;
        this.#query = this.#open(this.#epoch, claudeStartupResult(message, this.#epoch) ? "proven_zero" : "unknown", {...start, id: `${message.uuid}:baseline`});
      }
      if (!this.#query.capture([observation])) this.#deliveryCommitted = false;
    } catch { (this.#query ?? this.#history).gap("invalid_evidence"); }
  }
  result(message: SDKResultMessage, backendTurnId: string): void {
    try {
      const observation = claudeTurnObservation(message, backendTurnId, [...(this.#models.get(backendTurnId)?.values() ?? [])]);
      if (observation && !(this.#query ?? this.#history).capture([observation])) this.#deliveryCommitted = false;
    } catch { (this.#query ?? this.#history).gap("invalid_evidence"); }
  }
  reset(): void { this.#query?.seal("reset"); }
  close(): void { this.#query?.seal("detached"); this.#history.seal("closed"); }
}
