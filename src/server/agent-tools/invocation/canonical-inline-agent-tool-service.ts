import { CanonicalAgentToolRequestError } from "./canonical-agent-tool-request-error.js";
export { CanonicalAgentToolRequestError } from "./canonical-agent-tool-request-error.js";
import type { WorkpadAgentToolService } from "../tools/workpad-agent-tool-service.js";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { deterministicJson } from "../../canonical-json.js";
import { DomainError } from "../../domain/errors.js";
import { projectRemovalAdmissionError } from "../../db/project-removal-errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentToolAdapter,
  AgentToolCallerKind,
  AgentToolCatalogSummary,
  AgentToolContractArtifact,
  AgentToolDescription,
  AgentToolDefinition,
  SedesToolInvocationRequest,
  SedesToolInvocationResult,
  SedesToolProgress,
  SedesToolProgressUpdate,
  TrustedToolInvocationContext,
  TrustedAgentToolCallerDefaults,
  TrustedAgentToolPolicyIdentity,
  TrustedToolInvocationSubject,
} from "../contracts/agent-tool-contracts.js";
import { assertTrustedAgentToolAuthority } from "../contracts/agent-tool-contracts.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";
import { createTrustedCapabilityAccess } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS,
  AGENT_TOOL_MAXIMUM_DESCRIPTION_REQUEST_BYTES,
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
} from "../contracts/agent-tool-transport-limits.js";
import {
  AgentToolRegistry,
  cliCommandPath,
} from "../registry/agent-tool-registry.js";
import { createCanonicalAgentToolDefinitions } from "../registry/canonical-agent-tool-catalog.js";
import type { AgentManagementService } from "../application/agent-management-service.js";
import type { AgentThreadCreationService } from "../tools/thread-management-tools.js";
import type { SavedAgentCanonicalToolService } from "../tools/saved-agent-management-tools.js";
import type { AutomationAgentToolService } from "../tools/automation-agent-tool-service.js";
import type { AgentToolApplicationReader } from "../tools/agent-tool-readers.js";
import type { AgentThreadControlToolServices } from "../tools/thread-control-tools.js";
import type { AgentThreadWorktreeService } from "../tools/thread-worktree-tools.js";

export interface CanonicalAgentToolInvocationContext {
  readonly scope: RequestScope;
  readonly subject: TrustedToolInvocationSubject;
  readonly defaults: TrustedAgentToolCallerDefaults;
  readonly policyIdentity: TrustedAgentToolPolicyIdentity;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
  readonly adapter: AgentToolAdapter;
  readonly signal: AbortSignal;
  readonly onInvocationStarted?: (invocationId: string) => void | Promise<void>;
  readonly onProgress?: (progress: SedesToolProgress) => void | Promise<void>;
}


function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const AGENT_TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function assertAgentToolDescriptionIds(
  toolIds: readonly string[],
): void {
  if (
    toolIds.length < 1 ||
    toolIds.length > AGENT_TOOL_MAXIMUM_DESCRIPTION_IDS ||
    new Set(toolIds).size !== toolIds.length ||
    toolIds.some(
      (toolId) =>
        toolId.length < 1 ||
        toolId.length > 128 ||
        !AGENT_TOOL_ID_PATTERN.test(toolId),
    ) ||
    bytes(deterministicJson({ toolIds })) >
      AGENT_TOOL_MAXIMUM_DESCRIPTION_REQUEST_BYTES
  ) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "The requested tool IDs are invalid.",
    );
  }
}

function catalogSummary(
  artifact: AgentToolContractArtifact,
): AgentToolCatalogSummary {
  const cli = artifact.adapters.cli;
  return Object.freeze({
    id: artifact.id,
    schemaVersion: artifact.schemaVersion,
    label: artifact.catalog.label,
    description: artifact.description,
    group: Object.freeze({
      id: artifact.catalog.groupId,
      order: artifact.catalog.order,
    }),
    effects: artifact.effects,
    ...(cli
      ? {
          cli: Object.freeze({
            commandPath: cliCommandPath(cli.command),
          }),
        }
      : {}),
  });
}

