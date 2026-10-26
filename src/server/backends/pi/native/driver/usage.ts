import { createHash } from "node:crypto";
import type { ConversationBinding } from "../../../contracts.js";
import type { PiNativeHistory } from "../port.js";
import type { UsageCapture, UsageFact, UsageObservation, UsageSink } from "../../../../usage/contracts.js";
import { usageTokens } from "../../../../usage/contracts.js";
import { nativeUsageMoney } from "../../../../usage/native-money.js";
import { parsePiNativeEntry, type PiNativeEntry } from "../rpc/pi-rpc-wire.js";
import { object, string, type NativeHistoryProjection } from "./history.js";

function count(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("pi_native_usage_invalid");
  return value;
}
function observation(entry: PiNativeEntry, turnId: string | null, effort: string | null, provenance: "history" | "live"): UsageObservation | undefined {
  let source: Record<string, unknown>;
  let activity: UsageFact["activity"];
  let model: string | null = null;
  let provider: string | null = null;
  let requests: number | undefined;
  if (entry.type === "message" && entry.message.role === "assistant") {
    if (entry.message.stopReason === "pending") return;
    source = object(entry.message.usage); activity = "model"; requests = 1;
    model = string(entry.message.responseModel) ?? entry.message.model; provider = entry.message.provider;
  } else if (entry.type === "message" && entry.message.role === "toolResult") {
    source = object(entry.message.usage); activity = "tool";
  } else if (entry.type === "usage") {
    source = object(entry.usage); activity = entry.kind === "cache_warm" ? "cache_warming" : "auxiliary";
    model = entry.model; provider = entry.provider; requests = entry.kind === "cache_warm" ? 1 : undefined; turnId = null;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    source = object(entry.usage); activity = entry.type; turnId = null;
  } else return;
  if (!Object.keys(source).length) return;
  const input = count(source.input); const cacheRead = count(source.cacheRead); const cacheWrite = count(source.cacheWrite);
  const costs = object(source.cost);
  const additive = activity !== "auxiliary";
  const fact: UsageFact = {
    id: `${entry.id}:usage`, kind: activity === "model" ? "operation" : "auxiliary",
    sessionContribution: additive ? "additive" : "none", coverageDomain: "pi_native_entries",
    tokens: usageTokens({ input: input !== undefined && cacheRead !== undefined && cacheWrite !== undefined ? input + cacheRead + cacheWrite : undefined,
      uncachedInput: input, cacheRead, cacheWrite, output: count(source.output), reasoning: count(source.reasoning), total: count(source.totalTokens), requests }),
    costs: typeof costs.total === "number" ? [{ amount: nativeUsageMoney(costs.total), currency: "USD", kind: "estimated", provenance: "Pi native usage pricing" }] : [],
    models: [{ provider, model }], basis: ["sdk_normalized"], providerPresence: "unknown", quality: additive ? "complete" : "partial",
    reasons: additive ? [] : ["unknown_attribution"], activity,
    turn: turnId ? { backendTurnId: turnId, scope: "whole_turn", contribution: "additive" } : null,
  };
  return { id: fact.id, revision: createHash("sha256").update(JSON.stringify(fact)).digest("hex"), order: null,
    provenance, occurredAt: entry.timestamp, replaceCheckpoint: false, facts: [fact], attribution: { model: null, reasoningEffort: effort } };
}

/** Records native facts once; transport replay and copied fork history do not add another charge. */
export class PiNativeUsageAccounting {
  readonly #capture: UsageCapture;
  readonly #excluded = new Set<string>();
  readonly #committed = new Map<string, string>();
  constructor(sink: UsageSink, binding: ConversationBinding, namespace: string, initial: PiNativeHistory) {
    this.#capture = sink.open({ binding, nativeNamespace: namespace, nativeSession: binding.backendConversationId,
      normalizationVersion: "pi-native-1.4/usage-v1", epoch: "native_entries", initialBaseline: "unknown" });
    for (const id of initial.inheritedEntryIds) this.#excluded.add(id);
    if (initial.inheritance === "unknown") {
      for (const entry of initial.entries) if (typeof entry.id === "string") this.#excluded.add(entry.id);
      this.#capture.gap("inherited_baseline_unknown");
    }
  }
  update(history: PiNativeHistory, projection: NativeHistoryProjection, provenance: "history" | "live"): void {
    try {
      const entries = history.entries.map(parsePiNativeEntry);
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      const steering = new Map(history.operations.flatMap(operation => operation.phase === "accepted" && operation.userEntryId && operation.targetTurnId
        ? [[operation.userEntryId, operation.targetTurnId] as const] : []));
      const turnCache = new Map<string, string | null>();
      const effortCache = new Map<string, string | null>();
      const ancestry = (id: string, kind: "turn" | "effort"): string | null => {
        const cache = kind === "turn" ? turnCache : effortCache;
        const traversed: string[] = [];
        const seen = new Set<string>();
        let cursor: string | null = id;
        let result: string | null = null;
        while (cursor) {
          if (seen.has(cursor)) throw new Error("pi_native_usage_ancestry_cycle");
          seen.add(cursor);
          if (cache.has(cursor)) { result = cache.get(cursor)!; break; }
          const entry = byId.get(cursor);
          if (!entry) throw new Error("pi_native_usage_parent_missing");
          traversed.push(cursor);
          if (kind === "turn" && entry.type === "message" && entry.message.role === "user") { result = steering.get(entry.id) ?? entry.id; break; }
          if (kind === "effort" && entry.type === "thinking_level_change") { result = entry.thinkingLevel; break; }
          cursor = entry.parentId;
        }
        for (const entryId of traversed) cache.set(entryId, result);
        return result;
      };
      this.#capture.registerTurns(Object.values(projection.snapshot.turnsById), history.parentSessionId
        ? { nativeSession: history.parentSessionId, turns: Object.keys(projection.snapshot.turnsById).filter(id => this.#excluded.has(id)).map(backendTurnId => ({ backendTurnId, sourceBackendTurnId: backendTurnId })) } : undefined);
      const pending: UsageObservation[] = [];
      let complete = true;
      const flush = () => {
        if (!pending.length) return true;
        const batch = pending.splice(0);
        if (!this.#capture.capture(batch)) return false;
        for (const value of batch) this.#committed.set(value.id, value.revision);
        return true;
      };
      for (const entry of entries) {
        if (this.#excluded.has(entry.id)) continue;
        const value = observation(entry, ancestry(entry.id, "turn"), ancestry(entry.id, "effort"), provenance);
        if (!value || this.#committed.get(value.id) === value.revision) continue;
        pending.push(value);
        if (pending.length >= 64 && !flush()) { complete = false; break; }
      }
      if (!flush()) complete = false;
      if (complete) this.#capture.reconcile();
    } catch { this.#capture.gap("invalid_evidence"); }
  }
  close(): void { this.#capture.seal("detached"); }
}
