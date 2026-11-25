import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { backendConversationEventSchema, backendConversationSnapshotSchema, type BackendConversationEvent, type BackendConversationSnapshot,
  type DriverInteraction, type SequencedBackendEvent } from "../../../shared/protocol/backend.js";
import { boundDisplayText, boundText } from "../../conversations/payload-policy.js";
import { BackendError, type AttachConversationInput, type BackendEventListener, type ConversationHandle,
  type EstablishProjectionInput, type HistoryPageInput, type InteractionResponseInput, type InterruptConversationInput,
  type LocateTurnInput, type RegisteredBackendActionInput, type SubmitTurnInput, type SteerTurnInput, type SteerTurnResult } from "../contracts.js";
import type { AntigravityBinding } from "./binding.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import { hasOutstandingBackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { antigravityCapabilities, antigravityConfigOption, antigravityConfigValue, antigravitySelectOptions } from "./catalog.js";
import { unavailable, unsupported, type AntigravityDriver } from "./driver.js";
import { antigravityHistoryPage, antigravityWindowSnapshot, locateAntigravityTurn, projectAntigravityHistory, type AntigravityProjection } from "./history.js";
import { type AntigravityAttachment, type AntigravityCommand, type AntigravityEvent,
  type AntigravityHistory, type AntigravityOutcome, type AntigravitySetup } from "./port.js";
import { buildAntigravityPrompt, inspectAntigravityInput } from "./submission.js";
import { AntigravityUsage } from "./usage.js";
import { antigravityFailureError, antigravityReadError, antigravityTransportError } from "./errors.js";

