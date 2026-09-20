import { BackendError } from "../backends/contracts.js";
import type { AutomationRepository } from "../db/repositories/automation-repository.js";
import type { AutomationService } from "../domain/automation-service.js";
import { DomainError } from "../domain/errors.js";
import type {
  AutomationRunRecord,
  AutomationRunState,
} from "../domain/automation-models.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { AutomationConversationGateway } from "./automation-conversation-gateway.js";
import type { AutomationPrecheckExecutor } from "./automation-precheck-executor.js";

const UNCERTAIN_CODE = "automation_dispatch_uncertain";
const MAX_CONCURRENT_DISPATCHES = 4;

type DispatcherRepository = Pick<
  AutomationRepository,
  | "beginPrecheck"
  | "finishPrecheckWithoutDispatch"
  | "getDefinition"
  | "getRun"
  | "markRunUncertainAndPause"
  | "passPrecheck"
  | "updateRunState"
>;

type DispatcherInventory = Pick<InventoryRepository, "getThread">;
type DispatcherPublisher = Pick<
  AutomationService,
  "dispatchCapacityChanged" | "publishRun"
>;
type DispatcherPrechecks = Pick<AutomationPrecheckExecutor, "execute">;

export interface AutomationDispatcherDependencies {
  readonly repository: DispatcherRepository;
  readonly gateway: AutomationConversationGateway;
  readonly inventory: DispatcherInventory;
  readonly service: DispatcherPublisher;
  readonly prechecks: DispatcherPrechecks;
  readonly now?: () => number;
}

/**
 * Moves a durable automation claim across the backend submission boundary.
 *
 * One dispatcher instance must be shared by the service so concurrent HTTP and
 * scheduler replays can join the same in-flight operation.
 */
export class AutomationDispatcher {
  readonly #repository: DispatcherRepository;
  readonly #gateway: AutomationConversationGateway;
  readonly #inventory: DispatcherInventory;
  readonly #service: DispatcherPublisher;
  readonly #prechecks: DispatcherPrechecks;
  readonly #now: () => number;
  readonly #inFlight = new Map<string, Promise<AutomationRunRecord>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #queue: Array<{
    readonly signal: AbortSignal;
    readonly operation: () => Promise<AutomationRunRecord>;
    readonly resolve: (run: AutomationRunRecord) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #activeCount = 0;
  #disposed = false;

  constructor(dependencies: AutomationDispatcherDependencies) {
    this.#repository = dependencies.repository;
    this.#gateway = dependencies.gateway;
    this.#inventory = dependencies.inventory;
    this.#service = dependencies.service;
    this.#prechecks = dependencies.prechecks;
    this.#now = dependencies.now ?? Date.now;
  }

