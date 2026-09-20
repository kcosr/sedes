import type { CanonicalAgentToolRootSchema } from "../schema/canonical-json-schema.js";
import type { BackendKind } from "../../backends/contracts.js";
import type { CanonicalJsonValue } from "../../canonical-json.js";
import type {
  EnvironmentAuthorityDeclaration,
  TrustedEnvironmentAuthorityGrant,
} from "../environment/environment-authority.js";

export type SedesCapability = string;

export type AgentToolAdapter = "pi_sdk" | "mcp" | "http" | "cli";
export type AgentToolCallerKind = "thread_agent" | "principal_client";

export interface ToolEffects {
  readonly application: "read" | "write" | "destructive";
  readonly modelUsage: "none" | "agent_execution";
  readonly external: "none" | "durable_side_effect";
}

export interface ToolExecutionPolicy {
  readonly form: "inline" | "operation" | "hybrid";
  readonly adapterWaitCeilingMilliseconds: Readonly<
    Partial<Record<AgentToolAdapter, number>>
  >;
  readonly supportsCancellation: boolean;
  readonly idempotency: "required" | "supported" | "not_applicable";
  readonly progress: "none" | "structured";
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly concurrencyClass: string;
  readonly uncertainExternalOutcome: boolean;
}

export interface ToolExposurePolicy {
  readonly adapters: readonly AgentToolAdapter[];
}

export type AgentToolGroupId =
  | "context"
  | "threads"
  | "agents"
  | "tasks"
  | "workpads"
  | "automations"
  | "research";

export interface AgentToolCatalogPresentation {
  readonly groupId: AgentToolGroupId;
  readonly label: string;
  readonly order: number;
}

