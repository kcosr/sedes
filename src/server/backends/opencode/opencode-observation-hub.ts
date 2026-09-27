import { randomUUID } from "node:crypto";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeHttpNativeAdapter, OpenCodeHttpObservation } from "./opencode-http-native-adapter.js";
import { OPENCODE_NATIVE_EVENT_BUFFER_BYTES, OPENCODE_NATIVE_EVENT_BUFFER_RECORDS,
  OPENCODE_OBSERVATION_WIRE_BYTES, openCodeNeedsFullEvidenceEvent, type OpenCodeNativeEvent, type OpenCodeNativeActivity } from "./opencode-native-codecs.js";
import { OpenCodeNativeObservationProof, OPENCODE_NATIVE_PROOF_BYTES, OPENCODE_NATIVE_PROOF_RECORDS,
  openCodeNativeFactFingerprint } from "./opencode-native-observation-proof.js";
import type { OpenCodeNativeAuthority, OpenCodeObservationBoundary,
  OpenCodeObservationEnd, OpenCodeObservationRecord, OpenCodePortObservation } from "./opencode-native-port.js";

const MAX_SCOPES = 4_096;
const CRITICAL_BYTES = 64 * 1_024 * 1_024;
const RECONCILIATION_INITIAL_RETRY_MS = 1_000;
const RECONCILIATION_MAXIMUM_RETRY_MS = 120_000;
const RECONCILIATION_MAXIMUM_FAILURES = 10;
function settledWorkId(event: OpenCodeNativeEvent): string | undefined {
  switch (event.type) {
    case "permission.replied": return `permission:${event.data.requestID}`;
    case "form.replied": case "form.cancelled": return `form:${event.data.id}`;
    case "shell.exited": case "shell.deleted": return `shell:${event.data.id}`;
    case "session.execution.succeeded": case "session.execution.failed": case "session.execution.interrupted": case "session.deleted":
      return `execution:${event.data.sessionID}`;
  }
}
interface ReconciliationRetry { failures: number; nextAttemptAt: number; }
interface Scope {
  readonly authority: OpenCodeNativeAuthority; readonly journalId: string;
  readonly proof: OpenCodeNativeObservationProof; readonly records: OpenCodeObservationRecord[];
  readonly subscribers: Set<Subscriber>; evidence?: Subscriber;
  sequence: number; acknowledged: number; releaseRequested: boolean; lossPending: boolean; continuity: string; proofTouched: number;
}
interface Subscriber {
  readonly scope: Scope; readonly purpose: "evidence" | "presentation";
  readonly queue: OpenCodeObservationRecord[]; readonly wake: () => void;
  readonly finish: (end: OpenCodeObservationEnd) => void;
  delivered: number; bytes: number; ended: boolean; ready: boolean;
}

