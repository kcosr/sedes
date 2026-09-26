import { claudeMessageIsChildOwned } from "../claude-message-scope.js";
import { attachmentDiagnostic } from "../../../diagnostics/attachment-diagnostics.js";
import { ClaudeBackgroundActivity } from "../claude-background-activity.js";
import { claudeCommandLifecycle, claudeResultIsUnrelated, claudeResultUserMessageIds } from "../claude-result-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRuntimeClient, ClaudeRuntimeForkResult, ClaudeRuntimeSession } from "../claude-runtime-client.js";
import { claudeForkLaunchFailure } from "../claude-fork-launch.js";
import { SidecarOperationError } from "../../../../internal/sidecar-protocol/operation-registry.js";
import type { ClaudeRuntimeAgentToolMcp } from "../worker/claude-runtime-v1.js";
import type { PersistentSidecarServiceRegistry } from "../../../sidecar/persistent-sidecar-service-registry.js";
import { SidecarResourceHandoffPendingError } from "../../../sidecar/persistent-sidecar-service-registry.js";
import type { SidecarUpgradeBlocker } from "../../../../internal/sidecar-protocol/service-management-v1.js";
import { CLAUDE_PERSISTENT_MAXIMUM_SESSIONS, claudePersistentEventSchema, type ClaudePersistentConfiguration, type ClaudePersistentCommand, type ClaudePersistentEvent } from "./claude-persistent-runtime-wire.js";
import { ClaudeHistoryPager, iterateClaudeSessionHistory } from "../claude-session-history.js";
import { compactedStreamSequences, historyCandidates, historyCovers, isTransientReplay, replayMessage, replayStateKey } from "./claude-replay-retention.js";

type Permission = { event: ClaudePersistentEvent; resolve(value: PermissionResult): void; response?: PermissionResult; cancelled?: boolean };
type Session = {
  backgroundActivity: ClaudeBackgroundActivity; backgroundSequence?: number;
  terminalResultSequences: Set<number>; pendingTerminalSequence?: number; model?: string | null; commandsInvalidated: boolean; permissionMode?: import("@anthropic-ai/claude-agent-sdk").PermissionMode; confirmedEffort?: import("@anthropic-ai/claude-agent-sdk").EffortLevel | null;
  id: string; cwd: string; authorityFingerprint: string; runtime: ClaudeRuntimeSession; starting: Promise<unknown>;
  admissionJournalComplete: boolean;
  events: Map<number, ClaudePersistentEvent>; replay: Map<number, ClaudePersistentEvent>; bytes: number; replayBytes: number; sequence: number;
  /** Unacknowledged message events sit in both maps; retention counts them once. */
  journalMessageBytes: number; journalMessageCount: number;
  /** No main has been offered a sequence above this, live or in an attachment. */
  offeredThrough: number;
  sends: Map<string, string>; pendingInputs: Map<string, Parameters<ClaudeRuntimeSession["send"]>[0]>; pendingInputBytes: number; permissionResponses: Map<string,string>; retiring?: Promise<void>; active: Set<string>; permissions: Map<string, Permission>;
  evicted?: boolean;
  /** Claude Code's own run state; work it starts itself keeps it non-idle. */
  providerState: "idle" | "running" | "requires_action";
  listener?: (event: ClaudePersistentEvent) => void; epoch?: number; failureCode?: string;
  /** When main last stopped listening; drives retirement of an unattended, quiescent query. */
  detachedAt?: number;
  historySweep?: Promise<void>; historyTimer?: ReturnType<typeof setTimeout>; nextHistoryRead: number; historyBackoff: number; historyPressure: boolean; historyCandidatesDirty: boolean; hasHistoryCandidates: boolean; rewriteGeneration: number; streamStopSequence: number; replayStateSequences: Map<string, number>;
};

/** A detached query with nothing outstanding is retired after this long. */
export const DETACHED_SESSION_TTL_MS = 30 * 60_000;
const RESIDENCY_SWEEP_INTERVAL_MS = 60_000;
const MAXIMUM_ENDED_JOURNALS = 256;