export interface PiToolPresentation {
  readonly name: string;
  readonly label: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

export interface McpToolPresentation {
  readonly name: string;
  readonly title?: string;
}

export interface CliToolPresentation {
  readonly command: string;
}

export interface HttpToolPresentation {
  /** The current HTTP adapter supports bounded inline invocation only. */
  readonly invocation: "inline";
}

export interface AgentToolPresentations {
  readonly pi?: PiToolPresentation;
  readonly http?: HttpToolPresentation;
  readonly mcp?: McpToolPresentation;
  readonly cli?: CliToolPresentation;
}

export interface AgentToolDeploymentExposure {
  /** Definitions are never exposed merely because they are registered. */
  readonly eligible: boolean;
}

export interface AgentToolContract {
  readonly id: string;
  readonly schemaVersion: number;
  readonly description: string;
  readonly inputSchema: CanonicalAgentToolRootSchema;
  readonly outputSchema: CanonicalAgentToolRootSchema;
  readonly requiredCapabilities: readonly SedesCapability[];
  readonly effects: ToolEffects;
  readonly execution: ToolExecutionPolicy;
  readonly exposure: ToolExposurePolicy;
  /** Closed caller classes admitted to discover and execute this definition. */
  readonly callerEligibility: readonly AgentToolCallerKind[];
  /** Normalized grouping and display metadata; never an authorization grant. */
  readonly catalog: AgentToolCatalogPresentation;
  /** Required for new externally exposed definitions; optional for the T0 seam. */
  readonly deployment?: AgentToolDeploymentExposure;
  readonly adapters: AgentToolPresentations;
}

export interface SedesToolProgress {
  readonly invocationId: string;
  readonly revision: number;
  readonly phase: string;
  readonly message?: string;
  readonly percent?: number;
  readonly boundedData?: CanonicalJsonValue;
}

export interface SedesToolProgressUpdate {
  readonly phase: string;
  readonly message?: string;
  readonly percent?: number;
  readonly boundedData?: CanonicalJsonValue;
}

export type TrustedToolInvocationSubject =
  | {
      readonly kind: "thread_agent";
      readonly sourceThreadId: string;
      readonly backendKind: BackendKind;
    }
  | {
      readonly kind: "principal_client";
      readonly clientId: string;
      readonly credentialGeneration: number;
    };

export type TrustedAgentToolCallerDefaults =
  | {
      readonly kind: "thread_agent";
      readonly environmentId: string;
      readonly workspaceId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "principal_client";
      readonly environmentId: string;
      readonly workspaceId?: string;
      readonly threadId?: string;
    };

export type TrustedAgentToolPolicyIdentity =
  | {
      readonly ownerKind: "thread";
      readonly ownerId: string;
      readonly revision: number;
    }
  | {
      readonly ownerKind: "principal_client";
      readonly ownerId: string;
      readonly revision: number;
      readonly credentialGeneration: number;
    };

/**
 * Closed caller authority admitted before canonical execution. The flattened
 * invocation context remains ergonomic for definitions, while the canonical
 * boundary validates these four fields as one inseparable union.
 */
export type TrustedAgentToolAuthority =
  | {
      readonly subject: Extract<
        TrustedToolInvocationSubject,
        { readonly kind: "thread_agent" }
      >;
      readonly defaults: Extract<
        TrustedAgentToolCallerDefaults,
        { readonly kind: "thread_agent" }
      >;
      readonly policyIdentity: Extract<
        TrustedAgentToolPolicyIdentity,
        { readonly ownerKind: "thread" }
      >;
      readonly environmentAuthority: TrustedEnvironmentAuthorityGrant & {
        readonly callerKind: "thread_agent";
        readonly defaults: Extract<
          TrustedAgentToolCallerDefaults,
          { readonly kind: "thread_agent" }
        >;
        readonly policyIdentity: Extract<
          TrustedAgentToolPolicyIdentity,
          { readonly ownerKind: "thread" }
        >;
      };
    }
  | {
      readonly subject: Extract<
        TrustedToolInvocationSubject,
        { readonly kind: "principal_client" }
      >;
      readonly defaults: Extract<
        TrustedAgentToolCallerDefaults,
        { readonly kind: "principal_client" }
      >;
      readonly policyIdentity: Extract<
        TrustedAgentToolPolicyIdentity,
        { readonly ownerKind: "principal_client" }
      >;
      readonly environmentAuthority: TrustedEnvironmentAuthorityGrant & {
        readonly callerKind: "principal_client";
        readonly defaults: Extract<
          TrustedAgentToolCallerDefaults,
          { readonly kind: "principal_client" }
        >;
        readonly policyIdentity: Extract<
          TrustedAgentToolPolicyIdentity,
          { readonly ownerKind: "principal_client" }
        >;
      };
    };

export function assertTrustedAgentToolAuthority(authority: {
  readonly subject: TrustedToolInvocationSubject;
  readonly defaults: TrustedAgentToolCallerDefaults;
  readonly policyIdentity: TrustedAgentToolPolicyIdentity;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
}): asserts authority is TrustedAgentToolAuthority {
  const grant = authority.environmentAuthority;
  if (
    !grant.admittedEnvironmentIds.includes(authority.defaults.environmentId) ||
    grant.targetEnvironmentIds.some(
      (environmentId) => !grant.admittedEnvironmentIds.includes(environmentId),
    ) ||
    !sameDefaults(authority.defaults, grant.defaults) ||
    !samePolicyIdentity(authority.policyIdentity, grant.policyIdentity)
  ) {
    throw new Error("trusted_agent_tool_authority_incoherent");
  }
  if (authority.subject.kind === "thread_agent") {
    if (
      authority.defaults.kind !== "thread_agent" ||
      authority.policyIdentity.ownerKind !== "thread" ||
      grant.callerKind !== "thread_agent" ||
      grant.defaults.kind !== "thread_agent" ||
      grant.policyIdentity.ownerKind !== "thread" ||
      authority.subject.sourceThreadId !== authority.defaults.threadId ||
      authority.subject.sourceThreadId !== authority.policyIdentity.ownerId
    ) {
      throw new Error("trusted_agent_tool_authority_incoherent");
    }
    return;
  }
  if (
    authority.defaults.kind !== "principal_client" ||
    authority.policyIdentity.ownerKind !== "principal_client" ||
    grant.callerKind !== "principal_client" ||
    grant.defaults.kind !== "principal_client" ||
    grant.policyIdentity.ownerKind !== "principal_client" ||
    authority.subject.clientId !== authority.policyIdentity.ownerId ||
    authority.subject.credentialGeneration !==
      authority.policyIdentity.credentialGeneration
  ) {
    throw new Error("trusted_agent_tool_authority_incoherent");
  }
}

function sameDefaults(
  left: TrustedAgentToolCallerDefaults,
  right: TrustedAgentToolCallerDefaults,
): boolean {
  return (
    left.kind === right.kind &&
    left.environmentId === right.environmentId &&
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId
  );
}

function samePolicyIdentity(
  left: TrustedAgentToolPolicyIdentity,
  right: TrustedAgentToolPolicyIdentity,
): boolean {
  return (
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.revision === right.revision &&
    (left.ownerKind === "thread" || right.ownerKind === "thread"
      ? left.ownerKind === right.ownerKind
      : left.credentialGeneration === right.credentialGeneration)
  );
}

export interface TrustedToolInvocationContext {
  readonly invocationId: string;
  /** Fresh per execution and never exposed as transport retry identity. */
  readonly mutationId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly subject: TrustedToolInvocationSubject;
  readonly defaults: TrustedAgentToolCallerDefaults;
  readonly policyIdentity: TrustedAgentToolPolicyIdentity;
  readonly adapter: AgentToolAdapter;
  /** A frozen, sorted audit snapshot; authorization uses hasCapability. */
  readonly effectiveCapabilities: readonly SedesCapability[];
  readonly hasCapability: (capability: SedesCapability) => boolean;
  /** Server-resolved, invocation-specific environment authority. */
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
  readonly requestId: string;
  /** Cancels only this adapter's wait; it does not cancel accepted domain work. */
  readonly abortSignal: AbortSignal;
  /** The invocation service stamps invocation identity and monotonic revision. */
  readonly reportProgress: (
    update: SedesToolProgressUpdate,
  ) => void | Promise<void>;
}

export type TrustedCompletedToolReplayContext = Omit<
  TrustedToolInvocationContext,
  "abortSignal" | "reportProgress"
>;

export interface TrustedCapabilityAccess {
  readonly effectiveCapabilities: readonly SedesCapability[];
  readonly hasCapability: (capability: SedesCapability) => boolean;
}

export function createTrustedCapabilityAccess(
  capabilities: Iterable<SedesCapability>,
): TrustedCapabilityAccess {
  const supplied = [...capabilities];
  if (
    supplied.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.length === 0 ||
        capability.length > 128 ||
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(capability),
    )
  ) {
    throw new Error("trusted_capability_invalid");
  }
  const sorted = [...new Set(supplied)].sort();
  const lookup = new Set(sorted);
  return Object.freeze({
    effectiveCapabilities: Object.freeze(sorted),
    hasCapability: (capability: SedesCapability) => lookup.has(capability),
  });
}