/** Resident provider evidence. Closing a subscriber never closes native SSE. */
export class OpenCodeObservationHub {
  readonly #scopes = new Map<string, Scope>();
  readonly #lifetime = new AbortController();
  readonly #waiters = new Set<() => void>();
  readonly #reconcileScopes = new Map<Scope, Map<string, ReconciliationRetry>>();
  readonly #reconcileWaiters = new Set<() => void>();
  #reconciling = false;
  #settlementRevision = 0n;
  #settlementFloor = 0n;
  readonly #settlements = new Map<string, bigint>();
  readonly #running: Promise<void>;
  #native?: OpenCodeHttpObservation;
  #connected = false;
  #continuity = randomUUID();
  #revision = 0;
  #criticalBytes = 0;
  #criticalRecords = 0;
  #factRecords = 0;
  #proofClock = 0;
  #presentationBytes = 0;
  #exhausted = false;
  #notificationQueued = false;
  constructor(readonly adapter: OpenCodeHttpNativeAdapter, readonly options: {
    readonly route?: (authority: OpenCodeNativeAuthority, event: OpenCodeNativeEvent) => boolean;
    readonly onRetentionChanged?: () => void;
    readonly assertCurrent?: (signal: AbortSignal) => Promise<void>;
    readonly onActivity?: (authority: OpenCodeNativeAuthority, activity: OpenCodeNativeActivity) => void;
    readonly maximumCriticalBytes?: number; readonly maximumCriticalRecords?: number;
    readonly maximumProofBytes?: number; readonly maximumPresentationBytes?: number;
  } = {}) {
    adapter.client.lifetime.addEventListener("abort", () => this.close(), { once: true });
    if (adapter.client.lifetime.aborted) this.#lifetime.abort();
    this.#running = this.#run();
  }
  admitScope(authority: OpenCodeNativeAuthority): void {
    this.#assertOpen(); if (!authority.session) return;
    const key = configurationFingerprint(authority), existing = this.#scopes.get(key);
    if (existing) { existing.releaseRequested = false; return; }
    if (this.#scopes.size >= MAX_SCOPES) throw unavailable("opencode_native_scope_capacity");
    if (!this.#reclaimProofSpace(1_024)) {
      throw unavailable("opencode_observation_retention_full");
    }
    this.#scopes.set(key, { authority: structuredClone(authority), journalId: randomUUID(),
      proof: new OpenCodeNativeObservationProof(authority.session.nativeSessionID), records: [], subscribers: new Set(),
      sequence: 0, acknowledged: 0, releaseRequested: false, lossPending: false, continuity: this.#continuity, proofTouched: ++this.#proofClock });
    this.#changed();
  }
  releaseScope(authority: OpenCodeNativeAuthority): void {
    const scope = this.#scopes.get(configurationFingerprint(authority));
    if (!scope) return; scope.releaseRequested = true; this.#collect(scope);
  }
  hasRetainedAuthority(authority: OpenCodeNativeAuthority): boolean {
    const scope = this.#scopes.get(configurationFingerprint(authority));
    return !!scope && (scope.records.length > 0 || scope.subscribers.size > 0 || scope.proof.hasWork);
  }
  /** Pin a dispatched input before its admission response can race the SSE frame. */
  beginInput(authority: OpenCodeNativeAuthority, inputId: string): void {
    this.#assertOpen();
    const scope = this.#scopes.get(configurationFingerprint(authority));
    if (!scope || !authority.session) throw unavailable("opencode_request_authority_mismatch");
    this.#reclaimProofSpace(Buffer.byteLength(inputId) + 32);
    const others = this.#proofBytes() - scope.proof.bytes;
    if (!scope.proof.prepareInput(inputId, this.#maximumProofBytes - others)) throw unavailable("opencode_observation_retention_full");
    this.#changed();
  }
  /** Only a proven pre-native refusal may remove an unobserved dispatch pin. */
  refuseInput(authority: OpenCodeNativeAuthority, inputId: string): void {
    const scope = this.#scopes.get(configurationFingerprint(authority));
    if (!scope) return; scope.proof.refuseInput(inputId); this.#collect(scope); this.#changed();
  }
  async ensureListening(signal?: AbortSignal): Promise<void> {
    while (!this.#connected) {
      this.#assertOpen(); signal?.throwIfAborted();
      await this.#wait(signal);
    }
    this.#assertOpen(); signal?.throwIfAborted();
    if (this.#exhausted || this.#criticalRecords >= this.#maximumRecords || this.#factRecords >= OPENCODE_NATIVE_PROOF_RECORDS || this.#criticalBytes >= this.#maximumBytes) {
      throw unavailable("opencode_observation_retention_full");
    }
  }
  subscribe(authority: OpenCodeNativeAuthority, input: Parameters<OpenCodeNativePortLike>[0]): OpenCodePortObservation {
    this.#assertOpen(); input.signal?.throwIfAborted();
    const scope = this.#scopes.get(configurationFingerprint(authority));
    if (!scope || !authority.session) throw unavailable("opencode_request_authority_mismatch");
    if (input.purpose === "presentation" && input.after) throw unavailable("opencode_request_authority_mismatch");
    const after = input.after?.sequence ?? scope.acknowledged;
    if (input.after && (input.after.journalId !== scope.journalId || !Number.isSafeInteger(after) ||
        after < scope.acknowledged || after > scope.sequence)) throw unavailable("opencode_observation_continuity_lost");
    const boundary = (): OpenCodeObservationBoundary => ({ journalId: scope.journalId, throughSequence: scope.sequence,
      retainedAfterSequence: scope.acknowledged, nativeConnected: this.#connected,
      nativeContinuity: scope.continuity, proof: scope.proof.snapshot() });
    let resolveEnd!: (end: OpenCodeObservationEnd) => void;
    const ended = new Promise<OpenCodeObservationEnd>(resolve => { resolveEnd = resolve; });
    let end: OpenCodeObservationEnd | undefined;
    const subscription = new AbortController();
    const waiters = new Set<() => void>();
    const wake = () => { for (const notify of waiters) notify(); };
    const finish = (value: OpenCodeObservationEnd) => {
      if (end) return; end = value; subscriber.ended = true; subscription.abort();
      this.#presentationBytes -= subscriber.bytes; subscriber.bytes = 0; subscriber.queue.length = 0;
      scope.subscribers.delete(subscriber); if (scope.evidence === subscriber) scope.evidence = undefined;
      input.signal?.removeEventListener("abort", abort); wake(); resolveEnd(value); this.#collect(scope); this.#changed();
    };
    const subscriber: Subscriber = { scope, purpose: input.purpose, queue: [], wake, finish,
      delivered: input.purpose === "evidence" ? after : scope.sequence, bytes: 0, ended: false, ready: false };
    scope.subscribers.add(subscriber);
    if (input.purpose === "evidence") {
      const previous = scope.evidence; scope.evidence = subscriber;
      previous?.finish({ reason: "superseded", error: unavailable("opencode_observation_controller_superseded") });
    }
    const abort = () => finish({ reason: "aborted", error: unavailable("opencode_event_aborted") });
    input.signal?.addEventListener("abort", abort, { once: true });
    const available = () => input.purpose === "presentation" ? subscriber.queue.length > 0
      : scope.records.some(record => record.sequence > subscriber.delivered);
    const check = () => { if (end) throw end.error ?? unavailable("opencode_event_closed"); };
    const ready = (async () => {
      const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 5_000); timer.unref?.();
      const signal = AbortSignal.any([subscription.signal, timeout.signal, ...(input.signal ? [input.signal] : [])]);
      try {
        while (!this.#connected) { check(); await this.#wait(signal); }
        check(); subscriber.ready = true; return boundary();
      } catch (error) {
        if (!end) finish({ reason: "failed", error: unavailable("opencode_event_ready_timeout") });
        throw end?.error ?? error;
      } finally { clearTimeout(timer); }
    })();
    void ready.catch(() => undefined);
    this.#changed();
    return {
      ready, ended, get failure() { return end?.error; },
      drain: (maximumBytes = OPENCODE_OBSERVATION_WIRE_BYTES) => {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2) throw unavailable("opencode_request_authority_mismatch");
        const budget = Math.min(maximumBytes, OPENCODE_OBSERVATION_WIRE_BYTES);
        check(); const source = input.purpose === "presentation" ? subscriber.queue : scope.records;
        const result: OpenCodeObservationRecord[] = []; let bytes = 2;
        for (const record of source) {
          if (result.length >= OPENCODE_NATIVE_EVENT_BUFFER_RECORDS) break;
          if (input.purpose === "evidence" && record.sequence <= subscriber.delivered) continue;
          const size = Buffer.byteLength(JSON.stringify(record)) + 1;
          if (bytes + size > budget) break;
          result.push(record); bytes += size; subscriber.delivered = record.sequence;
        }
        if (input.purpose === "presentation") {
          subscriber.queue.splice(0, result.length);
          const released = result.reduce((sum, record) => sum + record.decodedBytes, 0);
          subscriber.bytes -= released; this.#presentationBytes -= released;
        }
        return structuredClone(result);
      },
      wait: async signal => {
        check(); signal?.throwIfAborted();
        if (!available()) await waitForChange(waiters, signal);
        check(); signal?.throwIfAborted();
      },
      acknowledge: async cursor => {
        check();
        if (input.purpose !== "evidence" || scope.evidence !== subscriber || cursor.journalId !== scope.journalId ||
            !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || cursor.sequence > subscriber.delivered) {
          throw unavailable("opencode_request_authority_mismatch");
        }
        if (cursor.sequence <= scope.acknowledged) return;
        while (scope.records[0] && scope.records[0].sequence <= cursor.sequence) {
          const record = scope.records.shift()!;
          if (record.kind !== "native_break") {
            if (record.kind === "native_fact") this.#factRecords--; else this.#criticalRecords--;
            this.#criticalBytes -= record.decodedBytes;
          }
          else scope.lossPending = false;
        }
        scope.acknowledged = cursor.sequence;
        if (this.#criticalRecords < this.#maximumRecords && this.#factRecords < OPENCODE_NATIVE_PROOF_RECORDS && this.#criticalBytes < this.#maximumBytes) this.#exhausted = false;
        this.#changed(); this.#collect(scope);
      },
      close: async () => finish({ reason: "closed" }),
    };
  }
  retentionSnapshot() {
    const scopes = [...this.#scopes.values()];
    return { revision: this.#revision, nativeContinuity: this.#continuity, nativeConnected: this.#connected,
      retainedThreadIds: [...new Set(scopes.filter(scope => this.hasRetainedAuthority(scope.authority))
        .map(scope => scope.authority.session!.applicationThreadId))],
      evidenceRecords: scopes.reduce((sum, scope) => sum + scope.records.length, 0),
      evidenceBytes: this.#criticalBytes + scopes.filter(scope => scope.lossPending).length * 1_024,
      proofBytes: scopes.reduce((sum, scope) => sum + scope.proof.bytes, 0),
      currentInputScopes: scopes.filter(scope => scope.proof.currentInputId !== null).length,
      retentionExhausted: this.#exhausted };
  }
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(); this.#connected = false; this.#reconcileScopes.clear(); void this.#native?.close();
    for (const scope of this.#scopes.values()) for (const sub of [...scope.subscribers]) sub.finish({ reason: "closed" });
    this.#changed(); void this.#running.catch(() => undefined);
  }
  get #maximumBytes() { return this.options.maximumCriticalBytes ?? CRITICAL_BYTES; }
  get #maximumRecords() { return this.options.maximumCriticalRecords ?? OPENCODE_NATIVE_EVENT_BUFFER_RECORDS; }
  get #maximumProofBytes() { return this.options.maximumProofBytes ?? OPENCODE_NATIVE_PROOF_BYTES; }
  get #maximumPresentationBytes() { return this.options.maximumPresentationBytes ?? OPENCODE_NATIVE_EVENT_BUFFER_BYTES; }
  #proofBytes() { return [...this.#scopes.values()].reduce((sum, scope) => sum + scope.proof.bytes, 0); }
  #reclaimProofSpace(additionalBytes: number): boolean {
    let needed = this.#proofBytes() + additionalBytes - this.#maximumProofBytes;
    if (needed <= 0) return true;
    let reclaimed = false;
    // Only cached density proofs are reclaimable. Input, execution and unknown
    // work markers retain their authority even when another scope needs space.
    for (const scope of [...this.#scopes.values()].sort((a, b) => a.proofTouched - b.proofTouched)) {
      const freed = scope.proof.reclaimCachedProofBytes(needed);
      needed -= freed; reclaimed ||= freed > 0;
      if (needed <= 0) break;
    }
    if (reclaimed) this.#changed();
    return needed <= 0;
  }
  #makePresentationSpace(subscriber: Subscriber, bytes: number): boolean {
    if (bytes > this.#maximumPresentationBytes || subscriber.queue.length >= OPENCODE_NATIVE_EVENT_BUFFER_RECORDS) {
      subscriber.finish({ reason: "resnapshot_required", error: unavailable("opencode_event_overflow") }); return false;
    }
    while (this.#presentationBytes + bytes > this.#maximumPresentationBytes) {
      let slowest: Subscriber | undefined;
      for (const scope of this.#scopes.values()) for (const candidate of scope.subscribers) {
        if (candidate.purpose === "presentation" && candidate.bytes > (slowest?.bytes ?? 0)) slowest = candidate;
      }
      if (!slowest) return false;
      slowest.finish({ reason: "resnapshot_required", error: unavailable("opencode_event_overflow") });
      if (subscriber.ended) return false;
    }
    return true;
  }
  #assertOpen() { if (this.#lifetime.signal.aborted) throw unavailable("opencode_runtime_unavailable"); }
  #collect(scope: Scope): void {
    if (!scope.releaseRequested || scope.records.length || scope.subscribers.size || scope.proof.hasWork) return;
    this.#scopes.delete(configurationFingerprint(scope.authority)); this.#reconcileScopes.delete(scope); this.#changed();
  }
  #changed(): void {
    this.#revision++; for (const wake of this.#waiters) wake();
    if (this.#notificationQueued) return; this.#notificationQueued = true;
    queueMicrotask(() => { this.#notificationQueued = false; this.options.onRetentionChanged?.(); });
  }
  #wait(signal?: AbortSignal): Promise<void> { return waitForChange(this.#waiters, signal ? AbortSignal.any([signal, this.#lifetime.signal]) : this.#lifetime.signal); }
  #break(scope: Scope, reason: Extract<OpenCodeObservationRecord, { kind: "native_break" }>["reason"]): void {
    scope.continuity = randomUUID();
    scope.proof.discontinuity();
    this.#queueReconciliation(scope);
    this.#scheduleReconciliation();
    // One reserved small loss marker per admitted scope, outside raw payload
    // capacity. Existing positive records are never silently evicted.
    if (!scope.lossPending) {
      scope.records.push({ kind: "native_break", reason, journalId: scope.journalId, sequence: ++scope.sequence,
        nativeContinuity: scope.continuity, decodedBytes: 1_024 }); scope.lossPending = true;
    } else {
      // The bounded loss marker is already pending. A new atomic boundary is
      // required to see this newer epoch; never mutate a replayed record.
      for (const sub of [...scope.subscribers]) if (sub.purpose === "evidence") {
        sub.finish({ reason: "disconnected", error: unavailable("opencode_observation_continuity_lost") });
      }
    }
    for (const sub of [...scope.subscribers]) {
      if (sub.purpose === "presentation") sub.finish({ reason: "resnapshot_required", error: unavailable("opencode_observation_continuity_lost") });
      else sub.wake();
    }
  }
  #capture(event: OpenCodeNativeEvent, nativeBytes: number): void {
    // A gap-born child/shell can settle before its parent route is seeded by
    // inventory. Fence all in-flight inventories before applying that filter.
    const settled = settledWorkId(event);
    if (settled) {
      this.#settlements.delete(settled); this.#settlements.set(settled, ++this.#settlementRevision);
      if (this.#settlements.size > 4_096) {
        const oldest = this.#settlements.entries().next().value!;
        this.#settlementFloor = oldest[1]; this.#settlements.delete(oldest[0]);
      }
    }
    for (const scope of this.#scopes.values()) {
      const matches = this.options.route ? this.options.route(scope.authority, event) : rootEvent(scope.authority, event);
      if (!matches || scope.proof.isDuplicate(event)) continue;
      if (scope.proof.isConflict(event)) { this.#break(scope, "malformed"); continue; }
      const critical = "durable" in event && !!event.durable || /^(permission|form|shell)\./u.test(event.type);
      if (critical && scope.proof.isGap(event)) this.#break(scope, "disconnected");
      const record: OpenCodeObservationRecord = { kind: "native", event, journalId: scope.journalId,
        sequence: critical ? scope.sequence + 1 : scope.sequence, nativeContinuity: scope.continuity, decodedBytes: 0 };
      const presentationBytes = Buffer.byteLength(JSON.stringify(record)) + 1_024;
      const presentation = { ...record, decodedBytes: presentationBytes };
      if (critical) {
        const compact = "durable" in event && event.durable && !openCodeNeedsFullEvidenceEvent(event.type) &&
          !/^(permission|form|shell)\./u.test(event.type);
        const evidence: OpenCodeObservationRecord = compact ? { kind: "native_fact", sessionID: event.durable!.aggregateID,
          journalId: record.journalId, sequence: record.sequence, nativeContinuity: record.nativeContinuity, decodedBytes: 0,
          fact: { nativeSequence: event.durable!.seq, fingerprint: openCodeNativeFactFingerprint(event), type: event.type,
            inputId: "inboxID" in event.data ? event.data.inboxID : null, boundaryId: null } } : record;
        const bytes = Buffer.byteLength(JSON.stringify(evidence)) + 1_024;
        const captured = { ...evidence, decodedBytes: bytes };
        if ((compact ? this.#factRecords >= OPENCODE_NATIVE_PROOF_RECORDS : this.#criticalRecords >= this.#maximumRecords) ||
            this.#criticalBytes + bytes > this.#maximumBytes || bytes + 2 > OPENCODE_OBSERVATION_WIRE_BYTES) {
          this.#exhausted = true; this.#break(scope, "overflow"); continue;
        }
        try { scope.proof.accept(event); }
        catch { this.#break(scope, "malformed"); continue; }
        scope.sequence++; scope.records.push(captured); this.#criticalBytes += bytes;
        if (compact) this.#factRecords++; else this.#criticalRecords++;
        scope.proofTouched = ++this.#proofClock; this.#reclaimProofSpace(0);
        const others = this.#proofBytes() - scope.proof.bytes;
        if (!scope.proof.trim(Math.max(0, this.#maximumProofBytes - others))) {
          this.#exhausted = true; this.#break(scope, "overflow");
        }
      }
      for (const sub of [...scope.subscribers]) {
        if (sub.purpose === "evidence") { if (critical) sub.wake(); continue; }
        if (sub.ended || !this.#makePresentationSpace(sub, presentationBytes)) continue;
        sub.queue.push(presentation); sub.bytes += presentationBytes; this.#presentationBytes += presentationBytes; sub.wake();
      }
    }
    void nativeBytes; this.#changed();
  }
  #queueReconciliation(scope: Scope): void {
    const cut = scope.proof.retentionCut(), owners = new Set(cut.work.map(item => item.sessionID));
    if (cut.pending.length || cut.unknownExecution) owners.add(scope.authority.session!.nativeSessionID);
    if (owners.size) this.#reconcileScopes.set(scope, new Map([...owners].map(owner => [owner, { failures: 0, nextAttemptAt: 0 }])));
    else this.#reconcileScopes.delete(scope);
    for (const wake of this.#reconcileWaiters) wake();
  }
  #waitForReconciliation(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.#reconcileWaiters.delete(finish);
        this.#lifetime.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, milliseconds); timer.unref?.();
      this.#reconcileWaiters.add(finish); this.#lifetime.signal.addEventListener("abort", finish, { once: true });
      if (this.#lifetime.signal.aborted) finish();
    });
  }
  #scheduleReconciliation(): void {
    if (this.#reconciling || !this.#connected || this.#lifetime.signal.aborted || !this.#reconcileScopes.size) return;
    this.#reconciling = true;
    void (async () => {
      try {
        while (this.#connected && !this.#lifetime.signal.aborted && this.#reconcileScopes.size) {
          const now = Date.now(); let nextAttemptAt = Infinity;
          const ready: Scope[] = [];
          for (const [scope, owners] of this.#reconcileScopes) {
            let due = false;
            for (const retry of owners.values()) { nextAttemptAt = Math.min(nextAttemptAt, retry.nextAttemptAt); due ||= retry.nextAttemptAt <= now; }
            if (due && ready.length < 8) ready.push(scope);
          }
          if (!ready.length) { await this.#waitForReconciliation(Math.max(1, nextAttemptAt - now)); continue; }
          await Promise.all(ready.map(scope => this.#reconcile(scope)));
          if (this.#reconcileScopes.size) await this.#waitForReconciliation(RECONCILIATION_INITIAL_RETRY_MS);
        }
      } finally { this.#reconciling = false; }
    })();
  }
  async #reconcile(scope: Scope): Promise<void> {
    const owners = this.#reconcileScopes.get(scope);
    if (!owners) return;
    if (this.#scopes.get(configurationFingerprint(scope.authority)) !== scope) { this.#reconcileScopes.delete(scope); return; }
    const cut = scope.proof.retentionCut(), continuity = scope.continuity, settlementRevision = this.#settlementRevision;
    const sessionID = scope.authority.session!.nativeSessionID;
    const selected = new Map([...owners].filter(([, retry]) => retry.nextAttemptAt <= Date.now()).slice(0, 4));
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5_000)]);
    let raced = false; const completedReads = new Set<string>();
    try {
      await this.options.assertCurrent?.(signal);
      // Inbox removal may mean promotion into execution. Read activity and
      // interactions afterwards, including when the cut had no work marker.
      const results = await Promise.allSettled([...selected.keys()].map(async owner => {
        const pending = owner === sessionID && cut.pending.length ? await this.adapter.read("getPending", { sessionID }, signal) : undefined;
        const native = await this.adapter.read("getSession", { sessionID: owner }, signal);
        if (owner === sessionID && native.location.directory !== scope.authority.directory) throw unavailable("opencode_request_authority_mismatch");
        const [activity, interactions] = await Promise.all([
          this.adapter.read("getActivity", { sessionID: owner, directory: native.location.directory }, signal),
          this.adapter.read("getInteractions", { sessionID: owner }, signal),
        ]);
        return { owner, activity, interactions, pending };
      }));
      const inventories = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (!inventories.length) throw unavailable("opencode_request_failed");
      const checkedOwners = new Set(inventories.map(item => item.owner));
      for (const owner of checkedOwners) completedReads.add(owner);
      await this.options.assertCurrent?.(signal); signal.throwIfAborted();
      if (!this.#connected || continuity !== scope.continuity) { raced = true; throw unavailable("opencode_observation_continuity_lost"); }
      const work = new Map<string, string>();
      for (const { owner, activity, interactions } of inventories) {
        if (activity.active) work.set(`execution:${owner}`, owner);
        for (const child of activity.activeChildren) work.set(`execution:${child}`, child);
        for (const shell of activity.shells) if (shell.status === "running") work.set(`shell:${shell.id}`, owner);
        for (const item of interactions.permissions) work.set(`permission:${item.id}`, owner);
        for (const item of interactions.forms) work.set(`form:${item.id}`, owner);
      }
      // Only settlements matching this inventory can invalidate it. A bounded
      // overflow loses precision and retries; unrelated daemon activity does not
      // spend this owner's failure budget or strand its lifecycle markers.
      if (this.#settlementFloor > settlementRevision || [...work].some(([id, owner]) =>
          (this.#settlements.get(id) ?? 0n) > settlementRevision ||
          (this.#settlements.get(`execution:${owner}`) ?? 0n) > settlementRevision)) {
        raced = true; throw unavailable("opencode_observation_continuity_lost");
      }
      for (const { activity } of inventories) this.options.onActivity?.(scope.authority, activity);
      if (!scope.proof.reconcileRetention(cut, { pending: new Set(inventories.find(item => item.owner === sessionID)?.pending?.map(item => item.id)), checkedOwners, work })) {
        raced = true; throw unavailable("opencode_observation_continuity_lost");
      }
      scope.proofTouched = ++this.#proofClock; this.#reclaimProofSpace(0);
      const others = this.#proofBytes() - scope.proof.bytes;
      if (!scope.proof.trim(Math.max(0, this.#maximumProofBytes - others))) {
        this.#exhausted = true; this.#break(scope, "overflow");
      }
      for (const owner of checkedOwners) owners.delete(owner);
      this.#collect(scope); this.#changed();
    } catch { /* Failed or raced reads prove nothing. Their markers stay conservative. */ }
    // A new native break replaces the entire retry cycle.
    if (this.#reconcileScopes.get(scope) !== owners) return;
    this.#reconcileScopes.delete(scope);
    for (const [owner, retry] of selected) if (owners.delete(owner)) {
      const fenceRace = raced && completedReads.has(owner);
      const failures = retry.failures + Number(!fenceRace);
      if (failures < RECONCILIATION_MAXIMUM_FAILURES) owners.set(owner, { failures,
        nextAttemptAt: Date.now() + (fenceRace ? RECONCILIATION_INITIAL_RETRY_MS
          : Math.min(RECONCILIATION_MAXIMUM_RETRY_MS, RECONCILIATION_INITIAL_RETRY_MS * 2 ** (failures - 1))) });
    }
    if (owners.size && !this.#lifetime.signal.aborted && this.#scopes.get(configurationFingerprint(scope.authority)) === scope) {
      this.#reconcileScopes.set(scope, owners);
    }
  }
  async #run(): Promise<void> {
    while (!this.#lifetime.signal.aborted) {
      try {
        const native = this.adapter.observe({ signal: this.#lifetime.signal, include: () => false,
          onConnected: () => { this.#connected = true; this.#changed(); this.#scheduleReconciliation(); },
          onEvent: record => this.#capture(record.event, record.decodedBytes) });
        this.#native = native; await native.ready; const end = await native.ended;
        if (this.#lifetime.signal.aborted) return;
        this.#connected = false; this.#continuity = randomUUID();
        for (const scope of this.#scopes.values()) this.#break(scope, end.reason === "malformed" ? "malformed" : end.reason === "overflow" ? "overflow" : "disconnected");
      } catch (error) {
        this.#connected = false;
        for (const scope of this.#scopes.values()) for (const sub of [...scope.subscribers]) if (!sub.ready) {
          sub.finish({ reason: error instanceof OpenCodeRuntimeError && error.code === "opencode_native_protocol_invalid" ? "malformed" : "failed",
            error: error instanceof OpenCodeRuntimeError ? error : unavailable("opencode_event_stream_failed") });
        }
      }
      this.#changed();
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref?.(); });
    }
  }
}
type OpenCodeNativePortLike = import("./opencode-native-port.js").OpenCodeNativePort["observe"];
function unavailable(code: string) { return new OpenCodeRuntimeError(code); }
function rootEvent(authority: OpenCodeNativeAuthority, event: OpenCodeNativeEvent): boolean {
  return "sessionID" in event.data && event.data.sessionID === authority.session?.nativeSessionID || event.type === "form.created" &&
    (event.data.form.sessionID === authority.session?.nativeSessionID || event.data.form.sessionID === "global");
}
function waitForChange(waiters: Set<() => void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { waiters.delete(wake); signal?.removeEventListener("abort", abort); };
    const wake = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal?.reason); };
    waiters.add(wake); signal?.addEventListener("abort", abort, { once: true });
  });
}
