import type {
  ThreadAutomationDefinition,
  ThreadAutomationRun,
} from "../../../shared/protocol/automation-presentation.js";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
  type AutomationPrecheck,
  type AutomationSchedule,
} from "../../../shared/protocol/automation.js";
import { ZodError } from "zod";
import type {
  AutomationMisfirePolicy,
  AutomationRunMode,
} from "../../domain/automation-models.js";
import type { AutomationService } from "../../domain/automation-service.js";
import { assertAutomationCloneEligible } from "../../domain/automation-clone-eligibility.js";
import { DomainError } from "../../domain/errors.js";
import type { ThreadApplicationService } from "../../conversations/thread-application-service.js";
import type { InventoryRepository } from "../../db/repositories/inventory-repository.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { requireAdmittedResource } from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";

const UPCOMING_OCCURRENCE_COUNT = 5;

export interface AgentAutomationDefinition extends ThreadAutomationDefinition {
  readonly upcoming: readonly string[];
}

export interface AutomationTargetInput {
  readonly threadId?: string;
}

export interface AutomationCreateToolInput extends AutomationTargetInput {
  readonly prompt: string;
  readonly runMode: AutomationRunMode;
  readonly schedule: AutomationSchedule;
  readonly misfirePolicy?: AutomationMisfirePolicy;
  readonly precheck?: AutomationPrecheck | null;
}

export interface AutomationUpdateToolInput extends AutomationTargetInput {
  readonly expectedRevision: number;
  readonly prompt?: string;
  readonly runMode?: AutomationRunMode;
  readonly schedule?: AutomationSchedule;
  readonly misfirePolicy?: AutomationMisfirePolicy;
  readonly precheck?: AutomationPrecheck | null;
}

export interface AutomationRunsToolInput extends AutomationTargetInput {
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface AutomationSetStateToolInput extends AutomationTargetInput {
  readonly expectedRevision: number;
  readonly action: "enable" | "pause";
}

type AutomationDomain = Pick<
  AutomationService,
  "create" | "get" | "listRuns" | "preview" | "runNow" | "setState" | "update"
>;

/** Canonical, source-scoped adapter over the existing automation domain. */
export class AutomationAgentToolService {
  readonly #automations: AutomationDomain;
  readonly #threads: Pick<ThreadApplicationService, "snapshot">;
  readonly #inventory: Pick<InventoryRepository, "getThread">;
  readonly #now: () => number;

  constructor(input: {
    readonly automations: AutomationDomain;
    readonly threads: Pick<ThreadApplicationService, "snapshot">;
    readonly inventory: Pick<InventoryRepository, "getThread">;
    readonly now?: () => number;
  }) {
    this.#automations = input.automations;
    this.#threads = input.threads;
    this.#inventory = input.inventory;
    this.#now = input.now ?? Date.now;
  }

  async get(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    const now = this.#now();
    const threadId = this.#admitTargetThread(input, context);
    const definition = this.#automations.get(scope(context), threadId);
    return this.#withUpcoming(definition, now);
  }

