import { randomUUID } from "node:crypto";
import type { SpeedArguments, SpeedCurrentRunResult, SpeedRunTarget, SpeedState, SpeedSelection } from "../../../shared/provider-features/codex-speed.js";
import { codexBackendTurnId } from "./codex-history-projector.js";
import { applicationTurnIdForBackendTurn } from "../../conversations/conversation-projector.js";
import { DomainError } from "../../domain/errors.js";
import type { ConversationBinding } from "../contracts.js";
import type { ProviderFeatureCoordinator } from "../contracts.js";
import { codexThreadReadMethod, codexThreadResumeMethod } from "./codex-c1-protocol.js";
import { codexC2NotificationSchemas, codexThreadSettingsUpdateMethod } from "./codex-c2-protocol.js";
import { codexTurnSettingsUpdateMethod } from "./codex-active-speed-protocol.js";
import { codexSpeedPolicyAllows, type CodexFastModeSessionRegistry } from "./codex-fast-mode-session.js";
import type { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import type { CodexExecutionSettingsTuple } from "./codex-thread-execution-settings-repository.js";
import { encodeCodexServiceTier } from "./codex-service-tier.js";
import { CodexRpcDeliveryError, CodexRpcProtocolError, CodexRpcRemoteError } from "./rpc/errors.js";
import { deliveryDiagnosticsEnabled } from "../../diagnostics/delivery-diagnostic-output.js";
import { CodexSpeedDiagnostic, type CodexSpeedActivationLoss, type CodexSpeedEligibilityReason } from "./codex-speed-diagnostics.js";

const TIMEOUT = 10_000;
const FINISHED_TTL = 120_000;
export const CODEX_RECOVERY_GRACE_MS = 30_000;
export type CodexSpeedAdmission = "active" | "finished" | "idle";
export type CodexSpeedDefaultState = "unknown" | "deferred" | "confirmed" | "not_convergent";
type Activation = { target: SpeedRunTarget; nativeTurnId: string; generation: number;
  model: string; startingSelection: SpeedSelection; requestedSelection: SpeedSelection;
  publicationState: "initial" | "pending" | "published" | "unknown" };

/** One continuously owned handle. No inference counter or deferred turn-update queue. */
export class CodexSpeedSession {
  readonly #scope;
  readonly diagnosticHandleId = randomUUID();
  readonly #diagnostic = new CodexSpeedDiagnostic();
  #activationLoss: CodexSpeedActivationLoss = "new_handle";
  #activation: Activation | undefined;
  // Native idle may arrive before turn/completed. Retain its exact identity
  // for the completion proof without retaining active publication authority.
  #awaitingCompletion: Activation | undefined;
  #finished: { activation: Activation; expiresAt: number } | undefined;
  #negativeGeneration: number | undefined;
  #uncertainContinuity: string | undefined;
  #coordinator: ProviderFeatureCoordinator | undefined;
  #unsubscribeIdle: (() => void) | undefined;
  #idleChanged = false;
  #goalChanged = false;
  #observedGoalKey: string | undefined;
  #scheduled = false;
  #closed = false;
  #publishedRun: string;
  #defaultAttemptKey: string | undefined;
  #confirmedDefaultKey: string | undefined;
  #interruptedTurn: string | undefined;
  #recoveryGraceUntil = 0;
  #observedGeneration = 0;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;
  defaultState: CodexSpeedDefaultState = "unknown";

  constructor(readonly input: {
    binding: ConversationBinding;
    client: CodexSharedClientFacade;
    policy: CodexFastModeSessionRegistry;
    goals?: CodexGoalSessionRegistry;
    desired(): { settings: CodexExecutionSettingsTuple | null; revision: number };
    nativeControl(): { generation: number; turnId: string | null } | undefined;
    managedTui(): boolean;
    validateSelection(settings: CodexExecutionSettingsTuple): Promise<void>;
    assertPolicy(settings: CodexExecutionSettingsTuple): void;
    confirmDefaults(response: Awaited<ReturnType<typeof codexThreadResumeMethod.decodeResult>>, generation: number): void;
    withManagedTuiLock(operation: () => Promise<void>): Promise<void>;
    verifyManagedTui(settings: CodexExecutionSettingsTuple): Promise<void>;
    changed(): void;
    now?: () => number;
  }) {
    this.#scope = { tenantId: input.binding.tenantId, principalId: input.binding.ownerPrincipalId };
    this.#publishedRun = JSON.stringify(this.currentRun());
  }
  #changed(): void {
    const current = JSON.stringify(this.currentRun());
    if (current === this.#publishedRun) return;
    this.#publishedRun = current;
    this.input.changed();
  }

  publicationChanged(): void { if (!this.#closed) this.input.changed(); }
  setCoordinator(coordinator: ProviderFeatureCoordinator): void {
    this.#unsubscribeIdle?.();
    this.#coordinator = coordinator;
    this.#unsubscribeIdle = coordinator.subscribeIdle(() => {
      this.#idleChanged = true;
      this.scheduleDefaults();
    });
    this.scheduleDefaults();
  }
  #now(): number { return this.input.now?.() ?? performance.now(); }
  #ready(generation: number): boolean {
    const current = this.input.client.lifecycleSnapshot();
    return !this.#closed && current.state === "ready" && current.generation === generation;
  }
  #eligible(activation: Activation): boolean {
    return this.#ineligibleReason(activation) === undefined;
  }
  #ineligibleReason(activation: Activation): CodexSpeedEligibilityReason | undefined {
    const lifecycle = this.input.client.lifecycleSnapshot();
    const desired = this.input.desired().settings;
    const control = this.input.nativeControl();
    const policy = this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId);
    if (this.#closed) return "closed";
    if (lifecycle.state !== "ready") return "connection_not_ready";
    if (lifecycle.generation !== activation.generation) return "activation_generation_changed";
    if (!control) return "native_control_missing";
    if (control.generation !== activation.generation) return "native_generation_changed";
    if (control.turnId !== activation.nativeTurnId) return "native_turn_changed";
    if (desired?.model !== activation.model) return "desired_model_changed";
    if (this.input.managedTui()) return "managed_tui";
    if (policy?.stepSwitchingEnabled !== true) return "step_switching_disabled";
    if (this.#negativeGeneration === activation.generation) return "step_switching_rejected";
    if (this.#uncertainContinuity !== undefined && this.#uncertainContinuity !== this.input.client.dispatchContinuity()) return "uncertain_connection_changed";
    return undefined;
  }
  #diagnose(): void {
    if (!deliveryDiagnosticsEnabled()) return;
    try {
      const lifecycle = this.input.client.lifecycleSnapshot();
      const activation = this.#activation;
      const control = this.input.nativeControl();
      const policy = this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId);
      const reason: CodexSpeedEligibilityReason = this.#closed ? "closed" :
        lifecycle.state !== "ready" ? "connection_not_ready" :
        control?.turnId === null && control.generation === lifecycle.generation ? "native_idle" :
        activation ? this.#ineligibleReason(activation) ?? "eligible" : "no_activation";
      this.#diagnostic.record("codex_speed_eligibility", {
        applicationThreadId: this.input.binding.applicationThreadId, backendInstanceId: this.input.binding.backendInstanceId,
        handleId: this.diagnosticHandleId, generation: lifecycle.generation, lifecycle: lifecycle.state, reason,
        applicationTurnId: activation?.target.turnId ?? null, activationId: activation?.target.activationId ?? null,
        activationGeneration: activation?.generation ?? null, activationPresent: activation !== undefined,
        activationLoss: activation ? null : this.#activationLoss,
        nativeControlGeneration: control?.generation ?? null,
        nativeControlApplicationTurnId: control?.turnId ? applicationTurnIdForBackendTurn({
          backendInstanceId: this.input.binding.backendInstanceId, sourceApplicationThreadId: this.input.binding.applicationThreadId,
          backendTurnId: codexBackendTurnId(this.input.binding.backendConversationId, control.turnId) }) : null,
        nativeTurnMatches: activation !== undefined && control?.turnId === activation.nativeTurnId,
        desiredModelMatches: activation !== undefined && this.input.desired().settings?.model === activation.model,
        managedTui: this.input.managedTui(), policyAvailability: policy?.availability ?? "missing",
        stepSwitchingEnabled: policy?.stepSwitchingEnabled === true,
        uncertainContinuityMatches: this.#uncertainContinuity === undefined || this.#uncertainContinuity === this.input.client.dispatchContinuity(),
      });
    } catch { /* Optional logging cannot affect current-run authority. */ }
  }
  currentRun(): SpeedState["currentRun"] {
    this.#diagnose();
    const activation = this.#activation;
    const currentControl = this.input.nativeControl();
    if (currentControl?.turnId === null && this.#ready(currentControl.generation)) return null;
    if (activation && this.#ready(activation.generation)) {
      return { target: this.#eligible(activation) ? activation.target : null,
        startingSelection: activation.startingSelection,
        requestedSelection: activation.requestedSelection, publicationState: activation.publicationState };
    }
    const control = this.input.nativeControl();
    if (control && this.#ready(control.generation) && control.turnId === null) return null;
    return { target: null, startingSelection: null, requestedSelection: null, publicationState: "unknown" };
  }
  started(generation: number, nativeTurnId: string, settings: CodexExecutionSettingsTuple): void {
    this.#finished = undefined;
    this.#awaitingCompletion = undefined;
    this.#uncertainContinuity = undefined;
    this.#activation = {
      target: { turnId: applicationTurnIdForBackendTurn({ backendInstanceId: this.input.binding.backendInstanceId,
        sourceApplicationThreadId: this.input.binding.applicationThreadId, backendTurnId: codexBackendTurnId(this.input.binding.backendConversationId, nativeTurnId) }), activationId: randomUUID() },
      nativeTurnId, generation, model: settings.model, startingSelection: settings.serviceTier,
      requestedSelection: settings.serviceTier, publicationState: "initial",
    };
    this.#changed();
  }
  observedStart(nativeTurnId: string): void {
    const owned = !!this.#activation;
    this.#awaitingCompletion = undefined;
    if (this.#activation?.nativeTurnId !== nativeTurnId) { this.#activation = undefined; this.#activationLoss = "other_turn"; }
    this.#finished = undefined;
    if (this.#interruptedTurn === nativeTurnId) this.#clearGrace();
    if (owned) this.#changed();
    this.#diagnose();
  }
  completed(nativeTurnId: string): void {
    const owned = !!this.#activation;
    const completed = this.#activation?.nativeTurnId === nativeTurnId ? this.#activation :
      this.#awaitingCompletion?.nativeTurnId === nativeTurnId ? this.#awaitingCompletion : undefined;
    if (completed) {
      this.#finished = { activation: completed, expiresAt: this.#now() + FINISHED_TTL };
      if (completed === this.#activation) this.#activation = undefined;
      this.#activationLoss = "completed";
      this.#awaitingCompletion = undefined;
    }
    if (this.#interruptedTurn === nativeTurnId) this.#clearGrace();
    if (owned) this.#changed();
    this.#diagnose();
    this.scheduleDefaults();
  }
  observedIdle(): void {
    const owned = !!this.#activation;
    if (this.#activation) this.#awaitingCompletion = this.#activation;
    this.#activation = undefined;
    this.#activationLoss = "native_idle";
    if (owned) this.#changed();
    this.#diagnose();
    this.scheduleDefaults();
  }
  invalidate(): void { const owned = !!this.#activation; this.#activation = undefined; this.#activationLoss = "invalidated"; this.#awaitingCompletion = undefined; this.#finished = undefined; if (owned) this.#changed(); this.#diagnose(); }
  rerouted(nativeTurnId: string): void {
    if (this.#activation?.nativeTurnId === nativeTurnId) { this.#activation = undefined; this.#activationLoss = "rerouted"; this.#changed(); }
  }
  lifecycle(): void {
    const lifecycle = this.input.client.lifecycleSnapshot();
    const control = this.input.nativeControl();
    if (control?.turnId && (lifecycle.state !== "ready" || control.generation !== lifecycle.generation)) {
      this.#interruptedTurn = control.turnId;
    }
    if (this.#activation && !this.#ready(this.#activation.generation)) {
      this.#interruptedTurn = this.#activation.nativeTurnId;
      this.#activation = undefined;
      this.#activationLoss = "connection_changed";
    }
    if (lifecycle.state !== "ready" || lifecycle.generation !== this.#observedGeneration) {
      this.#finished = undefined;
      this.#awaitingCompletion = undefined;
      this.defaultState = "unknown";
    }
    if (lifecycle.state === "ready" && lifecycle.generation !== this.#observedGeneration) {
      this.#observedGeneration = lifecycle.generation;
      if (this.#interruptedTurn) {
        this.#recoveryGraceUntil = this.#now() + CODEX_RECOVERY_GRACE_MS;
        clearTimeout(this.#graceTimer);
        this.#graceTimer = setTimeout(() => { this.#clearGrace(); this.scheduleDefaults(); }, CODEX_RECOVERY_GRACE_MS);
        this.#graceTimer.unref?.();
      }
    }
    this.#diagnose();
    this.scheduleDefaults();
  }
  #clearGrace(): void { this.#interruptedTurn = undefined; this.#recoveryGraceUntil = 0; clearTimeout(this.#graceTimer); }

  hasActiveNativeTurn(): boolean {
    const control = this.input.nativeControl();
    return !!control?.turnId && this.#ready(control.generation);
  }
  isIdleForGoalStart(): boolean {
    const control = this.input.nativeControl();
    return !!this.#coordinator?.isIdle() && control?.turnId === null && this.#ready(control.generation);
  }

  async prepare(selection: SpeedSelection): Promise<void> {
    const desired = this.input.desired().settings;
    if (!desired) throw unavailable();
    await this.input.validateSelection({ ...desired, serviceTier: selection });
  }
  /** Called synchronously immediately before the local transaction. */
  admit(argumentsValue: SpeedArguments, backendTurnId: string | undefined, actorIdle: boolean): CodexSpeedAdmission {
    const desired = this.input.desired().settings;
    if (!desired) throw unavailable();
    this.input.assertPolicy({ ...desired, serviceTier: argumentsValue.selection });
    if (!codexSpeedPolicyAllows(this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId), argumentsValue.selection)) throw unavailable();
    if (argumentsValue.currentRunTarget === null) {
      const control = this.input.nativeControl();
      if (actorIdle && control?.turnId === null && this.#ready(control.generation)) return "idle";
      throw stale();
    }
    const same = (activation: Activation) => activation.target.turnId === argumentsValue.currentRunTarget!.turnId &&
      activation.target.activationId === argumentsValue.currentRunTarget!.activationId && codexBackendTurnId(this.input.binding.backendConversationId, activation.nativeTurnId) === backendTurnId;
    if (this.#activation && same(this.#activation) && this.#eligible(this.#activation)) return "active";
    if (actorIdle && this.#finished && this.#now() <= this.#finished.expiresAt && same(this.#finished.activation) &&
      this.#ready(this.#finished.activation.generation) && !this.#activation) return "finished";
    throw stale();
  }

  async publish(input: { arguments: SpeedArguments; backendTurnId: string; operationId: string;
    dispatching(continuity: string): void }): Promise<SpeedCurrentRunResult> {
    const target = input.arguments.currentRunTarget!;
    const selection = input.arguments.selection;
    const attempt = { target, selection };
    const activation = this.#activation;
    if (!activation || activation.target.activationId !== target.activationId || codexBackendTurnId(this.input.binding.backendConversationId, activation.nativeTurnId) !== input.backendTurnId) {
      if (this.#finished?.activation.target.activationId === target.activationId) return { status: "target_finished", ...attempt };
      return { status: "not_attempted", reason: "ownership_changed", ...attempt };
    }
    if (!this.#ready(activation.generation)) return { status: "not_attempted", reason: "connection_changed", ...attempt };
    if (this.#uncertainContinuity !== undefined && this.#uncertainContinuity !== this.input.client.dispatchContinuity()) {
      return { status: "not_attempted", reason: "connection_changed", ...attempt };
    }
    if (!this.#eligible(activation)) return { status: "not_attempted", reason:
      this.input.desired().settings?.model !== activation.model ||
      !this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId)?.stepSwitchingEnabled ||
      this.#negativeGeneration === activation.generation ? "unsupported_model" : "ownership_changed", ...attempt };
    const desired = this.input.desired().settings;
    if (!desired || !codexSpeedPolicyAllows(this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId), selection))
      return { status: "not_attempted", reason: "unsupported_model", ...attempt };
    try { this.input.assertPolicy({ ...desired, serviceTier: selection }); } catch {
      return { status: "not_attempted", reason: "unsupported_model", ...attempt };
    }
    const continuity = this.input.client.dispatchContinuity();
    input.dispatching(continuity);
    const previous = { requestedSelection: activation.requestedSelection, publicationState: activation.publicationState };
    activation.publicationState = "pending";
    this.#changed();
    let result: SpeedCurrentRunResult;
    try {
      const response = await this.input.client.requestWithReceipt(codexTurnSettingsUpdateMethod, {
        threadId: this.input.binding.backendConversationId, turnId: activation.nativeTurnId, serviceTier: encodeCodexServiceTier(selection),
      }, { timeoutMilliseconds: TIMEOUT, runtimeCorrelation: { kind: "speed", applicationThreadId: this.input.binding.applicationThreadId, applicationOperationId: input.operationId } });
      result = response.generation !== activation.generation
        ? { status: "uncertain", reason: "generation_changed", ...attempt }
        : { status: response.result.status === "applied" ? "published" : "target_finished", ...attempt };
    } catch (error) {
      if (error instanceof CodexRpcRemoteError) {
        const disabled = error.code === -32600 && error.message === "turn settings updates require the step_model_switching feature";
        if (disabled) this.#negativeGeneration = activation.generation;
        result = { status: "rejected", reason: disabled ? "not_enabled" : "provider_rejected", ...attempt,
          message: { text: disabled ? "This loaded Codex session does not enable active Speed changes." : "Codex rejected the requested Speed change." } };
      } else if (error instanceof CodexRpcDeliveryError && error.delivery === "not_sent") {
        result = { status: "not_attempted", reason: "connection_changed", ...attempt };
      } else {
        result = { status: "uncertain", reason: error instanceof CodexRpcProtocolError ? "invalid_response" : "response_lost", ...attempt };
      }
    }
    if (result.status === "uncertain") this.#uncertainContinuity = continuity;
    if (this.#activation === activation) {
      if (result.status === "published") { activation.requestedSelection = selection; activation.publicationState = "published"; }
      else if (result.status === "uncertain") activation.publicationState = "unknown";
      else Object.assign(activation, previous);
    }
    this.#changed();
    return result;
  }

  /** Goal snapshots also follow our own metadata resumes. Only a change in
   * synchronization eligibility can request another pass, even if a different
   * reader already published it to the shared Goal store. */
  goalProjectionSettled(): void {
    if (this.#closed) return;
    const key = this.#goalObservationKey();
    if (key === this.#observedGoalKey) return;
    this.#observedGoalKey = key;
    this.#goalChanged = true;
    this.scheduleDefaults();
  }
  #goalObservationKey(): string {
    const goal = this.input.goals?.projection(this.#scope, this.input.binding.applicationThreadId);
    return JSON.stringify([goal?.nativeThreadId, goal?.connectionGeneration,
      goal?.availability, goal?.disabled === true, goal?.state.state,
      goal?.state.state === "set" ? goal.state.status : null]);
  }

  scheduleDefaults(): void {
    if (this.#closed || this.#scheduled || !this.#coordinator) return;
    this.#scheduled = true;
    this.#idleChanged = false;
    this.#goalChanged = false;
    const before = this.#defaultAuthorityKey();
    void this.#coordinator.run(async () => { await this.syncDefaults(); }).catch(() => undefined).finally(() => {
      this.#scheduled = false;
      // Coalesce our own notifications, but never lose a newer desired choice.
      if (!this.#closed && (this.#idleChanged || this.#goalChanged || this.#defaultAuthorityKey() !== before)) this.scheduleDefaults();
    });
  }
  #defaultAuthorityKey(): string {
    const policy = this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId);
    return JSON.stringify([this.input.desired().revision, this.input.client.lifecycleSnapshot(),
      policy?.fastEnabled, policy?.ultrafastEnabled, policy?.availability]);
  }
  async syncDefaults(): Promise<CodexSpeedDefaultState> {
    // A prior confirmation never authorizes an action after an incomplete read.
    this.defaultState = "unknown";
    const state = await this.#syncDefaults();
    this.defaultState = state;
    return state;
  }
  async #syncDefaults(): Promise<CodexSpeedDefaultState> {
    const coordinator = this.#coordinator;
    const lifecycle = this.input.client.lifecycleSnapshot();
    if (this.#recoveryGraceUntil > 0 && this.#now() >= this.#recoveryGraceUntil) this.#clearGrace();
    const idle = () => !!coordinator?.isIdle() && this.#ready(lifecycle.generation) &&
      this.input.nativeControl()?.generation === lifecycle.generation && this.input.nativeControl()?.turnId === null &&
      this.#now() >= this.#recoveryGraceUntil;
    if (!idle()) return "deferred";
    const desired = this.input.desired();
    if (!desired.settings) return "unknown";
    const policy = this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId);
    if (!codexSpeedPolicyAllows(policy, desired.settings.serviceTier)) return "deferred";
    const goals = await this.input.goals?.refresh({ scope: this.#scope, applicationThreadId: this.input.binding.applicationThreadId,
      nativeThreadId: this.input.binding.backendConversationId, connectionGeneration: lifecycle.generation, client: this.input.client });
    // Seed the resume-echo baseline from the current shared observation, without
    // consuming any external change that arrived while this pass was running.
    this.#observedGoalKey = this.#goalObservationKey();
    const goalIdle = () => {
      const current = this.input.goals?.projection(this.#scope, this.input.binding.applicationThreadId);
      return current?.connectionGeneration === lifecycle.generation &&
        ((current.availability === "available" && (current.state.state === "unset" ||
          (current.state.state === "set" && current.state.status !== "active"))) || current.disabled === true);
    };
    if (!goals || !goalIdle() || !idle()) return "deferred";
    const read = await this.input.client.requestWithReceipt(codexThreadReadMethod,
      { threadId: this.input.binding.backendConversationId, includeTurns: false }, { timeoutMilliseconds: TIMEOUT });
    if (read.generation !== lifecycle.generation || read.result.thread.status.type !== "idle" || !idle() || !goalIdle()) {
      return "deferred";
    }
    const latest = this.input.desired();
    if (latest.revision !== desired.revision || !latest.settings) { this.scheduleDefaults(); return "unknown"; }
    const settings = latest.settings;
    const key = JSON.stringify([latest.revision, lifecycle.generation, policy?.fastEnabled, policy?.ultrafastEnabled, policy?.availability]);
    // Only an explicit native tier confirms the saved selection. An unset
    // tier cannot establish the complete tuple required by fork or managed TUI.
    // Already matching defaults do not consume the one-write budget.
    const observed = await this.input.client.requestWithReceipt(codexThreadResumeMethod,
      { threadId: this.input.binding.backendConversationId, excludeTurns: true }, { timeoutMilliseconds: TIMEOUT });
    const stillAdmitted = () => {
      const currentPolicy = this.input.policy.projection(this.#scope, this.input.binding.applicationThreadId);
      return idle() && goalIdle() && this.input.desired().revision === latest.revision &&
        codexSpeedPolicyAllows(currentPolicy, settings.serviceTier) &&
        JSON.stringify([currentPolicy?.fastEnabled, currentPolicy?.ultrafastEnabled, currentPolicy?.availability]) ===
        JSON.stringify([policy?.fastEnabled, policy?.ultrafastEnabled, policy?.availability]);
    };
    if (observed.generation !== lifecycle.generation || !stillAdmitted()) return "unknown";
    if (observed.result.serviceTier === encodeCodexServiceTier(settings.serviceTier)) {
      // Ordinary notifications must not hold TUI input or re-verify its tuple.
      // A new saved choice still requires one verified handoff if a TUI exists.
      if (this.input.managedTui() && this.#confirmedDefaultKey !== key) {
        let verified = false;
        await this.input.withManagedTuiLock(async () => {
          if (!stillAdmitted()) return;
          await this.input.verifyManagedTui(settings);
          verified = stillAdmitted();
        });
        if (!verified) return "unknown";
      }
      this.input.confirmDefaults(observed.result, observed.generation);
      this.#confirmedDefaultKey = key;
      return "confirmed";
    }
    if (this.#defaultAttemptKey === key) {
      // A failed or interrupted handoff can consume the write budget before
      // TUI verification. Once idle again, fail a still-mismatched TUI under
      // its settings hold without granting another native write.
      if (this.input.managedTui()) {
        let verified = false;
        await this.input.withManagedTuiLock(async () => {
          if (!stillAdmitted()) return;
          await this.input.verifyManagedTui(settings);
          verified = stillAdmitted();
        });
        if (!verified) return "unknown";
      }
      return "not_convergent";
    }
    this.input.assertPolicy(settings);
    // A tier-only write also has to be supported by the loaded native model.
    const nativeSettings = { ...settings, model: observed.result.model, reasoningEffort: observed.result.reasoningEffort ?? settings.reasoningEffort };
    this.input.assertPolicy(nativeSettings);
    await this.input.validateSelection(nativeSettings);
    if (!stillAdmitted()) return "unknown";
    let outcome: CodexSpeedDefaultState = "unknown";
    await this.input.withManagedTuiLock(async () => {
    if (!stillAdmitted()) return;
    this.#defaultAttemptKey = key;
    let notificationTimer: ReturnType<typeof setTimeout> | undefined;
    let signalConfirmation!: () => void;
    let rejectConfirmation!: (error: Error) => void;
    const notificationConfirmation = new Promise<void>((resolve, reject) => {
      signalConfirmation = resolve; rejectConfirmation = reject;
    });
    void notificationConfirmation.catch(() => {});
    const unsubscribe = this.input.client.subscribeNotifications(notification => {
      if (notification.generation !== lifecycle.generation || notification.method !== "thread/settings/updated") return;
      if (notification.kind !== "decoded_notification") return;
      try {
        const parsed = codexC2NotificationSchemas["thread/settings/updated"].parse(notification.params);
        if (parsed.threadId === this.input.binding.backendConversationId &&
            parsed.threadSettings.serviceTier === encodeCodexServiceTier(settings.serviceTier)) signalConfirmation();
      } catch { /* Invalid notifications cannot confirm an idle settings write. */ }
    });
    try {
      const result = await this.input.client.requestWithReceipt(codexThreadSettingsUpdateMethod,
        { threadId: this.input.binding.backendConversationId, serviceTier: encodeCodexServiceTier(settings.serviceTier) }, { timeoutMilliseconds: TIMEOUT });
      if (result.generation !== lifecycle.generation || !stillAdmitted()) return;
      let confirmed = await this.input.client.requestWithReceipt(codexThreadResumeMethod,
        { threadId: this.input.binding.backendConversationId, excludeTurns: true }, { timeoutMilliseconds: TIMEOUT });
      if (confirmed.generation !== lifecycle.generation || !stillAdmitted()) return;
      const matches = () => confirmed.result.serviceTier === encodeCodexServiceTier(settings.serviceTier);
      if (!matches()) {
        notificationTimer = setTimeout(() => rejectConfirmation(new Error("codex_speed_default_confirmation_timeout")), TIMEOUT);
        notificationTimer.unref?.();
        await notificationConfirmation;
        if (!stillAdmitted()) return;
        confirmed = await this.input.client.requestWithReceipt(codexThreadResumeMethod,
          { threadId: this.input.binding.backendConversationId, excludeTurns: true }, { timeoutMilliseconds: TIMEOUT });
        if (confirmed.generation !== lifecycle.generation || !stillAdmitted()) return;
      }
      outcome = confirmed.result.serviceTier === encodeCodexServiceTier(settings.serviceTier) ? "confirmed" : "not_convergent";
      if (outcome === "confirmed") {
        this.input.confirmDefaults(confirmed.result, confirmed.generation);
        this.#confirmedDefaultKey = key;
      }
    } catch { outcome = "not_convergent"; }
    finally {
      clearTimeout(notificationTimer); unsubscribe();
      // Verify only an admitted handoff; active/deferred notifications never
      // take the hold, and never fail a TUI for its own settings changes.
      if (stillAdmitted()) await this.input.verifyManagedTui(settings);
    }
    });
    this.#changed();
    return outcome;
  }
  close(): void { this.#closed = true; this.#diagnose(); this.#unsubscribeIdle?.(); this.#activation = undefined; this.#awaitingCompletion = undefined; this.#finished = undefined; clearTimeout(this.#graceTimer); }
}
function stale(): DomainError { return new DomainError("conflict", "The turn changed before Speed could be saved. Refresh and choose again."); }
function unavailable(): DomainError { return new DomainError("invalid_transition", "The selected Speed is unavailable for this Codex model or session."); }