  dispatch(run: AutomationRunRecord): Promise<AutomationRunRecord> {
    const key = runKey(run);
    const active = this.#inFlight.get(key);
    if (active) return active;
    if (this.#disposed) {
      return Promise.reject(
        new DomainError(
          "runtime_unavailable",
          "The automation dispatcher is shutting down.",
          true,
        ),
      );
    }

    const controller = new AbortController();
    this.#controllers.set(key, controller);
    const operation = this.#enqueue(
      () => this.#dispatchOnce(run, controller.signal),
      controller.signal,
    ).finally(() => {
      if (this.#inFlight.get(key) === operation) {
        this.#inFlight.delete(key);
      }
      this.#controllers.delete(key);
    });
    this.#inFlight.set(key, operation);
    return operation;
  }

  availableCapacity(): number {
    return Math.max(
      0,
      MAX_CONCURRENT_DISPATCHES - this.#activeCount - this.#queue.length,
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    this.#pump();
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async #dispatchOnce(
    input: AutomationRunRecord,
    signal: AbortSignal,
  ): Promise<AutomationRunRecord> {
    const scope = runScope(input);
    let run = this.#repository.getRun(scope, input.automationId, input.id);

    if (isTerminal(run.state) || run.state === "uncertain") {
      return run;
    }
    if (run.state === "queued" || run.state === "running") {
      // Queue admission is not backend acceptance. The queue observer owns
      // completion after its durable input has actually been accepted.
      return run;
    }
    const recoveringForkDispatch =
      run.state === "dispatching" && run.runMode === "clone";
    if (run.state === "dispatching" && !recoveringForkDispatch) {
      return this.#recordUncertain(
        scope,
        run,
        "A prior dispatcher crossed its durable submission boundary; the prompt was not repeated.",
      );
    }

    try {
      if (!recoveringForkDispatch) {
        run = await this.#applyPrecheckAndSnoozeGate(scope, run, signal);
        if (isTerminal(run.state) || run.state === "uncertain") {
          return run;
        }

        run = this.#repository.updateRunState(scope, run.automationId, run.id, {
          expectedState: "claimed",
          state: "dispatching",
          claimToken: requiredClaimToken(run),
          retainPromptSnapshot: true,
          now: this.#now(),
        });
        this.#service.publishRun(scope, run);
      }

      const dispatched = await this.#gateway.dispatch({
        scope,
        automationId: run.automationId,
        automationRunId: run.id,
        anchorThreadId: run.anchorThreadId,
        runMode: run.runMode,
        prompt: requiredPrompt(run),
        dispatchMutationId: run.dispatchMutationId,
      });
      if (
        run.runMode === "same_thread" &&
        dispatched.targetThreadId !== run.anchorThreadId
      ) {
        throw new Error("automation_same_thread_target_mismatch");
      }

      if (dispatched.status === "uncertain") {
        return this.#recordUncertain(scope, run, dispatched.diagnostic);
      }
      if (dispatched.status === "accepted") {
        return this.#completeAcceptedRun(scope, run);
      }
      const accepted = this.#repository.updateRunState(
        scope,
        run.automationId,
        run.id,
        {
          expectedState: "dispatching",
          state: dispatched.status,
          claimToken: requiredClaimToken(run),
          retainPromptSnapshot: true,
          now: this.#now(),
        },
      );
      this.#service.publishRun(scope, accepted);
      return accepted;
    } catch (error) {
      return this.#recordDispatchError(scope, run, error);
    }
  }

  async #applyPrecheckAndSnoozeGate(
    scope: RequestScope,
    initial: AutomationRunRecord,
    signal: AbortSignal,
  ): Promise<AutomationRunRecord> {
    let run = initial;
    const anchor = this.#inventory.getThread(scope, run.anchorThreadId);
    if (anchor.inventory.inventoryState === "archived") {
      throw new DomainError(
        "archived_thread",
        "An archived thread cannot run an automation.",
      );
    }
    if (this.#scheduledSnoozeApplies(scope, run)) {
      return this.#skipForSnooze(scope, run);
    }
    if (run.precheckStatus === "pending") {
      run = this.#repository.beginPrecheck(scope, run.automationId, run.id, {
        claimToken: requiredClaimToken(run),
        now: this.#now(),
      });
      this.#service.publishRun(scope, run);
      const checked = await this.#prechecks.execute({
        scope,
        threadId: run.anchorThreadId,
        prompt: requiredPrompt(run),
        precheck: {
          command: requiredPrecheckCommand(run),
          timeoutSeconds: requiredPrecheckTimeout(run),
          includeStdout: run.precheckIncludeStdout ?? false,
        },
        signal,
      });
      if (checked.result.decision === "invoke") {
        run = this.#repository.passPrecheck(scope, run.automationId, run.id, {
          claimToken: requiredClaimToken(run),
          effectivePrompt: checked.result.effectivePrompt,
          stdoutIncluded: checked.result.stdoutIncluded,
          durationMilliseconds: checked.result.durationMilliseconds,
          stdoutBytes: checked.result.stdoutBytes,
          exitCode: 0,
          now: this.#now(),
        });
      } else {
        run = this.#repository.finishPrecheckWithoutDispatch(
          scope,
          run.automationId,
          run.id,
          {
            claimToken: requiredClaimToken(run),
            decision: checked.result.decision === "skip" ? "skipped" : "failed",
            errorCode:
              checked.result.decision === "skip"
                ? "automation_precheck_nonzero"
                : checked.result.diagnosticCode,
            errorDiagnostic:
              checked.result.decision === "skip"
                ? `The pre-check exited with status ${checked.result.exitCode}; the agent was not invoked.`
                : checked.result.diagnostic,
            durationMilliseconds: checked.result.durationMilliseconds,
            stdoutBytes: checked.result.stdoutBytes,
            ...("exitCode" in checked.result
              ? { exitCode: checked.result.exitCode }
              : {}),
            now: this.#now(),
            detachDefinition: this.#isOneShot(scope, run),
          },
        );
      }
      this.#service.publishRun(scope, run);
    } else if (run.precheckStatus === "checking") {
      throw new DomainError(
        "conflict",
        "The automation pre-check is already running.",
        true,
      );
    }
    if (run.state === "claimed" && this.#scheduledSnoozeApplies(scope, run)) {
      return this.#skipForSnooze(scope, run);
    }
    return run;
  }

  #enqueue(
    operation: () => Promise<AutomationRunRecord>,
    signal: AbortSignal,
  ): Promise<AutomationRunRecord> {
    const queued = new Promise<AutomationRunRecord>((resolve, reject) => {
      this.#queue.push({ signal, operation, resolve, reject });
    });
    this.#pump();
    return queued;
  }

  #pump(): void {
    while (
      this.#activeCount < MAX_CONCURRENT_DISPATCHES &&
      this.#queue.length > 0
    ) {
      const next = this.#queue.shift()!;
      if (next.signal.aborted) {
        next.reject(
          new DomainError(
            "runtime_unavailable",
            "The automation dispatch was cancelled during shutdown.",
            true,
          ),
        );
        continue;
      }
      this.#activeCount += 1;
      void Promise.resolve()
        .then(next.operation)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.#activeCount -= 1;
          this.#service.dispatchCapacityChanged();
          this.#pump();
        });
    }
  }

  #scheduledSnoozeApplies(
    scope: RequestScope,
    run: AutomationRunRecord,
  ): boolean {
    if (run.occurrenceKind !== "scheduled") return false;
    const inventory = this.#inventory.getThread(
      scope,
      run.anchorThreadId,
    ).inventory;
    return (
      inventory.inventoryState === "snoozed" &&
      inventory.snoozedUntil !== null &&
      inventory.snoozedUntil >= this.#now()
    );
  }

  #skipForSnooze(
    scope: RequestScope,
    run: AutomationRunRecord,
  ): AutomationRunRecord {
    const skipped = this.#repository.updateRunState(
      scope,
      run.automationId,
      run.id,
      {
        expectedState: "claimed",
        state: "skipped",
        claimToken: requiredClaimToken(run),
        errorCode: "automation_snoozed",
        errorDiagnostic: "The scheduled occurrence was suppressed by snooze.",
        now: this.#now(),
        completeDefinition: this.#isOneShot(scope, run),
      },
    );
    this.#service.publishRun(scope, skipped);
    return skipped;
  }

  #completeAcceptedRun(
    scope: RequestScope,
    run: AutomationRunRecord,
  ): AutomationRunRecord {
    const current = this.#repository.getRun(scope, run.automationId, run.id);
    if (current.state === "completed") return current;
    if (isTerminal(current.state) || current.state === "uncertain") {
      return current;
    }
    if (
      current.state !== "dispatching" &&
      current.state !== "queued" &&
      current.state !== "running"
    ) {
      throw new DomainError(
        "conflict",
        "The automation run is not awaiting dispatch completion.",
      );
    }

    // This phase records successful backend acceptance as completion. It does not
    // yet extend the run through the later agent-settled runtime event.
    const completed = this.#repository.updateRunState(
      scope,
      current.automationId,
      current.id,
      {
        expectedState: current.state,
        state: "completed",
        ...(current.claimToken ? { claimToken: current.claimToken } : {}),
        now: this.#now(),
        completeDefinition: this.#isOneShot(scope, current),
      },
    );
    this.#service.publishRun(scope, completed);
    return completed;
  }

  #recordDispatchError(
    scope: RequestScope,
    stale: AutomationRunRecord,
    error: unknown,
  ): AutomationRunRecord {
    const current = this.#repository.getRun(
      scope,
      stale.automationId,
      stale.id,
    );
    if (isTerminal(current.state) || current.state === "uncertain") {
      return current;
    }
    if (current.state !== "claimed" && current.state !== "dispatching") {
      throw error;
    }
    if (current.state === "claimed" && current.precheckStatus === "checking") {
      const failedAt = this.#now();
      const failed = this.#repository.finishPrecheckWithoutDispatch(
        scope,
        current.automationId,
        current.id,
        {
          claimToken: requiredClaimToken(current),
          decision: "failed",
          errorCode: "automation_precheck_execution_failed",
          errorDiagnostic: diagnostic(error),
          durationMilliseconds: Math.max(
            0,
            failedAt - (current.precheckStartedAt ?? current.claimedAt),
          ),
          stdoutBytes: current.precheckStdoutBytes ?? 0,
          now: failedAt,
          detachDefinition: this.#isOneShot(scope, current),
        },
      );
      this.#service.publishRun(scope, failed);
      return failed;
    }
    if (
      (error instanceof DomainError &&
        error.code === "operation_outcome_uncertain") ||
      (error instanceof BackendError && error.crossedSubmissionBoundary)
    ) {
      return this.#recordUncertain(scope, current, error.message);
    }
    if (
      current.state === "claimed" &&
      current.occurrenceKind === "scheduled" &&
      this.#scheduledSnoozeApplies(scope, current)
    ) {
      return this.#skipForSnooze(scope, current);
    }

    const failed = this.#repository.updateRunState(
      scope,
      current.automationId,
      current.id,
      {
        expectedState: current.state,
        state: "failed",
        claimToken: requiredClaimToken(current),
        errorCode: dispatchFailureCode(error),
        errorDiagnostic: diagnostic(error),
        now: this.#now(),
        completeDefinition: this.#isOneShot(scope, current),
      },
    );
    this.#service.publishRun(scope, failed);
    return failed;
  }

  #recordUncertain(
    scope: RequestScope,
    run: AutomationRunRecord,
    message: string,
  ): AutomationRunRecord {
    const uncertain = this.#repository.markRunUncertainAndPause(
      scope,
      run.automationId,
      run.id,
      {
        expectedState: "dispatching",
        claimToken: requiredClaimToken(run),
        errorCode: UNCERTAIN_CODE,
        errorDiagnostic: bounded(message, 500),
        now: this.#now(),
      },
    );
    this.#service.publishRun(scope, uncertain);
    return uncertain;
  }

  #isOneShot(scope: RequestScope, run: AutomationRunRecord): boolean {
    return (
      run.occurrenceKind === "scheduled" &&
      this.#repository.getDefinition(scope, run.automationId).schedule.kind ===
        "date_time"
    );
  }
}

