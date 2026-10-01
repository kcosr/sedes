import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenCodeUsageAccounting } from "./opencode-usage-accounting.js";
import type { OpenCodeAgentTools } from "./opencode-agent-tools.js";
import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type AttachConversationInput, type DiscoverConversationsInput } from "../contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { parseOpenCodeBindingDetail, serializeOpenCodeBindingDetail, type OpenCodeBindingDetail } from "./opencode-binding-detail.js";
import type { OpenCodeRuntime } from "./opencode-runtime.js";
import type { OpenCodeThreadRepository } from "./opencode-thread-repository.js";
import type { OpenCodeThreadSettingsRepository } from "./opencode-thread-settings-repository.js";
import type { OpenCodeModelCatalog } from "./opencode-model-catalog.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { OpenCodeExecutionEnvironment } from "./opencode-execution-environment.js";
import type { OpenCodeSkillCatalog } from "./opencode-skill-catalog.js";
import type { OutputArtifactPublisher } from "../../output-artifacts/contracts.js";

export type OpenCodeConversationRuntime = Pick<OpenCodeRuntime,
  "nativeNamespaceKey" | "start" | "health" | "snapshot" | "acquire" | "assertCurrent" | "admitToolSession" | "releaseToolSession">;

export interface OpenCodeDriverContext {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly nativeNamespaceKey: string;
  readonly repository: OpenCodeThreadRepository;
  readonly settings: OpenCodeThreadSettingsRepository;
  readonly catalog: OpenCodeModelCatalog;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly usage: OpenCodeUsageAccounting;
  readonly executionEnvironment: OpenCodeExecutionEnvironment;
  readonly skills: OpenCodeSkillCatalog;
  readonly tools: Pick<OpenCodeAgentTools, "admit" | "release" | "diagnostic" | "gatewayAction" | "cliAdmission">;
  readonly attachmentProvenanceKey: Uint8Array;
  readonly outputArtifacts: OutputArtifactPublisher;
  readonly runtime: () => Promise<OpenCodeConversationRuntime>;
  /** An ordered health observation, including failures hidden by normalized health. */
  readonly observeHealth?: () => (failure: unknown) => void;
}

/** Reject cross-scope targets before acquiring or launching a native runtime. */
export function assertOpenCodeWorkspace(context: OpenCodeDriverContext,
  input: Pick<DiscoverConversationsInput, "scope" | "workspace">): void {
  if (input.scope.tenantId !== context.scope.tenantId || input.scope.principalId !== context.scope.principalId ||
      context.instance.tenantId !== context.scope.tenantId || context.instance.kind !== "opencode" || !context.instance.enabled ||
      context.connection.tenantId !== context.scope.tenantId || context.connection.ownerPrincipalId !== context.scope.principalId ||
      context.connection.backendInstanceId !== context.instance.id || context.connection.kind !== "opencode_http" || !context.connection.enabled ||
      input.workspace.summary.environmentId !== context.connection.executionEnvironmentId ||
      !path.posix.isAbsolute(input.workspace.canonicalPath) || path.posix.normalize(input.workspace.canonicalPath) !== input.workspace.canonicalPath ||
      input.workspace.canonicalPath.includes("\0") || input.workspace.canonicalPath.length > 4_096) {
    throw openCodeConversationError("opencode_conversation_authority_invalid", "The OpenCode conversation target does not match its authority.", "permission_denied");
  }
}

export function requireOpenCodeBinding(context: OpenCodeDriverContext,
  input: Pick<AttachConversationInput, "scope" | "workspace" | "binding" | "opaqueBindingDetail">): Readonly<OpenCodeBindingDetail> {
  assertOpenCodeWorkspace(context, input);
  const binding = input.binding;
  try {
    const detail = parseOpenCodeBindingDetail(input.opaqueBindingDetail);
    if (binding.tenantId !== context.scope.tenantId || binding.ownerPrincipalId !== context.scope.principalId ||
        binding.backendInstanceId !== context.instance.id || binding.connectionProfileId !== context.connection.id ||
        binding.executionEnvironmentId !== context.connection.executionEnvironmentId ||
        detail.tenantId !== binding.tenantId || detail.principalId !== binding.ownerPrincipalId ||
        detail.backendInstanceId !== binding.backendInstanceId || detail.connectionProfileId !== binding.connectionProfileId ||
        detail.executionEnvironmentId !== binding.executionEnvironmentId || detail.sessionId !== binding.backendConversationId ||
        detail.canonicalWorkspacePath !== input.workspace.canonicalPath || detail.nativeNamespaceKey !== context.nativeNamespaceKey) throw new Error();
    const persisted = context.repository.getBinding(input.scope, binding.applicationThreadId);
    const admitted = persisted ?? serializeOpenCodeBindingDetail(context.repository.requireProvisionalBinding(
      input.scope, binding.applicationThreadId, binding.backendConversationId).detail);
    if (admitted !== serializeOpenCodeBindingDetail(detail)) throw new Error();
    return detail;
  } catch {
    throw openCodeConversationError("opencode_binding_authority_invalid", "The OpenCode conversation binding is unavailable.", "permission_denied");
  }
}

/** A native port is always scoped to a workspace and, for a bound thread, its exact binding. */
export function openCodeRuntimeTarget(input: Pick<AttachConversationInput, "workspace" | "binding" | "opaqueBindingDetail">) {
  return { directory: input.workspace.canonicalPath, session: {
    applicationThreadId: input.binding.applicationThreadId,
    nativeSessionID: input.binding.backendConversationId,
    bindingFingerprint: createHash("sha256").update(serializeOpenCodeBindingDetail(parseOpenCodeBindingDetail(input.opaqueBindingDetail))).digest("hex"),
  } };
}

export function openCodeConversationError(code: string, message: string,
  category: BackendError["category"] = "unavailable", retryable = false): BackendError {
  return new BackendError({ category, retryable, crossedSubmissionBoundary: false, backendCode: code, safeMessage: message });
}
