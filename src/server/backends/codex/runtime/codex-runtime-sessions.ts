import { createHash } from "node:crypto";
import {
  defineCodexAppServerMethod, type OfficialCodexClientRequestResult,
  type OfficialCodexServerNotificationParams,
} from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { CodexSharedClientFacade } from "../codex-client-facade.js";
import type { CodexRpcNotification, CodexRpcRequestOptions, CodexRpcRequestReceipt } from "../rpc/codex-rpc-client.js";
import { codexRuntimeMethod } from "./codex-runtime-protocol.js";

type Resume = OfficialCodexClientRequestResult<"thread/resume">;
type Metadata = Omit<Resume, "thread" | "initialTurnsPage" | "turnsBackwardsCursor" | "itemsBackwardsCursor">;
type Session = { generation: number; metadata: Metadata; active: boolean; activeTurnId: string | null; activeGoal: boolean; known: boolean };
const readMethod = defineCodexAppServerMethod({ method: "thread/read", refineParams: value => value, refineResult: value => value });
const turnsMethod = defineCodexAppServerMethod({ method: "thread/turns/list", refineParams: value => value, refineResult: value => value });
const itemsMethod = defineCodexAppServerMethod({ method: "thread/items/list", refineParams: value => value, refineResult: value => value });

/** Retains live session configuration, never a transcript. Reattachment reads
 * provider history and uses the original subscribed session's metadata rather
 * than executing thread/resume with new CLI credentials/settings. */
export class CodexRuntimeSessions {
  readonly #sessions = new Map<string, Session>();
  #inventory: ReadonlyMap<string, { active: boolean; activeGoal: boolean }> = new Map();
  readonly #evicted = new Set<string>();
  #inventoryKnown = false;
  #trackingFailed = false;
  constructor(readonly client: CodexSharedClientFacade) {}