function publicDescription(
  artifact: AgentToolContractArtifact,
  adapter: AgentToolAdapter,
): AgentToolDescription {
  const waitCeilingMilliseconds =
    artifact.execution.adapterWaitCeilingMilliseconds[adapter];
  if (waitCeilingMilliseconds === undefined) {
    throw new CanonicalAgentToolRequestError(
      "internal_error",
      "The requested tool has no wait ceiling for this adapter.",
    );
  }
  return Object.freeze({
    id: artifact.id,
    schemaVersion: artifact.schemaVersion,
    label: artifact.catalog.label,
    description: artifact.description,
    inputSchema: artifact.inputSchema,
    outputSchema: artifact.outputSchema,
    effects: artifact.effects,
    execution: Object.freeze({
      form: artifact.execution.form,
      waitCeilingMilliseconds,
      supportsCancellation: artifact.execution.supportsCancellation,
      idempotency: artifact.execution.idempotency,
      progress: artifact.execution.progress,
      maximumInputBytes: artifact.execution.maximumInputBytes,
      maximumOutputBytes: artifact.execution.maximumOutputBytes,
      uncertainExternalOutcome: artifact.execution.uncertainExternalOutcome,
    }),
  });
}

function executionBoundary(
  sourceSignal: AbortSignal,
  timeoutMilliseconds: number,
): {
  readonly signal: AbortSignal;
  readonly boundary: Promise<never>;
  abort(reason: unknown): void;
  close(): void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary:
    ((error: CanonicalAgentToolRequestError) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    rejectBoundary?.(
      new CanonicalAgentToolRequestError(
        "cancelled",
        "The tool invocation was cancelled.",
      ),
    );
    controller.abort(reason);
  };
  const cancel = () => abort(sourceSignal.reason);
  sourceSignal.addEventListener("abort", cancel, { once: true });
  if (sourceSignal.aborted) cancel();
  timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    rejectBoundary?.(
      new CanonicalAgentToolRequestError(
        "timed_out",
        "The tool invocation did not complete before its deadline.",
        true,
      ),
    );
    controller.abort(new Error("agent_tool_invocation_deadline_exceeded"));
  }, timeoutMilliseconds);
  timeout.unref();
  return {
    signal: controller.signal,
    boundary,
    abort,
    close() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      sourceSignal.removeEventListener("abort", cancel);
    },
  };
}

function admittedEffects(definition: AgentToolDefinition): boolean {
  const { application, modelUsage, external } = definition.effects;
  return (
    (application === "read" && modelUsage === "none" && external === "none") ||
    (application === "read" &&
      modelUsage === "agent_execution" &&
      external === "none") ||
    (application === "write" && modelUsage === "none" && external === "none") ||
    (application === "write" &&
      modelUsage === "none" &&
      external === "durable_side_effect") ||
    (application === "write" &&
      modelUsage === "agent_execution" &&
      external === "durable_side_effect") ||
    (application === "destructive" &&
      modelUsage === "none" &&
      external === "none")
  );
}

export function mapAgentToolDomainError(
  cause: DomainError,
): CanonicalAgentToolRequestError {
  switch (cause.code) {
    case "bad_request":
      return new CanonicalAgentToolRequestError(
        "invalid_input",
        "The supplied input is invalid.",
      );
    case "not_found":
    case "workspace_missing":
      return new CanonicalAgentToolRequestError(
        "not_found",
        "The requested resource was not found.",
      );
    case "conflict":
    case "draft_revision_conflict":
    case "inventory_revision_conflict":
    case "pin_revision_conflict":
    case "bookmark_revision_conflict":
    case "group_assignment_revision_conflict":
    case "group_revision_conflict":
    case "group_name_conflict":
    case "task_revision_conflict":
    case "task_reference_unresolved":
    case "task_context_too_large":
    case "workspace_file_revision_conflict":
    case "workspace_file_download_too_large":
    case "invalid_transition":
    case "steer_target_unavailable":
    case "attachment_quota_exceeded":
    case "archived_thread":
    case "stash_limit_reached":
      return new CanonicalAgentToolRequestError(
        "conflict",
        "The requested operation conflicts with current application state.",
      );
    case "cursor_invalid":
      return new CanonicalAgentToolRequestError(
        "invalid_input",
        "The supplied cursor is invalid.",
      );
    case "materialization_unresolved":
    case "runtime_unavailable":
      return new CanonicalAgentToolRequestError(
        "unavailable",
        "The requested operation is currently unavailable.",
        cause.retryable,
      );
    case "operation_outcome_uncertain":
    case "workspace_file_write_outcome_unknown":
      return new CanonicalAgentToolRequestError(
        "uncertain_outcome",
        "The operation outcome is uncertain.",
      );
  }
}