export interface SedesToolInvocationRequest {
  readonly toolId: string;
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly input: unknown;
}

export type ToolInvocationState =
  | "prepared"
  | "accepted"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancel_requested"
  | "cancelled";

export type SedesToolErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "uncertain_outcome"
  | "internal_error";

export interface SedesToolError {
  readonly code: SedesToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: CanonicalJsonValue;
}

export type SedesToolInvocationResult<Output> =
  | {
      readonly invocationId: string;
      readonly state: "completed";
      readonly output: Output;
    }
  | {
      readonly invocationId: string;
      readonly state:
        "accepted" | "running" | "waiting_for_input" | "cancel_requested";
      readonly operationId: string;
      readonly retryAfterMilliseconds?: number;
    }
  | {
      readonly invocationId: string;
      readonly state: "failed" | "uncertain" | "cancelled";
      readonly error: SedesToolError;
      readonly operationId?: string;
    };

export interface SedesToolExecutor {
  invoke<Output = unknown>(
    request: SedesToolInvocationRequest,
    context: TrustedToolInvocationContext,
  ): Promise<SedesToolInvocationResult<Output>>;
}

export interface AcceptedToolOperation<Output> {
  readonly state: "accepted";
  readonly operationId: string;
  readonly output?: Output;
}

export interface AgentToolDefinition<
  Input = unknown,
  Output = unknown,
> extends AgentToolContract {
  /** Explicit reach declaration; effects never imply environment authority. */
  readonly environmentAuthority: EnvironmentAuthorityDeclaration;
  execute(
    input: Input,
    context: TrustedToolInvocationContext,
  ): Promise<Output | AcceptedToolOperation<Output>>;
  /**
   * Reconstructs a completed, side-effect-free result from immutable trusted
   * context. It must not re-enter domain/business execution.
   */
  reconstructCompleted?(
    input: Input,
    context: TrustedCompletedToolReplayContext,
  ): Output | Promise<Output>;
}

export interface AgentToolContractArtifact extends AgentToolContract {
  readonly artifactVersion: 2;
}

/** Compact, policy-filtered discovery metadata safe for model consumption. */
export interface AgentToolCatalogSummary {
  readonly id: string;
  readonly schemaVersion: number;
  readonly label: string;
  readonly description: string;
  readonly group: {
    readonly id: AgentToolGroupId;
    readonly order: number;
  };
  readonly effects: ToolEffects;
  /** Live named command derived from the registered CLI adapter identity. */
  readonly cli?: {
    readonly commandPath: readonly string[];
  };
}

/** The complete public contract resolved for one requesting adapter. */
export interface AgentToolDescription {
  readonly id: string;
  readonly schemaVersion: number;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: CanonicalAgentToolRootSchema;
  readonly outputSchema: CanonicalAgentToolRootSchema;
  readonly effects: ToolEffects;
  readonly execution: {
    readonly form: "inline" | "operation" | "hybrid";
    readonly waitCeilingMilliseconds: number;
    readonly supportsCancellation: boolean;
    readonly idempotency: "required" | "supported" | "not_applicable";
    readonly progress: "none" | "structured";
    readonly maximumInputBytes: number;
    readonly maximumOutputBytes: number;
    readonly uncertainExternalOutcome: boolean;
  };
}
