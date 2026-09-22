import type { ConversationBinding } from "../backends/contracts.js";
import type { BackendTurn } from "../../shared/protocol/backend.js";
import type { UsageBasis, UsageModel, UsageMoney, UsageReason, UsageTokenKind } from "../../shared/protocol/usage-accounting.js";

/** Backend-private parsing must finish before entering this normalized boundary. */
export interface UsageFact {
  readonly id: string;
  readonly kind: "operation" | "auxiliary" | "cumulative" | "turn_aggregate";
  /** A checkpoint covers additive facts in this source. Allocations never charge the session twice. */
  readonly sessionContribution: "additive" | "checkpoint" | "none";
  readonly coverageDomain: string;
  readonly tokens: Readonly<Partial<Record<UsageTokenKind, string | null>>>;
  readonly costs: readonly UsageMoney[];
  /** Supplied pricing metadata is retained evidence, never an additional charge. */
  readonly pricing?: {
    readonly canonicalModel: string | null;
    readonly basis: string | null;
    readonly components: readonly {readonly kind: "input" | "output" | "cacheRead" | "cacheWrite" | "model_total"; readonly amount: string; readonly currency: string}[];
  };
  readonly models: readonly UsageModel[];
  readonly basis: readonly UsageBasis[];
  readonly providerPresence: "reported" | "unknown";
  readonly quality: "complete" | "partial";
  readonly reasons: readonly UsageReason[];
  readonly activity: "model" | "tool" | "compaction" | "branch_summary" | "cache_warming" | "auxiliary";
  readonly turn: {
    readonly backendTurnId: string;
    readonly scope: "whole_turn" | "main_loop" | "partial_interval";
    /** Later result/checkpoint replaces message allocations in this same domain for this turn. */
    readonly contribution: "additive" | "checkpoint";
  } | null;
  /** Verified ancestor only; the receiver validates scoped application ownership and source membership. */
  readonly inheritedFrom?: { readonly applicationThreadId: string; readonly factId: string };
}
export interface UsageObservation {
  readonly id: string;
  readonly revision: string;
  /** Optional source-proven order, never a receipt timestamp. */
  readonly order: string | null;
  readonly provenance: "live" | "history";
  readonly occurredAt: string | null;
  /** One cumulative snapshot replaces all prior checkpoint members atomically. */
  readonly replaceCheckpoint: boolean;
  readonly facts: readonly UsageFact[];
}
export interface UsageCapture {
  registerTurns(turns: readonly BackendTurn[], inherited?: { readonly turns: readonly { readonly backendTurnId: string; readonly sourceBackendTurnId: string }[] } & ({ readonly nativeSession: string } | { readonly forkOperationId: string })): void;
  capture(observations: readonly UsageObservation[]): boolean;
  /** Call only after complete authoritative history, or an authoritative cumulative subagent snapshot, has been successfully ingested. */
  reconcile(): boolean;
  gap(reason: UsageReason): void;
  seal(reason: "reset" | "detached" | "closed"): void;
}
export interface UsageSubagentRootScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly connectionProfileId: string;
  readonly nativeNamespace: string;
}
export interface UsageSink {
  /** Only roots with recorded descendants, paginated within an admitted runtime scope. */
  listSubagentRoots(input: UsageSubagentRootScope & {readonly cursor: string | null; readonly limit: number}): {
    readonly bindings: readonly ConversationBinding[];
    readonly nextCursor: string | null;
  };
  /** Backend-private descendants of this admitted root; never application threads. */
  listSubagents(input: { readonly binding: ConversationBinding; readonly nativeNamespace: string }): readonly {
    readonly nativeSession: string;
    readonly nativeParentSession: string;
    readonly epoch: string;
    readonly normalizationVersion: string;
    readonly captureState: "active" | "idle" | "disconnected" | "failed";
  }[];
  open(input: {
    readonly binding: ConversationBinding;
    readonly nativeNamespace: string;
    readonly nativeSession: string;
    /** Actual counter/query epoch; reconnecting transport identity alone is not an epoch. */
    readonly epoch: string;
    readonly normalizationVersion: string;
    readonly initialBaseline: "proven_zero" | "unknown";
    /** Verified native spawn relationship. Binding always names the root application conversation. */
    readonly subagent?: { readonly nativeParentSession: string };
  }): UsageCapture;
}

/** Explicit test/unsupported disposition, never used for supported production capture. */
export const NO_USAGE_CAPTURE: UsageCapture = {
  registerTurns: () => undefined,
  capture: () => true,
  reconcile: () => true,
  gap: () => undefined,
  seal: () => undefined,
};
export const NO_USAGE_SINK: UsageSink = { open: () => NO_USAGE_CAPTURE, listSubagents: () => [], listSubagentRoots: () => ({bindings:[],nextCursor:null}) };

/** Native numbers must still be exact before normalization; strings are not a second native shape. */
export function usageCount(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_native_usage_count");
  return String(value);
}
export function usageTokens(values: Partial<Record<UsageTokenKind, number | null | undefined>>): Partial<Record<UsageTokenKind, string | null>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, usageCount(value)]));
}
