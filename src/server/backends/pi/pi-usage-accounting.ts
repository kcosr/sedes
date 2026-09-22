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
  const cost = decimalAmount(usage.cost.total);
  const fact: UsageFact = {
    id: `${entry.id}:usage`, kind: activity === "model" ? "operation" : "auxiliary",
    sessionContribution: additive ? "additive" : "none", coverageDomain: "pi_native_entries",
    tokens, costs: [{amount: cost, currency: "USD", kind: "estimated", provenance: "pi-ai 0.86.0 SDK pricing"}],
    pricing: {canonicalModel: null, basis: "sdk_estimate", components: (["input", "output", "cacheRead", "cacheWrite"] as const)
      .map((kind) => ({kind, amount: decimalAmount(usage.cost[kind]), currency: "USD"}))},
    models: [{provider, model}], basis: ["sdk_normalized"], providerPresence: "unknown",
    quality: additive ? "complete" : "partial", reasons: additive ? [] : ["unknown_attribution"], activity,
    turn: backendTurnId ? {backendTurnId, scope: "whole_turn", contribution: "additive"} : null,
  };
  return {id: `${entry.id}:usage`, revision: createHash("sha256").update(JSON.stringify(fact)).digest("hex"), order: null,
    provenance, occurredAt: validTime(entry.timestamp), replaceCheckpoint: false, facts: [fact]};
}

export function decimalAmount(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_native_usage_money");
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = whole! + fraction;
  const point = whole!.length + exponent;
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  return point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
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
    try {
      const entries = this.#manager.getEntries();
      const parents = new Set(entries.map((entry) => entry.parentId));
      const turnByEntry = new Map<string, string>();
      for (const leaf of entries.filter((entry) => !parents.has(entry.id))) {
        const projected = new PiHistoryProjector({toolIdentityAuthentication: this.#authentication}).project(this.#manager.getBranch(leaf.id));
        const inheritedTurnIds = [...new Set([...projected.backendTurnIdByEntryId]
          .filter(([id]) => this.#inherited.has(id)).map(([, id]) => id))];
        this.#capture.registerTurns(Object.values(projected.snapshot.turnsById), this.#parentNativeSession
          ? {nativeSession: this.#parentNativeSession, turns: inheritedTurnIds.map(backendTurnId => ({backendTurnId, sourceBackendTurnId: backendTurnId}))} : undefined);
        for (const [id, turn] of projected.backendTurnIdByEntryId) turnByEntry.set(id, turn);
      }
      const observations: UsageObservation[] = [];
      for (const entry of entries) {
        if (this.#inherited.has(entry.id)) continue;
        try {
          const observation = piUsageObservation(entry, turnByEntry.get(entry.id) ?? null, provenance);
          if (!observation) continue;
          if (observation.facts.some((fact) => fact.reasons.includes("unknown_attribution"))) this.#capture.gap("unknown_attribution");
          observations.push(observation);
          if (observations.length === 64) this.#capture.capture(observations.splice(0));

        } catch { this.#capture.gap("invalid_evidence"); }
      }
      if (observations.length) this.#capture.capture(observations);
    } catch { this.#capture.gap("capture_failed"); }
  }
  registerTurn(turn: import("../../../shared/protocol/backend.js").BackendTurn): void { this.#capture.registerTurns([turn]); }
  close(): void { this.#capture.seal("closed"); }
}
