import { createHash } from "node:crypto";
import type { BackendTurn } from "../../../shared/protocol/backend.js";
import type { UsageModel, UsageReason } from "../../../shared/protocol/usage-accounting.js";
import { usageCount, type UsageCapture, type UsageFact, type UsageObservation, type UsageSink } from "../../usage/contracts.js";
import { nativeUsageMoney } from "../../usage/native-money.js";
import type { AttachConversationInput } from "../contracts.js";
import { requireOpenCodeBinding, type OpenCodeDriverContext, type OpenCodeConversationRuntime } from "./opencode-conversation-context.js";
import { OpenCodeNativeApi, type OpenCodeNativeMessage, type OpenCodeNativeSession } from "./opencode-native-api.js";
import type { OpenCodeHttpClient } from "./opencode-http-client.js";
import { openCodeHistoryTurnId } from "./opencode-history-projection.js";

export interface OpenCodeUsageLease {
  record(messages: readonly OpenCodeNativeMessage[], turns: readonly BackendTurn[]): void;
  gap(reason: UsageReason): void;
  release(): void;
  settled(): Promise<void>;
}
const disabled: OpenCodeUsageLease = { record() {}, gap() {}, release() {}, settled: async () => {} };
interface Entry {
  readonly key: string;
  readonly client: OpenCodeHttpClient;
  readonly generation: string;
  readonly context: OpenCodeDriverContext;
  readonly input: AttachConversationInput;
  readonly runtime: OpenCodeConversationRuntime;
  readonly abort: () => void;
  references: number;
  closed: boolean;
  tail: Promise<void>;
  pending?: { messages: readonly OpenCodeNativeMessage[]; turns: readonly BackendTurn[] };
  reading: boolean;
  capture?: UsageCapture;
  gapPending: boolean;
}

/** Shared by actor and read handles. Reconnect never creates a new native accounting epoch. */
export class OpenCodeUsageAccounting {
  readonly #clients = new WeakMap<OpenCodeHttpClient, Map<string, Entry>>();
  readonly #entries = new Set<Entry>();
  #closed = false;
  #capacityWarned = false;
  constructor(readonly sink: UsageSink) {}
  get enabled(): boolean { return this.sink.enabled; }

