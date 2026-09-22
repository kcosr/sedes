import { nativeUsageMoney } from "../../usage/native-money.js";
import { createHash } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { ConversationBinding } from "../contracts.js";
import { usageTokens, type UsageCapture, type UsageFact, type UsageObservation, type UsageSink } from "../../usage/contracts.js";
import { PiHistoryProjector } from "./pi-history-projector.js";
import type { PiToolIdentityAuthentication } from "./pi-tool-identity-marker.js";
import { readPiBranchMarker } from "./pi-branch-marker.js";

/** SDK 0.86.0 terminal usage buckets are disjoint; reasoning is an output subset. */
export function piUsageObservation(entry: SessionEntry, backendTurnId: string | null, provenance: "live" | "history"): UsageObservation | undefined {
  let usage: Usage | undefined;
  let provider: string | null = null;
  let model: string | null = null;
  let activity: UsageFact["activity"] = "auxiliary";
  let request: number | undefined;
  let additive = true;
  if (entry.type === "message" && entry.message.role === "assistant") {
    if (entry.message.stopReason === "pending" || entry.message.stopReason === "deferred") return;
    usage = entry.message.usage; provider = entry.message.provider; model = entry.message.responseModel ?? entry.message.model;
    activity = "model"; request = 1;
  } else if (entry.type === "message" && entry.message.role === "toolResult") {
    usage = entry.message.usage; activity = "tool";
  } else if (entry.type === "usage") {
    usage = entry.usage; provider = entry.provider; model = entry.model;
    activity = entry.kind === "cache_warm" ? "cache_warming" : "auxiliary";
    request = entry.kind === "cache_warm" ? 1 : undefined;
    // The pinned built-in cache warmer records separate work. Arbitrary
    // extension entries can overlap message/tool usage and lack that proof.
    additive = entry.kind === "cache_warm";
    backendTurnId = null;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    usage = entry.usage; activity = entry.type; backendTurnId = null;
  }
  if (!usage) return;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const tokens = usageTokens({input, uncachedInput: usage.input, cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite, output: usage.output, reasoning: usage.reasoning,
    total: usage.totalTokens, requests: request});
  const cost = nativeUsageMoney(usage.cost.total);
  const fact: UsageFact = {
    id: `${entry.id}:usage`, kind: activity === "model" ? "operation" : "auxiliary",
    sessionContribution: additive ? "additive" : "none", coverageDomain: "pi_native_entries",
    tokens, costs: [{amount: cost, currency: "USD", kind: "estimated", provenance: "pi-ai 0.86.0 SDK pricing"}],
    pricing: {canonicalModel: null, basis: "sdk_estimate", components: (["input", "output", "cacheRead", "cacheWrite"] as const)
      .map((kind) => ({kind, amount: nativeUsageMoney(usage.cost[kind]), currency: "USD"}))},
    models: [{provider, model}], basis: ["sdk_normalized"], providerPresence: "unknown",
    quality: additive ? "complete" : "partial", reasons: additive ? [] : ["unknown_attribution"], activity,
    turn: backendTurnId ? {backendTurnId, scope: "whole_turn", contribution: "additive"} : null,
  };
  return {id: `${entry.id}:usage`, revision: createHash("sha256").update(JSON.stringify(fact)).digest("hex"), order: null,
    provenance, occurredAt: validTime(entry.timestamp), replaceCheckpoint: false, facts: [fact]};
}

function validTime(value: string): string | null {
  const date = Date.parse(value); return Number.isFinite(date) ? new Date(date).toISOString() : null;
}