/** Service-owned sessions never depend on an upstream SSH attachment lifetime. */
export class ClaudePersistentRuntimeHost {
  readonly runtimeId = randomUUID();
  readonly #sessions = new Map<string, Session>();
  /** Running one-shot fork launches by child session; they share the session cap. */
  readonly #forkLaunches = new Map<string, Promise<ClaudeRuntimeForkResult>>();
  /** Admission journals of failed queries retired by eviction, most recent last. */
  readonly #endedJournals = new Map<string, { readonly cwd: string; readonly sends: ReadonlySet<string>; readonly admissionJournalComplete: boolean }>();
  #residencyTimer: ReturnType<typeof setInterval> | undefined;
  readonly #stoppedHistoryPager = new ClaudeHistoryPager();
  readonly #historySweepQueue = new Set<Session>();
  #historySweepSession?: Session;
  #revision = 0;
  #closed = false;
  #runtimeStopped = false;
  #closing = false;
  readonly #shutdownFailures = new Set<Session>();
  readonly #shutdownCancellations: { session: Session; requestId: string; toolUseID: string }[] = [];
  #cleanupUnproven = false;
  #frozen = false;
  #abandoning = false;
  /** An unforced stop ended work that started after its confirmation. */
  #handedOver = false;
  #inflight = 0;
  readonly #stoppedHistory = new Map<string, { info: Awaited<ReturnType<ClaudeRuntimeClient["getSessionInfo"]>>; present: boolean; messages: Awaited<ReturnType<ClaudeRuntimeClient["getSessionMessages"]>> }>();
  freezeAdmission(): void { this.#frozen = true; }
  restoreAdmission(): void {
    if (this.#abandoning) return;
    this.#frozen = false;
    for (const session of this.#sessions.values()) this.#scheduleHistorySweep(session);
    this.#drainHistorySweeps();
  }
  constructor(readonly input: {
    configuration: ClaudePersistentConfiguration;
    client: ClaudeRuntimeClient;
    close(): Promise<void>;
    services: PersistentSidecarServiceRegistry;
    maximumEventBytes?: number;
    replayRetention?: { highWaterEntries?: number; highWaterBytes?: number; minimumHistoryIntervalMs?: number };
    validateQueryEnvironment?: (environment: Readonly<Record<string, string | undefined>>) => void;
    validateAgentToolMcp?: (agentToolMcp: ClaudeRuntimeAgentToolMcp) => void;
    /** How long a detached, quiescent query stays resident before retirement. */
    detachedSessionTtlMs?: number;
  }) {}

  detach(epoch?: number): void {
    for (const session of this.#sessions.values()) {
      if (epoch !== undefined && session.epoch !== epoch) continue;
      this.#unlisten(session);
      this.#cancelHistoryTimer(session);
      void this.#retireIdle(session).catch(() => undefined);
    }
  }

  snapshot() {
    const sessions = [...this.#sessions.values()];
    const blockers: SidecarUpgradeBlocker[] = [];
    if (this.#cleanupUnproven) blockers.push("cleanup_unproven");
    if (this.#inflight || sessions.some(session => session.active.size || session.providerState !== "idle" || session.backgroundActivity.active || session.backgroundActivity.retirementBlocked)) blockers.push("active_work");
    if (sessions.some(session => session.permissions.size)) blockers.push("pending_interaction");
    if (sessions.some(session => this.#hasUnsettledOutcomes(session))) blockers.push("unsettled_outcome");
    return { state: this.#cleanupUnproven ? "unknown" as const : blockers.length ? "active" as const : "idle" as const,
      revision: String(this.#revision), blockers };
  }

  /** Sessions whose work needs a main attachment, live work first, so a
   * replacement main applies and acknowledges their output instead of letting
   * it accumulate; and bounded activity counts for interruption previews. */
  retainedWork() {
    const sessions = [...this.#sessions.values()];
    const live = sessions.filter(session => this.#hasLiveWork(session));
    const unacknowledged = sessions.filter(session => !this.#hasLiveWork(session) && session.events.size > 0);
    const background = { agents: 0, commands: 0, other: 0, unknownSessions: 0 };
    for (const session of sessions) {
      const snapshot = session.backgroundActivity.snapshot();
      if (snapshot.state === "unknown") background.unknownSessions++;
      background.agents += snapshot.agents; background.commands += snapshot.commands; background.other += snapshot.other;
    }
    return {
      retainedSessionIds: [...live, ...unacknowledged].map(session => session.id),
      activity: {
        runningTurns: sessions.filter(session => session.active.size > 0 || session.providerState !== "idle").length,
        pendingInteractions: sessions.reduce((count, session) => count + session.permissions.size, 0),
        unacknowledgedSessions: sessions.filter(session => session.events.size > 0).length,
        background,
      },
    };
  }

  abandonmentEvidence() {
    return { ...this.snapshot(), sessionCount: this.#sessions.size,
      sessions: [...this.#sessions.values()].slice(0, 256).map(session => ({ sessionId: session.id,
        providerState: session.providerState,
        // Settled sessions hold only unacknowledged output, possibly a result.
        liveWork: this.#hasLiveWork(session),
        background: (({ state, agents, commands, other }) => ({ state, agents, commands, other }))(session.backgroundActivity.snapshot()),
        activeOperationIds: [...session.active], pendingInputIds: [...session.pendingInputs.keys()],
        retainedEventCount: session.events.size,
        events: [...session.events.values()].slice(0, 256).map(event => ({ sequence: event.sequence, kind: event.payload.kind,
          ...(event.payload.kind === "message" ? { messageType: event.payload.message.type } : {}),
          ...(event.payload.kind === "failed" ? { code: event.payload.code } : {}),
          ...(event.payload.kind === "permission" ? { requestId: event.payload.request.options.requestId, toolUseID: event.payload.request.options.toolUseID } : {}) })),
      })) };
  }
  async stop(force = false, reason = "runtime_cleanup"): Promise<void> {
    this.freezeAdmission();
    for (const session of this.#sessions.values()) this.#cancelHistoryTimer(session);
    if (!force && [...this.#sessions.values()].some(session => this.#hasUnsettledOutcomes(session))) throw new SidecarResourceHandoffPendingError();
    if (force) {
      await this.input.services.recordAbandonment({ resourceId: this.runtimeId, kind: "claude_agent_sdk", reason,
        evidence: { phase: "before_shutdown", ...this.abandonmentEvidence() } });
      this.#abandoning = true;
      const interrupted = new Set([...this.#sessions.values()].filter(session => this.#hasLiveWork(session)));
      for (const session of this.#sessions.values()) {
        for (const permission of session.permissions.values()) {
          const payload = permission.event.payload;
          if (payload.kind === "permission") permission.resolve({ behavior: "deny", message: "The operator stopped this runtime.", toolUseID: payload.request.options.toolUseID });
        }
        // Every session ends: its failure event is how an attached main learns
        // the query is gone. A settled session's retained output, including an
        // unacknowledged result, remains its outcome; its code says it was
        // stopped after settling rather than interrupted.
        this.#fail(session, interrupted.has(session) ? "claude_persistent_operator_stopped" : "claude_persistent_operator_stopped_settled");
      }
    }
    if (!this.#runtimeStopped) {
      // Capture the provider-owned baseline before terminating its worker.
      // Late terminal frames are retained separately and replay over this exact
      // snapshot during handoff; this is never advertised as a fresh disk read.
      let historyBytes = 0;
      // Explicit interruption preserves the retained journal above; fresh
      // provider history is not a prerequisite for terminating an unavailable worker.
      for (const session of force ? [] : this.#sessions.values()) {
        const info = await this.input.client.getSessionInfo(session.id, { dir: session.cwd }, {});
        // Metadata implies a transcript; a startup-only transcript has none.
        const present = info !== undefined || await this.input.client.hasSessionTranscript(session.id, { dir: session.cwd }, {});
        const messages = present ? await this.input.client.getSessionMessages(session.id, { dir: session.cwd, includeSystemMessages: true }, {}) : [];
        historyBytes += Buffer.byteLength(JSON.stringify({ info, messages }), "utf8");
        if (historyBytes > 64 * 1024 * 1024) throw new Error("claude_persistent_recovery_history_capacity_exceeded");
        this.#stoppedHistory.set(session.id, { info, present, messages });
      }
      // Claude can start work itself after an unforced stop was confirmed
      // idle (a notification, a scheduled wake-up). Ending it is still a hard
      // handover, so it leaves the same evidence as an operator's forced stop.
      const handover = !force && [...this.#sessions.values()].some(session => this.#hasLiveWork(session));
      this.#handedOver = handover;
      if (handover) await this.input.services.recordAbandonment({ resourceId: this.runtimeId, kind: "claude_agent_sdk", reason,
        evidence: { phase: "before_shutdown", startedAfterConfirmation: true, ...this.abandonmentEvidence() } });
      this.#closing = true;
      try { await this.input.close(); }
      catch (error) {
        this.#closing = false;
        this.#cleanupUnproven = true; this.#revision++;
        // Suppression requires proven cleanup. Preserve deferred failure
        // evidence if the intentional stop itself could not terminate safely.
        for (const session of this.#shutdownFailures) this.#fail(session, "claude_persistent_query_failed");
        for (const { session, requestId, toolUseID } of this.#shutdownCancellations) this.#event(session, { kind: "permission_failed", requestId, toolUseID });
        this.#shutdownFailures.clear(); this.#shutdownCancellations.length = 0;
        throw error;
      }
      this.#runtimeStopped = true;
      this.#closing = false;
      this.#shutdownFailures.clear(); this.#shutdownCancellations.length = 0;
      for (const session of this.#sessions.values()) {
        session.active.clear();
        session.providerState = "idle";
        for (const permission of [...session.permissions.values()]) {
          if (permission.event.payload.kind === "permission") this.#permissionDelivered(session, permission.event.payload.request.options, false);
        }
      }
    }
    // Native cleanup can emit terminal or permission receipts while awaited.
    // Proven termination and application adoption are separate obligations.
    if (!force && [...this.#sessions.values()].some(session => this.#hasUnsettledOutcomes(session))) throw new SidecarResourceHandoffPendingError();
    if (force || this.#handedOver) await this.input.services.recordAbandonment({ resourceId: this.runtimeId, kind: "claude_agent_sdk", reason,
      evidence: { phase: "after_shutdown", ...(force ? {} : { startedAfterConfirmation: true }), ...this.abandonmentEvidence() } });
    this.#closed = true;
    this.#stopResidencySweep();
    this.#stoppedHistoryPager.close();
    this.detach();
    this.#sessions.clear(); this.#revision++;
  }

  async execute(command: ClaudePersistentCommand, listener: (event: ClaudePersistentEvent) => void): Promise<unknown> {
    if (command.action === "fork") return await this.#forkLaunch(command);
    if (command.runtimeId !== this.runtimeId) throw new Error("claude_persistent_runtime_unknown");
    this.input.services.assertController(command.controllerEpoch);
    if (this.#closed || this.#cleanupUnproven) throw new Error("claude_persistent_runtime_unavailable");
    const existingOpen = command.action === "open" && this.#sessions.has(command.request.sessionId);
    const retainedProbe = this.#runtimeStopped && command.action === "probe";
    const permissionSettlement = command.action === "respond_permission" &&
      (this.#sessions.get(command.request.sessionId)?.permissionResponses.has(permissionKey(command.request)) ||
        ((!this.#runtimeStopped && !this.#frozen || command.request.response.behavior === "deny") &&
          this.#sessions.get(command.request.sessionId)?.permissions.has(permissionKey(command.request))));
    if (this.#runtimeStopped && !existingOpen && !permissionSettlement && !["attach", "detach", "evict", "retire", "acknowledge", "submission_disposition", "info", "messages", "transcript", "list", "probe"].includes(command.action)) throw new Error("claude_persistent_runtime_stopped");
    if (!existingOpen && !retainedProbe && !permissionSettlement && !["attach", "detach", "evict", "retire", "acknowledge", "list", "info", "messages", "transcript", "submission_disposition"].includes(command.action)) {
      if (this.#frozen) throw new Error("claude_persistent_admission_frozen");
      this.input.services.assertAdmission(command.controllerEpoch);
    }
    // Reads and attachment observation do not invalidate an operator's stop
    // confirmation. Only asynchronous provider mutations need an in-flight
    // blocker; synchronous admission and journal changes update their own state.
    const mutation = ["rename", "interrupt", "set_model", "set_effort", "set_permission_mode"].includes(command.action);
    if (mutation) { this.#inflight++; this.#revision++; }
    const started = performance.now();
    try { return await this.#execute(command, listener); }
    catch (error) {
      attachmentDiagnostic("claude_sidecar_command_failed", {
        role: "sidecar",
        backendInstanceId: this.input.configuration.backendInstanceId,
        executionEnvironmentId: this.input.configuration.executionEnvironmentId,
        method: command.action,
        durationMs: performance.now() - started,
      }, error);
      throw error;
    }
    finally { if (mutation) { this.#inflight--; this.#revision++; } }
  }

  async #execute(command: ClaudePersistentCommand, listener: (event: ClaudePersistentEvent) => void): Promise<unknown> {
    const config = this.input.configuration;
    if (this.#runtimeStopped) {
      if (command.action === "info" || command.action === "messages" || command.action === "transcript") {
        const session = this.#session(command.request.sessionId);
        if (command.request.dir && command.request.dir !== session.cwd) throw new Error("claude_persistent_session_configuration_conflict");
        const baseline = this.#stoppedHistory.get(session.id);
        if (!baseline) throw new Error("claude_persistent_recovery_history_unavailable");
        if (command.action === "info") return { session: baseline.info ?? null };
        if (command.action === "transcript") return { present: baseline.present };
        const messages = command.request.includeSystemMessages ? baseline.messages : baseline.messages.filter(message => message.type !== "system");
        return this.#stoppedHistoryPager.getPage(session.id, command.request, async () => messages);
      }
      if (command.action === "list") throw new Error("claude_persistent_stopped_discovery_unavailable");
      if (command.action === "probe") {
        const retainedSession = [...this.#sessions.values()].find(session => session.cwd === command.request.cwd || command.request.cwd === (config.configDirectory ?? "/"));
        const initialization = retainedSession?.runtime.initialization;
        if (!initialization) throw new Error("claude_persistent_recovery_probe_unavailable");
        const { cliRelease, account, models, commands, skillNames, terminalCommandNames } = initialization;
        return { cliRelease, account, models, commands, skillNames: retainedSession?.commandsInvalidated ? [] : skillNames, terminalCommandNames };
      }
    }
    switch (command.action) {
      case "submission_disposition": {
        const session = this.#sessions.get(command.request.sessionId);
        const retired = this.#endedJournals.get(command.request.sessionId);
        // A failed query retired by eviction keeps its admission journal, so
        // its inputs still resolve instead of becoming permanently unknown.
        if (retired && retired.cwd === command.request.cwd) {
          if (retired.sends.has(command.request.operationId)) return { disposition: "session_ended" };
          if (!session) return { disposition: retired.admissionJournalComplete ? "not_sent" : "session_ended" };
        }
        if (!session || session.cwd !== command.request.cwd) return { disposition: "unknown" };
        const ended = Boolean(session.failureCode || session.runtime.closed);
        if (session.sends.has(command.request.operationId)) {
          return { disposition: ended ? "session_ended" : "submitted" };
        }
        // Failed/closed sessions reject even delayed sends. An absent ID then
        // proves non-admission only if this owner has the whole session journal;
        // a resumed query may have lost an earlier incarnation's entries.
        return { disposition: ended ? session.admissionJournalComplete ? "not_sent" : "session_ended" : "unknown" };
      }
      case "probe": return await this.input.client.probe({ executablePath: config.executablePath, timeoutMs: config.initializationTimeoutMs, environment: {}, cwd: command.request.cwd });
      case "list": return { sessions: await this.input.client.listSessions(command.request, {}) };
      case "info":
        await this.#settledForkLaunch(command.request.sessionId);
        return { session: await this.input.client.getSessionInfo(command.request.sessionId, command.request.dir ? { dir: command.request.dir } : {}, {}) ?? null };
      case "messages": {
        const { sessionId, ...options } = command.request;
        await this.#settledForkLaunch(sessionId);
        return await this.input.client.getSessionMessagesPage(sessionId, options, {});
      }
      case "transcript":
        await this.#settledForkLaunch(command.request.sessionId);
        return { present: await this.input.client.hasSessionTranscript(command.request.sessionId, { dir: command.request.dir }, {}) };
      case "rename": await this.input.client.renameSession(command.request.sessionId, command.request.title, { dir: command.request.dir }, {}); return { renamed: true };
      case "open": return await this.#open(command, listener);
      case "attach": return await this.#attach(this.#session(command.request.sessionId), command.controllerEpoch, listener, true, command.replay);
      case "evict":
      case "detach": {
        const session = this.#sessions.get(command.request.sessionId);
        if (!session && command.action === "evict") return { detached: true };
        if (!session) throw new Error("claude_persistent_session_not_found");
        if (command.action === "evict" || session.epoch === command.controllerEpoch) {
          session.evicted = command.action === "evict";
          this.#unlisten(session);
          this.#cancelHistoryTimer(session);
        }
        await this.#retireIdle(session);
        return { detached: true };
      }
      case "retire": {
        const session = this.#sessions.get(command.request.sessionId);
        if (!session) return { outcome: "absent" };
        if (session.cwd !== command.request.cwd) throw new Error("claude_persistent_session_configuration_conflict");
        // A query main still attends belongs to that attachment.
        if (session.listener) return { outcome: "busy" };
        session.evicted = true;
        await this.#retireIdle(session);
        if (this.#sessions.get(session.id) !== session) return { outcome: "retired" };
        // Output no main has applied is not provider work: an attachment can
        // apply and acknowledge it, after which the query retires.
        return { outcome: !this.#hasLiveWork(session) && session.events.size > 0 ? "undelivered" : "busy" };
      }
      case "acknowledge": {
        const session = this.#session(command.request.sessionId);
        const event = session.events.get(command.request.sequence);
        if (event) {
          session.events.delete(event.sequence);
          session.bytes -= eventSize(event);
          if (event.payload.kind === "message") { session.journalMessageBytes -= eventSize(event); session.journalMessageCount--; }
          const currentReplay = session.replay.get(event.sequence);
          if (currentReplay) {
            const previous = [...session.replay.values()].filter(retained => retained.sequence < event.sequence).at(-1);
            const merged = previous && !session.events.has(previous.sequence) ? coalesceDelta(previous, currentReplay) : undefined;
            if (merged && previous) {
              session.replay.delete(previous.sequence);
              session.replayBytes -= eventSize(previous) + eventSize(currentReplay);
              session.replay.set(event.sequence, merged); session.replayBytes += eventSize(merged);
            }
          }
          if (session.terminalResultSequences.delete(event.sequence)) session.pendingTerminalSequence = event.sequence;
          const terminalSequence = session.pendingTerminalSequence;
          if (terminalSequence !== undefined && ![...session.events.values()].some(retained => retained.sequence <= terminalSequence && retained.payload.kind === "message")) {
            // Claude's current run and permission state outlive the turn: it can
            // chain a result straight into a turn of its own with no idle edge.
            const currentState = new Set([...session.replayStateSequences]
              .flatMap(([key, sequence]) => key.startsWith("state:") || key.startsWith("status:") ? [sequence] : []));
            for (const [sequence, retained] of session.replay) {
              if (sequence > terminalSequence || sequence === session.backgroundSequence || currentState.has(sequence)) continue;
              this.#removeReplay(session, sequence);
            }
            session.pendingTerminalSequence = undefined;
            session.historyCandidatesDirty = true;
          }
          if (isBackgroundInventory(event) && event.sequence !== session.backgroundSequence) {
            const obsolete = session.replay.get(event.sequence);
            if (obsolete) { session.replay.delete(event.sequence); session.replayBytes -= eventSize(obsolete); }
          }
          if (session.failureCode && ![...session.events.values()].some(retained => retained.payload.kind === "message" || retained.payload.kind === "failed")) {
            session.replay.clear(); session.replayBytes = 0;
            session.replayStateSequences.clear();
          }
          this.#compactAcknowledged(session, event);
          this.#scheduleHistorySweep(session);
          this.#revision++;
        }
        // Retiring closes a Claude process, which can take seconds. Main bounds
        // its in-flight acknowledgements across every session, so an
        // acknowledgement never waits for it; failed cleanup records itself.
        void this.#retireIdle(session).catch(() => undefined);
        return { acknowledged: true };
      }
      case "respond_permission": {
        const session = this.#session(command.request.sessionId);
        const key = permissionKey(command.request);
        const fingerprint = createHash("sha256").update(JSON.stringify(command.request.response)).digest("hex");
        const previous = session.permissionResponses.get(key);
        if (previous) {
          if (previous !== fingerprint) throw new Error("claude_persistent_permission_response_conflict");
          return { responded: true };
        }
        const permission = session.permissions.get(key);
        if (!permission) throw new Error("claude_persistent_permission_not_found");
        if (permission.response) {
          if (JSON.stringify(permission.response) !== JSON.stringify(command.request.response)) throw new Error("claude_persistent_permission_response_conflict");
        } else {
          if (session.permissionResponses.size >= 16384) throw new Error("claude_persistent_permission_receipt_capacity_exceeded");
          session.permissionResponses.set(key, fingerprint); permission.response = command.request.response as PermissionResult; this.#retirePermissionEvent(session, permission); permission.resolve(permission.response); this.#revision++; }
        return { responded: true };
      }
      case "send": {
        const session = this.#session(command.request.queryId);
        const { operationId } = command.request;
        const fingerprint = createHash("sha256").update(JSON.stringify(command.request)).digest("hex");
        const previous = session.sends.get(operationId);
        if (previous && previous !== fingerprint) throw new Error("claude_persistent_operation_conflict");
        if (!previous) {
          if (session.runtime.closed || session.failureCode) return { accepted: false, code: "claude_persistent_query_closed" };
          if (session.active.size && command.request.priority !== "next") return { accepted: false, code: "claude_persistent_query_busy" };
          const inputBytes = Buffer.byteLength(JSON.stringify(command.request.content), "utf8");
          if (retainedBytes(session) + session.pendingInputBytes + inputBytes > (this.input.maximumEventBytes ?? 64 * 1024 * 1024)) return { accepted: false, code: "claude_persistent_input_capacity_exceeded" };
          if (session.sends.size >= 16384) return { accepted: false, code: "claude_persistent_operation_capacity_exceeded" };
          session.sends.set(operationId, fingerprint); session.active.add(operationId); session.pendingInputs.set(operationId, command.request as Parameters<ClaudeRuntimeSession["send"]>[0]); session.pendingInputBytes += inputBytes; this.#revision++;
          try { await session.runtime.send(command.request as Parameters<ClaudeRuntimeSession["send"]>[0]); }
          catch (error) { session.active.delete(operationId); this.#fail(session, "claude_persistent_send_failed"); throw error; }
        }
        return { accepted: true };
      }
      case "interrupt": return { receipt: await this.#session(command.request.queryId).runtime.interrupt() ?? null };
      case "set_model": { const session = this.#session(command.request.queryId); await session.runtime.setModel(command.request.model ?? undefined); session.model = command.request.model; return { updated: true }; }
      case "set_effort": { const session = this.#session(command.request.queryId); await session.runtime.setEffort(command.request.effort ?? undefined); session.confirmedEffort = command.request.effort; return { updated: true }; }
      case "set_permission_mode": { const session = this.#session(command.request.queryId); await session.runtime.setPermissionMode(command.request.permissionMode); session.permissionMode = command.request.permissionMode; return { updated: true }; }
    }
  }

  /**
   * One-shot fork launch. It runs to its proven exit even if main disconnects,
   * is never a retained session, and cannot be adopted by a later open. Every
   * refusal before the launch starts is reported as such, so main can treat
   * it as proof that no child was created.
   */
  async #forkLaunch(command: Extract<ClaudePersistentCommand, { action: "fork" }>): Promise<ClaudeRuntimeForkResult> {
    const request = command.request;
    const started = performance.now();
    try {
      try {
        if (command.runtimeId !== this.runtimeId) throw new Error("claude_persistent_runtime_unknown");
        this.input.services.assertController(command.controllerEpoch);
        if (this.#closed || this.#cleanupUnproven || this.#runtimeStopped || this.#frozen) throw new Error("claude_persistent_admission_frozen");
        this.input.services.assertAdmission(command.controllerEpoch);
        if (this.#sessions.has(request.sessionId) || this.#forkLaunches.has(request.sessionId)) throw new Error("claude_persistent_session_configuration_conflict");
      } catch (error) {
        throw claudeForkLaunchFailure("claude_fork_launch_refused", error);
      }
      if (this.#sessions.size + this.#forkLaunches.size >= CLAUDE_PERSISTENT_MAXIMUM_SESSIONS) {
        throw claudeForkLaunchFailure("claude_fork_launch_refused_capacity");
      }
      const config = this.input.configuration;
      const launch = this.input.client.forkSession({
        executablePath: config.executablePath, initializationTimeoutMs: config.initializationTimeoutMs,
        sessionId: request.sessionId, sourceSessionId: request.sourceSessionId, resumeSessionAt: request.resumeSessionAt,
        cwd: request.cwd, ...(request.title ? { title: request.title } : {}), model: request.model,
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.executionEnvironment ? { executionEnvironment: request.executionEnvironment } : {}),
        environment: {},
      });
      this.#forkLaunches.set(request.sessionId, launch); this.#inflight++; this.#revision++;
      try { return await launch; }
      finally { this.#forkLaunches.delete(request.sessionId); this.#inflight--; this.#revision++; }
    } catch (error) {
      attachmentDiagnostic("claude_sidecar_command_failed", {
        role: "sidecar",
        backendInstanceId: this.input.configuration.backendInstanceId,
        executionEnvironmentId: this.input.configuration.executionEnvironmentId,
        method: "fork",
        durationMs: performance.now() - started,
      }, error);
      throw error;
    }
  }

  /** A read of a child whose fork launch is running waits for its proven exit. */
  async #settledForkLaunch(sessionId: string): Promise<void> {
    await this.#forkLaunches.get(sessionId)?.catch(() => undefined);
  }

  async #open(command: Extract<ClaudePersistentCommand, { action: "open" }>, listener: (event: ClaudePersistentEvent) => void) {
    const request = command.request;
    let session = this.#sessions.get(request.sessionId);
    if (session?.retiring) { await session.retiring; this.input.services.assertController(command.controllerEpoch); session = this.#sessions.get(request.sessionId); }
    if (session) {
      if (session.cwd !== request.cwd || session.authorityFingerprint !== queryAuthorityFingerprint(request)) throw new Error("claude_persistent_session_configuration_conflict");
      return await this.#attach(session, command.controllerEpoch, listener, true, command.replay);
    }
    if (this.#frozen || this.#runtimeStopped) throw new Error("claude_persistent_admission_frozen");
    this.input.services.assertAdmission(command.controllerEpoch);
    // A running fork launch owns this identity until its process has exited.
    if (this.#forkLaunches.has(request.sessionId)) throw new Error("claude_persistent_session_configuration_conflict");
    if (this.#sessions.size + this.#forkLaunches.size >= CLAUDE_PERSISTENT_MAXIMUM_SESSIONS) {
      throw new SidecarOperationError("claude_persistent_session_capacity_exceeded", true);
    }
    this.input.validateQueryEnvironment?.(request.environment);
    if (request.agentToolMcp) {
      if (!this.input.validateAgentToolMcp) throw new Error("claude_persistent_agent_tool_mcp_denied");
      this.input.validateAgentToolMcp(request.agentToolMcp);
    }
    const config = this.input.configuration;
    let created!: Session;
    const runtime = this.input.client.createSession({
      ...request, executablePath: config.executablePath, initializationTimeoutMs: config.initializationTimeoutMs,
      environment: request.environment,
      ...(request.enableCanUseTool ? { canUseTool: this.#canUseTool(() => created) } : {}),
      onPermissionResponseDelivered: identity => this.#permissionDelivered(created, identity, true),
      onPermissionResponseDeliveryFailed: identity => this.#permissionDelivered(created, identity, false),
      onMessage: message => this.#message(created, message),
      onFailure: () => this.#fail(created, "claude_persistent_query_failed"),
    });
    created = { backgroundActivity: new ClaudeBackgroundActivity(), id: request.sessionId, cwd: request.cwd, authorityFingerprint: queryAuthorityFingerprint(request), runtime, starting: Promise.resolve(), events: new Map(), replay: new Map(), bytes: 0, replayBytes: 0, sequence: 0,
      journalMessageBytes: 0, journalMessageCount: 0, offeredThrough: 0,
      nextHistoryRead: 0, historyBackoff: 0, historyPressure: false, historyCandidatesDirty: true, hasHistoryCandidates: false, rewriteGeneration: 0, streamStopSequence: 0, replayStateSequences: new Map(),
      admissionJournalComplete: request.launch === "new",
      terminalResultSequences: new Set(), sends: new Map(), pendingInputs: new Map(), pendingInputBytes: 0, commandsInvalidated: false, permissionResponses: new Map(), active: new Set(), permissions: new Map(),
      providerState: "idle" };
    session = created;
    session.backgroundActivity.reset();
    this.#sessions.set(session.id, session); this.#inflight++; this.#revision++;
    session.starting = runtime.start();
    try { await session.starting; }
    catch (error) {
      try { await runtime.close(); this.#sessions.delete(session.id); }
      catch (cleanupError) { this.#cleanupUnproven = true; this.#revision++; throw cleanupError; }
      throw error;
    } finally { this.#inflight--; this.#revision++; }
    return await this.#attach(session, command.controllerEpoch, listener, false, command.replay);
  }

  async #attach(session: Session, epoch: number, listener: (event: ClaudePersistentEvent) => void, reattached = true, replay: "full" | "unacknowledged" = "full") {
    await session.starting;
    // An explicit eviction may already be closing this query. Never report a
    // successful attachment to a worker that is leaving; open can recreate it
    // after cleanup, whereas attach requires the retained query to exist.
    if (session.retiring) await session.retiring;
    this.input.services.assertController(epoch);
    if (this.#sessions.get(session.id) !== session) throw new Error("claude_persistent_session_not_found");
    // A deliberate shutdown can retain final receipts for a replacement main
    // to drain. Observing that stopped worker must not manufacture a failure.
    if (!this.#closing && !this.#runtimeStopped && session.runtime.closed && !session.failureCode) this.#fail(session, "claude_persistent_query_closed");
    session.evicted = false;
    session.listener = listener; session.epoch = epoch; session.detachedAt = undefined;
    // The response below offers every retained event to this main.
    session.offeredThrough = session.sequence;
    this.#scheduleHistorySweep(session);
    const { actualModel: initialModel, ...initialization } = session.runtime.initialization!;
    const actualModel = session.model === undefined ? initialModel : session.model;
    return { queryId: session.id, initialization: { ...initialization, ...(actualModel ? { actualModel } : {}), ...(session.commandsInvalidated ? { skillNames: [] } : {}), ...(session.permissionMode ? { actualPermissionMode: session.permissionMode } : {}) }, ...(session.confirmedEffort !== undefined ? { confirmedEffort: session.confirmedEffort } : {}), startupProbeUuid: session.runtime.startupProbeUuid,
      reattached, failureCode: session.failureCode ?? null, backgroundActivity: session.backgroundActivity.snapshot(), pendingBackgroundTaskIds: session.backgroundActivity.pendingTaskIds(), events: [...new Map([...[...session.events].filter(([, event]) => replay !== "full" || event.payload.kind !== "message"), ...(replay === "full" ? session.replay : []), ...[...session.permissions.values()].filter(permission => !permission.response && !permission.cancelled).map(permission => [permission.event.sequence, permission.event] as const)]).values()].sort((a, b) => a.sequence - b.sequence) };
  }

  #unlisten(session: Session): void {
    session.listener = undefined; session.epoch = undefined;
    session.detachedAt ??= Date.now();
    this.#scheduleResidencySweep();
  }

  /**
   * A query main no longer attends is retired once it has been detached for
   * the residency limit and has nothing outstanding: no admitted or running
   * input, no Claude activity of its own, no background work, and no
   * unacknowledged event or unanswered permission. It resumes on demand.
   */
  #scheduleResidencySweep(): void {
    if (this.#residencyTimer || this.#closed || this.#runtimeStopped) return;
    const ttl = this.input.detachedSessionTtlMs ?? DETACHED_SESSION_TTL_MS;
    this.#residencyTimer = setInterval(() => {
      if (this.#closed || this.#runtimeStopped) { this.#stopResidencySweep(); return; }
      const now = Date.now();
      let detached = 0;
      for (const session of this.#sessions.values()) {
        if (session.listener || session.detachedAt === undefined) continue;
        detached++;
        if (session.retiring || this.#frozen || now - session.detachedAt < ttl) continue;
        session.evicted = true;
        void this.#retireIdle(session).catch(() => undefined);
      }
      if (!detached) this.#stopResidencySweep();
    }, Math.min(ttl, RESIDENCY_SWEEP_INTERVAL_MS));
    this.#residencyTimer.unref();
  }

  #stopResidencySweep(): void {
    if (this.#residencyTimer) clearInterval(this.#residencyTimer);
    this.#residencyTimer = undefined;
  }

  #rememberEndedJournal(session: Session): void {
    this.#endedJournals.delete(session.id);
    this.#endedJournals.set(session.id, { cwd: session.cwd, sends: new Set(session.sends.keys()),
      admissionJournalComplete: session.admissionJournalComplete });
    while (this.#endedJournals.size > MAXIMUM_ENDED_JOURNALS) this.#endedJournals.delete(this.#endedJournals.keys().next().value!);
  }

  #session(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("claude_persistent_session_not_found");
    return session;
  }
  async #retireIdle(session: Session): Promise<void> {
    if (session.retiring) return await session.retiring;
    if (this.#runtimeStopped || this.#closed) return;
    // Retained work (live work or unacknowledged output) keeps the query for
    // an attachment; eviction, the residency limit, and retire all wait for it.
    if (!session.evicted || session.listener || this.#hasLiveWork(session) || session.events.size) return;
    // The application explicitly evicted an idle, fully acknowledged query.
    // Its transcript lives in provider history; replay exists only for a
    // retained attachment and must not keep an evicted subprocess resident.
    session.replay.clear(); session.replayBytes = 0;
    session.replayStateSequences.clear();
    this.#cancelHistoryTimer(session);
    // Closing an idle, fully acknowledged attachment cannot add provider work.
    // Preserve an accepted stop confirmation; late events and failed cleanup
    // still advance the revision through their normal evidence paths.
    this.#inflight++;
    session.retiring = session.runtime.close().then(() => {
      if (session.events.size || session.replay.size || session.permissions.size) this.#fail(session, "claude_persistent_query_retired");
      else if (this.#sessions.get(session.id) === session) {
        if (session.failureCode) this.#rememberEndedJournal(session);
        this.#sessions.delete(session.id);
      }
      session.retiring = undefined;
    }).catch(error => { this.#cleanupUnproven = true; this.#revision++; throw error; }).finally(() => { this.#inflight--; });
    await session.retiring;
  }
  #message(session: Session, message: SDKMessage): void {
    // Filter before any synthetic parent acceptance or replay bookkeeping.
    if (claudeMessageIsChildOwned(message)) return;
    if (message.type === "conversation_reset" || (message.type === "system" && ["compact_boundary", "model_refusal_fallback"].includes(message.subtype)) ||
        ("supersedes" in message && message.supersedes !== undefined)) session.rewriteGeneration++;
    const backgroundChanged = session.backgroundActivity.consume(message);
    if (message.type === "system" && message.subtype === "task_started") session.backgroundActivity.observeTaskStarted(message);
    // The retained terminal event itself blocks retirement until the caller has
    // acknowledged durable application, so the local edge hold can now end.
    if (message.type === "system" && (message.subtype === "task_notification" ||
        (message.subtype === "task_updated" && ["completed", "failed", "killed"].includes(message.patch.status ?? "")))) {
      session.backgroundActivity.settleTask(message.task_id);
    }
    if (message.type === "system" && "subtype" in message && message.subtype === "commands_changed") session.commandsInvalidated = true;
    if (message.type === "user" && "uuid" in message && typeof message.uuid === "string" &&
        session.pendingInputs.get(message.uuid)?.priority !== "next") this.#forgetPendingInput(session, message.uuid);
    if (message.type === "system" && message.subtype === "session_state_changed") session.providerState = message.state;
    const terminalResult = message.type === "result" && !claudeResultIsUnrelated(message,
      session.active.size ? [...session.active] : [...session.sends.keys()].slice(-1));
    const consumedIds = message.type === "assistant" || message.type === "stream_event" || message.type === "result"
      ? claudeResultUserMessageIds(message) : [];
    const lifecycle = claudeCommandLifecycle(message);
    const started = lifecycle?.state === "started" ? lifecycle.commandUuid : undefined;
    // Claude declined this input before queueing it; it never runs here.
    if (lifecycle?.state === "refused" && session.pendingInputs.has(lifecycle.commandUuid)) {
      this.#forgetPendingInput(session, lifecycle.commandUuid);
      session.active.delete(lifecycle.commandUuid);
    }
    // Only exact native evidence materializes an admitted input: Claude's
    // dequeue of an ordinary input, or a consumption stamp. Unstamped output
    // can belong to a turn Claude started itself, and a steer's receiving turn
    // is known only from its stamp.
    for (const [operationId, input] of session.pendingInputs) {
      if (!consumedIds.includes(operationId) && (started !== operationId || input.priority === "next")) continue;
      this.#forgetPendingInput(session, operationId);
      this.#event(session, { kind: "message", message: {
        type: "user", uuid: operationId, session_id: session.id,
        parent_tool_use_id: null, message: { role: "user", content: input.content },
        ...(input.priority ? { priority: input.priority } : {}),
      }, ...(input.priority ? { consumedTurnRootUuid: consumedIds[0]! } : {}) } as ClaudePersistentEvent["payload"]);
    }
    if (terminalResult) {
      for (const id of session.active) {
        // A later result may truncate its UUID list. Inputs already proven
        // consumed by earlier reply frames still finish with this turn.
        // Keep unstamped next inputs pending: an older result, even with an
        // empty queue count, cannot settle a concurrently submitted message.
        if (consumedIds.includes(id) || !session.pendingInputs.has(id)) session.active.delete(id);
      }
    }
    this.#event(session, { kind: "message", message: message as unknown as Extract<ClaudePersistentEvent["payload"], { kind: "message" }>["message"] }, false,
      event => {
        if (terminalResult) session.terminalResultSequences.add(event.sequence);
        if (message.type === "stream_event" && message.event.type === "message_stop") session.streamStopSequence = event.sequence;
        if (message.type === "stream_event" && message.event.type === "message_start") session.historyCandidatesDirty = true;
        if (backgroundChanged) {
          const previous = session.backgroundSequence === undefined ? undefined : session.replay.get(session.backgroundSequence);
          if (previous && !session.events.has(previous.sequence)) {
            session.replay.delete(previous.sequence); session.replayBytes -= eventSize(previous);
          }
          session.backgroundSequence = event.sequence;
        }
      });
  }
  #forgetPendingInput(session: Session, operationId: string): void {
    const pending = session.pendingInputs.get(operationId);
    if (!pending) return;
    session.pendingInputBytes -= Buffer.byteLength(JSON.stringify(pending.content), "utf8");
    session.pendingInputs.delete(operationId);
  }
  #fail(session: Session, code: string): void {
    // WorkerClient.close reports a generic failure for each resident query.
    // An operator-owned, proven stop already accounts for that termination;
    // it must not manufacture receipts requiring detached actors to reattach.
    if (code === "claude_persistent_query_failed" && (this.#closing || this.#runtimeStopped)) {
      if (this.#closing) this.#shutdownFailures.add(session);
      return;
    }
    if (session.failureCode) return;
    this.#cancelHistoryTimer(session);
    session.failureCode = code; session.backgroundActivity.invalidate(); session.active.clear(); session.pendingInputs.clear(); session.pendingInputBytes = 0;
    session.providerState = "idle";
    this.#event(session, { kind: "failed", code }, true);
  }
  #event(session: Session, payload: ClaudePersistentEvent["payload"], reserve = false, beforePublish?: (event: ClaudePersistentEvent) => void): ClaudePersistentEvent {
    let event = claudePersistentEventSchema.parse({ sessionId: session.id, sequence: ++session.sequence, payload });
    // While no main is attached, a streamed delta folds into the immediately
    // preceding delta if no main was ever offered that frame. Offered frames
    // keep their exact sequences: a main may have applied one without
    // acknowledging it yet, and a merged replay would repeat its text.
    const previous = session.listener ? undefined : session.events.get(event.sequence - 1);
    const merged = previous && previous.sequence > session.offeredThrough && session.replay.get(previous.sequence) === previous
      ? coalesceUnofferedDelta(previous, event) : undefined;
    const released = merged && previous ? eventSize(previous) : 0;
    const size = eventSize(merged ?? event);
    // Each retained event counts once, although an unacknowledged message is
    // both a journal entry and a replay entry.
    if (!reserve && (retainedBytes(session) - released + session.pendingInputBytes + size > (this.input.maximumEventBytes ?? 64 * 1024 * 1024) ||
        retainedCount(session) - (merged ? 1 : 0) >= CLAUDE_PERSISTENT_RETAINED_EVENT_LIMIT)) {
      this.#fail(session, "claude_persistent_event_capacity_exceeded");
      void session.runtime.close().catch(() => { this.#cleanupUnproven = true; this.#revision++; });
      throw new Error("claude_persistent_event_capacity_exceeded");
    }
    if (merged && previous) {
      session.events.delete(previous.sequence); session.replay.delete(previous.sequence);
      session.bytes -= released; session.replayBytes -= released;
      session.journalMessageBytes -= released; session.journalMessageCount--;
      event = merged;
    }
    session.events.set(event.sequence, event); session.bytes += size; this.#revision++;
    if (payload.kind === "message") {
      session.replay.set(event.sequence, event); session.replayBytes += size;
      session.journalMessageBytes += size; session.journalMessageCount++;
    }
    if (session.listener) session.offeredThrough = event.sequence;
    beforePublish?.(event);
    try { session.listener?.(event); } catch { this.#unlisten(session); }
    return event;
  }
  #removeReplay(session: Session, sequence: number): void {
    if (session.events.has(sequence)) return;
    const event = session.replay.get(sequence);
    if (!event) return;
    const message = replayMessage(event);
    const key = message && replayStateKey(message);
    if (key && session.replayStateSequences.get(key) === sequence) session.replayStateSequences.delete(key);
    if (["user", "assistant", "stream_event"].includes(String(replayMessage(event)?.type))) session.historyCandidatesDirty = true;
    session.replay.delete(sequence); session.replayBytes -= eventSize(event); this.#revision++;
  }
  #compactAcknowledged(session: Session, acknowledged: ClaudePersistentEvent): void {
    const message = replayMessage(acknowledged);
    if (!message || !session.replay.has(acknowledged.sequence)) return;
    if (acknowledged.payload.kind === "message" && acknowledged.payload.consumedTurnRootUuid) return;
    if (message.type === "user" || message.type === "assistant") session.historyCandidatesDirty = true;
    if (isTransientReplay(acknowledged) || (message.type === "system" && message.subtype === "commands_changed")) {
      this.#removeReplay(session, acknowledged.sequence);
      return;
    }
    if (message.type === "system") {
      // Preserve permission-mode evidence independently of plain status pulses,
      // and a running edge independently of a later idle pulse.
      const key = replayStateKey(message);
      if (key) {
        const previous = session.replayStateSequences.get(key);
        if (previous !== undefined && previous > acknowledged.sequence) this.#removeReplay(session, acknowledged.sequence);
        else {
          if (previous !== undefined) this.#removeReplay(session, previous);
          session.replayStateSequences.set(key, acknowledged.sequence);
        }
      }
      if (typeof message.task_id === "string" && ["task_started", "task_updated", "task_notification"].includes(String(message.subtype))) {
        const related = [...session.replay.values()].filter(event => {
          const candidate = replayMessage(event);
          return candidate?.type === "system" && candidate.task_id === message.task_id && ["task_started", "task_updated", "task_notification"].includes(String(candidate.subtype));
        });
        const settled = related.some(event => {
          const candidate = replayMessage(event)!;
          const patch = candidate.patch as { status?: string } | undefined;
          return candidate.subtype === "task_notification" || (candidate.subtype === "task_updated" && ["completed", "failed", "killed"].includes(patch?.status ?? ""));
        });
        if (settled && related.every(event => !session.events.has(event.sequence))) {
          for (const event of related) this.#removeReplay(session, event.sequence);
        }
      }
    }
    // Most ACKs are streaming deltas. Scan only after a stop has arrived and
    // an ACK can settle that group, including late ACKs of its originals.
    if (session.streamStopSequence && (acknowledged.sequence <= session.streamStopSequence || message.type === "assistant")) {
      for (const sequence of compactedStreamSequences(session.replay, session.events)) this.#removeReplay(session, sequence);
      session.streamStopSequence = 0;
      for (const event of session.replay.values()) {
        const candidate = replayMessage(event);
        if (candidate?.type === "stream_event" && (candidate.event as { type?: string })?.type === "message_stop") session.streamStopSequence = Math.max(session.streamStopSequence, event.sequence);
      }
    }
  }
  #cancelHistoryTimer(session: Session): void {
    if (session.historyTimer) clearTimeout(session.historyTimer);
    session.historyTimer = undefined;
    this.#historySweepQueue.delete(session);
  }
  #scheduleHistorySweep(session: Session): void {
    if (session.historySweep || session.historyTimer || this.#historySweepQueue.has(session) || !session.listener || session.epoch === undefined || session.failureCode || session.retiring || this.#closed || this.#frozen || this.#runtimeStopped) return;
    const highEntries = this.input.replayRetention?.highWaterEntries ?? 1024;
    const highBytes = this.input.replayRetention?.highWaterBytes ?? 8 * 1024 * 1024;
    if (session.replay.size >= highEntries || session.replayBytes >= highBytes) session.historyPressure = true;
    else if (session.replay.size <= highEntries / 2 && session.replayBytes <= highBytes / 2) session.historyPressure = false;
    if (!session.historyPressure) return;
    if (session.historyCandidatesDirty) {
      session.hasHistoryCandidates = historyCandidates(session.replay, session.events).length > 0;
      session.historyCandidatesDirty = false;
    }
    if (!session.hasHistoryCandidates) return;
    session.historyTimer = setTimeout(() => {
      session.historyTimer = undefined;
      this.#historySweepQueue.add(session);
      this.#drainHistorySweeps();
    }, Math.max(0, session.nextHistoryRead - Date.now()));
    session.historyTimer.unref();
  }
  #drainHistorySweeps(): void {
    if (this.#historySweepSession || this.#closed || this.#frozen || this.#runtimeStopped) return;
    for (const session of this.#historySweepQueue) {
      this.#historySweepQueue.delete(session);
      if (this.#sessions.get(session.id) !== session || !session.listener || session.epoch === undefined || session.failureCode || session.retiring) continue;
      this.#historySweepSession = session;
      session.historySweep = this.#reclaimHistory(session).finally(() => {
        session.historySweep = undefined;
        this.#historySweepSession = undefined;
        this.#scheduleHistorySweep(session);
        this.#drainHistorySweeps();
      });
      return;
    }
  }
  async #reclaimHistory(session: Session): Promise<void> {
    const candidates = historyCandidates(session.replay, session.events);
    const epoch = session.epoch, rewrite = session.rewriteGeneration;
    const interval = this.input.replayRetention?.minimumHistoryIntervalMs ?? 5_000;
    const isCurrent = () => this.#sessions.get(session.id) === session && session.epoch === epoch && !!session.listener && session.rewriteGeneration === rewrite &&
      !session.failureCode && !session.retiring && !this.#closed && !this.#frozen && !this.#runtimeStopped;
    let removed = 0;
    try {
      if (!candidates.length || !isCurrent()) return;
      const byUuid = new Map<string, ClaudePersistentEvent[]>();
      for (const event of candidates) {
        const uuid = replayMessage(event)!.uuid as string;
        const matches = byUuid.get(uuid) ?? [];
        matches.push(event); byUuid.set(uuid, matches);
      }
      const covered = new Set<ClaudePersistentEvent>();
      let authorityValid = true;
      for await (const page of iterateClaudeSessionHistory(
        options => this.input.client.getSessionMessagesPage(session.id, options, {}),
        { dir: session.cwd, includeSystemMessages: false, maintenance: true },
      )) {
        authorityValid &&= isCurrent();
        if (authorityValid) {
          for (const persisted of page.messages) {
            for (const candidate of byUuid.get(persisted.uuid) ?? []) {
              if (historyCovers(candidate, persisted)) covered.add(candidate);
            }
          }
        } else {
          // Finish draining this bounded worker snapshot so a replacement main
          // need not wait for its expiry. Lost authority can never become valid
          // again within this acquisition, even if another attach follows.
          covered.clear(); byUuid.clear();
        }
      }
      // A partial acquisition, including a history-change error on a later
      // page, proves nothing. Prune only after the complete read and fencing.
      if (!authorityValid || !isCurrent()) return;
      if (epoch === undefined) return;
      this.input.services.assertController(epoch);
      const eligible = new Set(historyCandidates(session.replay, session.events));
      for (const event of covered) {
        if (!eligible.has(event) || session.replay.get(event.sequence) !== event) continue;
        this.#removeReplay(session, event.sequence); removed++;
      }
    } catch {
      // A failed or oversized history read is not provider execution failure.
      // Exact unacknowledged originals and uncovered replay remain retained.
    } finally {
      session.historyBackoff = removed ? 0 : Math.min(Math.max(interval, session.historyBackoff * 2), 60_000);
      session.nextHistoryRead = Date.now() + Math.max(interval, session.historyBackoff);
    }
  }
  #canUseTool(getSession: () => Session): CanUseTool {
    return async (toolName, input, options) => {
      if (this.#abandoning) return { behavior: "deny", message: "The operator stopped this runtime.", toolUseID: options.toolUseID };
      const session = getSession();
      const key = permissionKey(options);
      const { signal, ...details } = options;
      let resolve!: (value: PermissionResult) => void;
      const promise = new Promise<PermissionResult>(yes => { resolve = yes; });
      const event = this.#event(session, { kind: "permission", request: {
        queryId: session.id, toolName, input,
        options: details,
      } } as ClaudePersistentEvent["payload"], false, event => {
        session.permissions.set(key, { event, resolve }); this.#revision++;
      });
      const abort = () => {
        const permission = session.permissions.get(key);
        if (permission) { permission.cancelled = true; this.#retirePermissionEvent(session, permission); this.#revision++; }
        resolve({ behavior: "deny", message: "Permission request cancelled.", toolUseID: options.toolUseID });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try { return await promise; }
      finally { signal.removeEventListener("abort", abort); }
    };
  }
  /** Work the provider is still doing or waiting on, as opposed to settled output. */
  #hasLiveWork(session: Session): boolean {
    return session.active.size > 0 || session.pendingInputs.size > 0 || session.providerState !== "idle" || session.permissions.size > 0 ||
      session.backgroundActivity.active || session.backgroundActivity.retirementBlocked;
  }
  #hasUnsettledOutcomes(session: Session): boolean {
    return [...session.events.values()].some(event => event.payload.kind !== "permission");
  }
  #retirePermissionEvent(session: Session, permission: Permission): void {
    if (session.events.delete(permission.event.sequence)) {
      session.bytes -= eventSize(permission.event); this.#revision++;
    }
  }
  #permissionDelivered(session: Session, identity: { requestId: string; toolUseID: string }, adopted: boolean): void {
    const key = permissionKey(identity);
    const permission = session.permissions.get(key);
    if (!permission) return;
    this.#retirePermissionEvent(session, permission);
    session.permissions.delete(key);
    if (!permission.response && (this.#closing || this.#runtimeStopped)) {
      // No main-owned answer exists to adopt. The deliberate native stop
      // cancels this unanswered interaction; spontaneous cancellation and
      // receipts for accepted answers retain their ordinary journal semantics.
      if (this.#closing) this.#shutdownCancellations.push({ session, requestId: identity.requestId, toolUseID: identity.toolUseID });
      this.#revision++;
      return;
    }
    this.#event(session, { kind: adopted && !permission.cancelled ? "permission_delivered" : "permission_failed", requestId: identity.requestId, toolUseID: identity.toolUseID });
  }
}
function isBackgroundInventory(event: ClaudePersistentEvent): boolean {
  return event.payload.kind === "message" && event.payload.message.type === "system" &&
    event.payload.message.subtype === "background_tasks_changed";
}
function permissionKey(identity: { requestId: string; toolUseID: string }): string { return JSON.stringify([identity.requestId, identity.toolUseID]); }
function eventSize(event: ClaudePersistentEvent): number { return Buffer.byteLength(JSON.stringify(event), "utf8"); }
/** Distinct retained events. An attachment offers at most this many, within
 * its 8,192-event wire bound (a reserved failure event may follow). */
export const CLAUDE_PERSISTENT_RETAINED_EVENT_LIMIT = 8190;
function retainedBytes(session: Session): number { return session.bytes + session.replayBytes - session.journalMessageBytes; }
function retainedCount(session: Session): number { return session.events.size + session.replay.size - session.journalMessageCount; }

/** Only plain delta frames fold before any main sees them. A consumption stamp,
 * time-to-first-token, or any unreviewed field keeps the frame exact. */
const plainStreamEventKeys = ["event", "parent_tool_use_id", "session_id", "type", "uuid"].join();
function coalesceUnofferedDelta(previous: ClaudePersistentEvent, current: ClaudePersistentEvent): ClaudePersistentEvent | undefined {
  if (previous.payload.kind !== "message" || current.payload.kind !== "message" || previous.payload.consumedTurnRootUuid || current.payload.consumedTurnRootUuid) return undefined;
  const keys = (value: unknown) => { const fields = object(value); return fields ? Object.keys(fields).sort().join() : undefined; };
  const plain = (value: unknown) => {
    const message = object(value); const frame = object(message?.event); const delta = object(frame?.delta);
    return keys(message) === plainStreamEventKeys && keys(frame) === "delta,index,type" && delta !== undefined && Object.keys(delta).length === 2;
  };
  if (!plain(previous.payload.message) || !plain(current.payload.message)) return undefined;
  return coalesceDelta(previous, current);
}

/** Merge only adjacent native delta fragments; lifecycle/index/type boundaries
 * remain ordered. Only acknowledged fragments merge. The journal retains original frames for a surviving
 * client, while a replacement main process hydrates this compact full replay. */
function coalesceDelta(previous: ClaudePersistentEvent, current: ClaudePersistentEvent): ClaudePersistentEvent | undefined {
  if (previous.payload.kind !== "message" || current.payload.kind !== "message") return undefined;
  const a = object(previous.payload.message); const b = object(current.payload.message);
  if (!a || !b) return undefined;
  if (a.type !== "stream_event" || b.type !== "stream_event" || a.parent_tool_use_id !== b.parent_tool_use_id) return undefined;
  const ae = object(a.event); const be = object(b.event);
  if (!ae || !be || ae.type !== "content_block_delta" || be.type !== ae.type || ae.index !== be.index) return undefined;
  const ad = object(ae.delta); const bd = object(be.delta);
  if (!ad || !bd || ad.type !== bd.type) return undefined;
  const field = ad.type === "text_delta" ? "text" : ad.type === "thinking_delta" ? "thinking" : ad.type === "input_json_delta" ? "partial_json" : ad.type === "signature_delta" ? "signature" : undefined;
  if (!field || typeof ad[field] !== "string" || typeof bd[field] !== "string") return undefined;
  return claudePersistentEventSchema.parse({ ...current, payload: { kind: "message", message: { ...b, event: { ...be, delta: { ...bd, [field]: ad[field] + bd[field] } } } } });
}
function object(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function queryAuthorityFingerprint(request: Extract<ClaudePersistentCommand, { action: "open" }>["request"]): string {
  return createHash("sha256").update(JSON.stringify({
    cwd: request.cwd, enableCanUseTool: request.enableCanUseTool,
    allowDangerouslySkipPermissions: request.allowDangerouslySkipPermissions ?? false,
    environment: request.environment,
    agentToolMcp: request.agentToolMcp ?? null,
  })).digest("hex");
}