function runScope(run: AutomationRunRecord): RequestScope {
  return {
    tenantId: run.tenantId,
    principalId: run.ownerPrincipalId,
  };
}

function runKey(run: AutomationRunRecord): string {
  return [run.tenantId, run.ownerPrincipalId, run.automationId, run.id].join(
    "\0",
  );
}

function isTerminal(state: AutomationRunState): boolean {
  return state === "completed" || state === "failed" || state === "skipped";
}

function requiredPrompt(run: AutomationRunRecord): string {
  if (!run.promptSnapshot) {
    throw new DomainError(
      "invalid_transition",
      "The automation run has no frozen prompt.",
    );
  }
  return run.promptSnapshot;
}

function requiredClaimToken(run: AutomationRunRecord): string {
  if (!run.claimToken) {
    throw new DomainError(
      "invalid_transition",
      "The automation run has no active claim.",
    );
  }
  return run.claimToken;
}

function requiredPrecheckCommand(run: AutomationRunRecord): string {
  if (!run.precheckCommandSnapshot) {
    throw new DomainError(
      "invalid_transition",
      "The automation run has no frozen pre-check command.",
    );
  }
  return run.precheckCommandSnapshot;
}

function requiredPrecheckTimeout(run: AutomationRunRecord): number {
  if (!run.precheckTimeoutSeconds) {
    throw new DomainError(
      "invalid_transition",
      "The automation run has no frozen pre-check timeout.",
    );
  }
  return run.precheckTimeoutSeconds;
}