export class AntigravityHandle implements ConversationHandle {
  readonly automaticEviction = "client_detach" as const;
  readonly binding;
  readonly #lifetime = new AbortController();
  readonly #control = new AbortController();
  readonly #rawListeners = new Set<(event: BackendConversationEvent) => void>();
  readonly #listeners = new Set<BackendEventListener>();
  readonly #journal: SequencedBackendEvent[] = [];
  readonly #permissions = new Map<string, AntigravityAttachment["pendingPermissions"][number]>();
  readonly #resolvedPermissions = new Set<string>();
  #permissionReadChanges?: Set<string>;
  #permissionSequence: number;
  readonly #receipts = new Map<string, AntigravityOutcome>();
  readonly #acknowledgedOperations = new Set<string>();
  readonly #receiptWaiters = new Set<() => void>();
  readonly #receiptPolledAt = new Map<string, number>();
  readonly #controlOperations = new Map<string, AntigravityCommand["type"]>();
  readonly #ackReady = new Set<string>();
  readonly #ackAttemptedAt = new Map<string, number>();
  readonly #inFlightRequests = new Set<string>();
  readonly #waitingOperations = new Set<string>();
  readonly #requestedSetters = new Set<string>();
  readonly #appliedSetters = new Set<string>();
  readonly #configurationApplications = new Map<string, Promise<void>>();
  readonly #accounting;
  #native!: AntigravityHistory;
  #nativeProjection!: AntigravityProjection;
  #projection!: AntigravityProjection;
  #lastHistoryReadAt = -Infinity;
  #accountedRevision?: string;
  #lastAccountingAttemptAt = -Infinity;
  #deferredHistoryRefresh?: ReturnType<typeof setTimeout>;
  #setup: AntigravitySetup;
  #sequence = 0;
  #journalBytes = 0;
  #after: number;
  #closed = false;
  #closeComplete = false;
  #loop?: Promise<void>;
  #queue: Promise<unknown> = Promise.resolve();
  #pendingSubmit?: string;
  #streaming = false;
  #disconnected = false;
  #recovering = false;
  // Background work confirmed before the first disconnect; unknown afterwards.
  #backgroundBeforeDisconnect?: BackendConversationSnapshot["backgroundActivity"];
  #serviceRetired = false;
  #contextUsage?: UsageSnapshot["context"];
  #configurationSequence: number;
  constructor(readonly driver: AntigravityDriver, readonly attached: AttachConversationInput,
    readonly detail: AntigravityBinding, readonly attachment: AntigravityAttachment) {
    this.binding = attached.binding; this.#setup = attachment.setup; this.#after = attachment.retainedAfterSequence;
    this.#permissionSequence = attachment.throughSequence;
    this.#configurationSequence = attachment.throughSequence;
    this.#accounting = new AntigravityUsage(driver.input.usage, this.binding, detail.nativeNamespaceKey);
    this.#control.signal.addEventListener("abort", () => this.#cancelDeferredHistoryRefresh(), { once: true });
  }
  get retirementBlocked(): boolean { return !!this.#pendingSubmit || this.#ackReady.size > 0 || [...this.#controlOperations].some(([id, kind]) =>
    (kind === "set_config" || kind === "set_mode") && this.#requestedSetters.has(id) && !this.#appliedSetters.has(id)) || [...this.#receipts.values()].some(value =>
    value.status === "pending" || value.status === "failed" && value.failure.delivery === "sent_outcome_unknown"); }
  /**
   * A replaced execution-host service retired this runtime and every process
   * it launched. Vouch only when no receipt, permission, setter or request is
   * outstanding and no background work was running before the disconnect.
   */
  get providerServiceReplacementSafe(): boolean | undefined {
    if (this.#closed || this.retirementBlocked || this.#streaming || this.#permissions.size > 0 || this.#inFlightRequests.size > 0 ||
      this.#waitingOperations.size > 0 || this.#controlOperations.size > 0 || this.#configurationApplications.size > 0) return false;
    if (!this.#serviceRetired) return undefined;
    return !hasOutstandingBackgroundActivity(this.#backgroundBeforeDisconnect);
  }
  get scope() { return { binding: this.detail, key: this.driver.input.correlationKey }; }
  get identity() { return { sessionId: this.detail.sessionId, cwd: this.detail.canonicalWorkspacePath }; }
  async initialize(): Promise<void> {
    this.driver.input.modeCatalog?.observe(this.#setup);
    // Control is independent of transcript acquisition and revoked on owner loss.
    this.attached.onControlReady?.({ generation: this.attachment.generation, lifetime: this.#control.signal,
      interrupt: input => this.interrupt(input), reconcileInterrupt: input => this.reconcileInterrupt(input) });
    for (const pending of this.attachment.pendingPermissions) this.#permissions.set(pending.requestId, pending);
    await this.#refresh(false);
    for (const operationId of this.attachment.retainedOperationIds) this.#receipts.set(operationId,
      await this.driver.input.port.outcome({ handleId: this.attachment.handleId, operationId }, this.#lifetime.signal)
        .catch(error => { throw antigravityReadError(error, this.#lifetime.signal); }));
    this.#loop = this.#observe();
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#queue.then(operation); this.#queue = work.catch(() => undefined); return work;
  }
  #assert(): void { if (this.#closed || this.#control.signal.aborted) throw unavailable("The Antigravity session is disconnected."); }
  #emit(event: BackendConversationEvent): void {
    if (this.#closed) return;
    const validated = backendConversationEventSchema.parse(event);
    const sequenced = { handleSequence: ++this.#sequence, event: validated };
    this.#journal.push(sequenced); this.#journalBytes += Buffer.byteLength(JSON.stringify(sequenced));
    while (this.#journal.length > 1024 || this.#journalBytes > 16 * 1024 * 1024) {
      const removed = this.#journal.shift(); if (!removed) break;
      this.#journalBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    for (const listener of this.#rawListeners) { try { listener(validated); } catch { /* Observers cannot change provider authority. */ } }
    for (const listener of this.#listeners) { try { listener(sequenced); } catch { /* Independent observer boundary. */ } }
    if (event.type === "interaction_opened") for (const wake of this.#receiptWaiters) wake();
  }
  async #refresh(emit: boolean, force = false): Promise<void> {
    const previousUsage = this.#projection?.usage;
    await this.#acknowledgeAbandoned(this.#lifetime.signal, force)
      .catch(error => { throw antigravityReadError(error, this.#lifetime.signal); });
    // Operation outcomes have independent retention. A dropped event page must
    // not leave a completed request permanently pending in this handle.
    for (const [operationId, outcome] of this.#receipts) if (!this.#inFlightRequests.has(operationId) && (outcome.status === "pending" ||
      outcome.status === "failed" && outcome.failure.delivery === "sent_outcome_unknown")) await this.#pollReceipt(operationId);
    await this.#settleControls();
    for (const operationId of this.#ackReady) await this.#ackReceipt(operationId, true, true);
    // Notifications and receipt waits share one bounded history cadence. They
    // still process control events immediately; native history also polls when
    // no ACP events arrive, because children and continuations can write it.
    let changed = false, checkedHistory = false;
    if (force || !this.#native || performance.now() - this.#lastHistoryReadAt >= 250) {
      this.#cancelDeferredHistoryRefresh();
      const history = await this.driver.input.port.readHistory({ ...this.identity,
        ...(this.#native ? { knownRevision: this.#native.native.revision } : {}) }, this.#lifetime.signal)
        .catch(error => { throw antigravityReadError(error, this.#lifetime.signal); });
      this.#lastHistoryReadAt = performance.now();
      checkedHistory = true;
      if (history && history.native.revision !== this.#native?.native.revision) {
        const projected = projectAntigravityHistory(history.native, this.scope);
        this.#native = history; this.#nativeProjection = projected; changed = true;
      }
      if (!this.#nativeProjection) throw unavailable("Antigravity did not supply an initial history snapshot.");
    } else this.#deferHistoryRefresh();
    // Keep native evidence separate from transient transport, permission and
    // usage state so unchanged history can still publish those transitions.
    const projection = { ...this.#nativeProjection, snapshot: { ...this.#nativeProjection.snapshot },
      usage: { ...this.#nativeProjection.usage } };
    if (this.#contextUsage) projection.usage.context = this.#contextUsage;
    if (projection.snapshot.runState === "reconciling" && this.#streaming) projection.snapshot.runState = "running";
    if (this.#permissions.size && (projection.snapshot.runState === "running" || projection.snapshot.runState === "reconciling"))
      projection.snapshot.runState = "running";
    if (this.#disconnected) projection.snapshot.runState = "disconnected";
    if (this.#pendingSubmit && projection.snapshot.runState === "idle" && !Object.values(projection.snapshot.turnsById).some(
      turn => turn.completionCorrelations?.includes(this.#pendingSubmit!))) projection.snapshot.runState = "starting";
    if (this.#disconnected && projection.snapshot.backgroundActivity) {
      // Newer native evidence of background work invalidates the idle proof
      // taken before the disconnect; it never restores one.
      if (hasOutstandingBackgroundActivity(projection.snapshot.backgroundActivity)) this.#backgroundBeforeDisconnect = projection.snapshot.backgroundActivity;
      projection.snapshot.backgroundActivity = this.#disconnectedBackground(projection.snapshot.backgroundActivity);
    }
    if (emit && this.#projection) this.#diff(this.#projection.snapshot, projection.snapshot);
    this.#projection = projection;
    if (projection.snapshot.runState === "idle") this.#streaming = false;
    if (emit && JSON.stringify(previousUsage) !== JSON.stringify(projection.usage)) this.#emit({ type: "usage_changed", usage: projection.usage });
    if (this.#accountedRevision !== this.#native.native.revision && (changed || performance.now() - this.#lastAccountingAttemptAt >= 250)) {
      this.#lastAccountingAttemptAt = performance.now();
      if (this.#accounting.update(this.#native.native, projection, emit ? "live" : "history")) this.#accountedRevision = this.#native.native.revision;
    }
    for (const turn of Object.values(projection.snapshot.turnsById)) for (const correlation of turn.completionCorrelations ?? []) {
      if (this.#pendingSubmit === correlation) this.#pendingSubmit = undefined;
      // Publication is asynchronous and may need retry even after the provider
      // outcome was acknowledged; native equality is not application receipt
      // acknowledgement. Retry at the bounded history-check cadence.
      if (checkedHistory || this.#receipts.has(correlation)) this.attached.onSubmissionObserved?.({ backendCorrelation: correlation });
      if (turn.status !== "in_progress" && this.#receipts.get(correlation)?.status !== "pending") await this.#ackReceipt(correlation, true);
    }
  }
  #cancelDeferredHistoryRefresh(): void {
    if (this.#deferredHistoryRefresh !== undefined) clearTimeout(this.#deferredHistoryRefresh);
    this.#deferredHistoryRefresh = undefined;
  }
  #deferHistoryRefresh(): void {
    if (this.#deferredHistoryRefresh !== undefined || this.#closed || this.#control.signal.aborted) return;
    // Flush the trailing event even if the provider goes quiet and observe()
    // enters its one-second long poll. Repeated chunks never postpone the flush.
    const timer = setTimeout(() => {
      void this.#serialize(async () => {
        if (this.#deferredHistoryRefresh !== timer || this.#closed || this.#control.signal.aborted) return;
        this.#deferredHistoryRefresh = undefined;
        try { await this.#refresh(true); }
        catch { this.#markDisconnected(); }
      }).catch(() => undefined);
    }, Math.max(1, Math.ceil(250 - (performance.now() - this.#lastHistoryReadAt))));
    this.#deferredHistoryRefresh = timer; timer.unref();
  }
  #markDisconnected(): void {
    if (this.#closed || this.#control.signal.aborted) return;
    this.#cancelDeferredHistoryRefresh();
    const before = this.#projection.snapshot;
    if (!this.#disconnected) this.#backgroundBeforeDisconnect = before.backgroundActivity;
    this.#disconnected = true; this.#recovering = true; this.#streaming = false;
    const snapshot: BackendConversationSnapshot = { ...before, runState: "disconnected",
      ...(before.backgroundActivity ? { backgroundActivity: this.#disconnectedBackground(before.backgroundActivity) } : {}) };
    this.#projection = { ...this.#projection, snapshot };
    this.#diff(before, snapshot);
  }
  /** Retirement of the whole service settles background work confirmed idle before the disconnect. */
  #disconnectedBackground(activity: NonNullable<BackendConversationSnapshot["backgroundActivity"]>) {
    return this.#serviceRetired && this.#backgroundBeforeDisconnect && !hasOutstandingBackgroundActivity(this.#backgroundBeforeDisconnect)
      ? this.#backgroundBeforeDisconnect : { ...activity, state: "unknown" as const };
  }
  #observeServiceRetired(): void {
    if (this.#serviceRetired || this.#closed) return;
    this.#serviceRetired = true;
    const before = this.#projection.snapshot;
    if (!before.backgroundActivity) return;
    const snapshot: BackendConversationSnapshot = { ...before, backgroundActivity: this.#disconnectedBackground(before.backgroundActivity) };
    this.#projection = { ...this.#projection, snapshot };
    this.#diff(before, snapshot);
  }
  #diff(before: BackendConversationSnapshot, after: BackendConversationSnapshot): void {
    if (before.turnsById !== after.turnsById || before.itemsById !== after.itemsById) for (const id of after.orderedBackendTurnIds) {
      const turn = after.turnsById[id]!; const previous = before.turnsById[id];
      if (!previous) this.#emit({ type: "turn_started", turn: { ...turn, status: "in_progress", endedBy: undefined, completedAt: undefined, failure: undefined } });
      for (const itemId of turn.orderedBackendItemIds) {
        const item = after.itemsById[itemId]!;
        if (JSON.stringify(item) === JSON.stringify(before.itemsById[itemId])) continue;
        this.#emit({ type: item.status === "streaming" ? before.itemsById[itemId] ? "item_updated" : "item_started" : "item_completed", item });
      }
      if (JSON.stringify(turn) !== JSON.stringify(previous)) this.#emit({ type: turn.status === "in_progress" ? "turn_updated" : "turn_completed", turn,
        ...(!this.#streaming && turn.status !== "in_progress" ? { completionProvenance: "recovered" as const } : {}) });
    }
    if (before.runState !== after.runState || before.activeBackendTurnId !== after.activeBackendTurnId)
      this.#emit({ type: "run_state_changed", state: after.runState, ...(after.activeBackendTurnId ? { activeBackendTurnId: after.activeBackendTurnId } : {}) });
    if (JSON.stringify(before.backgroundActivity) !== JSON.stringify(after.backgroundActivity) && after.backgroundActivity)
      this.#emit({ type: "background_activity_changed", activity: after.backgroundActivity });
  }
  async #observe(): Promise<void> {
    while (!this.#closed) {
      try {
        const observed = await this.driver.input.port.observe({ handleId: this.attachment.handleId, afterSequence: this.#after }, this.#lifetime.signal);
        await this.#serialize(async () => {
          if (this.#closed) return;
          if (observed.retainedAfterSequence > this.#after) {
            this.#recovering = true; this.#streaming = false;
            this.#emit({ type: "resnapshot_required", reason: "sequence_gap" });
          }
          for (const event of observed.events) if (event.sequence > this.#after) this.#accept(event);
          // ACP events have already entered the retained handle journal. Their
          // acknowledgement is independent of passive SQLite acquisition.
          this.#after = observed.throughSequence;
          await this.driver.input.port.acknowledge({ handleId: this.attachment.handleId, throughSequence: this.#after }, this.#lifetime.signal);
          this.#disconnected = observed.closed;
          await this.#refresh(true, this.#recovering || observed.closed);
          this.#recovering = false;
        });
        if (observed.closed) { this.#control.abort(); this.#emit({ type: "resnapshot_required", reason: "provider_handle_closed" }); return; }
      } catch {
        if (this.#closed) return;
        // Store the emitted state as well: an unchanged native revision on
        // reconnect must still produce the restoring state transition.
        await this.#serialize(async () => this.#markDisconnected());
        // Reconnect only to retained authority; a missing owner cannot authorize
        // launching/replaying a prompt from this handle.
        const changed = new Set<string>();
        this.#permissionReadChanges = changed;
        try {
          const retained = await this.driver.input.port.attachExisting(this.identity, this.#lifetime.signal);
          await this.#serialize(async () => {
            if (this.#closed || this.#control.signal.aborted) return;
            if (!retained || retained.handleId !== this.attachment.handleId || retained.generation !== this.attachment.generation) {
              this.#control.abort(); this.#emit({ type: "resnapshot_required", reason: "provider_handle_closed" }); return;
            }
            this.#applyRetainedSetup(retained);
            if (retained.throughSequence >= this.#permissionSequence) {
              const pendingIds = new Set(retained.pendingPermissions.map(pending => pending.requestId));
              for (const id of this.#permissions.keys()) if (!changed.has(id) && !pendingIds.has(id)) this.#resolvePermission(id);
              for (const pending of retained.pendingPermissions) if (!changed.has(pending.requestId)) this.#openPermission(pending);
              // Inventory supersedes older permission events still awaiting
              // delivery. A local response completed during this read wins.
              this.#permissionSequence = retained.throughSequence;
              for (const id of this.#resolvedPermissions) if (!pendingIds.has(id)) this.#resolvedPermissions.delete(id);
            }
            this.#disconnected = false;
          });
          if (this.#control.signal.aborted) return;
        } catch { /* Keep ownership unknown until exact retained lookup succeeds. */ }
        finally { if (this.#permissionReadChanges === changed) this.#permissionReadChanges = undefined; }
        if (this.driver.input.port.serviceReplaced) {
          // The retained owner retired with its service and can never return.
          // Stay disconnected until the backend is rebuilt; do not keep polling.
          await this.#serialize(async () => this.#observeServiceRetired());
          return;
        }
        await delay(500, undefined, { signal: this.#lifetime.signal }).catch(() => undefined);
      }
    }
  }
  #openPermission(pending: AntigravityAttachment["pendingPermissions"][number]): void {
    if (this.#resolvedPermissions.has(pending.requestId)) return;
    const current = this.#permissions.get(pending.requestId);
    if (current && isDeepStrictEqual(permissionInteraction(current), permissionInteraction(pending))) return;
    this.#permissionReadChanges?.add(pending.requestId);
    this.#permissions.set(pending.requestId, pending);
    this.#emit({ type: "interaction_opened", interaction: permissionInteraction(pending) });
  }
  #resolvePermission(id: string): void {
    this.#permissionReadChanges?.add(id);
    if (this.#permissions.delete(id)) this.#emit({ type: "interaction_resolved", backendInteractionId: id });
  }
  #accept(event: AntigravityEvent): void {
    if (event.kind === "permission") {
      if (event.sequence <= this.#permissionSequence) return;
      this.#permissionSequence = event.sequence;
      this.#openPermission(event);
    } else if (event.kind === "permission_resolved") {
      if (event.sequence <= this.#permissionSequence) return;
      this.#permissionSequence = event.sequence;
      this.#resolvePermission(event.requestId); this.#resolvedPermissions.delete(event.requestId);
    } else if (event.kind === "operation") {
      if (!this.#acknowledgedOperations.has(event.operationId)) this.#receipts.set(event.operationId, event.outcome);
      for (const wake of this.#receiptWaiters) wake();
      if (event.operationId === this.#pendingSubmit && event.outcome.status !== "pending") this.#pendingSubmit = undefined;
    } else if (event.kind === "update") {
      const update = event.notification.update;
      if (update.sessionUpdate === "config_option_update" && event.sequence > this.#configurationSequence) {
        this.#configurationSequence = event.sequence;
        this.#applyConfigOptions(update.configOptions);
      }
      if (update.sessionUpdate === "usage_update" && Number.isSafeInteger(update.used) && update.used >= 0 &&
        Number.isSafeInteger(update.size) && update.size > 0) {
        this.#contextUsage = { usedTokens: update.used, windowTokens: update.size, percent: update.used * 100 / update.size };
      }
      if (!this.#recovering && event.sequence > this.attachment.throughSequence &&
        (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")) this.#streaming = true;
    } else { this.#disconnected = true; }
  }
  async establishProjection(input: EstablishProjectionInput) {
    return this.#serialize(async () => {
      input.signal.throwIfAborted(); await this.#refresh(true, true); input.signal.throwIfAborted();
      const sequence = this.#sequence;
      const page = antigravityHistoryPage(this.#projection.snapshot, { limit: 50, signal: input.signal });
      const { previousCursor } = page;
      const snapshot = backendConversationSnapshotSchema.parse(antigravityWindowSnapshot(this.#projection.snapshot, page));
      return { handleSequence: sequence, snapshot, history: { operational: true, ...(previousCursor ? { previousCursor } : {}) },
        subscribeFromNext: (listener: BackendEventListener) => {
          if ((this.#journal[0]?.handleSequence ?? sequence + 1) > sequence + 1) listener({ handleSequence: this.#sequence,
            event: { type: "resnapshot_required", reason: "buffer_overflow" } });
          else for (const event of this.#journal) if (event.handleSequence > sequence) listener(event);
          this.#listeners.add(listener);
          for (const pending of this.#permissions.values()) this.#emit({ type: "interaction_opened", interaction: permissionInteraction(pending) });
          return () => { this.#listeners.delete(listener); };
        } };
    });
  }
  async history(input: HistoryPageInput) { this.#assert(); return antigravityHistoryPage(this.#projection.snapshot, input); }
  async locateTurn(input: LocateTurnInput) { this.#assert(); return locateAntigravityTurn(this.#projection.snapshot, input); }
  async backendCapabilities() { this.#assert(); return antigravityCapabilities(this.#setup, this.driver.connection.id); }
  async usage() { this.#assert(); return this.#projection.usage; }
  isNativeRecoveryTurn(backendTurnId: string): boolean { return backendTurnId.startsWith("continuation:"); }
  async captureSubmissionRetryAnchor(): Promise<string> {
    this.#assert(); await this.#serialize(() => this.#refresh(true, true));
    if (this.#projection.snapshot.runState !== "idle" || this.#pendingSubmit) throw unsupported("Wait for the current Antigravity turn to settle.");
    return this.#native.native.revision;
  }
  async #request(operationId: string, command: AntigravityCommand): Promise<AntigravityOutcome> {
    this.#assert();
    const newSetter = (command.type === "set_config" || command.type === "set_mode") && !this.#requestedSetters.has(operationId);
    if (newSetter) this.#requestedSetters.add(operationId);
    if (command.type !== "prompt" && command.type !== "steer") this.#controlOperations.set(operationId, command.type);
    this.#receipts.set(operationId, { status: "pending" });
    this.#inFlightRequests.add(operationId);
    try {
      const outcome = await this.driver.input.port.request({ handleId: this.attachment.handleId, operationId, command }, this.#lifetime.signal);
      const observed = this.#receipts.get(operationId);
      const retained = observed && observed.status !== "pending" && outcome.status !== "completed" ? observed : outcome;
      this.#receipts.set(operationId, retained); return retained;
    } catch (error) {
      const mapped = antigravityTransportError(error);
      if (mapped instanceof BackendError && !mapped.crossedSubmissionBoundary) {
        if (newSetter) this.#requestedSetters.delete(operationId);
        this.#receipts.delete(operationId); this.#controlOperations.delete(operationId); throw mapped;
      }
      this.#receipts.set(operationId, { status: "failed", failure: { code: "antigravity_delivery_unknown", delivery: "sent_outcome_unknown" } });
      throw mapped instanceof BackendError ? mapped : unknown();
    } finally { this.#inFlightRequests.delete(operationId); }
  }
  async #wait(operationId: string, deadline = Date.now() + 30_000): Promise<AntigravityOutcome> {
    this.#waitingOperations.add(operationId);
    try {
      while (Date.now() < deadline) {
        try { this.#assert(); } catch { throw unknown(); }
        const cached = this.#receipts.get(operationId);
        let outcome: AntigravityOutcome;
        try { outcome = cached && cached.status !== "pending" ? cached : await this.#pollReceipt(operationId); }
        catch { throw unknown(); }
        if (outcome.status === "failed") { await this.#ackReceipt(operationId); throw outcomeError(outcome); }
        if (outcome.status === "completed") return outcome;
        await this.#waitForReceipt(Math.min(1000, deadline - Date.now())).catch(() => { throw unknown(); });
      }
      throw unknown();
    } finally { this.#waitingOperations.delete(operationId); }
  }
  async #pollReceipt(operationId: string, force = false): Promise<AntigravityOutcome> {
    const cached = this.#receipts.get(operationId);
    if (!force && cached && Date.now() - (this.#receiptPolledAt.get(operationId) ?? 0) < 1000) return cached;
    this.#receiptPolledAt.set(operationId, Date.now());
    const outcome = await this.driver.input.port.outcome({ handleId: this.attachment.handleId, operationId }, this.#lifetime.signal)
      .catch(error => { throw antigravityReadError(error, this.#lifetime.signal); });
    this.#receipts.set(operationId, outcome); return outcome;
  }
  #waitForReceipt(milliseconds: number): Promise<void> {
    this.#lifetime.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.#receiptWaiters.delete(finish); this.#lifetime.signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => { finish(); reject(this.#lifetime.signal.reason); };
      const timer = setTimeout(finish, Math.max(0, milliseconds));
      this.#receiptWaiters.add(finish); this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    });
  }
  async #ackReceipt(operationId: string, consumedTerminal = false, retry = false): Promise<void> {
    const outcome = this.#receipts.get(operationId);
    if (!outcome || outcome.status === "pending") return;
    if (outcome.status === "failed" && outcome.failure.delivery === "sent_outcome_unknown" && !consumedTerminal) return;
    this.#ackReady.add(operationId);
    if (retry && Date.now() - (this.#ackAttemptedAt.get(operationId) ?? 0) < 1000) return;
    this.#ackAttemptedAt.set(operationId, Date.now());
    try { await this.driver.input.port.acknowledgeOperation({ handleId: this.attachment.handleId, operationId }, this.#lifetime.signal); }
    catch { return; }
    this.#acknowledgedOperations.add(operationId);
    this.#receipts.delete(operationId);
    this.#receiptPolledAt.delete(operationId);
    this.#ackReady.delete(operationId); this.#controlOperations.delete(operationId);
    this.#ackAttemptedAt.delete(operationId);
  }
  async #settleControls(): Promise<void> {
    for (const [operationId, kind] of this.#controlOperations) {
      if (this.#inFlightRequests.has(operationId) || this.#waitingOperations.has(operationId)) continue;
      const outcome = this.#receipts.get(operationId);
      if (outcome?.status === "completed" && (kind === "set_config" || kind === "set_mode")) {
        try { await this.#applyConfigResult(operationId, outcome); }
        catch { continue; } // Retain accepted control proof until its current configuration can be read.
      }
      if (outcome && outcome.status !== "pending") await this.#ackReceipt(operationId, false, true);
    }
  }
  async #afterSubmissionDispatch<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      // An exact native rejection remains definitive. Every other failure after
      // dispatch leaves delivery uncertain, including a read classified as
      // safely retryable when used before any submission.
      if (error instanceof BackendError && error.category === "rejected" && !error.crossedSubmissionBoundary) throw error;
      throw unknown();
    }
  }
  async #configure(): Promise<void> {
    for (const [id, kind] of this.#controlOperations) if (kind === "set_config" || kind === "set_mode") {
      const value = this.#receipts.get(id);
      if (value?.status === "pending" || value?.status === "failed" && value.failure.delivery === "sent_outcome_unknown")
        await this.#pollReceipt(id).catch(() => { throw unavailable("Antigravity could not confirm the requested settings. The prompt was not sent."); });
    }
    await this.#settleControls();
    if ([...this.#controlOperations].some(([id, kind]) => (kind === "set_config" || kind === "set_mode") &&
      (this.#receipts.get(id)?.status === "pending" || this.#receipts.get(id)?.status === "failed" ||
        this.#requestedSetters.has(id) && !this.#appliedSetters.has(id))))
      throw unavailable("Antigravity could not confirm the requested settings. The prompt was not sent.");
    const settings = this.driver.input.settings.get(this.attached.scope, this.binding.applicationThreadId);
    this.#assertSelection(settings.modelId ?? antigravityConfigValue(this.#setup, "model"),
      settings.thinkingLevel ?? antigravityConfigValue(this.#setup, "thought_level"));
    for (const [category, requested] of [["model", settings.modelId], ["thought_level", settings.thinkingLevel], ["mode", settings.modeId]] as const) {
      if (!requested || antigravityConfigValue(this.#setup, category) === requested) continue;
      const option = antigravityConfigOption(this.#setup, category);
      const configId = option?.id;
      if (!configId) throw unsupported("The selected Antigravity setting is unavailable.");
      if (!antigravitySelectOptions(option).some(value => value.value === requested)) throw unsupported("The selected Antigravity setting is unavailable.");
      // An external native setting change can require applying the same desired
      // revision again. It is a new setter invocation, not a replay of an old
      // acknowledged result from before that external change.
      const operationId = `config:${randomUUID()}`;
      try {
        await this.#request(operationId, { type: "set_config", configId, value: requested });
        const result = await this.#wait(operationId);
        await this.#applyConfigResult(operationId, result);
        if (antigravityConfigValue(this.#setup, category) !== requested) throw unknown();
        await this.#ackReceipt(operationId);
      } catch { throw unavailable("Antigravity could not confirm the requested settings. The prompt was not sent."); }
    }
    const model = antigravityConfigValue(this.#setup, "model"), effort = antigravityConfigValue(this.#setup, "thought_level");
    this.#assertSelection(model, effort);
  }
  #assertSelection(model: string | undefined, effort: string | undefined): void {
    if (!model || !(effort ? this.driver.input.modelPolicy.isSelectionAllowed({ modelId: model, reasoningEffort: effort }) :
      this.driver.input.modelPolicy.isModelWithoutReasoningEffortAllowed({ modelId: model }))) throw unsupported("The selected Antigravity model is excluded by policy.");
  }
  async #applyConfigResult(operationId: string, outcome: AntigravityOutcome): Promise<void> {
    if (outcome.status !== "completed" || this.#appliedSetters.has(operationId) || !this.#requestedSetters.has(operationId)) return;
    const existing = this.#configurationApplications.get(operationId);
    if (existing) return existing;
    // Response delivery and notification delivery can race across SSH. Refresh
    // the exact retained owner after success; its sequence fences older events
    // without confusing a delayed earlier notification with a newer setting.
    const work = (async () => {
      const retained = await this.driver.input.port.attachExisting(this.identity, this.#lifetime.signal).catch(() => { throw unknown(); });
      if (!retained || retained.handleId !== this.attachment.handleId || retained.generation !== this.attachment.generation) throw unknown();
      this.#applyRetainedSetup(retained);
      this.#appliedSetters.add(operationId);
    })();
    this.#configurationApplications.set(operationId, work);
    try { await work; } finally { this.#configurationApplications.delete(operationId); }
  }
  #applyRetainedSetup(retained: AntigravityAttachment): void {
    if (retained.throughSequence < this.#configurationSequence) return;
    this.#configurationSequence = retained.throughSequence;
    this.#applySetup(retained.setup);
  }
  #applyConfigOptions(configOptions: SessionConfigOption[]): void {
    this.#applySetup({ ...this.#setup, session: { ...this.#setup.session, configOptions } });
  }
  #applySetup(setup: AntigravitySetup): void {
    const before = antigravityCapabilities(this.#setup, this.driver.connection.id);
    this.#setup = setup;
    this.driver.input.modeCatalog?.observe(this.#setup);
    const capabilities = antigravityCapabilities(this.#setup, this.driver.connection.id);
    if (JSON.stringify(before) !== JSON.stringify(capabilities)) this.#emit({ type: "capabilities_changed", capabilities });
  }
  async submit(input: SubmitTurnInput) {
    this.#assert();
    if (this.#pendingSubmit || this.#projection.snapshot.runState !== "idle") throw unsupported("Wait for the current Antigravity turn to settle.");
    await this.#configure();
    const prompt = await buildAntigravityPrompt(this.scope, input, this.driver.input.agentTools?.instructions(
      this.driver.toolSource(this.binding.applicationThreadId, this.attached.workspace.summary.id), this.attachment.toolPeerStamp));
    this.#pendingSubmit = input.applicationOperationId; this.#streaming = true;
    let outcome: AntigravityOutcome;
    try { outcome = await this.#request(input.applicationOperationId, { type: "prompt", prompt }); }
    catch (error) { if (error instanceof BackendError && !error.crossedSubmissionBoundary) this.#pendingSubmit = undefined; throw error; }
    if (outcome.status === "failed") { this.#pendingSubmit = undefined; await this.#ackReceipt(input.applicationOperationId).catch(() => undefined); throw outcomeError(outcome); }
    return this.#afterSubmissionDispatch(async () => {
      const deadline = Date.now() + 30_000;
      let firstRead = true;
      while (Date.now() < deadline) {
        await this.#serialize(() => this.#refresh(true, firstRead)); firstRead = false;
        const turn = Object.values(this.#projection.snapshot.turnsById).find(value => value.completionCorrelations?.includes(input.applicationOperationId));
        if (turn) return { accepted: true as const, reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId, backendTurnId: turn.backendTurnId };
        const receipt = this.#receipts.get(input.applicationOperationId);
        if (receipt?.status === "failed") { this.#pendingSubmit = undefined; await this.#ackReceipt(input.applicationOperationId); throw outcomeError(receipt); }
        await delay(50, undefined, { signal: this.#lifetime.signal });
      }
      throw unknown();
    });
  }
  async steer(input: SteerTurnInput): Promise<SteerTurnResult> {
    this.#assert();
    if (input.target.kind !== "conversation") throw unsupported("Antigravity steer targets the conversation.");
    this.#assertSelection(antigravityConfigValue(this.#setup, "model"), antigravityConfigValue(this.#setup, "thought_level"));
    const prompt = await buildAntigravityPrompt(this.scope, { ...input, source: { kind: "user" } },
      this.driver.input.agentTools?.instructions(this.driver.toolSource(this.binding.applicationThreadId, this.attached.workspace.summary.id), this.attachment.toolPeerStamp), "steer");
    const outcome = await this.#request(input.applicationOperationId, { type: "steer", prompt });
    if (outcome.status === "failed") { await this.#ackReceipt(input.applicationOperationId).catch(() => undefined); throw outcomeError(outcome); }
    this.#streaming = true;
    return this.#afterSubmissionDispatch(async (): Promise<SteerTurnResult> => {
      // Give asynchronous native enqueue a short evidence window, but release
      // the actor mailbox immediately when its provider needs a permission.
      // Host dispatch alone never proves native acceptance or authorizes replay.
      const deadline = Date.now() + 1000;
      let firstRead = true;
      while (true) {
        const finalRead = Date.now() >= deadline;
        await this.#serialize(() => this.#refresh(true, firstRead || finalRead || this.#permissions.size > 0)); firstRead = false;
        const turn = Object.values(this.#projection.snapshot.turnsById).find(value => value.completionCorrelations?.includes(input.applicationOperationId));
        if (turn) return { status: "accepted", reconciliationToken: input.reconciliationToken, completionCorrelation: input.applicationOperationId, backendTurnId: turn.backendTurnId };
        const staged = this.#native.native.steps.some(step => step.user && inspectAntigravityInput(this.scope, step.user.text).operationId === input.applicationOperationId);
        if (staged) return { status: "pending_materialization", reconciliationToken: input.reconciliationToken, completionCorrelation: input.applicationOperationId };
        const receipt = this.#receipts.get(input.applicationOperationId);
        if (receipt?.status === "failed") { await this.#ackReceipt(input.applicationOperationId); throw outcomeError(receipt); }
        if (this.#permissions.size || finalRead) throw unknown();
        await this.#waitForReceipt(Math.min(50, deadline - Date.now()));
      }
    });
  }
  async interrupt(input: InterruptConversationInput): Promise<void> {
    input.signal?.throwIfAborted();
    if (input.deadlineAt <= Date.now()) throw unknown();
    await this.#request(input.applicationOperationId, { type: "cancel" }); await this.#wait(input.applicationOperationId, input.deadlineAt);
    await this.#serialize(() => this.#refresh(true, true)).catch(() => undefined);
    await this.#ackReceipt(input.applicationOperationId);
  }
  async reconcileInterrupt(input: InterruptConversationInput) { return this.#reconcileReceipt(input.applicationOperationId, "cancel"); }
  async perform(input: RegisteredBackendActionInput) {
    this.#assert();
    if (input.action !== "set_model" && input.action !== "set_thinking_level") throw unsupported("This action is unavailable for Antigravity.");
    if (this.#projection.snapshot.runState !== "idle") throw unsupported("Wait for Antigravity to settle before changing settings.");
    if (input.action === "set_model" && input.provider !== this.driver.connection.id) throw unsupported("The model belongs to a different connection.");
    const option = antigravityConfigOption(this.#setup, input.action === "set_model" ? "model" : "thought_level");
    const configId = option?.id;
    const value = input.action === "set_model" ? input.modelId : input.level;
    if (!configId || !antigravitySelectOptions(option).some(option => option.value === value)) throw unsupported("The selected native setting is unavailable.");
    this.#assertSelection(input.action === "set_model" ? value : antigravityConfigValue(this.#setup, "model"),
      input.action === "set_thinking_level" ? value : antigravityConfigValue(this.#setup, "thought_level"));
    await this.#request(input.applicationOperationId, { type: "set_config", configId, value });
    const outcome = await this.#wait(input.applicationOperationId);
    try { await this.#applyConfigResult(input.applicationOperationId, outcome); }
    catch { return { accepted: true as const }; }
    await this.#ackReceipt(input.applicationOperationId);
    return { accepted: true as const };
  }
  async reconcileAction(input: RegisteredBackendActionInput) { return this.#reconcileReceipt(input.applicationOperationId, "set_config"); }
  async respond(input: InteractionResponseInput): Promise<void> {
    const request = this.#permissions.get(input.interactionId)?.request;
    if (!request) throw unsupported("The Antigravity interaction is no longer pending.");
    const selected = input.kind === "decision" ? input.selectedActionId : input.kind === "choice" && input.selectedOptionIds.length === 1 ? input.selectedOptionIds[0] : undefined;
    if (input.kind !== "cancel" && !request.options.some(option => option.optionId === selected)) throw unsupported("The selected interaction response is invalid.");
    await this.#request(input.applicationOperationId, { type: "permission", requestId: input.interactionId,
      response: { outcome: input.kind === "cancel" ? { outcome: "cancelled" } : { outcome: "selected", optionId: selected! } } });
    await this.#wait(input.applicationOperationId);
    if (this.#permissions.has(input.interactionId)) this.#resolvedPermissions.add(input.interactionId);
    this.#resolvePermission(input.interactionId);
    await this.#ackReceipt(input.applicationOperationId);
  }
  async reconcileInteractionResponse(input: InteractionResponseInput) { return this.#reconcileReceipt(input.applicationOperationId, "permission"); }
  async #reconcileReceipt(operationId: string, kind: AntigravityCommand["type"]) {
    this.#controlOperations.set(operationId, kind);
    try { const cached = this.#receipts.get(operationId);
      const value = cached?.status === "completed" || cached?.status === "failed" && cached.failure.delivery !== "sent_outcome_unknown"
        ? cached : await this.#pollReceipt(operationId, true);
      this.#receipts.set(operationId, value);
      if (value.status === "completed" && (kind === "set_config" || kind === "set_mode")) {
        try { await this.#applyConfigResult(operationId, value); }
        catch { return { outcome: "accepted" as const }; }
      }
      await this.#ackReceipt(operationId);
      return { outcome: value.status === "completed" ? "accepted" as const : value.status === "failed" && value.failure.delivery !== "sent_outcome_unknown" ? "not_applied" as const : "unknown" as const }; }
    catch { return { outcome: "unknown" as const }; }
  }
  subscribe(listener: (event: BackendConversationEvent) => void) { this.#rawListeners.add(listener); return () => { this.#rawListeners.delete(listener); }; }
  async #acknowledgeAbandoned(signal?: AbortSignal, force = false): Promise<void> {
    const now = Date.now();
    const candidates = [...this.#receipts].filter(([id, outcome]) => !this.#inFlightRequests.has(id) &&
      (force || now - (this.#receiptPolledAt.get(id) ?? 0) >= 1000 || outcome.status === "completed" ||
        outcome.status === "failed" && outcome.failure.delivery !== "sent_outcome_unknown")).map(([id]) => id);
    const { acknowledged, pending } = await this.driver.acknowledgeAbandonedOperations(this.binding.applicationThreadId,
      this.attachment.handleId, candidates, signal);
    for (const id of pending) { this.#receiptPolledAt.set(id, now); this.#receipts.set(id, { status: "pending" }); }
    for (const id of acknowledged) {
      this.#acknowledgedOperations.add(id); this.#receipts.delete(id); this.#receiptPolledAt.delete(id);
      this.#ackReady.delete(id); this.#controlOperations.delete(id); this.#ackAttemptedAt.delete(id);
      if (this.#pendingSubmit === id) this.#pendingSubmit = undefined;
    }
  }
  async close(): Promise<void> {
    if (this.#closeComplete) return;
    this.#closed = true; this.#lifetime.abort(); this.#control.abort(); await this.#loop;
    // Receipt cleanup must not prevent releasing the handle on carrier loss.
    // The retained owner keeps any outcomes whose acknowledgement was unproven.
    await this.#acknowledgeAbandoned(AbortSignal.timeout(5000), true).catch(() => undefined);
    await this.driver.input.port.release({ handleId: this.attachment.handleId }).catch(error => { throw antigravityReadError(error); });
    this.#accounting.close(); this.#listeners.clear(); this.#rawListeners.clear(); this.driver.handles.delete(this); this.#closeComplete = true;
  }
}

function permissionInteraction({ requestId: id, request, openedAt }: AntigravityAttachment["pendingPermissions"][number]): DriverInteraction {
  const base = { backendInteractionId: id, sourceLabel: boundDisplayText("Antigravity"), title: boundDisplayText(request.toolCall.title || "Permission required"),
    openedAt, secret: false, destructive: true, cancellable: true };
  if (request.toolCall.toolCallId.startsWith("interaction_")) return { ...base, kind: "choice", destructive: false, multiple: false,
    options: request.options.map(option => ({ backendOptionId: option.optionId, label: boundDisplayText(option.name) })) };
  return { ...base, kind: "decision", message: boundText(request.toolCall.title || "Antigravity requests permission to continue."),
    actions: request.options.map((option, index) => ({ backendActionId: option.optionId, label: boundDisplayText(option.name),
      role: option.kind.startsWith("reject") ? "reject" : index === 0 ? "primary" : "alternative" })) };
}
function unknown(): BackendError { return new BackendError({ category: "submission_unknown", retryable: false, crossedSubmissionBoundary: true,
  safeMessage: "The Antigravity operation outcome is not yet known. It has not been resent." }); }
function outcomeError(outcome: Extract<AntigravityOutcome, { status: "failed" }>): BackendError {
  return antigravityFailureError(outcome.failure);
}