  listRuns(
    input: AutomationRunsToolInput,
    context: TrustedToolInvocationContext,
  ): {
    readonly items: ThreadAutomationRun[];
    readonly nextCursor: string | null;
  } {
    const threadId = this.#admitTargetThread(input, context);
    return this.#automations.listRuns(scope(context), threadId, {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      pageSize: input.pageSize ?? 50,
      environmentAuthority: {
        sourceEnvironmentId: context.environmentAuthority.defaults.environmentId,
        targetEnvironmentIds: context.environmentAuthority.targetEnvironmentIds,
        policyRevision: context.environmentAuthority.policyIdentity.revision,
      },
    });
  }

  async create(
    input: AutomationCreateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    const operationScope = scope(context);
    const threadId = this.#admitTargetThread(input, context);
    const prompt = automationPromptSchema.parse(input.prompt);
    const schedule = automationScheduleSchema.parse(input.schedule);
    const precheck =
      input.precheck == null
        ? null
        : automationPrecheckSchema.parse(input.precheck);
    const now = this.#now();
    this.#validateSchedule(schedule, now);
    await this.#assertCloneEligible(
      operationScope,
      threadId,
      input.runMode,
      context.abortSignal,
    );
    const definition = this.#automations.create(
      operationScope,
      threadId,
      {
        prompt,
        runMode: input.runMode,
        schedule,
        misfirePolicy: input.misfirePolicy ?? "coalesce",
        precheck,
        mutationId: context.mutationId,
      },
      now,
    );
    return this.#withUpcoming(definition, now);
  }

  async update(
    input: AutomationUpdateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    if (!hasDefinitionChange(input)) {
      throw new ZodError([
        {
          code: "custom",
          path: [],
          message: "At least one automation definition field is required.",
        },
      ]);
    }
    const operationScope = scope(context);
    const threadId = this.#admitTargetThread(input, context);
    const prompt =
      input.prompt === undefined
        ? undefined
        : automationPromptSchema.parse(input.prompt);
    const schedule =
      input.schedule === undefined
        ? undefined
        : automationScheduleSchema.parse(input.schedule);
    const precheck =
      input.precheck === undefined || input.precheck === null
        ? input.precheck
        : automationPrecheckSchema.parse(input.precheck);
    const now = this.#now();
    if (schedule !== undefined) this.#validateSchedule(schedule, now);
    const current = this.#automations.get(operationScope, threadId);
    const merged = {
      prompt: prompt ?? current.prompt,
      runMode: input.runMode ?? current.runMode,
      schedule: schedule ?? current.schedule,
      misfirePolicy: input.misfirePolicy ?? current.misfirePolicy,
      precheck: Object.prototype.hasOwnProperty.call(input, "precheck")
        ? (precheck ?? null)
        : current.precheck,
    };
    await this.#assertCloneEligible(
      operationScope,
      threadId,
      merged.runMode,
      context.abortSignal,
    );
    const definition = this.#automations.update(
      operationScope,
      threadId,
      {
        ...merged,
        expectedRevision: input.expectedRevision,
        mutationId: context.mutationId,
      },
      now,
    );
    return this.#withUpcoming(definition, now);
  }

  async setState(
    input: AutomationSetStateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    const now = this.#now();
    const threadId = this.#admitTargetThread(input, context);
    const definition = this.#automations.setState(
      scope(context),
      threadId,
      {
        action: input.action,
        expectedRevision: input.expectedRevision,
        mutationId: context.mutationId,
      },
      now,
    );
    return this.#withUpcoming(definition, now);
  }

  runNow(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): Promise<ThreadAutomationRun> {
    const threadId = this.#admitTargetThread(input, context);
    return this.#automations.runNow(
      scope(context),
      threadId,
      context.mutationId,
      this.#now(),
    );
  }

  #admitTargetThread(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): string {
    const threadId = targetThreadId(input, context);
    const target = this.#inventory.getThread(scope(context), threadId).thread;
    requireAdmittedResource(context.environmentAuthority, {
      kind: "thread",
      id: target.id,
      environmentId: target.environmentId,
      workspaceId: target.workspaceId,
    });
    return threadId;
  }

  async #assertCloneEligible(
    operationScope: ReturnType<typeof scope>,
    threadId: string,
    runMode: AutomationRunMode,
    signal: AbortSignal,
  ): Promise<void> {
    if (runMode !== "clone") return;
    // This is configuration-time admission, not a lease on branching state.
    // Backend/runtime capability can change after this snapshot; the shared
    // fork service deliberately rechecks it at dispatch and records a stable
    // failed run instead of crossing the branch boundary when it is gone.
    if (signal.aborted) throw cancellationError();
    const snapshot = await this.#threads.snapshot(operationScope, threadId);
    // The snapshot remains owned by the canonical execution/drain. Cancellation
    // does not detach it; this fence prevents the mutation continuation after
    // the read reaches its real terminal state.
    if (signal.aborted) throw cancellationError();
    assertAutomationCloneEligible({
      runMode,
      canCloneOnRun: snapshot.capabilities.automation.canCloneOnRun,
    });
  }

  #validateSchedule(schedule: AutomationSchedule, now: number): void {
    try {
      // `preview` enters the same evaluator and domain conversion used by
      // create/update, so cadence, timezone, and cron rules remain defined in
      // one place. This call is read-only and happens before any mutation.
      this.#automations.preview(schedule, 1, now);
    } catch (cause) {
      if (cause instanceof DomainError && cause.code === "invalid_transition") {
        throw new ZodError([
          {
            code: "custom",
            path: ["schedule"],
            message: cause.message,
          },
        ]);
      }
      throw cause;
    }
  }

  #withUpcoming(
    definition: ThreadAutomationDefinition,
    now: number,
  ): AgentAutomationDefinition {
    return {
      ...definition,
      upcoming: this.#automations.preview(
        definition.schedule,
        UPCOMING_OCCURRENCE_COUNT,
        now,
      ),
    };
  }
}

function scope(context: TrustedToolInvocationContext) {
  return { tenantId: context.tenantId, principalId: context.principalId };
}

function targetThreadId(
  input: AutomationTargetInput,
  context: TrustedToolInvocationContext,
): string {
  const threadId = input.threadId ?? context.defaults.threadId;
  if (!threadId) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "The requested operation requires a configured default thread.",
    );
  }
  return threadId;
}

function hasDefinitionChange(input: AutomationUpdateToolInput): boolean {
  return ["prompt", "runMode", "schedule", "misfirePolicy", "precheck"].some(
    (field) => Object.prototype.hasOwnProperty.call(input, field),
  );
}

function cancellationError(): DOMException {
  return new DOMException("The tool invocation was cancelled.", "AbortError");
}