/** Main-side session subscription owns capture even when no browser is mounted. */
export class PiUsageAccounting {
  readonly #capture: UsageCapture;
  readonly #manager: SessionManager;
  readonly #authentication: PiToolIdentityAuthentication;
  readonly #inherited = new Set<string>();
  #parentNativeSession: string | undefined;
  #scanIncomplete = false;
  readonly #committed = new Map<string, string>();
  readonly #pending = new Map<string, UsageObservation>();
  readonly #turnByEntry = new Map<string, string>();
  constructor(input: {sink: UsageSink; binding: ConversationBinding; nativeNamespace: string; manager: SessionManager; authentication: PiToolIdentityAuthentication}) {
    this.#manager = input.manager; this.#authentication = input.authentication;
    this.#capture = input.sink.open({binding: input.binding, nativeNamespace: input.nativeNamespace,
      nativeSession: input.binding.backendConversationId, normalizationVersion: "pi-ai-0.86.0/usage-v1", epoch: "native_entries", initialBaseline: "unknown"});
    const entries = input.manager.getEntries();
    if (input.manager.getHeader()?.parentSession) {
      const boundary = entries.findIndex((entry) => {
        const read = readPiBranchMarker(entry, input.authentication.installationKey);
        if (read.status === "authenticated" && read.marker.targetBackendConversationId === input.binding.backendConversationId) {
          this.#parentNativeSession = read.marker.sourceBackendConversationId;
          return true;
        }
        return false;
      });
      // Excluding copied evidence needs no filesystem traversal. Only the
      // authenticated child boundary proves which later records are new work.
      for (const entry of boundary >= 0 ? entries.slice(0, boundary + 1) : entries) this.#inherited.add(entry.id);
      if (boundary < 0) this.#capture.gap("inherited_baseline_unknown");
    }
    this.reconcile("history");
  }
  reconcile(provenance: "live" | "history"): void {
    let complete = true;
    this.#scanIncomplete = true;
    try {
      const entries = this.#manager.getEntries();
      const parents = new Set(entries.map((entry) => entry.parentId));
      const turns = new Map<string, import("../../../shared/protocol/backend.js").BackendTurn>();
      const inheritedTurnIds = new Set<string>();
      for (const leaf of entries.filter((entry) => !parents.has(entry.id))) {
        const projected = new PiHistoryProjector({toolIdentityAuthentication: this.#authentication}).project(this.#manager.getBranch(leaf.id));
        for (const turn of Object.values(projected.snapshot.turnsById)) turns.set(turn.backendTurnId, turn);
        for (const [id, turn] of projected.backendTurnIdByEntryId) {
          this.#turnByEntry.set(id, turn);
          if (this.#inherited.has(id)) inheritedTurnIds.add(turn);
        }
      }
      this.#capture.registerTurns([...turns.values()], this.#parentNativeSession
        ? {nativeSession: this.#parentNativeSession, turns: [...inheritedTurnIds].map(backendTurnId => ({backendTurnId, sourceBackendTurnId: backendTurnId}))} : undefined);
      for (const entry of entries) {
        if (!this.#queue(entry, this.#turnByEntry.get(entry.id) ?? null, provenance)) complete = false;
        if (this.#pending.size >= 64 && !this.#flush()) return;
      }
      if (!this.#flush()) return;
      this.#scanIncomplete = false;
      if (complete && !this.#capture.reconcile()) this.#scanIncomplete = true;
    } catch { this.#capture.gap("capture_failed"); }
  }
  /** Live append already has the driver's authoritative active turn when available. */
  append(entry: SessionEntry, activeBackendTurnId?: string): void {
    try {
      let turnId = activeBackendTurnId ?? this.#turnByEntry.get(entry.id);
      if (!turnId && entry.type === "message") {
        const projected = new PiHistoryProjector({toolIdentityAuthentication: this.#authentication}).project(this.#manager.getBranch(entry.id));
        turnId = projected.backendTurnIdByEntryId.get(entry.id);
        this.#capture.registerTurns(Object.values(projected.snapshot.turnsById));
      }
      this.#queue(entry, turnId ?? null, "live");
      this.#flush();
    } catch { this.#capture.gap("capture_failed"); }
  }
  retryPending(): void {
    if (this.#scanIncomplete) this.reconcile("history");
    else this.#flush();
  }
  #queue(entry: SessionEntry, backendTurnId: string | null, provenance: "live" | "history"): boolean {
    if (this.#inherited.has(entry.id)) return true;
    try {
      const observation = piUsageObservation(entry, backendTurnId, provenance);
      if (!observation) return true;
      if (this.#committed.get(observation.id) === observation.revision) return true;
      if (observation.facts.some((fact) => fact.reasons.includes("unknown_attribution"))) this.#capture.gap("unknown_attribution");
      this.#pending.set(observation.id, observation);
      return true;
    } catch { this.#capture.gap("invalid_evidence"); return false; }
  }
  #flush(): boolean {
    const pending = [...this.#pending.values()];
    for (let index = 0; index < pending.length; index += 64) {
      const batch = pending.slice(index, index + 64);
      if (!this.#capture.capture(batch)) return false;
      for (const observation of batch) {
        this.#committed.set(observation.id, observation.revision);
        this.#pending.delete(observation.id);
      }
    }
    return true;
  }
  registerTurn(turn: import("../../../shared/protocol/backend.js").BackendTurn): void { this.#capture.registerTurns([turn]); }
  close(): void { this.#capture.seal("closed"); }
}