  observeResult(method: string, result: unknown, generation: number): void {
    if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/fork") return;
    const value = result as Resume;
    const { thread, initialTurnsPage: _initial, turnsBackwardsCursor: _turns, itemsBackwardsCursor: _items, ...metadata } = value;
    if (!this.#sessions.has(thread.id) && this.#sessions.size >= 4096) throw new Error("codex_runtime_session_capacity_exceeded");
    this.#evicted.delete(thread.id);
    this.#sessions.set(thread.id, { generation, metadata, active: thread.status.type === "active", activeTurnId: null, activeGoal: false, known: true });
  }
  observeNotification(notification: CodexRpcNotification): void {
    if (notification.kind !== "decoded_notification") {
      this.#inventoryKnown = false;
      for (const session of this.#sessions.values()) session.known = false;
      return;
    }
    const params = notification.params as { threadId?: string };
    if (notification.method === "thread/started") this.#inventoryKnown = false;
    if (!params.threadId) return;
    const inventoried = this.#inventory.get(params.threadId);
    if (inventoried) {
      if (notification.method === "turn/started") inventoried.active = true;
      if (notification.method === "turn/completed") inventoried.active = false;
      if (notification.method === "thread/goal/updated") inventoried.activeGoal = (notification.params as { goal: { status: string } }).goal.status === "active";
      if (notification.method === "thread/goal/cleared") inventoried.activeGoal = false;
      if (notification.method === "thread/status/changed") inventoried.active = (notification.params as OfficialCodexServerNotificationParams<"thread/status/changed">).status.type === "active";
      if (notification.method === "thread/status/changed" && !["idle", "active"].includes((notification.params as OfficialCodexServerNotificationParams<"thread/status/changed">).status.type)) this.#inventoryKnown = false;
    }
    const session = this.#sessions.get(params.threadId);
    if (!session || session.generation !== notification.generation) return;
    switch (notification.method) {
      case "thread/settings/updated": {
        const { threadSettings: settings } = notification.params as OfficialCodexServerNotificationParams<"thread/settings/updated">;
        session.metadata = { ...session.metadata, cwd: settings.cwd, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandboxPolicy, activePermissionProfile: settings.activePermissionProfile, model: settings.model, modelProvider: settings.modelProvider, serviceTier: settings.serviceTier, reasoningEffort: settings.effort, multiAgentMode: settings.multiAgentMode };
        return;
      }
      case "turn/started": session.active = true; session.activeTurnId = (notification.params as { turn: { id: string } }).turn.id; return;
      case "turn/completed": session.active = false; session.activeTurnId = null; return;
      case "thread/goal/updated": session.activeGoal = (notification.params as { goal: { status: string } }).goal.status === "active"; return;
      case "thread/goal/cleared": session.activeGoal = false; return;
      case "thread/status/changed": {
        const value = notification.params as OfficialCodexServerNotificationParams<"thread/status/changed">;
        session.active = value.status.type === "active";
        session.known = true;
        return;
      }
      case "thread/closed":
      case "thread/deleted": this.#sessions.delete(params.threadId); return;
    }
  }

  revision(): string { return createHash("sha256").update(JSON.stringify([this.#inventoryKnown, this.#trackingFailed, [...this.#inventory].sort(), [...this.#sessions.entries()].map(([id, value]) => [id, value.generation, value.known, value.active, value.activeTurnId, value.activeGoal]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))] )).digest("hex"); }
  evict(threadId: string, generation: number): void {
    const session = this.#sessions.get(threadId);
    if (session?.generation === generation) this.#evicted.add(threadId);
  }
  canIdle(): boolean {
    return !this.#trackingFailed && [...this.#sessions].every(([id, session]) =>
      this.#evicted.has(id) && session.known && !session.active && !session.activeGoal);
  }
  invalidate(): void { this.#evicted.clear(); this.#sessions.clear(); this.#trackingFailed = false; this.#inventoryKnown = false; this.#inventory = new Map(); }
  markUnknown(): void { this.#trackingFailed = true; }
  activity(): "active" | "idle" | "unknown" {
    if (this.#trackingFailed || !this.#inventoryKnown) return "unknown";
    if ([...this.#sessions.values()].some(session => !session.known)) return "unknown";
    return [...this.#sessions.values(), ...this.#inventory.values()].some(session => session.active || session.activeGoal) ? "active" : "idle";
  }

  /** Owned-server Stop only: interrupt exact observed turns, never discover or
   * replay work during shutdown. EOF/process cleanup follows regardless. */
  async interruptKnownActiveTurns(): Promise<void> {
    const lifecycle = this.client.lifecycleSnapshot();
    if (lifecycle.state !== "ready" || this.#trackingFailed) return;
    const turns = [...this.#sessions].flatMap(([threadId, session]) => session.generation === lifecycle.generation && session.known && session.active && session.activeTurnId !== null
      ? [{ threadId, session, turnId: session.activeTurnId }] : []);
    if (turns.length === 0) return;
    const controller = new AbortController();
    const deadline = Date.now() + 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          for (const { threadId, session, turnId } of turns) {
            const current = this.client.lifecycleSnapshot();
            if (controller.signal.aborted || current.state !== "ready" || current.generation !== lifecycle.generation) return;
            if (!session.known || !session.active || session.activeTurnId !== turnId || this.#sessions.get(threadId) !== session) continue;
            try {
              await this.client.requestWithReceipt(codexRuntimeMethod("turn/interrupt"), { threadId, turnId },
                { timeoutMilliseconds: Math.max(1, deadline - Date.now()), signal: controller.signal });
            } catch { /* Continue only while the common shutdown budget remains. */ }
          }
        })(),
        new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 1_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  hasCurrent(threadId: string): boolean {
    return this.#sessions.get(threadId)?.generation === this.client.lifecycleSnapshot().generation;
  }

  async reattach(threadId: string, options: CodexRpcRequestOptions): Promise<CodexRpcRequestReceipt<Resume> | undefined> {
    const deadline = Date.now() + options.timeoutMilliseconds;
    const boundedOptions = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("codex_runtime_session_snapshot_timeout");
      return { ...options, timeoutMilliseconds: remaining };
    };
    for (let attempt = 0; ; attempt++) {
      try { return await this.#reattach(threadId, boundedOptions); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "codex_runtime_session_snapshot_changed" || attempt >= 2) throw error;
      }
    }
  }

  async #reattach(threadId: string, options: () => CodexRpcRequestOptions): Promise<CodexRpcRequestReceipt<Resume> | undefined> {
    const session = this.#sessions.get(threadId);
    if (!session || session.generation !== this.client.lifecycleSnapshot().generation) return undefined;
    this.#evicted.delete(threadId);
    const metadata = await this.client.requestWithReceipt(readMethod, { threadId, includeTurns: false }, options());
    this.#assertCurrent(session, metadata.generation);
    if (metadata.result.thread.id !== threadId) throw new Error("codex_runtime_session_identity_mismatch");
    let result: Resume;
    if (metadata.result.thread.historyMode === "paginated") {
      const turns = await this.client.requestWithReceipt(turnsMethod, { threadId, limit: 10, sortDirection: "desc", itemsView: "notLoaded" }, options());
      this.#assertCurrent(session, turns.generation);
      const items = await this.client.requestWithReceipt(itemsMethod, { threadId, limit: 1, sortDirection: "desc" }, options());
      this.#assertCurrent(session, items.generation);
      // The snapshot spans several reads. Keep the earliest notification fence
      // so completion/settings events between those reads are replayed. The
      // final metadata read only detects a changed history/status boundary.
      const final = await this.client.requestWithReceipt(readMethod, { threadId, includeTurns: false }, options());
      this.#assertCurrent(session, final.generation);
      if (final.result.thread.id !== threadId) throw new Error("codex_runtime_session_identity_mismatch");
      if (final.result.thread.historyMode !== metadata.result.thread.historyMode ||
        final.result.thread.status.type !== metadata.result.thread.status.type) {
        throw new Error("codex_runtime_session_snapshot_changed");
      }
      result = { ...session.metadata, thread: metadata.result.thread, initialTurnsPage: turns.result, turnsBackwardsCursor: turns.result.backwardsCursor, itemsBackwardsCursor: items.result.backwardsCursor };
      codexRuntimeMethod("thread/resume").decodeResult(result);
      return { ...metadata, result };
    }
    const history = await this.client.requestWithReceipt(readMethod, { threadId, includeTurns: true }, options());
    this.#assertCurrent(session, history.generation);
    if (history.result.thread.id !== threadId) throw new Error("codex_runtime_session_identity_mismatch");
    result = { ...session.metadata, thread: history.result.thread, initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    codexRuntimeMethod("thread/resume").decodeResult(result);
    return { ...history, result };
  }

  /** Registry calls under its admission fence before allowing idle upgrades. */
  async refreshActivity(): Promise<void> {
    this.#inventoryKnown = false;
    const generation = this.client.lifecycleSnapshot().generation;
    const deadline = Date.now() + 10_000;
    const options = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("codex_runtime_inventory_timeout");
      return { timeoutMilliseconds: remaining };
    };
    const list = async () => {
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 64; page++) {
        const receipt = await this.client.requestWithReceipt(codexRuntimeMethod("thread/loaded/list"), { cursor, limit: 100 }, options());
        this.#assertCurrent({ generation }, receipt.generation);
        const value = receipt.result as OfficialCodexClientRequestResult<"thread/loaded/list">;
        for (const id of value.data) {
          if (!id || ids.has(id) || ids.size >= 4096) throw new Error("codex_runtime_inventory_incomplete");
          ids.add(id);
        }
        if (value.nextCursor === null) return ids;
        if (cursors.has(value.nextCursor)) throw new Error("codex_runtime_inventory_incomplete");
        cursors.add(value.nextCursor);
        cursor = value.nextCursor;
      }
      throw new Error("codex_runtime_inventory_incomplete");
    };
    const ids = await list();
    const inventory = new Map<string, { active: boolean; activeGoal: boolean }>();
    for (const threadId of ids) {
      const receipt = await this.client.requestWithReceipt(readMethod, { threadId, includeTurns: false }, options());
      this.#assertCurrent({ generation }, receipt.generation);
      if (receipt.result.thread.id !== threadId) throw new Error("codex_runtime_inventory_identity_mismatch");
      if (receipt.result.thread.status.type !== "idle" && receipt.result.thread.status.type !== "active") throw new Error("codex_runtime_inventory_thread_unavailable");
      const goal = await this.client.requestWithReceipt(codexRuntimeMethod("thread/goal/get"), { threadId }, options());
      this.#assertCurrent({ generation }, goal.generation);
      const nativeGoal = (goal.result as OfficialCodexClientRequestResult<"thread/goal/get">).goal;
      if (nativeGoal && nativeGoal.threadId !== threadId) throw new Error("codex_runtime_inventory_identity_mismatch");
      inventory.set(threadId, {
        active: receipt.result.thread.status.type === "active",
        activeGoal: nativeGoal?.status === "active",
      });
    }
    // External clients can change the loaded set during inspection. Refuse an
    // incomplete snapshot instead of treating omitted sessions as idle.
    const finalIds = await list();
    if (finalIds.size !== ids.size || [...finalIds].some(id => !ids.has(id))) throw new Error("codex_runtime_inventory_changed");
    for (const [threadId, session] of this.#sessions) {
      const current = inventory.get(threadId);
      if (current) Object.assign(session, current, { known: true });
      else this.#sessions.delete(threadId);
    }
    this.#inventory = inventory;
    this.#inventoryKnown = true;
  }
  #assertCurrent(session: Pick<Session, "generation">, generation: number): void {
    if (generation !== session.generation || this.client.lifecycleSnapshot().generation !== generation || this.client.lifecycleSnapshot().state !== "ready") throw new Error("codex_runtime_session_generation_changed");
  }
}
