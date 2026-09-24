import type { CodexBindingDetail } from "./codex-binding-codec.js";
import { randomUUID } from "node:crypto";
import type { BackendTurn } from "../../../shared/protocol/backend.js";
import type { UsageReason } from "../../../shared/protocol/usage-accounting.js";
import type { ConversationBinding } from "../contracts.js";
import { usageTokens, type UsageAttribution, type UsageCapture, type UsageFact, type UsageSink } from "../../usage/contracts.js";
import type { CodexThreadTokenUsage } from "./codex-c1-protocol.js";
import { codexBackendTurnId } from "./codex-history-projector.js";

/** Native cumulative totals survive attachment changes; receipt IDs do not identify requests. */
export class CodexUsageCapture {
  readonly #capture: UsageCapture;
  readonly #threadId: string;
  readonly #incarnation = randomUUID();
  readonly #onError: (error: unknown) => void;
  readonly #inherited: boolean;
  readonly #parentNativeSession: string | null;
  #previous: { generation: number; sequence: number; turnId: string | null; tokens: UsageFact["tokens"] } | undefined;
  #startedTurn: string | undefined;
  #idleResume: { generation: number; sequence: number } | undefined;
  #lastLifecycle: { generation: number; sequence: number } | undefined;
  #completed: { turnId: string; generation: number; sequence: number } | undefined;
  #boundary: { turnId: string; generation: number; sequence: number; baselineSequence: number } | undefined;
  #conflict = false;
  #provenZero: boolean;
  #knownBaselineTurn: string | undefined;

