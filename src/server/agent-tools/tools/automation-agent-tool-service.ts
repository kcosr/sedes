import type {
  ThreadAutomationDefinition,
  ThreadAutomationRun,
} from "../../../shared/protocol/automation-presentation.js";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationNameSchema,
  automationScheduleSchema,
  type AutomationPrecheck,
  type AutomationSchedule,
} from "../../../shared/protocol/automation.js";
import { ZodError, z } from "zod";
import { assertToolPolicyWithinCaller } from "../application/assert-tool-policy-within-caller.js";
import type { ThreadAgentToolPolicyRepository } from "../../db/repositories/thread-agent-tool-policy-repository.js";
import type { PrincipalAgentToolClientRepository } from "../../db/repositories/principal-agent-tool-client-repository.js";
import type {
  AutomationMisfirePolicy,
  AutomationRunMode,
} from "../../domain/automation-models.js";
import type { AutomationService } from "../../domain/automation-service.js";
import { automationPromptPreview } from "../../domain/automation-presentation.js";
import { assertAutomationCloneEligible } from "../../domain/automation-clone-eligibility.js";
import { DomainError } from "../../domain/errors.js";
import type { ThreadApplicationService } from "../../conversations/thread-application-service.js";
import type { AutomationRepository } from "../../db/repositories/automation-repository.js";
import type { InventoryRepository } from "../../db/repositories/inventory-repository.js";
import type { TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { requireAdmittedResource } from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";

const UPCOMING_OCCURRENCE_COUNT = 5;

/**
 * The definition shape frozen by the `automation.get@2`, `automation.create@2`,
 * `automation.update@2` and `automation.set_state@2` output schemas; the last
 * two add `retired`. The run-history revision and the last run's agent turn
 * are browser-only detail and are stripped.
 */
export interface AgentAutomationDefinition extends Omit<
  ThreadAutomationDefinition,
  "lastRun" | "runsRevision"
> {
  readonly lastRun?: Omit<
    NonNullable<ThreadAutomationDefinition["lastRun"]>,
    "turn"
  >;
  readonly upcoming: readonly string[];
}

/**
 * The `automation.update@2` and `automation.set_state@2` result: the
 * definition the change produced, and whether that change retired a finished
 * one-time automation, which then no longer exists.
 */
export interface AgentAutomationMutationResult extends AgentAutomationDefinition {
  readonly retired: boolean;
}

export interface AutomationTargetInput {
  readonly automationId: string;
}
export interface AutomationThreadInput {
  readonly threadId?: string;
}
export interface AutomationListToolInput extends AutomationThreadInput {
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly status?: "enabled" | "paused" | "exhausted";
}
export interface AutomationRunNowToolInput extends AutomationTargetInput {
  readonly mutationId: string;
}
export interface AutomationDeleteToolInput extends AutomationTargetInput {
  readonly expectedRevision: number;
}

/**
 * The run shape frozen by the `automation.runs@2` and `automation.run_now@2`
 * output schemas. Browser-only run detail is stripped rather than versioning
 * the tools.
 */
export type AutomationToolRun = Omit<
  ThreadAutomationRun,
  "definitionRevision" | "forceResetAt" | "precheck" | "turn"
> & {
  readonly precheck?: Omit<
    NonNullable<ThreadAutomationRun["precheck"]>,
    "command" | "timeoutSeconds"
  >;
};

export interface AutomationCreateToolInput extends AutomationThreadInput {
  readonly name: string;
  readonly initialState: "enabled" | "paused";
  readonly mutationId: string;
  readonly prompt: string;
  readonly runMode: AutomationRunMode;
  readonly schedule: AutomationSchedule;
  readonly misfirePolicy: AutomationMisfirePolicy | null;
  readonly precheck?: AutomationPrecheck | null;
}

export interface AutomationUpdateToolInput extends AutomationTargetInput {
  readonly expectedRevision: number;
  readonly name?: string;
  readonly prompt?: string;
  readonly runMode?: AutomationRunMode;
  readonly schedule?: AutomationSchedule;
  readonly misfirePolicy?: AutomationMisfirePolicy | null;
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
  | "create"
  | "replayCreate"
  | "get"
  | "list"
  | "listRuns"
  | "preview"
  | "presentDefinition"
  | "replayUpdate"
  | "runNow"
  | "setState"
  | "update"
  | "delete"
>;

/**
 * Scoped reads of a mutation's receipt and the definition it left, including
 * one it retired. Replay cannot depend on a live definition.
 */
type AutomationMutationRecords = Pick<
  AutomationRepository,
  "getMutationReceipt" | "getDefinition"
>;

/** Canonical, source-scoped adapter over the existing automation domain. */
export class AutomationAgentToolService {
  readonly #automations: AutomationDomain;
  readonly #mutationRecords: AutomationMutationRecords;
  readonly #threads: Pick<ThreadApplicationService, "automationCapability">;
  readonly #inventory: Pick<InventoryRepository, "getThread">;
  readonly #toolPolicies: Pick<ThreadAgentToolPolicyRepository, "getDurable">;
  readonly #principalToolClients: Pick<PrincipalAgentToolClientRepository, "get">;
  readonly #now: () => number;

  constructor(input: {
    readonly automations: AutomationDomain;
    readonly mutationRecords: AutomationMutationRecords;
    readonly threads: Pick<ThreadApplicationService, "automationCapability">;
    readonly inventory: Pick<InventoryRepository, "getThread">;
    readonly toolPolicies: Pick<ThreadAgentToolPolicyRepository, "getDurable">;
    readonly principalToolClients: Pick<PrincipalAgentToolClientRepository, "get">;
    readonly now?: () => number;
  }) {
    this.#automations = input.automations;
    this.#mutationRecords = input.mutationRecords;
    this.#threads = input.threads;
    this.#inventory = input.inventory;
    this.#toolPolicies = input.toolPolicies;
    this.#principalToolClients = input.principalToolClients;
    this.#now = input.now ?? Date.now;
  }

  async get(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    const now = this.#now();
    const definition = this.#admitAutomation(input, context);
    return this.#withUpcoming(definition, now);
  }

  listRuns(
    input: AutomationRunsToolInput,
    context: TrustedToolInvocationContext,
  ): {
    readonly items: AutomationToolRun[];
    readonly nextCursor: string | null;
  } {
    this.#admitAutomation(input, context);
    const page = this.#automations.listRuns(
      scope(context),
      input.automationId,
      {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        pageSize: input.pageSize ?? 50,
        environmentAuthority: {
          sourceEnvironmentId:
            context.environmentAuthority.defaults.environmentId,
          targetEnvironmentIds:
            context.environmentAuthority.targetEnvironmentIds,
          policyRevision: context.environmentAuthority.policyIdentity.revision,
        },
      },
    );
    return { items: page.items.map(toolRun), nextCursor: page.nextCursor };
  }

  async create(
    input: AutomationCreateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationDefinition> {
    const operationScope = scope(context);
    const threadId = this.#admitTargetThread(input, context);
    this.#assertClonePolicy(threadId, input.runMode, context);
    const name = automationNameSchema.parse(input.name);
    const prompt = automationPromptSchema.parse(input.prompt);
    const schedule = automationScheduleSchema.parse(input.schedule);
    const precheck =
      input.precheck == null
        ? null
        : automationPrecheckSchema.parse(input.precheck);
    const now = this.#now();
    this.#validateSchedule(schedule, now);
    validateMisfirePolicy(schedule, input.misfirePolicy);
    const creation = {
      name,
      initialState: input.initialState,
      prompt,
      runMode: input.runMode,
      schedule,
      misfirePolicy: input.misfirePolicy,
      precheck,
      mutationId: z.uuid().parse(input.mutationId),
    };
    const replay = this.#automations.replayCreate(
      operationScope,
      threadId,
      creation,
    );
    if (replay) return this.#withUpcoming(replay, now);
    await this.#assertCloneEligible(
      operationScope,
      threadId,
      input.runMode,
      context.abortSignal,
    );
    if (input.runMode === "clone") {
      this.#admitTargetThread(input, context);
      this.#assertClonePolicy(threadId, input.runMode, context);
    }
    const definition = this.#automations.create(
      operationScope,
      threadId,
      {
        name,
        initialState: input.initialState,
        prompt,
        runMode: input.runMode,
        schedule,
        misfirePolicy: input.misfirePolicy,
        precheck,
        mutationId: z.uuid().parse(input.mutationId),
      },
      now,
    );
    return this.#withUpcoming(definition, now);
  }

  async update(
    input: AutomationUpdateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationMutationResult> {
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
    const { definition: current, recorded } = this.#admitMutationTarget(
      input,
      context,
    );
    const threadId = current.threadId;
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
    const merged = {
      name:
        input.name === undefined
          ? current.name
          : automationNameSchema.parse(input.name),
      prompt: prompt ?? current.prompt,
      runMode: input.runMode ?? current.runMode,
      schedule: schedule ?? current.schedule,
      misfirePolicy:
        input.misfirePolicy === undefined
          ? current.misfirePolicy
          : input.misfirePolicy,
      precheck: Object.prototype.hasOwnProperty.call(input, "precheck")
        ? (precheck ?? null)
        : current.precheck,
    };
    validateMisfirePolicy(merged.schedule, merged.misfirePolicy);
    this.#assertClonePolicy(threadId, merged.runMode, context);
    const mutation = {
      ...merged,
      expectedRevision: input.expectedRevision,
      mutationId: context.mutationId,
    };
    // Merging over the definition the recorded mutation left reproduces its
    // request, so the domain verifies and replays it without re-admission.
    const replayed = recorded
      ? this.#automations.replayUpdate(
          operationScope,
          input.automationId,
          mutation,
        )
      : undefined;
    if (replayed) return this.#mutationResult(replayed, context, now);
    if (merged.runMode === "clone" && current.runMode !== "clone") {
      await this.#assertCloneEligible(
        operationScope,
        threadId,
        merged.runMode,
        context.abortSignal,
      );
    }
    if (merged.runMode === "clone") {
      this.#admitTarget(current, context);
      this.#assertClonePolicy(threadId, merged.runMode, context);
    }
    const definition = this.#automations.update(
      operationScope,
      input.automationId,
      mutation,
      now,
    );
    return this.#mutationResult(definition, context, now);
  }

  async setState(
    input: AutomationSetStateToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AgentAutomationMutationResult> {
    const now = this.#now();
    // The domain replays a recorded state mutation before any live lookup.
    const { definition: current } = this.#admitMutationTarget(input, context);
    if (input.action === "enable") {
      this.#assertClonePolicy(current.threadId, current.runMode, context);
    }
    const definition = this.#automations.setState(
      scope(context),
      input.automationId,
      {
        action: input.action,
        expectedRevision: input.expectedRevision,
        mutationId: context.mutationId,
      },
      now,
    );
    return this.#mutationResult(definition, context, now);
  }

  async runNow(
    input: AutomationRunNowToolInput,
    context: TrustedToolInvocationContext,
  ): Promise<AutomationToolRun> {
    const current = this.#admitAutomation(input, context);
    this.#assertClonePolicy(current.threadId, current.runMode, context);
    // The domain reserves or replays its manual run synchronously, before its
    // first await. The authority check therefore covers that reservation
    // without adding a capability preflight that could change replay behavior.
    return toolRun(
      await this.#automations.runNow(
        scope(context),
        input.automationId,
        z.uuid().parse(input.mutationId),
        this.#now(),
      ),
    );
  }

  list(input: AutomationListToolInput, context: TrustedToolInvocationContext) {
    const threadId = this.#admitTargetThread(input, context);
    const page = this.#automations.list(scope(context), {
      threadId,
      pageSize: input.pageSize ?? 50,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return {
      items: page.items.map((definition) => {
        const {
          prompt,
          precheck: _precheck,
          ...summary
        } = this.#withUpcoming(definition, this.#now());
        return { ...summary, promptPreview: automationPromptPreview(prompt) };
      }),
      nextCursor: page.nextCursor,
    };
  }

  delete(
    input: AutomationDeleteToolInput,
    context: TrustedToolInvocationContext,
  ) {
    this.#admitAutomation(input, context);
    this.#automations.delete(scope(context), input.automationId, {
      expectedRevision: input.expectedRevision,
      mutationId: context.mutationId,
    });
    return { deleted: true as const };
  }

  #admitAutomation(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): ThreadAutomationDefinition {
    this.#admitReference(input, context);
    return this.#admitTarget(
      this.#automations.get(scope(context), input.automationId),
      context,
    );
  }

  /**
   * A retry of a recorded mutation admits the definition that mutation left,
   * even one it retired, so the domain replays the original result rather
   * than finding no live definition. The domain still verifies the receipt's
   * kind and request; a different automation's receipt is not reused here.
   */
  #admitMutationTarget(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): {
    readonly definition: ThreadAutomationDefinition;
    readonly recorded: boolean;
  } {
    this.#admitReference(input, context);
    const operationScope = scope(context);
    const receipt = this.#mutationRecords.getMutationReceipt(
      operationScope,
      context.mutationId,
    );
    if (receipt?.automationId !== input.automationId)
      return {
        definition: this.#admitAutomation(input, context),
        recorded: false,
      };
    const definition = this.#automations.presentDefinition(
      operationScope,
      this.#mutationRecords.getDefinition(operationScope, input.automationId),
    );
    return {
      definition: this.#admitTarget(definition, context),
      recorded: true,
    };
  }

  /**
   * The domain mutation and replay are synchronous, so nothing else can
   * remove the definition before this read: a removed definition was retired
   * by this mutation. A replay whose definition was removed later conflicts.
   */
  #mutationResult(
    definition: ThreadAutomationDefinition,
    context: TrustedToolInvocationContext,
    now: number,
  ): AgentAutomationMutationResult {
    const retired =
      this.#mutationRecords.getDefinition(scope(context), definition.id)
        .deletedAt !== null;
    return {
      ...this.#withUpcoming(definition, now),
      ...(retired ? { upcoming: [] } : {}),
      retired,
    };
  }

  #admitReference(
    input: AutomationTargetInput,
    context: TrustedToolInvocationContext,
  ): void {
    const admitted = context.environmentAuthority.resolvedResourceRefs.find(
      (ref) => ref.kind === "automation" && ref.id === input.automationId,
    );
    if (!admitted)
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The automation was not admitted for this invocation.",
      );
    requireAdmittedResource(context.environmentAuthority, admitted);
  }

  #admitTarget(
    definition: ThreadAutomationDefinition,
    context: TrustedToolInvocationContext,
  ): ThreadAutomationDefinition {
    const target = this.#inventory.getThread(
      scope(context),
      definition.threadId,
    ).thread;
    requireAdmittedResource(context.environmentAuthority, {
      kind: "automation",
      id: definition.id,
      threadId: target.id,
      environmentId: target.environmentId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });
    return definition;
  }

  #admitTargetThread(
    input: AutomationThreadInput,
    context: TrustedToolInvocationContext,
  ): string {
    const threadId = targetThreadId(input, context);
    const target = this.#inventory.getThread(scope(context), threadId).thread;
    requireAdmittedResource(context.environmentAuthority, {
      kind: "thread",
      id: target.id,
      environmentId: target.environmentId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
    });
    return threadId;
  }

  #assertClonePolicy(
    threadId: string,
    runMode: AutomationRunMode,
    context: TrustedToolInvocationContext,
  ): void {
    if (runMode !== "clone") return;
    assertToolPolicyWithinCaller({
      scope: scope(context),
      authority: context.environmentAuthority,
      requested: this.#toolPolicies.getDurable(scope(context), threadId),
      toolPolicies: this.#toolPolicies,
      principalToolClients: this.#principalToolClients,
    });
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
    const capability = await this.#threads.automationCapability(
      operationScope,
      threadId,
    );
    // The capture remains owned by the canonical execution/drain. Cancellation
    // does not detach it; this fence prevents the mutation continuation after
    // the read reaches its real terminal state.
    if (signal.aborted) throw cancellationError();
    assertAutomationCloneEligible({
      runMode,
      canCloneOnRun: capability.canCloneOnRun,
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
    const { lastRun, runsRevision: _runsRevision, ...rest } = definition;
    return {
      ...rest,
      ...(lastRun ? { lastRun: toolLastRun(lastRun) } : {}),
      upcoming:
        definition.schedule.kind === "date_time" &&
        Date.parse(definition.schedule.runAt) <= now
          ? []
          : this.#automations.preview(
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
  input: AutomationThreadInput,
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
  return [
    "name",
    "prompt",
    "runMode",
    "schedule",
    "misfirePolicy",
    "precheck",
  ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
}

function cancellationError(): DOMException {
  return new DOMException("The tool invocation was cancelled.", "AbortError");
}

function toolLastRun(
  lastRun: NonNullable<ThreadAutomationDefinition["lastRun"]>,
): NonNullable<AgentAutomationDefinition["lastRun"]> {
  const { turn: _turn, ...rest } = lastRun;
  return rest;
}

function toolRun(run: ThreadAutomationRun): AutomationToolRun {
  const {
    definitionRevision: _definitionRevision,
    forceResetAt: _forceResetAt,
    turn: _turn,
    precheck,
    ...rest
  } = run;
  if (!precheck) return rest;
  const {
    command: _command,
    timeoutSeconds: _timeoutSeconds,
    ...toolPrecheck
  } = precheck;
  return { ...rest, precheck: toolPrecheck };
}

function validateMisfirePolicy(
  schedule: AutomationSchedule,
  policy: AutomationMisfirePolicy | null,
): void {
  if ((schedule.kind === "date_time") !== (policy === null))
    throw new ZodError([
      {
        code: "custom",
        path: ["misfirePolicy"],
        message:
          "One-shots require null; recurring schedules require coalesce or skip.",
      },
    ]);
}
