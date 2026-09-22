import { randomUUID } from "node:crypto";
import type { ConversationBinding } from "../contracts.js";
import type { UsageCapture, UsageSink, UsageSubagentRootScope } from "../../usage/contracts.js";
import { usageTokens } from "../../usage/contracts.js";
import type { CodexSharedClientFacade, CodexClientLifecycleSnapshot } from "./codex-client-facade.js";
import type { CodexRpcNotification } from "./rpc/codex-rpc-client.js";
import { codexC2NotificationSchemas, refineCodexThreadStartedNotification } from "./codex-c2-protocol.js";
import { codexThreadResumeMethod, type CodexThreadTokenUsage } from "./codex-c1-protocol.js";
import { codexRuntimeMethod } from "./runtime/codex-runtime-protocol.js";
import type { ThreadClosedNotification } from "../../provider-protocol/bindings/codex-app-server/generated/0.153.0/stable/v2/ThreadClosedNotification.js";
import type { OfficialCodexClientRequestResult } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

const MAX_PENDING = 256;
const MAX_CHILDREN = 4096;
const EPOCH = "native-counter-v1";
const NORMALIZER = "codex-subagent-usage-v1";
type Counter = { generation: number; sequence: number; usage: CodexThreadTokenUsage };
type Child = { lease: { release(evicted?: boolean): Promise<void> } | undefined; binding: ConversationBinding; parent: string; capture: UsageCapture; generation: number; sequence: number };

/** Runtime-owned observer: child accounting outlives the root's presentation handle.
 * Only native spawn evidence descending from an admitted binding grants ownership.
 */
export class CodexSubagentUsageCoordinator {
  readonly #roots = new Map<string, ConversationBinding>();
  readonly #children = new Map<string, Child>();
  readonly #pendingParents = new Map<string, string>();
  readonly #pendingCounters = new Map<string, Counter>();
  readonly #pendingActivity = new Map<string, boolean>();
  readonly #incarnation = randomUUID();
  #generation = 0;
  #ready = false;
  #recovery: Promise<void> | undefined;
  #recoverAgain = false;
  #restoringRoots = false;