  constructor(input: {
    sink: UsageSink; binding: ConversationBinding; nativeNamespace: string;
    provenZero: boolean; ancestry: CodexBindingDetail["nativeAncestry"]; onError: (error: unknown) => void;
  }) {
    this.#threadId = input.binding.backendConversationId;
    this.#onError = input.onError;
    this.#inherited = input.ancestry !== null;
    this.#parentNativeSession = input.ancestry?.forkedFromThreadId ?? null;
    this.#provenZero = input.provenZero;
    this.#capture = input.sink.open({ binding: input.binding, nativeNamespace: input.nativeNamespace,
      nativeSession: this.#threadId, epoch: "native-counter-v1", normalizationVersion: "codex-app-server-usage-v3",
      initialBaseline: input.provenZero ? "proven_zero" : "unknown" });
    if (this.#inherited) this.gap("inherited_baseline_unknown");
  }

  registerTurns(turns: readonly BackendTurn[], nativeTurnIds: readonly string[]): void {
    const visible = new Set(turns.map(turn => turn.backendTurnId));
    const nativeSession = this.#parentNativeSession;
    // The receiver verifies both scoped lineage and an existing source turn.
    // New child turns have no matching source row and retain their own usage.
    const inherited = nativeSession ? { nativeSession, turns: nativeTurnIds.map(nativeTurnId => ({
      backendTurnId: codexBackendTurnId(this.#threadId, nativeTurnId),
      sourceBackendTurnId: codexBackendTurnId(nativeSession, nativeTurnId),
    })).filter(turn => visible.has(turn.backendTurnId)) } : undefined;
    this.#safely(() => this.#capture.registerTurns(turns, inherited));
  }

  /** Pinned resume replies precede restored usage replay, including on cold restart. */
  resumed(event: { generation: number; sequence: number; idle: boolean }): void {
    const lifecycle = this.#lastLifecycle;
    if (!event.idle || (lifecycle?.generation === event.generation && lifecycle.sequence > event.sequence)) {
      this.#idleResume = undefined;
    } else if (this.#idleResume?.generation !== event.generation) {
      // A same-generation resnapshot need not replay usage again. Preserve the
      // earlier idle boundary until lifecycle activity or a gap invalidates it.
      this.#idleResume = event;
    }
  }

  started(event: { turnId: string; generation: number; sequence: number }): void {
    this.#startedTurn = event.turnId;
    const previous = this.#previous;
    const completed = this.#completed;
    const resume = this.#idleResume;
    const completedBoundary = previous && completed && previous.turnId === completed.turnId &&
      completed.generation === event.generation && previous.sequence < completed.sequence && completed.sequence < event.sequence;
    const resumedBoundary = previous && resume && resume.generation === event.generation &&
      resume.sequence < previous.sequence && previous.sequence < event.sequence;
    this.#boundary = previous && previous.turnId !== event.turnId && previous.generation === event.generation &&
      (completedBoundary || resumedBoundary) ? { ...event, baselineSequence: previous.sequence } : undefined;
    this.#idleResume = undefined;
    this.#lastLifecycle = event;
    this.#completed = undefined;
  }

  completed(event: { turnId: string; generation: number; sequence: number }): void {
    this.#completed = event;
    this.#lastLifecycle = event;
    this.#idleResume = undefined;
    this.#boundary = undefined;
  }

  gap(reason: UsageReason): void {
    this.#previous = undefined;
    this.#idleResume = undefined;
    this.#lastLifecycle = undefined;
    this.#provenZero = false;
    this.#knownBaselineTurn = undefined;
    this.#startedTurn = undefined;
    this.#completed = undefined;
    this.#boundary = undefined;
    this.#safely(() => this.#capture.gap(reason));
  }

  seal(): void {
    this.#previous = undefined;
    this.#safely(() => this.#capture.seal("detached"));
  }

  /** `attribution` is the provider-confirmed effective tuple; it never changes accounting. */
  observe(input: { generation: number; sequence: number; turnId: string; usage: CodexThreadTokenUsage; attribution?: UsageAttribution }): void {
    this.#safely(() => {
      const tokens = normalize(input.usage.total);
      if (!this.#previous && this.#provenZero && this.#startedTurn === input.turnId) this.#knownBaselineTurn = input.turnId;
      const previous = this.#previous ?? (this.#provenZero && this.#startedTurn === input.turnId ? { generation: input.generation, sequence: -1, turnId: input.turnId,
        tokens: Object.fromEntries(Object.keys(tokens).map(key => [key, "0"])) } : undefined);
      this.#provenZero = false;
      if (previous && previous.generation !== input.generation) this.#knownBaselineTurn = undefined;
      if (previous?.generation === input.generation && input.sequence <= previous.sequence) return;
      const receipt = `${this.#incarnation}:${input.generation}:${input.sequence}`;
      const facts: UsageFact[] = [{
        ...baseFact(), id: "session-counter", kind: "cumulative",
        sessionContribution: this.#inherited ? "none" : "checkpoint", tokens,
        reasons: this.#inherited ? ["inherited_baseline_unknown", "main_loop_only", "model_coverage_unknown"] : ["main_loop_only", "model_coverage_unknown"],
      }, {
        ...baseFact(), id: "latest-call", kind: "operation", sessionContribution: "none",
        tokens: normalize(input.usage.last), quality: "partial", reasons: ["unknown_attribution"],
      }];
      if (previous && previous.generation === input.generation && !this.#conflict) {
        const regression = Object.entries(tokens).some(([key, value]) => value !== null &&
          previous.tokens[key as keyof typeof tokens] != null && BigInt(value) < BigInt(previous.tokens[key as keyof typeof tokens]!));
        if (regression) {
          this.#conflict = true;
          this.#capture.gap("counter_regression");
        } else if (previous.turnId === input.turnId || (this.#boundary?.turnId === input.turnId &&
          this.#boundary.generation === input.generation && this.#boundary.sequence < input.sequence &&
          this.#boundary.baselineSequence === previous.sequence)) {
          if (previous.turnId !== input.turnId) this.#knownBaselineTurn = input.turnId;
          const delta = Object.fromEntries(Object.entries(tokens).map(([key, value]) => {
            const before = previous.tokens[key as keyof typeof tokens];
            return [key, value === null || before == null ? null : String(BigInt(value) - BigInt(before))];
          }));
          if (Object.values(delta).some(value => value !== null && value !== "0")) facts.push({
            ...baseFact(), id: `interval:${receipt}`, kind: "turn_aggregate", sessionContribution: this.#inherited ? "additive" : "none",
            tokens: delta, basis: ["sdk_normalized", "derived"], quality: this.#knownBaselineTurn === input.turnId ? "complete" : "partial",
            reasons: [...(this.#knownBaselineTurn === input.turnId ? [] : ["unknown_baseline" as const]), "model_coverage_unknown", "main_loop_only"],
            turn: { backendTurnId: codexBackendTurnId(this.#threadId, input.turnId),
              scope: this.#knownBaselineTurn === input.turnId ? "main_loop" : "partial_interval", contribution: "additive" },
          });
        }
      }
      const accepted = this.#capture.capture([{ id: receipt, revision: "1", order: null, provenance: "live", occurredAt: null,
        replaceCheckpoint: true, facts, ...(input.attribution ? { attribution: bounded(input.attribution) } : {}) }]);
      this.#boundary = undefined;
      this.#completed = undefined;
      if (!accepted) { this.#idleResume = undefined; this.#previous = undefined; this.#startedTurn = undefined; this.#knownBaselineTurn = undefined; return; }
      if (!this.#conflict) this.#previous = { generation: input.generation, sequence: input.sequence, turnId: input.turnId, tokens };
      this.#startedTurn = undefined;
    });
  }

  #safely(action: () => void): void {
    try { action(); } catch (error) {
      this.#previous = undefined;
      this.#idleResume = undefined;
      this.#knownBaselineTurn = undefined;
      try { this.#capture.gap("capture_failed"); } catch { /* Diagnostic-only failure; do not retry provider work. */ }
      try { this.#onError(error); } catch { /* Accounting must not break provider delivery. */ }
    }
  }
}

function baseFact(): Omit<UsageFact, "id" | "kind" | "sessionContribution" | "tokens"> {
  return { coverageDomain: "native-counter", costs: [], models: [{ provider: null, model: null }],
    basis: ["sdk_normalized"], providerPresence: "unknown", quality: "complete", reasons: [], activity: "model", turn: null };
}

/** Out-of-range native labels become unknown instead of invalidating the evidence. */
function bounded(attribution: UsageAttribution): UsageAttribution {
  const text = (value: string | null | undefined, maximum: number) => value && value.length <= maximum ? value : null;
  const provider = text(attribution.model?.provider, 240), model = text(attribution.model?.model, 240);
  return { model: provider || model ? { provider, model } : null, reasoningEffort: text(attribution.reasoningEffort, 64) };
}

function normalize(usage: CodexThreadTokenUsage["total"]): UsageFact["tokens"] {
  return usageTokens({ input: usage.inputTokens, cacheRead: usage.cachedInputTokens,
    cacheWrite: usage.cacheWriteInputTokens, output: usage.outputTokens,
    reasoning: usage.reasoningOutputTokens, total: usage.totalTokens });
}
