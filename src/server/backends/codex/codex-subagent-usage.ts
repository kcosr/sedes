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
type Child = { id:string; closed:boolean; activitySequence:number; subscribedGeneration:number|null; attachedGeneration:number|null; attachmentRevision:number; pendingRelease:{revision:number;promise:Promise<void>}|undefined; lease: { release(evicted?: boolean): Promise<void> } | undefined; binding: ConversationBinding; parent: string; capture: UsageCapture; captureOpen: boolean; active: boolean; generation: number; sequence: number };

/** Runtime-owned observer: child accounting outlives the root's presentation handle.
 * Only native spawn evidence descending from an admitted binding grants ownership.
 */
export class CodexSubagentUsageCoordinator {
  readonly #roots = new Map<string, ConversationBinding>();
  readonly #pendingRoots = new Map<string, ConversationBinding>();
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
  #releaseTail: Promise<void> = Promise.resolve();

  constructor(readonly input: { client: CodexSharedClientFacade; sink: UsageSink; nativeNamespace: string; runtimeScope: Omit<UsageSubagentRootScope,"nativeNamespace">; onError: (error: unknown) => void }) {
    input.client.subscribeNotifications(notification => this.#safe(() => this.#notification(notification)));
    input.client.subscribeLifecycle(snapshot => this.#safe(() => this.#lifecycle(snapshot)));
  }

  registerRoot(binding: ConversationBinding): void {
    this.#safe(() => {
      const existing = this.#roots.get(binding.backendConversationId) ?? this.#pendingRoots.get(binding.backendConversationId);
      if (existing && (["tenantId","ownerPrincipalId","applicationThreadId","backendInstanceId","executionEnvironmentId","connectionProfileId","backendConversationId"] as const)
        .some(key => existing[key] !== binding[key])) throw new Error("codex_subagent_root_conflict");
      if (this.#roots.has(binding.backendConversationId)) return;
      if (this.#children.has(binding.backendConversationId)) throw new Error("codex_subagent_root_is_child");
      // Remember trusted attachment identity without admitting it. A transient
      // database failure can be retried by later spawn evidence or reconnect.
      this.#pendingRoots.set(binding.backendConversationId, binding);
      let restored: ReturnType<UsageSink["listSubagents"]>;
      try { restored = this.input.sink.listSubagents({ binding, nativeNamespace: this.input.nativeNamespace }); }
      catch (cause) { throw new Error("codex_subagent_root_admission_failed", { cause }); }
      this.#roots.set(binding.backendConversationId, binding);
      this.#pendingRoots.delete(binding.backendConversationId);
      for (const row of restored) {
        if (!this.#children.has(row.nativeSession)) this.#pendingParents.set(row.nativeSession, row.nativeParentSession);
      }
      this.#resolvePending(new Map(restored.map(row => [row.nativeSession,row.captureState])), binding);
      if (restored.some(row=>row.captureState!=="idle") && this.#ready && !this.#restoringRoots) this.#scheduleRecovery();
    });
  }

  #lifecycle(snapshot: CodexClientLifecycleSnapshot): void {
    const ready = snapshot.state === "ready";
    const changed = snapshot.generation !== this.#generation;
    if ((!ready && this.#ready) || changed) {
      for (const child of this.#children.values()) {
        child.attachedGeneration = null;
        // A replacement process has no work protected by the old lease.
        // Do not send an eviction carrying the old generation to the new host.
        if (changed) this.#release(child, false);
        if (child.active && child.captureOpen) {
          child.capture.gap("capture_gap");
          child.capture.seal("detached");
          child.captureOpen = false;
        }
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
      this.#pendingRoots.clear();
      this.#children.clear();
    } else if (recovered) {
      for (const [id, child] of this.#children) {
        // Idle identities remain in the accounting registry. Actual new native
        // activity can look one up; reconnect does not revisit their history.
        if (!child.active) { this.#children.delete(id); continue; }
        if (child.active) this.#ensureCapture(id,child);
        child.generation = this.#generation;
        child.sequence = -1;
        child.activitySequence = -1;
        child.subscribedGeneration = null;
      }
      for (const binding of [...this.#pendingRoots.values()]) this.registerRoot(binding);
      this.#restoreRoots();
      if ([...this.#children.values()].some(child=>child.active)) this.#scheduleRecovery();
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
      const child=this.#children.get(notification.nativeThreadId);
      if(child){this.#ensureCapture(child.id,child);child.capture.gap("invalid_evidence");if(!child.active)this.#idle(child);}
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
      } else if (item.type === "subAgentActivity" && item.kind === "started") {
        // Multi-agent v2 emits this public spawn record; its v1 collaboration
        // record is analytics-only. Other activity kinds do not prove ancestry.
        this.#discover(item.agentThreadId, event.threadId);
      }
    } else if (notification.method === "thread/closed") {
      // The shared RPC decoder validates this stable lifecycle notification
      // against its official schema before producing decoded_notification.
      const event = notification.params as ThreadClosedNotification;
      const child = this.#children.get(event.threadId);
      if (child) {child.activitySequence=notification.sequence;this.#idle(child,true);}
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, false);
    } else if (notification.method === "thread/status/changed") {
      const event = codexC2NotificationSchemas["thread/status/changed"].parse(notification.params);
      const child = this.#children.get(event.threadId) ?? (event.status.type === "active" ? this.#restoreKnownChild(event.threadId) : undefined);
      if (child) {
        child.activitySequence=notification.sequence;
        if (event.status.type === "active") this.#activate(event.threadId,child);
        else if (event.status.type === "idle") this.#idle(child);
        else { this.#ensureCapture(event.threadId,child);child.capture.gap("capture_gap");this.#idle(child); }
      }
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, event.status.type === "active");
    } else if (notification.method === "turn/started" || notification.method === "turn/completed") {
      const event = codexC2NotificationSchemas[notification.method].parse(notification.params);
      const child = this.#children.get(event.threadId) ?? (notification.method === "turn/started" ? this.#restoreKnownChild(event.threadId) : undefined);
      if (child) {
        child.activitySequence=notification.sequence;
        if (notification.method === "turn/started") {
          this.#activate(event.threadId,child);
        }
        else this.#idle(child);
      }
      else if (!this.#roots.has(event.threadId)) this.#boundedSet(this.#pendingActivity, event.threadId, notification.method === "turn/started");
    } else if (notification.method === "thread/tokenUsage/updated") {
      const event = codexC2NotificationSchemas["thread/tokenUsage/updated"].parse(notification.params);
      const counter = { generation: notification.generation, sequence: notification.sequence, usage: event.tokenUsage };
      const child = this.#children.get(event.threadId) ?? this.#restoreKnownChild(event.threadId);
      if (child) this.#capture(event.threadId, child, counter);
      else if (!this.#roots.has(event.threadId) && (this.#pendingCounters.get(event.threadId)?.sequence ?? -1) < counter.sequence) this.#boundedSet(this.#pendingCounters, event.threadId, counter);
    }
  }

  #discover(id: string, parent: string): void {
    if (id === parent || this.#roots.has(id) || this.#pendingRoots.has(id)) throw new Error("codex_subagent_identity_conflict");
    const child = this.#children.get(id);
    if (child) {
      if (child.parent !== parent) throw new Error("codex_subagent_parent_conflict");
      return;
    }
    const pending = this.#pendingParents.get(id);
    if (pending && pending !== parent) throw new Error("codex_subagent_parent_conflict");
    this.#boundedSet(this.#pendingParents, id, parent);
    const pendingRoot = this.#pendingRoots.get(parent);
    if (pendingRoot) this.registerRoot(pendingRoot);
    this.#resolvePending();
  }

  #restoreKnownChild(id: string): Child | undefined {
    if (this.#roots.has(id) || this.#pendingRoots.has(id)) return undefined;
    const stored = this.input.sink.findSubagent({ ...this.input.runtimeScope, nativeNamespace: this.input.nativeNamespace, nativeSession: id });
    if (!stored) return undefined;
    this.#boundedSet(this.#pendingParents, id, stored.nativeParentSession);
    // A targeted live event proves this identity is relevant now. Start idle;
    // the calling event, not historical accounting, determines activity.
    this.#resolvePending(new Map([[id, "idle"]]), stored.binding, true);
    return this.#children.get(id);
  }

  #resolvePending(restored: ReadonlyMap<string, "active" | "idle" | "disconnected" | "failed"> = new Map(), restoredBinding?: ConversationBinding, liveEvent = false): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parent] of this.#pendingParents) {
        if (restored.get(id) === "idle" && !liveEvent) { this.#pendingParents.delete(id); continue; }
        const binding = (restored.has(id) ? restoredBinding : undefined) ?? this.#roots.get(parent) ?? this.#children.get(parent)?.binding
          ?? this.input.sink.findSubagent({ ...this.input.runtimeScope, nativeNamespace: this.input.nativeNamespace, nativeSession: parent })?.binding;
        if (!binding) continue;
        if (this.#children.size >= MAX_CHILDREN) {
          this.#pendingParents.delete(id);
          this.#pendingCounters.delete(id);
          this.#pendingActivity.delete(id);
          const rejected=this.#open(binding,id,parent);
          rejected.gap("capture_gap");rejected.seal("detached");
          this.#diagnose(new Error("codex_subagent_capture_limit"));
          continue;
        }
        const capture = this.#open(binding, id, parent);
        const active = this.#pendingActivity.get(id) ?? restored.get(id) !== "idle";
        const child: Child = { id,closed:false,activitySequence:-1,subscribedGeneration:restored.has(id)?null:this.#generation,attachedGeneration:null,attachmentRevision:0,pendingRelease:undefined,
          lease: active && !restored.has(id) ? this.input.client.residency?.retain() : undefined, binding, parent, capture,
          captureOpen:true,active,generation:this.#generation,sequence:-1 };
        this.#children.set(id, child);
        this.#pendingActivity.delete(id);
        if (restored.has(id) && restored.get(id) !== "idle") child.capture.gap("capture_gap");
        if (!active) this.#idle(child);
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
    // Final usage can arrive after an idle/completed notification. Temporarily
    // reopen that source so sealing completion never drops the final counter.
    this.#ensureCapture(id,child);
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
    if (!child.active) this.#idle(child);
  }

  #ensureCapture(id:string,child:Child):void {
    if(child.captureOpen)return;
    child.capture=this.#open(child.binding,id,child.parent);
    child.captureOpen=true;
  }

  #activate(id:string,child:Child):void {
    this.#ensureCapture(id,child);
    child.active=true;
    child.closed=false;
    child.lease ??= this.input.client.residency?.retain();
  }

  #idle(child:Child,closed=false):void {
    child.active=false;
    child.closed ||= closed;
    if(child.captureOpen){child.capture.seal("closed");child.captureOpen=false;}
    this.#release(child);
    if(closed)this.#pruneClosed();
  }

  #pruneClosed():void {
    // Native closed threads are rediscovered by thread/started when resumed.
    // Keep ancestors while any tracked descendant still needs their identity.
    let changed=true;
    while(changed){
      changed=false;
      const parents=new Set([...this.#children.values()].map(child=>child.parent));
      for(const [id,child] of this.#children)if(child.closed && !parents.has(id)){
        this.#children.delete(id);changed=true;
      }
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
    const candidates = [...this.#children.values()].filter(child=>child.active && child.subscribedGeneration!==generation);
    if (!candidates.length) return;
    const loaded = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let inventorySequence: number | undefined;
    for (let page = 0; page < 64; page++) {
      const receipt = await this.input.client.requestWithReceipt(codexRuntimeMethod("thread/loaded/list"), { cursor, limit: 100 }, { timeoutMilliseconds: 10_000 });
      if (!current() || receipt.generation !== generation) return;
      inventorySequence ??= receipt.inboundSequence;
      const result = receipt.result as OfficialCodexClientRequestResult<"thread/loaded/list">;
      for (const id of result.data) loaded.add(id);
      if (loaded.size > MAX_CHILDREN) throw new Error("codex_subagent_inventory_limit");
      cursor = result.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor) || page === 63) throw new Error("codex_subagent_inventory_incomplete");
      cursors.add(cursor);
    }
    for (const child of candidates) {
      const id = child.id;
      if (!current()) return;
      if(!child.active || child.subscribedGeneration===generation)continue;
      if (!loaded.has(id)) {
        // Activity received after inventory started outranks its absence.
        if (child.activitySequence > inventorySequence!) continue;
        // Authoritative absence ends monitoring, without claiming that missing
        // final usage was recovered. The accounting gap remains durable.
        this.#ensureCapture(id,child);child.capture.gap("capture_gap");
        this.#idle(child,true);continue;
      }
      try {
        const receipt = await this.input.client.requestWithReceipt(codexThreadResumeMethod, { threadId: id, excludeTurns: true }, { timeoutMilliseconds: 10_000 });
        if (!current() || receipt.generation !== generation) return;
        if (receipt.result.thread.id !== id) throw new Error("codex_subagent_resume_identity_mismatch");
        child.subscribedGeneration=generation;
        child.attachedGeneration=generation;
        child.attachmentRevision++;
        if(child.activitySequence>receipt.inboundSequence){
          // Newer streamed lifecycle evidence wins over the resumed snapshot.
          // Re-evict after resume since the host clears its eviction flag when
          // it admits that response, potentially after our earlier idle event.
          if(!child.active)this.#idle(child);
          continue;
        }
        if (receipt.result.thread.status.type === "idle") this.#idle(child);
        else if (receipt.result.thread.status.type === "active") {
          const wasIdle=!child.active;
          this.#activate(id,child);
          if(wasIdle && child.sequence<0)child.capture.gap("capture_gap");
        } else {
          this.#ensureCapture(id,child);
          child.capture.gap("capture_gap");
          this.#idle(child);
        }
      } catch (error) {
        if (!current()) return;
        if(child.active){this.#ensureCapture(id,child);child.capture.gap("capture_gap");}
        if(!child.lease)this.#release(child);
        this.#diagnose(error);
      }
    }
  }

  #release(child: Child, detach = true): void {
    const lease = child.lease;
    child.lease = undefined;
    const generation=child.attachedGeneration;
    let detached=Promise.resolve();
    if (detach && generation!==null && generation===this.#generation && this.#ready) {
      const revision=child.attachmentRevision;
      if (child.pendingRelease?.revision!==revision) {
        // Only real host attachments enter this single background lane. It
        // leaves transport capacity available to interactive requests.
        const release=this.#releaseTail.then(async()=>{
          const successor=this.#children.get(child.id);
          if (!this.#ready || generation!==this.#generation || child.active ||
            child.attachedGeneration!==generation || child.attachmentRevision!==revision ||
            (successor && successor!==child)) return;
          child.attachedGeneration=null;
          await this.input.client.persistentSessions?.detachThread(child.id,generation,true);
        }).catch(error=>this.#diagnose(error));
        child.pendingRelease={revision,promise:release};
        this.#releaseTail=release;
        void release.then(()=>{if(child.pendingRelease?.revision===revision)child.pendingRelease=undefined;});
      }
      detached=child.pendingRelease.promise;
    } else if (!detach || generation!==this.#generation || !this.#ready) child.attachedGeneration=null;
    void detached.then(()=>lease?.release()).catch(error=>this.#diagnose(error));
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