function diagnostic(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return bounded(error.message.trim(), 500);
  }
  return "The automation prompt could not be dispatched.";
}

function dispatchFailureCode(error: unknown): string {
  if (error instanceof BackendError) {
    switch (error.category) {
      case "unavailable":
      case "overloaded":
        return "automation_backend_unavailable";
      case "permission_denied":
        return "automation_backend_permission_denied";
      case "not_found":
        return "automation_checkpoint_unavailable";
      case "invalid_state":
      case "rejected":
        return "automation_dispatch_rejected";
      case "submission_unknown":
        return "automation_dispatch_uncertain";
      case "incompatible_protocol":
        return "automation_backend_incompatible";
      case "internal":
        return "automation_backend_failure";
    }
  }
  if (error instanceof DomainError) {
    switch (error.code) {
      case "archived_thread":
        return "automation_anchor_archived";
      case "materialization_unresolved":
        return "automation_anchor_materializing";
      case "runtime_unavailable":
        return "automation_anchor_unavailable";
      case "conflict":
        return "automation_run_conflict";
      case "invalid_transition":
        return error.message.toLocaleLowerCase().includes("needs input")
          ? "automation_anchor_needs_input"
          : "automation_dispatch_rejected";
      default:
        return "automation_dispatch_rejected";
    }
  }
  return "automation_dispatch_failed";
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
