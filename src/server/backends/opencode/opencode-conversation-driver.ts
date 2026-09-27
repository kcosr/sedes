import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type BackendHealth, type ConversationBackendDriver } from "../contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/** Runtime admission is implemented separately from the M2/M3 conversation adapter. */
export class OpenCodeConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  constructor(readonly input: { scope: RequestScope; instance: AgentBackendInstance; connection: AgentConnectionProfile; health(): Promise<BackendHealth> }) {
    this.instance = input.instance; this.connection = input.connection;
  }
  health(): Promise<BackendHealth> { return this.input.health(); }
  async catalog(..._input: Parameters<ConversationBackendDriver["catalog"]>): Promise<never> { throw unavailable(); }
  async discover(..._input: Parameters<ConversationBackendDriver["discover"]>): Promise<never> { throw unavailable(); }
  async create(..._input: Parameters<ConversationBackendDriver["create"]>): Promise<never> { throw unavailable(); }
  async attach(..._input: Parameters<ConversationBackendDriver["attach"]>): Promise<never> { throw unavailable(); }
  async read(..._input: Parameters<ConversationBackendDriver["read"]>): Promise<never> { throw unavailable(); }
  async resolveBranchCheckpoint(..._input: Parameters<ConversationBackendDriver["resolveBranchCheckpoint"]>): Promise<never> { throw unavailable(); }
  async branchConversation(..._input: Parameters<ConversationBackendDriver["branchConversation"]>): Promise<never> { throw unavailable(); }
  async reconcileSubmission(..._input: Parameters<ConversationBackendDriver["reconcileSubmission"]>): Promise<never> { throw unavailable(); }
  async releaseConversationResidency(..._input: Parameters<NonNullable<ConversationBackendDriver["releaseConversationResidency"]>>): Promise<never> { throw unavailable(); }
}
function unavailable(): BackendError {
  return new BackendError({ category: "unavailable", retryable: false, crossedSubmissionBoundary: false,
    backendCode: "opencode_conversation_integration_unavailable", safeMessage: "OpenCode conversation integration is unavailable." });
}