  acquire(context: OpenCodeDriverContext, input: AttachConversationInput, runtime: OpenCodeConversationRuntime, client: OpenCodeHttpClient): OpenCodeUsageLease {
    if (!this.sink.enabled || this.#closed) return disabled;
    requireOpenCodeBinding(context, input);
    const { binding } = input;
    const key = hash([input.scope.tenantId, input.scope.principalId, binding.applicationThreadId,
      binding.backendInstanceId, binding.connectionProfileId, binding.executionEnvironmentId,
      binding.backendConversationId, input.opaqueBindingDetail]);
    let entries = this.#clients.get(client);
    if (!entries) { entries = new Map(); this.#clients.set(client, entries); }
    let entry = entries.get(key);
    if (!entry) {
      if (this.#entries.size >= 1_000) {
        if (!this.#capacityWarned) { this.#capacityWarned = true; console.warn("OpenCode usage capture limit reached; additional captures are unavailable."); }
        return disabled;
      }
      if (!runtime.snapshot().generation) return disabled;
      const created: Entry = { key, client, generation: runtime.snapshot().generation!, context, input, runtime,
        references: 0, closed: false, tail: Promise.resolve(), reading: false, gapPending: false, abort: () => this.#retire(created) };
      entry = created; entries.set(key, entry); this.#entries.add(entry);
      client.lifetime.addEventListener("abort", entry.abort, { once: true });
    }
    const current = entry; current.references++;
    let released = false;
    return {
      record: (messages, turns) => {
        if (released || current.closed) return;
        // Keep at most one pending retained snapshot. A counter read cannot
        // race another publisher for this exact source or build an event queue.
        current.pending = { messages, turns };
        if (current.reading) return;
        current.reading = true;
        current.tail = this.#drain(current);
      },
      gap: reason => { if (!released && !current.closed) { current.gapPending = true; safely(() => current.capture?.gap(reason)); } },
      release: () => {
        if (released) return; released = true; current.references--;
        void current.tail.finally(() => { if (current.references === 0) this.#retire(current); });
      },
      settled: () => current.tail,
    };
  }
  close(): void { this.#closed = true; for (const entry of [...this.#entries]) this.#retire(entry); }

  async #drain(entry: Entry): Promise<void> {
    try {
      while (entry.pending && !entry.closed) {
        const pending = entry.pending; entry.pending = undefined;
        try { await this.#record(entry, pending.messages, pending.turns); }
        catch { if (!entry.closed) { entry.gapPending = true; safely(() => entry.capture?.gap("capture_failed")); } }
      }
    } finally { entry.reading = false; }
  }

  async #record(entry: Entry, messages: readonly OpenCodeNativeMessage[], turns: readonly BackendTurn[]): Promise<void> {
    if (entry.closed || this.#closed || entry.client.lifetime.aborted) return;
    requireOpenCodeBinding(entry.context, entry.input);
    if (entry.runtime.snapshot().generation !== entry.generation) throw new Error("opencode_usage_generation_changed");
    const signal = AbortSignal.any([entry.client.lifetime, AbortSignal.timeout(30_000)]);
    const session = await new OpenCodeNativeApi(entry.client).getSession(entry.input.binding.backendConversationId, signal);
    await entry.runtime.assertCurrent(signal);
    if (entry.closed || this.#closed) return;
    requireOpenCodeBinding(entry.context, entry.input);
    if (entry.runtime.snapshot().generation !== entry.generation || session.location.directory !== entry.input.workspace.canonicalPath) throw new Error("opencode_usage_authority_changed");
    const checkpoint = openCodeUsageCheckpoint(session);
    if (!entry.capture) {
      const proven = !session.parentID && !session.fork && entry.context.repository.hasCreatedRoot(entry.input.scope, entry.input.binding.applicationThreadId, session.id);
      entry.capture = this.sink.open({ binding: entry.input.binding, nativeNamespace: entry.context.nativeNamespaceKey, nativeSession: session.id,
        epoch: "native-session-counter-v1", normalizationVersion: "opencode-2.0.18-usage-v1", initialBaseline: proven ? "proven_zero" : "unknown",
        ...(!proven ? { reportedBaseline: { ...checkpoint, id: "native-session-baseline" } } : {}) });
      if (entry.gapPending) entry.capture.gap("capture_gap");
    }
    entry.capture.registerTurns(turns);
    if (!entry.capture.capture([checkpoint])) return;
    // A native fork's copied transcript is not new work in its fresh counter.
    if (!session.parentID && !session.fork) {
      const observations = openCodeUsageAllocations(session.id, messages, new Set(turns.map(turn => turn.backendTurnId)));
      for (let index = 0; index < observations.length; index += 256) if (!entry.capture.capture(observations.slice(index, index + 256))) return;
    } else entry.capture.gap("inherited_baseline_unknown");
    // Retained history plus the persisted lifetime counter restores capture,
    // while explicit baseline/model/child limitations remain in normalized facts.
    entry.capture.reconcile(); entry.gapPending = false;
  }
  #retire(entry: Entry): void {
    if (entry.closed) return; entry.closed = true;
    entry.pending = undefined;
    entry.client.lifetime.removeEventListener("abort", entry.abort);
    this.#clients.get(entry.client)?.delete(entry.key); this.#entries.delete(entry);
    safely(() => entry.capture?.seal("detached"));
  }
}

type NativeTokens = OpenCodeNativeSession["tokens"];
function tokens(value: NativeTokens | undefined): UsageFact["tokens"] {
  const uncachedInput = usageCount(value?.input), cacheRead = usageCount(value?.cache.read), cacheWrite = usageCount(value?.cache.write);
  const reasoning = usageCount(value?.reasoning), visible = usageCount(value?.output);
  const input = sum(uncachedInput, cacheRead, cacheWrite), output = sum(visible, reasoning);
  return { input, uncachedInput, cacheRead, cacheWrite, output, reasoning, total: sum(input, output), requests: null };
}
function sum(...values: (string | null)[]): string | null {
  if (values.some(value => value === null)) return null;
  const value = values.reduce((total, next) => total + BigInt(next!), 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("opencode_usage_sum_invalid");
  return value.toString();
}
function costs(value: number | undefined): UsageFact["costs"] {
  return value === undefined ? [] : [{ amount: nativeUsageMoney(value), currency: "USD", kind: "estimated", provenance: "OpenCode native catalog estimate" }];
}
function model(value: { providerID: string; id: string } | undefined): readonly UsageModel[] {
  return value && bounded(value.providerID) && bounded(value.id) ? [{ provider: value.providerID, model: value.id }] : [];
}
function bounded(value: string) { return !!value && value.length <= 240 && !/\p{Cc}/u.test(value); }
const base = { coverageDomain: "opencode_main_session", basis: ["sdk_normalized", "derived"] as const,
  providerPresence: "unknown" as const, quality: "partial" as const };
export function openCodeUsageCheckpoint(session: OpenCodeNativeSession): UsageObservation {
  const fact: UsageFact = { ...base, id: "native-session-counter", kind: "cumulative", sessionContribution: "checkpoint",
    tokens: tokens(session.tokens), costs: costs(session.cost), models: [], reasons: ["child_coverage_unknown", "model_coverage_unknown"], activity: "model", turn: null };
  // Native deliberately leaves time.updated unchanged when incrementing usage.
  // No public source timestamp identifies this lifetime checkpoint.
  return observation("native-session-counter", [fact], true, null);
}
export function openCodeUsageAllocations(sessionID: string, messages: readonly OpenCodeNativeMessage[], turns: ReadonlySet<string>): UsageObservation[] {
  const result: UsageObservation[] = []; let opening: string | undefined;
  for (const message of messages) {
    opening ??= message.id;
    const turn = openCodeHistoryTurnId(sessionID, opening);
    if (message.type === "idle") { opening = undefined; continue; }
    if (!turns.has(turn)) continue;
    if (message.type !== "assistant" && message.type !== "compaction") continue;
    if (message.type === "assistant" && message.time.streamed === undefined && message.time.completed === undefined && !message.error ||
        message.type === "compaction" && message.status === "running") continue;
    const native = message as Extract<OpenCodeNativeMessage, { type: "assistant" }> | Exclude<Extract<OpenCodeNativeMessage, { type: "compaction" }>, { status: "running" }>;
    if (native.tokens === undefined && native.cost === undefined) continue;
    const fact: UsageFact = { ...base, id: `message:${message.id}`, kind: "operation", sessionContribution: "none",
      tokens: tokens(native.tokens), costs: costs(native.cost), models: model("model" in native ? native.model : undefined),
      reasons: ["main_loop_only", "history_partial"], activity: message.type === "compaction" ? "compaction" : "model",
      turn: { backendTurnId: turn, scope: "main_loop", contribution: "additive" } };
    result.push(observation(`message:${message.id}`, [fact], false, message.time.created));
  }
  return result;
}
function observation(id: string, facts: readonly UsageFact[], replaceCheckpoint: boolean, time: number | null): UsageObservation {
  return { id, revision: hash(facts), order: null, provenance: "history", occurredAt: time === null ? null : new Date(time).toISOString(), replaceCheckpoint, facts };
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safely(action: () => void): void { try { action(); } catch { /* Optional accounting cannot break provider execution. */ } }