  constructor(readonly input: { client: CodexSharedClientFacade; sink: UsageSink; nativeNamespace: string; runtimeScope: Omit<UsageSubagentRootScope,"nativeNamespace">; onError: (error: unknown) => void }) {
    input.client.subscribeNotifications(notification => this.#safe(() => this.#notification(notification)));
    input.client.subscribeLifecycle(snapshot => this.#safe(() => this.#lifecycle(snapshot)));
  }

  registerRoot(binding: ConversationBinding): void {
    this.#safe(() => {
      const existing = this.#roots.get(binding.backendConversationId);
      if (existing && (["tenantId","ownerPrincipalId","applicationThreadId","backendInstanceId","executionEnvironmentId","connectionProfileId","backendConversationId"] as const)
        .some(key => existing[key] !== binding[key])) throw new Error("codex_subagent_root_conflict");
      if (existing) return;
      if (this.#children.has(binding.backendConversationId)) throw new Error("codex_subagent_root_is_child");
      const restored = this.input.sink.listSubagents({ binding, nativeNamespace: this.input.nativeNamespace });
      // Admission can fail transiently. Do not poison subsequent attachment
      // attempts by remembering a root whose durable recovery was never read.
      this.#roots.set(binding.backendConversationId, binding);
      for (const row of restored) {
        if (!this.#children.has(row.nativeSession)) this.#pendingParents.set(row.nativeSession, row.nativeParentSession);
      }
      this.#resolvePending(new Set(restored.map(row => row.nativeSession)));
      if (restored.length && this.#ready && !this.#restoringRoots) this.#scheduleRecovery();
    });
  }

  #lifecycle(snapshot: CodexClientLifecycleSnapshot): void {
    const ready = snapshot.state === "ready";
    const changed = snapshot.generation !== this.#generation;
    if ((!ready && this.#ready) || changed) {
      for (const child of this.#children.values()) {
        child.capture.gap("capture_gap");
        child.capture.seal("detached");
      }
      this.#pendingCounters.clear();
      this.#pendingParents.clear();
      this.#pendingActivity.clear();
    }
    const recovered = ready && (!this.#ready || changed);
    this.#generation = snapshot.generation;
    this.#ready = ready;
    if (snapshot.state === "closed") {
      for (const child of this.#children.values()) this.#release(child);
      this.#roots.clear();
      this.#children.clear();
    } else if (recovered) {
      for (const [id, child] of this.#children) {
        child.capture = this.#open(child.binding, id, child.parent);
        child.generation = this.#generation;
        child.sequence = -1;
      }
      this.#restoreRoots();
      if (this.#children.size) this.#scheduleRecovery();
    }
  }

  #restoreRoots(): void {
    this.#restoringRoots = true;
    try {
      // Enumerate only the durable registry for this exact runtime/profile.
      // This does not discover native history or open any root conversation.
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = this.input.sink.listSubagentRoots({ ...this.input.runtimeScope,
          nativeNamespace: this.input.nativeNamespace, cursor, limit: 128 });
        for (const binding of page.bindings) this.registerRoot(binding);
        cursor = page.nextCursor;
        if (cursor !== null && cursors.has(cursor)) throw new Error("codex_subagent_root_cursor_cycle");
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
    } catch (error) { this.#diagnose(error); }
    finally { this.#restoringRoots = false; }
  }

  #notification(notification: CodexRpcNotification): void {
    if (!this.#ready || notification.generation !== this.#generation) return;
    if (notification.kind === "undecodable_notification") {
      this.#children.get(notification.nativeThreadId)?.capture.gap("invalid_evidence");
      return;
    }
    if (notification.method === "thread/started") {
      const thread = refineCodexThreadStartedNotification(notification.params).thread;
      const source = thread.source;
      if (typeof source === "object" && "subAgent" in source && typeof source.subAgent === "object" && "thread_spawn" in source.subAgent) {
        this.#discover(thread.id, source.subAgent.thread_spawn.parent_thread_id);
      }
    } else if (notification.method === "item/completed") {
      const event = codexC2NotificationSchemas["item/completed"].parse(notification.params);
      const item = event.item;
      // send/wait/resume operations do not prove ancestry. Only the spawn result does.
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && item.status === "completed" && item.senderThreadId === event.threadId) {
        for (const id of item.receiverThreadIds) this.#discover(id, event.threadId);
      }
    } else if (notification.method === "thread/closed") {
      // The shared RPC decoder validates this stable lifecycle notification
      // against its official schema before producing decoded_notification.
      const event = notification.params as ThreadClosedNotification;
      const child = this.#children.get(event.threadId);
      if (child) { child.capture.seal("closed"); this.#release(child); }
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, false);
    } else if (notification.method === "thread/status/changed") {
      const event = codexC2NotificationSchemas["thread/status/changed"].parse(notification.params);
      const child = this.#children.get(event.threadId);
      if (child) {
        if (event.status.type === "active") child.lease ??= this.input.client.residency?.retain();
        else if (event.status.type === "idle") this.#release(child);
        else { child.capture.gap("capture_gap"); this.#release(child); }
      }
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, event.status.type === "active");
    } else if (notification.method === "turn/started" || notification.method === "turn/completed") {
      const event = codexC2NotificationSchemas[notification.method].parse(notification.params);
      const child = this.#children.get(event.threadId);
      if (child) {
        if (notification.method === "turn/started") {
          child.capture = this.#open(child.binding, event.threadId, child.parent);
          child.lease ??= this.input.client.residency?.retain();
        }
        else this.#release(child);
      }
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, notification.method === "turn/started");
    } else if (notification.method === "thread/tokenUsage/updated") {
      const event = codexC2NotificationSchemas["thread/tokenUsage/updated"].parse(notification.params);
      const counter = { generation: notification.generation, sequence: notification.sequence, usage: event.tokenUsage };
      const child = this.#children.get(event.threadId);
      if (child) this.#capture(event.threadId, child, counter);
      else if (!this.#roots.has(event.threadId) && (this.#pendingCounters.get(event.threadId)?.sequence ?? -1) < counter.sequence) this.#boundedSet(this.#pendingCounters, event.threadId, counter);
    }
  }

  #discover(id: string, parent: string): void {
    if (id === parent || this.#roots.has(id)) throw new Error("codex_subagent_identity_conflict");
    const child = this.#children.get(id);
    if (child) {
      if (child.parent !== parent) throw new Error("codex_subagent_parent_conflict");
      return;
    }
    const pending = this.#pendingParents.get(id);
    if (pending && pending !== parent) throw new Error("codex_subagent_parent_conflict");
    this.#boundedSet(this.#pendingParents, id, parent);
    this.#resolvePending();
  }

  #resolvePending(restored: ReadonlySet<string> = new Set()): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parent] of this.#pendingParents) {
        const binding = this.#roots.get(parent) ?? this.#children.get(parent)?.binding;
        if (!binding) continue;
        if (this.#children.size >= MAX_CHILDREN) throw new Error("codex_subagent_capture_limit");
        const capture = this.#open(binding, id, parent);
        const child: Child = { lease: this.#pendingActivity.get(id) === false ? undefined : this.input.client.residency?.retain(), binding, parent, capture, generation: this.#generation, sequence: -1 };
        this.#children.set(id, child);
        this.#pendingActivity.delete(id);
        if (restored.has(id)) child.capture.gap("capture_gap");
        this.#pendingParents.delete(id);
        const counter = this.#pendingCounters.get(id);
        this.#pendingCounters.delete(id);
        if (counter) this.#capture(id, child, counter);
        changed = true;
      }
    }
  }

  #open(binding: ConversationBinding, id: string, parent: string): UsageCapture {
    return this.input.sink.open({ binding, nativeNamespace: this.input.nativeNamespace, nativeSession: id,
      epoch: EPOCH, normalizationVersion: NORMALIZER, initialBaseline: "unknown", subagent: { nativeParentSession: parent } });
  }

  #capture(id: string, child: Child, counter: Counter): void {
    if (counter.generation !== this.#generation || (child.generation === counter.generation && counter.sequence <= child.sequence)) return;
    const total = counter.usage.total;
    const accepted = child.capture.capture([{ id: `${this.#incarnation}:${counter.generation}:${counter.sequence}`, revision: "1", order: null,
      provenance: "live", occurredAt: null, replaceCheckpoint: true, facts: [{ id: "session-counter", kind: "cumulative", sessionContribution: "checkpoint",
        coverageDomain: "native-counter", tokens: usageTokens({ input: total.inputTokens, cacheRead: total.cachedInputTokens,
          cacheWrite: total.cacheWriteInputTokens, output: total.outputTokens, reasoning: total.reasoningOutputTokens, total: total.totalTokens }),
        costs: [], models: [{ provider: null, model: null }], basis: ["sdk_normalized"], providerPresence: "unknown", quality: "complete",
        reasons: ["model_coverage_unknown"], activity: "model", turn: null }] }]);
    if (accepted) {
      child.generation = counter.generation;
      child.sequence = counter.sequence;
      // This source contains only an authoritative lifetime counter, so its next
      // snapshot recovers missed observations without replaying any transcript.
      child.capture.reconcile();
    }
  }

  #scheduleRecovery(): void {
    if (this.#recovery) { this.#recoverAgain = true; return; }
    this.#recovery = this.#recover().catch(error => this.#diagnose(error)).finally(() => {
      this.#recovery = undefined;
      if (this.#recoverAgain) { this.#recoverAgain = false; if (this.#ready) this.#scheduleRecovery(); }
    });
  }

  async #recover(): Promise<void> {
    const generation = this.#generation;
    const current = () => this.#ready && this.#generation === generation;
    const loaded = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 64; page++) {
      const receipt = await this.input.client.requestWithReceipt(codexRuntimeMethod("thread/loaded/list"), { cursor, limit: 100 }, { timeoutMilliseconds: 10_000 });
      if (!current() || receipt.generation !== generation) return;
      const result = receipt.result as OfficialCodexClientRequestResult<"thread/loaded/list">;
      for (const id of result.data) loaded.add(id);
      if (loaded.size > MAX_CHILDREN) throw new Error("codex_subagent_inventory_limit");
      cursor = result.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor) || page === 63) throw new Error("codex_subagent_inventory_incomplete");
      cursors.add(cursor);
    }
    for (const [id, child] of this.#children) {
      if (!current()) return;
      if (!loaded.has(id)) { this.#release(child); continue; } // Never load an old completed thread to recover accounting.
      try {
        const receipt = await this.input.client.requestWithReceipt(codexThreadResumeMethod, { threadId: id, excludeTurns: true }, { timeoutMilliseconds: 10_000 });
        if (!current() || receipt.generation !== generation) return;
        if (receipt.result.thread.id !== id) throw new Error("codex_subagent_resume_identity_mismatch");
        if (receipt.result.thread.status.type === "idle") this.#release(child);
        else child.lease ??= this.input.client.residency?.retain();
      } catch (error) {
        if (!current()) return;
        child.capture.gap("capture_gap");
        this.#diagnose(error);
      }
    }
  }

  #release(child: Child): void {
    const lease = child.lease;
    child.lease = undefined;
    void lease?.release().catch(error => { try { this.input.onError(error); } catch { /* Diagnostic only. */ } });
  }

  #boundedSet<T>(map: Map<string, T>, id: string, value: T): void {
    if (!map.has(id) && map.size >= MAX_PENDING) map.delete(map.keys().next().value!);
    map.set(id, value);
  }

  #diagnose(error: unknown): void {
    try { this.input.onError(error); } catch { /* Diagnostic only. */ }
  }

  #safe(action: () => void): void {
    try { action(); } catch (error) { this.#diagnose(error); }
  }
}