export class CanonicalInlineAgentToolService {
  readonly registry: AgentToolRegistry;
  readonly #invocationId: () => string;
  readonly #mutationId: () => string;
  readonly #unavailableToolIds: ReadonlySet<string>;
  readonly #executions = new Set<{
    readonly operation: Promise<unknown>;
    readonly abort: (reason: unknown) => void;
  }>();
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(input: {
    readonly application: AgentToolApplicationReader;
    readonly management?: AgentManagementService;
    readonly workpads?: WorkpadAgentToolService;
    readonly automations?: AutomationAgentToolService;
    readonly threadCreation?: AgentThreadCreationService;
    readonly savedAgents?: SavedAgentCanonicalToolService;
    readonly threadControl?: AgentThreadControlToolServices;
    readonly webSearch?: import("../tools/web-search-tool.js").WebSearchExecutor;
    readonly threadWorktrees?: AgentThreadWorktreeService;
    readonly additionalDefinitions?: readonly AgentToolDefinition[];
    readonly unavailableToolIds?: ReadonlySet<string>;
    readonly invocationId?: () => string;
    readonly mutationId?: () => string;
  }) {
    this.registry = new AgentToolRegistry();
    for (const definition of createCanonicalAgentToolDefinitions(input)) {
      this.registry.register(definition);
    }
    this.#invocationId = input.invocationId ?? randomUUID;
    this.#mutationId = input.mutationId ?? randomUUID;
    this.#unavailableToolIds = new Set(input.unavailableToolIds ?? []);
  }

  catalog(
    adapter: CanonicalAgentToolInvocationContext["adapter"],
    callerKind: AgentToolCallerKind,
  ): readonly AgentToolContractArtifact[] {
    return Object.freeze(
      this.registry
        .list()
        .filter(
          (definition) =>
            definition.deployment?.eligible === true &&
            !this.#unavailableToolIds.has(definition.id) &&
            definition.callerEligibility.includes(callerKind) &&
            definition.exposure.adapters.includes(adapter),
        )
        .map((definition) =>
          this.registry.artifact(definition.id, definition.schemaVersion),
        ),
    );
  }

  catalogSummaries(
    adapter: AgentToolAdapter,
    callerKind: AgentToolCallerKind,
  ): readonly AgentToolCatalogSummary[] {
    return Object.freeze(this.catalog(adapter, callerKind).map(catalogSummary));
  }

  describeMany(
    adapter: AgentToolAdapter,
    callerKind: AgentToolCallerKind,
    toolIds: readonly string[],
  ): readonly AgentToolDescription[] {
    assertAgentToolDescriptionIds(toolIds);
    const byId = new Map(
      this.catalog(adapter, callerKind).map((tool) => [tool.id, tool]),
    );
    const artifacts = toolIds.map((toolId) => byId.get(toolId));
    if (artifacts.some((artifact) => artifact === undefined)) {
      throw new CanonicalAgentToolRequestError(
        "not_found",
        "The requested tool is unavailable.",
      );
    }
    const descriptions = artifacts.map((artifact) =>
      publicDescription(artifact!, adapter),
    );
    if (
      bytes(deterministicJson({ tools: descriptions })) >
      AGENT_TOOL_MAXIMUM_RESPONSE_BYTES
    ) {
      throw new CanonicalAgentToolRequestError(
        "internal_error",
        "The requested tool descriptions exceed the response limit.",
      );
    }
    return Object.freeze(descriptions);
  }

  prepareInlineInvocation(
    adapter: AgentToolAdapter,
    callerKind: AgentToolCallerKind,
    request: SedesToolInvocationRequest,
  ): AgentToolDefinition {
    if (this.#closing) {
      throw new CanonicalAgentToolRequestError(
        "unavailable",
        "Agent tools are unavailable while the application is shutting down.",
      );
    }
    if (!request.requestId || bytes(request.requestId) > 256) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        "The tool request ID is invalid.",
      );
    }
    let definition;
    try {
      definition = this.registry.get(request.toolId, request.schemaVersion);
    } catch {
      throw new CanonicalAgentToolRequestError(
        "not_found",
        "The requested tool version is unavailable.",
      );
    }
    if (
      definition.deployment?.eligible !== true ||
      this.#unavailableToolIds.has(definition.id) ||
      !definition.callerEligibility.includes(callerKind) ||
      !definition.exposure.adapters.includes(adapter) ||
      definition.execution.form !== "inline" ||
      !admittedEffects(definition)
    ) {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The tool is not exposed here.",
      );
    }
    if (
      !this.registry.validatesInput(
        definition.id,
        definition.schemaVersion,
        request.input,
      )
    ) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        "The tool input is invalid.",
      );
    }
    if (
      bytes(deterministicJson(request.input)) >
      definition.execution.maximumInputBytes
    ) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        "The tool input is too large.",
      );
    }
    return definition;
  }

  async invoke<Output = unknown>(
    request: SedesToolInvocationRequest,
    source: CanonicalAgentToolInvocationContext,
  ): Promise<SedesToolInvocationResult<Output>> {
    assertTrustedAgentToolAuthority(source);
    const definition = this.prepareInlineInvocation(
      source.adapter,
      source.subject.kind,
      request,
    );
    if (source.signal.aborted) {
      throw new CanonicalAgentToolRequestError(
        "cancelled",
        "The tool invocation was cancelled.",
      );
    }

    const waitCeiling =
      definition.execution.adapterWaitCeilingMilliseconds[source.adapter];
    if (waitCeiling === undefined) {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The tool is not exposed here.",
      );
    }
    const execution = executionBoundary(source.signal, waitCeiling);
    const invocationId = this.#invocationId();
    const mutationId = this.#mutationId();
    let progressRevision = 0;
    const capabilities = createTrustedCapabilityAccess([]);
    const context: TrustedToolInvocationContext = Object.freeze({
      invocationId,
      mutationId,
      tenantId: source.scope.tenantId,
      principalId: source.scope.principalId,
      subject: Object.freeze({ ...source.subject }),
      defaults: Object.freeze({ ...source.defaults }),
      policyIdentity: Object.freeze({ ...source.policyIdentity }),
      environmentAuthority: source.environmentAuthority,
      adapter: source.adapter,
      ...capabilities,
      requestId: request.requestId,
      abortSignal: execution.signal,
      reportProgress: (update: SedesToolProgressUpdate) =>
        source.onProgress?.({
          invocationId,
          revision: ++progressRevision,
          ...update,
        }),
    });
    const operation = (async () => {
      await source.onInvocationStarted?.(invocationId);
      execution.signal.throwIfAborted();
      return definition.execute(request.input, context);
    })();
    const activeExecution = {
      operation,
      abort: execution.abort,
    };
    this.#executions.add(activeExecution);
    void operation.then(
      () => this.#executions.delete(activeExecution),
      () => this.#executions.delete(activeExecution),
    );

    try {
      const output = await Promise.race([operation, execution.boundary]);
      if (
        typeof output === "object" &&
        output !== null &&
        "state" in output &&
        output.state === "accepted"
      ) {
        throw new Error("agent_tool_operation_result_unsupported");
      }
      const serializedOutput = deterministicJson(output);
      if (
        !this.registry.validatesOutput(
          definition.id,
          definition.schemaVersion,
          output,
        ) ||
        bytes(serializedOutput) > definition.execution.maximumOutputBytes
      ) {
        throw new Error("agent_tool_output_invalid");
      }
      return { invocationId, state: "completed", output: output as Output };
    } catch (cause) {
      if (cause instanceof CanonicalAgentToolRequestError) throw cause;
      if (cause instanceof ZodError) {
        const issue = cause.issues[0]?.message.trim();
        throw new CanonicalAgentToolRequestError(
          "invalid_input",
          boundedInputDiagnostic(issue),
        );
      }
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new CanonicalAgentToolRequestError(
          "cancelled",
          "The tool invocation was cancelled.",
        );
      }
      const projectAdmissionError = projectRemovalAdmissionError(cause);
      if (projectAdmissionError) {
        throw new CanonicalAgentToolRequestError(
          "conflict", projectAdmissionError.message, false, { cause },
        );
      }
      if (cause instanceof DomainError) throw mapAgentToolDomainError(cause);
      throw new CanonicalAgentToolRequestError(
        "internal_error",
        "The tool invocation failed.",
        false,
        { cause },
      );
    } finally {
      execution.close();
    }
  }

  close(): Promise<void> {
    this.#closing = true;
    const shutdownReason = new Error("agent_tool_service_shutdown");
    for (const execution of this.#executions) {
      execution.abort(shutdownReason);
    }
    this.#closePromise ??= this.#drainExecutions();
    return this.#closePromise;
  }

  async #drainExecutions(): Promise<void> {
    while (this.#executions.size > 0) {
      await Promise.allSettled(
        [...this.#executions].map(({ operation }) => operation),
      );
    }
  }
}

function boundedInputDiagnostic(issue: string | undefined): string {
  const generic = "The tool input is invalid.";
  if (!issue) return generic;
  const message = `${generic.slice(0, -1)}: ${issue}`;
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}
