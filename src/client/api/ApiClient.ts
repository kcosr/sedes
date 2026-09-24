import { usageReportSchema, usageAvailabilitySchema, usageAvailabilityRequestSchema, type UsageAvailability, type UsageReport } from "../../shared/protocol/usage-accounting.js";
import { usageAnalyticsRequestSchema, usageAnalyticsResponseSchema, type UsageAnalyticsRequest, type UsageAnalyticsResponse } from "../../shared/protocol/usage-analytics.js";
import {
  environmentVariablesPreviewQuerySchema,
  environmentVariablesPreviewResultSchema,
  threadEnvironmentVariablesResultSchema,
  type EnvironmentVariablesPreviewQuery,
  type EnvironmentVariablesPreviewResult,
  type ThreadEnvironmentVariablesResult,
} from "../../shared/protocol/environment-variables.js";
import { listProjectsResultSchema, projectSummarySchema, removeProjectRequestSchema,
  type ListProjectsResult, type ProjectSummary, type RemoveProjectRequest } from "../../shared/index.js";
import { authenticatedFetch } from "../authentication/auth-transport.js";
import {
  workpadSchema, workpadRevisionSchema, workpadDraftSchema, workpadListPageSchema, workpadRevisionPageSchema,
  type CreateWorkpadRequest, type UpdateWorkpadRequest, type ListWorkpadsRequest,
  type SaveWorkpadDraftRequest, type CommitWorkpadDraftRequest,
} from "../../shared/protocol/workpads.js";
import { respondToQuestionResultSchema, type RespondToQuestionResult } from "../../shared/protocol/api.js";
import {
  questionRequestsResultSchema,
  questionStatusesResultSchema,
  type QuestionStatusesResult,
  type QuestionRequestsResult,
  type RespondToQuestionRequest,
  type DismissQuestionRequest,
} from "../../shared/protocol/questions.js";
import {
  notificationSettingsSchema,
  notificationTestResultSchema,
  updateNotificationSettingsRequestSchema,
  testNotificationRequestSchema,
  type NotificationSettings,
  type UpdateNotificationSettingsRequest,
  type TestNotificationRequest,
  type NotificationTestResult,
} from "../../shared/protocol/notification.js";
import { z } from "zod";
import {
  hostPairingListSchema, hostRegistrationSchema, acceptHostRegistrationRequestSchema,
  denyHostRegistrationRequestSchema, changeHostPairingRequestSchema,
  acceptHostRegistrationResultSchema, changeHostPairingResultSchema,
  type HostPairingList, type HostRegistration, type AcceptHostRegistrationRequest,
  type DenyHostRegistrationRequest, type ChangeHostPairingRequest,
  type AcceptHostRegistrationResult, type ChangeHostPairingResult,
} from "../../shared/protocol/host-pairing.js";
import {
  configurationSnapshotSchema,
  saveConfigurationRequestSchema,
  configurationLifecycleImpactRequestSchema,
  configurationLifecycleImpactSchema,
  configurationLifecycleRequestSchema,
  configurationLifecycleResultSchema,
  type ConfigurationSnapshot,
  type SaveConfigurationRequest,
  type ConfigurationLifecycleImpactRequest,
  type ConfigurationLifecycleImpact,
  type ConfigurationLifecycleRequest,
  type ConfigurationLifecycleResult,
} from "../../shared/protocol/configuration-admin.js";
import {
  configurationOperationRecoveryReferenceSchema,
  configurationOperationRecoveryListSchema,
  configurationOperationRecoveryInspectionSchema,
  configurationOperationRecoveryAcknowledgeRequestSchema,
  configurationOperationRecoveryAcknowledgmentSchema,
  type ConfigurationOperationRecoveryReference,
  type ConfigurationOperationRecoverySummary,
  type ConfigurationOperationRecoveryInspection,
  type ConfigurationOperationRecoveryAcknowledgeRequest,
} from "../../shared/protocol/configuration-operation-recovery.js";
import {
  automationPrecheckTestResultSchema,
  pageResultSchema,
  threadAutomationDefinitionSchema,
  threadAutomationRunSchema,
  threadAutomationSchedulePreviewSchema,
} from "../../shared/protocol/automation-presentation.js";
import {
  apiErrorSchema,
  savedAgentDeleteResultSchema,
  savedAgentListPageSchema,
  savedAgentMutationResultSchema,
  savedAgentOptionsResultSchema,
  savedAgentSchema,
  threadTemplateDeleteResultSchema,
  threadTemplateListPageSchema,
  threadTemplateMutationResultSchema,
  threadTemplateSchema,
  resolveSavedAgentResultSchema,
  createThreadRequestSchema,
  createThreadFromSettingsRequestSchema,
  createThreadResultSchema,
  composerSkillCatalogSchema,
  normalizedApplicationSessionSchema,
  normalizedThreadDescendantsPageSchema,
  normalizedThreadLineagePlacementSchema,
  normalizedDraftSchema,
  normalizedStashSchema,
  putComposerAttachmentResultSchema,
  forkThreadRequestSchema,
  forkThreadResultSchema,
  threadEventEnvelopeSchema,
  threadHistorySeekResultSchema,
  threadApplicationMutationResultSchema,
  threadDeliveryMutationResultSchema,
  threadQueueMutationResultSchema,
  threadApplicationOperationSchema,
  threadArchiveImpactSchema,
  bulkInventoryImpactRequestSchema,
  bulkInventoryImpactSchema,
  bulkInventoryMutationRequestSchema,
  bulkInventoryMutationResultSchema,
  threadExecutionWorkspaceResourceSchema,
  deleteThreadExecutionWorkspaceRequestSchema,
  deleteThreadExecutionWorkspaceResultSchema,
  importThreadExecutionWorkspaceRequestSchema,
  importThreadExecutionWorkspaceResultSchema,
  handoffThreadExecutionWorkspaceRequestSchema,
  handoffThreadExecutionWorkspaceResultSchema,
  threadForceResetImpactSchema,
  threadForceResetRequestSchema,
  threadForceResetResultSchema,
  threadArchiveMutationResultSchema,
  SEDES_CLIENT_PROTOCOL_VERSION,
  type ActivityDetailMode,
  type NormalizedApplicationSession,
  type CreateThreadRequest,
  type CreateThreadFromSettingsRequest,
  type CreateThreadResult,
  type CreateSavedAgentRequest,
  type DeleteSavedAgentRequest,
  type ResolveSavedAgentRequest,
  type ResolveSavedAgentResult,
  type SavedAgent,
  type SavedAgentBackendTypeId,
  type SavedAgentDeleteResult,
  type SavedAgentListPage,
  type SavedAgentOptionsRequest,
  type SavedAgentOptionsResult,
  type CreateThreadTemplateRequest,
  type DeleteThreadTemplateRequest,
  type ThreadTemplate,
  type ThreadTemplateDeleteResult,
  type ThreadTemplateListPage,
  type UpdateThreadTemplateRequest,
  type UpdateSavedAgentRequest,
  type NormalizedThreadDescendantsPage,
  type NormalizedThreadLineagePlacement,
  type NormalizedDraft,
  type NormalizedStash,
  type ComposerAttachmentDescriptor,
  type ComposerSkillCatalog,
  type ForkThreadRequest,
  type ForkThreadResult,
  type ThreadEventEnvelope,
  type ThreadHistorySeekResult,
  type ThreadApplicationMutationResult,
  type ThreadApplicationOperation,
  type ThreadArchiveImpact,
  type BulkInventoryImpactRequest,
  type BulkInventoryImpact,
  type BulkInventoryMutationRequest,
  type BulkInventoryMutationResult,
  type ThreadExecutionWorkspaceResource,
  type DeleteThreadExecutionWorkspaceRequest,
  type DeleteThreadExecutionWorkspaceResult,
  type ImportThreadExecutionWorkspaceRequest,
  type ImportThreadExecutionWorkspaceResult,
  type HandoffThreadExecutionWorkspaceRequest,
  type HandoffThreadExecutionWorkspaceResult,
  type ThreadForceResetImpact,
  type ThreadForceResetResult,
  type ThreadArchiveMutationResult,
  type ListTurnBookmarksResult,
  type SetTurnBookmarkRequest,
  type SetTurnBookmarkResult,
  type LoadThreadHistoryRequest,
  type UpdateThreadPinRequest,
  type UpdateThreadGroupAssignmentRequest,
  type UpdateThreadGroupRequest,
  type ThreadGroupMutationResult,
  threadGroupMutationResultSchema,
  listTurnBookmarksResultSchema,
  setTurnBookmarkResultSchema,
  taskMutationResultSchema,
  workspaceFileContentResultSchema,
  workspaceFileLinkResolveRequestSchema,
  workspaceFileLinkResolveResultSchema,
  workspaceFileListResultSchema,
  workspaceFileDirectoryResultSchema,
  workspaceFileRootCreateRequestSchema,
  workspaceFileRootCreateResultSchema,
  workspaceFileRootDeleteRequestSchema,
  workspaceFileRootDeleteResultSchema,
  workspaceFileRootsResultSchema,
  workspaceFileStatusResultSchema,
  workspaceFileWriteRequestSchema,
  workspaceFileWriteResultSchema,
  workspaceDiffChangedFilesQuerySchema,
  workspaceDiffChangedFilesResultSchema,
  workspaceDiffComparisonCreateRequestSchema,
  workspaceDiffComparisonCreateResultSchema,
  workspaceDiffFileContentRequestSchema,
  workspaceDiffFileContentResultSchema,
  workspaceDiffFileRequestSchema,
  workspaceDiffPatchResultSchema,
  workspaceDiffRefCatalogQuerySchema,
  workspaceDiffRefCatalogResultSchema,
  workspaceDiffRepositoriesResultSchema,
  threadPreferredWorktreeUpdateRequestSchema,
  threadPreferredWorktreeUpdateResultSchema,
  workspaceLinkedWorktreeDeleteRequestSchema,
  workspaceLinkedWorktreeDeleteResultSchema,
  workspaceDiffReviewCommentCreateRequestSchema,
  workspaceDiffReviewCommentDeleteRequestSchema,
  workspaceDiffReviewCommentUpdateRequestSchema,
  workspaceDiffReviewCommentsResultSchema,
  workspaceDiffReviewListQuerySchema,
  workspaceDiffReviewListResultSchema,
  workspaceDiffReviewMutationResultSchema,
  workspaceDiffReviewOpenRequestSchema,
  workspaceDiffReviewSchema,
  workspaceDiffReviewUpdateRequestSchema,
  workspaceDiffReviewedFileMutationResultSchema,
  workspaceDiffReviewedFileSetRequestSchema,
  workspaceDiffReviewedFilesResultSchema,
  workspaceDiffReviewRepositoryListQuerySchema,
  providerPulseCheckAllResultSchema,
  providerPulseOperationReceiptSchema,
  providerPulseSnapshotResultSchema,
  providerPulseStatusSchema,
  type ProviderPulseOperationReceipt,
  type ProviderPulseStatus,
  type CreateTaskRequest,
  type MoveTaskRequest,
  directoryBrowseRequestSchema,
  directoryBrowseResultSchema,
  type DirectoryBrowseRequest,
  type DirectoryBrowseResult,
  type Task,
  type UpdateTaskRequest,
  type WorkspaceFileContentResult,
  type WorkspaceFileLinkReference,
  type WorkspaceFileLinkResolveResult,
  type WorkspaceFileListResult,
  type WorkspaceFileDirectoryPath,
  type WorkspaceFileDirectoryResult,
  type WorkspaceFileRootCreateRequest,
  type WorkspaceFileRootCreateResult,
  type WorkspaceFileRootDeleteRequest,
  type WorkspaceFileRootDeleteResult,
  type WorkspaceFileRootId,
  type WorkspaceFileSupplementalRootId,
  type WorkspaceFileRootsResult,
  type WorkspaceFileStatusResult,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResult,
  type ThreadPreferredWorktreeUpdateRequest,
  type ThreadPreferredWorktreeUpdateResult,
  type WorkspaceFileLinkedWorktreeRootId,
  type WorkspaceLinkedWorktreeDeleteRequest,
  type WorkspaceLinkedWorktreeDeleteResult,
  type WorkspaceDiffChangedFilesQuery,
  type WorkspaceDiffChangedFilesResult,
  type WorkspaceDiffComparisonCreateRequest,
  type WorkspaceDiffComparisonCreateResult,
  type WorkspaceDiffFileContentRequest,
  type WorkspaceDiffFileContentResult,
  type WorkspaceDiffFileRequest,
  type WorkspaceDiffPatchResult,
  type WorkspaceDiffRefCatalogQuery,
  type WorkspaceDiffRefCatalogResult,
  type WorkspaceDiffRepositoriesResult,
  type WorkspaceDiffReview,
  type WorkspaceDiffReviewCommentCreateRequest,
  type WorkspaceDiffReviewCommentDeleteRequest,
  type WorkspaceDiffReviewCommentUpdateRequest,
  type WorkspaceDiffReviewCommentsResult,
  type WorkspaceDiffReviewListQuery,
  type WorkspaceDiffReviewListResult,
  type WorkspaceDiffReviewMutationResult,
  type WorkspaceDiffReviewOpenRequest,
  type WorkspaceDiffReviewUpdateRequest,
  type WorkspaceDiffReviewedFileMutationResult,
  type WorkspaceDiffReviewedFileSetRequest,
  type WorkspaceDiffReviewedFilesResult,
  type WorkspaceDiffReviewRepositoryListQuery,
  createToolClientRequestSchema,
  replaceToolClientRequestSchema,
  toolClientCreationConflictSchema,
  toolClientCredentialResultSchema,
  toolClientListPageSchema,
  toolClientOptionsSchema,
  toolClientRevisionRequestSchema,
  toolClientSchema,
  type CreateToolClientRequest,
  type ReplaceToolClientRequest,
  type ToolClient,
  type ToolClientCredentialResult,
  type ToolClientListPage,
  type ToolClientOptions,
  TERMINAL_WEBSOCKET_PATH,
  createTerminalRequestSchema,
  createTerminalAdmissionRequestSchema,
  renameTerminalRequestSchema,
  terminalAdmissionSchema,
  terminalListResultSchema,
  terminalMutationRequestSchema,
  terminalMutationResultSchema,
  terminalResourceSchema,
  type CreateTerminalAdmissionRequest,
  type CreateTerminalRequest,
  type TerminalAdmission,
  type TerminalListResult,
  type TerminalResource,
} from "../../shared/index.js";
import { WORKSPACE_FILE_MAX_DOWNLOAD_BYTES } from "../../shared/workspace-file-limits.js";
import { SEDES_VERSION } from "../../shared/version.js";
import {
  applicationPreferencesSchema,
  updateApplicationPreferencesRequestSchema,
  type ApplicationPreferences,
  type UpdateApplicationPreferencesRequest,
} from "../../shared/protocol/application-preferences.js";
import {
  cannedPromptLibrarySchema,
  cannedPromptMutationResultSchema,
  createCannedPromptRequestSchema,
  deleteCannedPromptRequestSchema,
  reorderCannedPromptsRequestSchema,
  updateCannedPromptRequestSchema,
  type CannedPromptLibrary,
  type CannedPromptMutationResult,
  type CreateCannedPromptRequest,
  type DeleteCannedPromptRequest,
  type ReorderCannedPromptsRequest,
  type UpdateCannedPromptRequest,
} from "../../shared/protocol/canned-prompts.js";
import type {
  AutomationPrecheck,
  AutomationPrecheckTestResult,
  PageResult,
  ThreadAutomationDefinition,
  ThreadAutomationRun,
  ThreadAutomationSchedulePreview,
} from "../types.js";
import type { AutomationSchedule } from "../../shared/protocol/automation.js";
import type {
  AutomationMisfirePolicy,
  AutomationRunMode,
} from "../../shared/protocol/domain.js";
import {
  endpointUsesCrossOriginTransport,
  resolveSedesServerUrl,
  resolveSedesServerWebSocketUrl,
  sameOriginSedesServer,
  type SedesServerEndpoint,
} from "../app/server-endpoint.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

function workspaceFileDownloadPreflightError(status: number): ApiError {
  if (status === 409) {
    return new ApiError(
      status,
      "workspace_file_revision_conflict",
      "The file changed on disk. Refresh it before downloading.",
      false,
    );
  }
  if (status === 413) {
    return new ApiError(
      status,
      "workspace_file_download_too_large",
      "This file is larger than the download limit.",
      false,
    );
  }
  return new ApiError(
    status,
    "workspace_file_download_unavailable",
    "The file could not be prepared for download.",
    status >= 500,
  );
}

const idResponseSchema = z.object({ id: z.string().min(1).max(160) });
const compositionResponseSchema = z.strictObject({
  draft: normalizedDraftSchema,
  stashes: z.array(normalizedStashSchema),
});
const stashesResponseSchema = z.strictObject({
  stashes: z.array(normalizedStashSchema),
});
/**
 * Diagnostic probe for an application-session body this build could not parse.
 * It is deliberately not the normalized session contract: it reads only the
 * two fields needed to render an actionable protocol-mismatch remedy, and the
 * server version stays optional because a server older than this field reports
 * none.
 */
const clientProtocolVersionResponseSchema = z.object({
  clientProtocolVersion: z.number().int(),
  version: z.string().min(1).max(64).optional(),
});
const codexTuiAdmissionSchema = z.strictObject({
  token: z
    .string()
    .min(32)
    .max(2_048)
    .regex(/^[A-Za-z0-9_-]+$/u),
  expiresAt: z.iso.datetime(),
  resourceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type CodexTuiAdmission = z.infer<typeof codexTuiAdmissionSchema>;

export interface PreparedWorkspaceFileDownload {
  /** Exact GET URL validated by the preflight request. */
  readonly url: string;
  readonly serverOrigin: string;
  readonly contentDisposition: string;
  readonly contentLength: number;
  readonly revision: string;
}

export class ApiClient {
  readonly #endpoint: SedesServerEndpoint;
  readonly #credentialOverride: string | null | undefined;
  #csrfToken = "";
  #sessionSequence = 0;
  #appliedSessionSequence = 0;
  #sessionPromise?: Promise<NormalizedApplicationSession>;

  constructor(endpoint: SedesServerEndpoint = sameOriginSedesServer, credentialOverride?: string | null) {
    this.#endpoint = endpoint;
    this.#credentialOverride = credentialOverride;
  }

  #fetch(path: string, init: RequestInit): Promise<Response> {
    return authenticatedFetch(this.#endpoint, path, init, this.#credentialOverride);
  }

  session(options?: {
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<NormalizedApplicationSession> {
    if (options?.refresh || !this.#sessionPromise) {
      const sequence = ++this.#sessionSequence;
      this.#sessionPromise = this.#request(
        "/api/application/session",
        { signal: options?.signal },
        normalizedApplicationSessionSchema,
      ).then((session) => {
        if (sequence > this.#appliedSessionSequence) {
          this.#csrfToken = session.csrfToken;
          this.#appliedSessionSequence = sequence;
        }
        return session;
      });
    }
    return this.#sessionPromise;
  }

  readProviderPulseStatus(signal?: AbortSignal): Promise<ProviderPulseStatus> {
    return this.#request(
      "/api/provider-pulse/status",
      { signal },
      providerPulseStatusSchema,
    );
  }

  checkProviderPulseAccount(
    accountId: string,
  ): Promise<ProviderPulseOperationReceipt> {
    return this.#mutation(
      `/api/provider-pulse/accounts/${encodeURIComponent(accountId)}/check`,
      providerPulseOperationReceiptSchema,
      { method: "POST", body: "{}" },
    );
  }

  checkAllProviderPulseAccounts(): Promise<{
    receipts: readonly ProviderPulseOperationReceipt[];
  }> {
    return this.#mutation(
      "/api/provider-pulse/check-all",
      providerPulseCheckAllResultSchema,
      { method: "POST", body: "{}" },
    );
  }

  snapshotProviderPulseUsage(): Promise<{
    usageBaseline: ProviderPulseStatus["usageBaseline"];
  }> {
    return this.#mutation(
      "/api/provider-pulse/snapshot",
      providerPulseSnapshotResultSchema,
      { method: "POST", body: "{}" },
    );
  }

  readNotificationSettings(
    signal?: AbortSignal,
  ): Promise<NotificationSettings> {
    return this.#request(
      "/api/application/notifications",
      { signal },
      notificationSettingsSchema,
    );
  }

  updateNotificationSettings(
    input: UpdateNotificationSettingsRequest,
  ): Promise<NotificationSettings> {
    const request = updateNotificationSettingsRequestSchema.parse(input);
    return this.#mutation(
      "/api/application/notifications",
      notificationSettingsSchema,
      { method: "PUT", body: JSON.stringify(request) },
    );
  }

  setNotificationSilenced(silenced: boolean): Promise<NotificationSettings> {
    return this.#mutation(
      "/api/application/notifications/silence",
      notificationSettingsSchema,
      { method: "PUT", body: JSON.stringify({ silenced }) },
    );
  }

  testNotification(
    input: TestNotificationRequest,
  ): Promise<NotificationTestResult> {
    const request = testNotificationRequestSchema.parse(input);
    return this.#mutation(
      "/api/application/notifications/test",
      notificationTestResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  readApplicationPreferences(): Promise<ApplicationPreferences> {
    return this.#request(
      "/api/application/preferences",
      {},
      applicationPreferencesSchema,
    );
  }

  outboundConnectorSetup(): { readonly serverUrl: string; readonly downloadUrl: string } {
    return { serverUrl: this.#endpoint.baseUrl ?? window.location.origin,
      downloadUrl: resolveSedesServerUrl(this.#endpoint, "/api/outbound/connector/sedes-sidecar.mjs") };
  }

  listHostRegistrations(signal?: AbortSignal): Promise<HostPairingList> {
    return this.#request("/api/host-registrations", { signal }, hostPairingListSchema);
  }

  acceptHostRegistration(input: AcceptHostRegistrationRequest, signal?: AbortSignal): Promise<AcceptHostRegistrationResult> {
    const request = acceptHostRegistrationRequestSchema.parse(input);
    return this.#mutation("/api/host-registrations/accept", acceptHostRegistrationResultSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  denyHostRegistration(input: DenyHostRegistrationRequest, signal?: AbortSignal): Promise<HostRegistration> {
    const request = denyHostRegistrationRequestSchema.parse(input);
    return this.#mutation("/api/host-registrations/deny", hostRegistrationSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  revokeHostPairing(input: ChangeHostPairingRequest, signal?: AbortSignal): Promise<ChangeHostPairingResult> {
    const request = changeHostPairingRequestSchema.parse(input);
    return this.#mutation("/api/host-pairings/revoke", changeHostPairingResultSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  reapproveHostPairing(input: ChangeHostPairingRequest, signal?: AbortSignal): Promise<ChangeHostPairingResult> {
    const request = changeHostPairingRequestSchema.parse(input);
    return this.#mutation("/api/host-pairings/reapprove", changeHostPairingResultSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  readConfiguration(signal?: AbortSignal): Promise<ConfigurationSnapshot> {
    return this.#request("/api/configuration", { signal }, configurationSnapshotSchema);
  }

  saveConfiguration(input: SaveConfigurationRequest, signal?: AbortSignal): Promise<ConfigurationSnapshot> {
    const request = saveConfigurationRequestSchema.parse(input);
    return this.#mutation("/api/configuration", configurationSnapshotSchema,
      { method: "PUT", body: JSON.stringify(request), signal });
  }

  configurationLifecycleImpact(input: ConfigurationLifecycleImpactRequest, signal?: AbortSignal): Promise<ConfigurationLifecycleImpact> {
    const request = configurationLifecycleImpactRequestSchema.parse(input);
    return this.#mutation("/api/configuration/lifecycle/impact", configurationLifecycleImpactSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  configurationLifecycle(input: ConfigurationLifecycleRequest, signal?: AbortSignal): Promise<ConfigurationLifecycleResult> {
    const request = configurationLifecycleRequestSchema.parse(input);
    return this.#mutation("/api/configuration/lifecycle", configurationLifecycleResultSchema,
      { method: "POST", body: JSON.stringify(request), signal });
  }

  getLifecycleReceipt(mutationId: string, signal?: AbortSignal): Promise<ConfigurationLifecycleResult> {
    const id = configurationLifecycleRequestSchema.shape.mutationId.parse(mutationId);
    return this.#request(`/api/configuration/lifecycle/${id}`, { signal }, configurationLifecycleResultSchema);
  }

  listConfigurationOperations(environmentId: string, signal?: AbortSignal): Promise<{ receipts: ConfigurationOperationRecoverySummary[] }> {
    return this.#request(`/api/configuration/environments/${encodeURIComponent(environmentId)}/operations`, { signal }, configurationOperationRecoveryListSchema);
  }

  inspectConfigurationOperation(environmentId: string, input: ConfigurationOperationRecoveryReference, signal?: AbortSignal): Promise<ConfigurationOperationRecoveryInspection> {
    const reference = configurationOperationRecoveryReferenceSchema.parse(input);
    return this.#request(`/api/configuration/environments/${encodeURIComponent(environmentId)}/operations/${reference.kind}/${reference.receiptId}`,
      { signal }, configurationOperationRecoveryInspectionSchema);
  }

  acknowledgeConfigurationOperation(environmentId: string, input: ConfigurationOperationRecoveryReference, rawRequest: ConfigurationOperationRecoveryAcknowledgeRequest, signal?: AbortSignal): Promise<{ acknowledged: boolean }> {
    const reference = configurationOperationRecoveryReferenceSchema.parse(input);
    const request = configurationOperationRecoveryAcknowledgeRequestSchema.parse(rawRequest);
    return this.#mutation(`/api/configuration/environments/${encodeURIComponent(environmentId)}/operations/${reference.kind}/${reference.receiptId}/acknowledge`,
      configurationOperationRecoveryAcknowledgmentSchema, { method: "POST", body: JSON.stringify(request), signal });
  }

  updateApplicationPreferences(
    rawRequest: UpdateApplicationPreferencesRequest,
  ): Promise<ApplicationPreferences> {
    const request = updateApplicationPreferencesRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/application/preferences",
      applicationPreferencesSchema,
      { method: "PUT", body: JSON.stringify(request) },
    );
  }

  listCannedPrompts(signal?: AbortSignal): Promise<CannedPromptLibrary> {
    return this.#request(
      "/api/application/canned-prompts",
      { signal },
      cannedPromptLibrarySchema,
    );
  }

  createCannedPrompt(
    rawRequest: CreateCannedPromptRequest,
    signal?: AbortSignal,
  ): Promise<CannedPromptMutationResult> {
    const request = createCannedPromptRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/application/canned-prompts",
      cannedPromptMutationResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  updateCannedPrompt(
    promptId: string,
    rawRequest: UpdateCannedPromptRequest,
    signal?: AbortSignal,
  ): Promise<CannedPromptMutationResult> {
    const request = updateCannedPromptRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/application/canned-prompts/${encodeURIComponent(promptId)}`,
      cannedPromptMutationResultSchema,
      { method: "PUT", body: JSON.stringify(request), signal },
    );
  }

  deleteCannedPrompt(
    promptId: string,
    rawRequest: DeleteCannedPromptRequest,
    signal?: AbortSignal,
  ): Promise<CannedPromptMutationResult> {
    const request = deleteCannedPromptRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/application/canned-prompts/${encodeURIComponent(promptId)}`,
      cannedPromptMutationResultSchema,
      { method: "DELETE", body: JSON.stringify(request), signal },
    );
  }

  reorderCannedPrompts(
    rawRequest: ReorderCannedPromptsRequest,
    signal?: AbortSignal,
  ): Promise<CannedPromptMutationResult> {
    const request = reorderCannedPromptsRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/application/canned-prompts/order",
      cannedPromptMutationResultSchema,
      { method: "PUT", body: JSON.stringify(request), signal },
    );
  }

  getToolClientOptions(signal?: AbortSignal): Promise<ToolClientOptions> {
    return this.#request(
      "/api/tool-clients/options",
      { signal },
      toolClientOptionsSchema,
    );
  }

  listToolClients(
    input: {
      readonly creationRequestId?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ToolClientListPage> {
    const query = new URLSearchParams();
    if (input.creationRequestId) {
      query.set("creationRequestId", input.creationRequestId);
    }
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.pageSize !== undefined) {
      query.set("pageSize", String(input.pageSize));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.#request(
      `/api/tool-clients${suffix}`,
      { signal: input.signal },
      toolClientListPageSchema,
    );
  }

  getToolClient(clientId: string, signal?: AbortSignal): Promise<ToolClient> {
    return this.#request(
      `/api/tool-clients/${encodeURIComponent(clientId)}`,
      { signal },
      toolClientSchema,
    );
  }

  createToolClient(
    rawRequest: CreateToolClientRequest,
  ): Promise<ToolClientCredentialResult> {
    const request = createToolClientRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/tool-clients",
      toolClientCredentialResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  replaceToolClient(
    clientId: string,
    rawRequest: ReplaceToolClientRequest,
  ): Promise<ToolClient> {
    const request = replaceToolClientRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/tool-clients/${encodeURIComponent(clientId)}`,
      toolClientSchema,
      { method: "PUT", body: JSON.stringify(request) },
    );
  }

  rotateToolClient(
    clientId: string,
    expectedRevision: number,
  ): Promise<ToolClientCredentialResult> {
    const request = toolClientRevisionRequestSchema.parse({ expectedRevision });
    return this.#mutation(
      `/api/tool-clients/${encodeURIComponent(clientId)}/rotate`,
      toolClientCredentialResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  revokeToolClient(
    clientId: string,
    expectedRevision: number,
  ): Promise<ToolClient> {
    const request = toolClientRevisionRequestSchema.parse({ expectedRevision });
    return this.#mutation(
      `/api/tool-clients/${encodeURIComponent(clientId)}/revoke`,
      toolClientSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  createCodexTuiAdmission(threadId: string): Promise<CodexTuiAdmission> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/provider-features/codex.tui/terminal-admission`,
      codexTuiAdmissionSchema,
      { method: "POST", body: "{}" },
    );
  }

  listSavedAgents(
    input: {
      readonly backendTypeId?: SavedAgentBackendTypeId;
      readonly targetId?: string;
      readonly nameSearch?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<SavedAgentListPage> {
    const query = new URLSearchParams();
    if (input.backendTypeId) query.set("backendTypeId", input.backendTypeId);
    if (input.targetId) query.set("targetId", input.targetId);
    if (input.nameSearch) query.set("nameSearch", input.nameSearch);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.pageSize !== undefined) {
      query.set("pageSize", String(input.pageSize));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.#request(
      `/api/agents${suffix}`,
      { signal: input.signal },
      savedAgentListPageSchema,
    );
  }

  getSavedAgent(agentId: string, signal?: AbortSignal): Promise<SavedAgent> {
    return this.#request(
      `/api/agents/${encodeURIComponent(agentId)}`,
      { signal },
      savedAgentSchema,
    );
  }

  getSavedAgentOptions(
    input: SavedAgentOptionsRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgentOptionsResult> {
    return this.#mutation(
      "/api/agents/options",
      savedAgentOptionsResultSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      },
    );
  }

  resolveSavedAgent(
    agentId: string,
    input: ResolveSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<ResolveSavedAgentResult> {
    return this.#mutation(
      `/api/agents/${encodeURIComponent(agentId)}/resolve`,
      resolveSavedAgentResultSchema,
      { method: "POST", body: JSON.stringify(input), signal },
    );
  }

  async createSavedAgent(input: CreateSavedAgentRequest): Promise<SavedAgent> {
    const result = await this.#mutation(
      "/api/agents",
      savedAgentMutationResultSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.agent;
  }

  async updateSavedAgent(
    agentId: string,
    input: UpdateSavedAgentRequest,
  ): Promise<SavedAgent> {
    const result = await this.#mutation(
      `/api/agents/${encodeURIComponent(agentId)}`,
      savedAgentMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return result.agent;
  }

  deleteSavedAgent(
    agentId: string,
    input: DeleteSavedAgentRequest,
  ): Promise<SavedAgentDeleteResult> {
    return this.#mutation(
      `/api/agents/${encodeURIComponent(agentId)}`,
      savedAgentDeleteResultSchema,
      { method: "DELETE", body: JSON.stringify(input) },
    );
  }

  listThreadTemplates(
    input: {
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ThreadTemplateListPage> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.pageSize !== undefined)
      query.set("pageSize", String(input.pageSize));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.#request(
      `/api/thread-templates${suffix}`,
      { signal: input.signal },
      threadTemplateListPageSchema,
    );
  }

  getThreadTemplate(
    templateId: string,
    signal?: AbortSignal,
  ): Promise<ThreadTemplate> {
    return this.#request(
      `/api/thread-templates/${encodeURIComponent(templateId)}`,
      { signal },
      threadTemplateSchema,
    );
  }

  getEnvironmentVariablePreview(input: EnvironmentVariablesPreviewQuery, signal?: AbortSignal): Promise<EnvironmentVariablesPreviewResult> {
    const query = environmentVariablesPreviewQuerySchema.parse(input);
    const parameters = new URLSearchParams({ targetId: query.targetId });
    if (query.agentId) parameters.set("agentId", query.agentId);
    return this.#request(`/api/environment-variables/preview?${parameters}`, { signal }, environmentVariablesPreviewResultSchema);
  }

  getUsageAvailability(threadId: string, turnIds: readonly string[], signal?: AbortSignal): Promise<UsageAvailability> {
    const body=usageAvailabilityRequestSchema.parse({turnIds});
    return this.#mutation(`/api/threads/${encodeURIComponent(threadId)}/usage/turn-availability`,usageAvailabilitySchema,
      {method:"POST",body:JSON.stringify(body),signal});
  }

  getUsage(threadId: string, turnId: string | null = null, signal?: AbortSignal): Promise<UsageReport> {
    const suffix = turnId === null ? "" : `/turns/${encodeURIComponent(turnId)}`;
    return this.#request(`/api/threads/${encodeURIComponent(threadId)}/usage${suffix}`, { signal }, usageReportSchema);
  }

  /** Principal-wide usage aggregates; a database-only read sent as POST for its bounded body. */
  getUsageAnalytics(request: UsageAnalyticsRequest, signal?: AbortSignal): Promise<UsageAnalyticsResponse> {
    const body = usageAnalyticsRequestSchema.parse(request);
    return this.#mutation("/api/usage/analytics", usageAnalyticsResponseSchema, {method: "POST", body: JSON.stringify(body), signal});
  }

  getThreadEnvironmentVariables(threadId: string, signal?: AbortSignal): Promise<ThreadEnvironmentVariablesResult> {
    return this.#request(`/api/threads/${encodeURIComponent(threadId)}/environment-variables`, { signal }, threadEnvironmentVariablesResultSchema);
  }

  async createThreadTemplate(
    input: CreateThreadTemplateRequest,
  ): Promise<ThreadTemplate> {
    const result = await this.#mutation(
      "/api/thread-templates",
      threadTemplateMutationResultSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
    return result.template;
  }

  async updateThreadTemplate(
    templateId: string,
    input: UpdateThreadTemplateRequest,
  ): Promise<ThreadTemplate> {
    const result = await this.#mutation(
      `/api/thread-templates/${encodeURIComponent(templateId)}`,
      threadTemplateMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return result.template;
  }

  deleteThreadTemplate(
    templateId: string,
    input: DeleteThreadTemplateRequest,
  ): Promise<ThreadTemplateDeleteResult> {
    return this.#mutation(
      `/api/thread-templates/${encodeURIComponent(templateId)}`,
      threadTemplateDeleteResultSchema,
      { method: "DELETE", body: JSON.stringify(input) },
    );
  }

  listWorkspaceFiles(
    workspaceId: string,
    input: {
      readonly rootId: WorkspaceFileRootId;
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkspaceFileListResult> {
    const parameters = new URLSearchParams({ rootId: input.rootId });
    if (input.cursor) parameters.set("cursor", input.cursor);
    if (input.pageSize !== undefined)
      parameters.set("pageSize", String(input.pageSize));
    const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
    return this.#request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files${query}`,
      { signal: input.signal },
      workspaceFileListResultSchema,
    );
  }

  listWorkspaceFileDirectory(
    workspaceId: string,
    input: {
      readonly rootId: WorkspaceFileRootId;
      readonly directory?: WorkspaceFileDirectoryPath;
      readonly cursor?: string;
      readonly pageSize?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkspaceFileDirectoryResult> {
    const parameters = new URLSearchParams({
      rootId: input.rootId,
      directory: input.directory ?? "",
    });
    if (input.cursor) parameters.set("cursor", input.cursor);
    if (input.pageSize !== undefined)
      parameters.set("pageSize", String(input.pageSize));
    return this.#request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/directory?${parameters.toString()}`,
      { signal: input.signal },
      workspaceFileDirectoryResultSchema,
    );
  }

  readWorkspaceFile(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileContentResult> {
    const parameters = new URLSearchParams({ rootId, path });
    return this.#request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?${parameters.toString()}`,
      { signal },
      workspaceFileContentResultSchema,
    );
  }

  async prepareWorkspaceFileDownload(
    workspaceId: string,
    input: {
      readonly rootId: WorkspaceFileRootId;
      readonly path: string;
      readonly expectedRevision: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PreparedWorkspaceFileDownload> {
    const parameters = new URLSearchParams({
      rootId: input.rootId,
      path: input.path,
      expectedRevision: input.expectedRevision,
    });
    const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/files/download?${parameters.toString()}`;
    const url = resolveSedesServerUrl(this.#endpoint, path);
    const response = await this.#fetch(path, {
      method: "HEAD",
      credentials: endpointUsesCrossOriginTransport(this.#endpoint)
        ? "omit"
        : "same-origin",
      redirect: "error",
      headers: { Accept: "application/octet-stream" },
      signal: input.signal,
    });
    if (!response.ok) {
      throw workspaceFileDownloadPreflightError(response.status);
    }

    const contentDisposition = response.headers.get("Content-Disposition");
    const contentLengthText = response.headers.get("Content-Length");
    const contentType = response.headers.get("Content-Type");
    const revision = response.headers.get("X-Sedes-Workspace-File-Revision");
    const contentLength =
      contentLengthText === null ? Number.NaN : Number(contentLengthText);
    if (
      !contentDisposition ||
      contentDisposition.length > 2_048 ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > WORKSPACE_FILE_MAX_DOWNLOAD_BYTES ||
      contentType !== "application/octet-stream" ||
      revision !== input.expectedRevision
    ) {
      throw new ApiError(
        502,
        "invalid_response",
        "The server returned invalid file download metadata.",
        true,
      );
    }
    return {
      url,
      serverOrigin: this.#endpoint.baseUrl ?? window.location.origin,
      contentDisposition,
      contentLength,
      revision,
    };
  }

  workspaceFileStatus(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileStatusResult> {
    return this.#request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/status`,
      { signal },
      workspaceFileStatusResultSchema,
    );
  }

  saveWorkspaceFile(
    workspaceId: string,
    rawRequest: WorkspaceFileWriteRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileWriteResult> {
    const request = workspaceFileWriteRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content`,
      workspaceFileWriteResultSchema,
      { method: "PUT", body: JSON.stringify(request), signal },
    );
  }

  listWorkspaceFileRoots(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootsResult> {
    return this.#request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file-roots`,
      { signal },
      workspaceFileRootsResultSchema,
    );
  }

  attachWorkspaceFileRoot(
    workspaceId: string,
    rawRequest: WorkspaceFileRootCreateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootCreateResult> {
    const request = workspaceFileRootCreateRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file-roots`,
      workspaceFileRootCreateResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  removeWorkspaceFileRoot(
    workspaceId: string,
    rootId: WorkspaceFileSupplementalRootId,
    rawRequest: WorkspaceFileRootDeleteRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootDeleteResult> {
    const request = workspaceFileRootDeleteRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file-roots/${encodeURIComponent(rootId)}`,
      workspaceFileRootDeleteResultSchema,
      { method: "DELETE", body: JSON.stringify(request), signal },
    );
  }

  resolveWorkspaceFileLink(
    workspaceId: string,
    reference: WorkspaceFileLinkReference,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileLinkResolveResult> {
    const request = workspaceFileLinkResolveRequestSchema.parse({ reference });
    return this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/file-links/resolve`,
      workspaceFileLinkResolveResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  resolveThreadWorkspaceFileLink(
    threadId: string,
    reference: WorkspaceFileLinkReference,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileLinkResolveResult> {
    const request = workspaceFileLinkResolveRequestSchema.parse({ reference });
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/file-links/resolve`,
      workspaceFileLinkResolveResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  updateThreadPreferredWorktree(
    threadId: string,
    rawRequest: ThreadPreferredWorktreeUpdateRequest,
    signal?: AbortSignal,
  ): Promise<ThreadPreferredWorktreeUpdateResult> {
    const request =
      threadPreferredWorktreeUpdateRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/preferred-worktree`,
      threadPreferredWorktreeUpdateResultSchema,
      { method: "PUT", body: JSON.stringify(request), signal },
    );
  }

  deleteLinkedWorktree(
    workspaceId: string,
    rootId: WorkspaceFileLinkedWorktreeRootId,
    rawRequest: WorkspaceLinkedWorktreeDeleteRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceLinkedWorktreeDeleteResult> {
    const request =
      workspaceLinkedWorktreeDeleteRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/linked-worktrees/${encodeURIComponent(rootId)}`,
      workspaceLinkedWorktreeDeleteResultSchema,
      { method: "DELETE", body: JSON.stringify(request), signal },
    );
  }

  listWorkspaceDiffRepositories(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRepositoriesResult> {
    return this.#request(
      this.#workspaceDiffUrl(workspaceId, rootId, "repositories"),
      { signal },
      workspaceDiffRepositoriesResultSchema,
    );
  }

  listWorkspaceDiffRefs(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawQuery: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRefCatalogResult> {
    const query = workspaceDiffRefCatalogQuerySchema.parse(rawQuery);
    const parameters = new URLSearchParams({
      repositoryId: query.repositoryId,
      pageSize: String(query.pageSize),
    });
    if (query.history) parameters.set("history", query.history);
    if (query.resolveRef) parameters.set("resolveRef", query.resolveRef);
    if (query.resolveCommit) parameters.set("resolveCommit", query.resolveCommit);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "refs")}?${parameters.toString()}`,
      { signal },
      workspaceDiffRefCatalogResultSchema,
    );
  }

  createWorkspaceDiffComparison(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawRequest: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffComparisonCreateResult> {
    const request =
      workspaceDiffComparisonCreateRequestSchema.parse(rawRequest);
    return this.#mutation(
      this.#workspaceDiffUrl(workspaceId, rootId, "comparisons"),
      workspaceDiffComparisonCreateResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  listWorkspaceDiffChangedFiles(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawQuery: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffChangedFilesResult> {
    const query = workspaceDiffChangedFilesQuerySchema.parse(rawQuery);
    const parameters = new URLSearchParams({
      comparisonId: query.comparisonId,
      fingerprint: query.fingerprint,
      pageSize: String(query.pageSize),
    });
    if (query.after) parameters.set("after", query.after);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "files")}?${parameters.toString()}`,
      { signal },
      workspaceDiffChangedFilesResultSchema,
    );
  }

  readWorkspaceDiffPatch(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawRequest: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffPatchResult> {
    const request = workspaceDiffFileRequestSchema.parse(rawRequest);
    const parameters = new URLSearchParams(request);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "patch")}?${parameters.toString()}`,
      { signal },
      workspaceDiffPatchResultSchema,
    );
  }

  readWorkspaceDiffFileContent(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawRequest: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffFileContentResult> {
    const request = workspaceDiffFileContentRequestSchema.parse(rawRequest);
    const parameters = new URLSearchParams(request);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "content")}?${parameters.toString()}`,
      { signal },
      workspaceDiffFileContentResultSchema,
    );
  }

  listWorkspaceDiffReviews(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawQuery: WorkspaceDiffReviewListQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewListResult> {
    const query = workspaceDiffReviewListQuerySchema.parse(rawQuery);
    const parameters = new URLSearchParams(query);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "reviews")}?${parameters.toString()}`,
      { signal },
      workspaceDiffReviewListResultSchema,
    );
  }

  listWorkspaceDiffReviewHistory(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawQuery: WorkspaceDiffReviewRepositoryListQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewListResult> {
    const query = workspaceDiffReviewRepositoryListQuerySchema.parse(rawQuery);
    const parameters = new URLSearchParams(query);
    return this.#request(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "review-history")}?${parameters.toString()}`,
      { signal },
      workspaceDiffReviewListResultSchema,
    );
  }

  openWorkspaceDiffReview(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rawRequest: WorkspaceDiffReviewOpenRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReview> {
    const request = workspaceDiffReviewOpenRequestSchema.parse(rawRequest);
    return this.#mutation(
      this.#workspaceDiffUrl(workspaceId, rootId, "reviews"),
      workspaceDiffReviewSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  updateWorkspaceDiffReview(
    reviewId: string,
    rawRequest: WorkspaceDiffReviewUpdateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReview> {
    const request = workspaceDiffReviewUpdateRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspace-diff-reviews/${encodeURIComponent(reviewId)}`,
      workspaceDiffReviewSchema,
      { method: "PATCH", body: JSON.stringify(request), signal },
    );
  }

  listWorkspaceDiffReviewComments(
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewCommentsResult> {
    return this.#request(
      `/api/workspace-diff-reviews/${encodeURIComponent(reviewId)}/comments`,
      { signal },
      workspaceDiffReviewCommentsResultSchema,
    );
  }

  createWorkspaceDiffReviewComment(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    reviewId: string,
    rawRequest: WorkspaceDiffReviewCommentCreateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewMutationResult> {
    const request =
      workspaceDiffReviewCommentCreateRequestSchema.parse(rawRequest);
    return this.#mutation(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "reviews")}/${encodeURIComponent(reviewId)}/comments`,
      workspaceDiffReviewMutationResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  updateWorkspaceDiffReviewComment(
    reviewId: string,
    commentId: string,
    rawRequest: WorkspaceDiffReviewCommentUpdateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewMutationResult> {
    const request =
      workspaceDiffReviewCommentUpdateRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspace-diff-reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`,
      workspaceDiffReviewMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(request), signal },
    );
  }

  deleteWorkspaceDiffReviewComment(
    reviewId: string,
    commentId: string,
    rawRequest: WorkspaceDiffReviewCommentDeleteRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewMutationResult> {
    const request =
      workspaceDiffReviewCommentDeleteRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/workspace-diff-reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(commentId)}`,
      workspaceDiffReviewMutationResultSchema,
      { method: "DELETE", body: JSON.stringify(request), signal },
    );
  }

  listWorkspaceDiffReviewedFiles(
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewedFilesResult> {
    return this.#request(
      `/api/workspace-diff-reviews/${encodeURIComponent(reviewId)}/reviewed-files`,
      { signal },
      workspaceDiffReviewedFilesResultSchema,
    );
  }

  setWorkspaceDiffReviewedFile(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    reviewId: string,
    rawRequest: WorkspaceDiffReviewedFileSetRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewedFileMutationResult> {
    const request = workspaceDiffReviewedFileSetRequestSchema.parse(rawRequest);
    return this.#mutation(
      `${this.#workspaceDiffUrl(workspaceId, rootId, "reviews")}/${encodeURIComponent(reviewId)}/reviewed-files`,
      workspaceDiffReviewedFileMutationResultSchema,
      { method: "PUT", body: JSON.stringify(request), signal },
    );
  }

  #workspaceDiffUrl(
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    operation:
      | "repositories"
      | "refs"
      | "comparisons"
      | "files"
      | "patch"
      | "content"
      | "reviews"
      | "review-history",
  ): string {
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/file-roots/${encodeURIComponent(rootId)}/diff/${operation}`;
  }

  codexTuiWebSocketUrl(): string {
    return resolveSedesServerWebSocketUrl(
      this.#endpoint,
      "/api/provider-feature-terminal",
    );
  }

  terminalWebSocketUrl(): string {
    return resolveSedesServerWebSocketUrl(
      this.#endpoint,
      TERMINAL_WEBSOCKET_PATH,
    );
  }

  listTerminals(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<TerminalListResult> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/terminals`,
      { signal },
      terminalListResultSchema,
    );
  }

  createTerminal(
    threadId: string,
    rawRequest: CreateTerminalRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly terminal: TerminalResource | null }> {
    const request = createTerminalRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/terminals`,
      terminalMutationResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  readTerminal(
    terminalId: string,
    signal?: AbortSignal,
  ): Promise<TerminalResource> {
    return this.#request(
      `/api/terminals/${encodeURIComponent(terminalId)}`,
      { signal },
      terminalResourceSchema,
    );
  }

  createTerminalAdmission(
    terminalId: string,
    rawRequest: CreateTerminalAdmissionRequest,
    signal?: AbortSignal,
  ): Promise<TerminalAdmission> {
    const request = createTerminalAdmissionRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/terminals/${encodeURIComponent(terminalId)}/admissions`,
      terminalAdmissionSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  renameTerminal(
    terminalId: string,
    rawRequest: {
      readonly mutationId: string;
      readonly expectedRevision: number;
      readonly displayName: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly terminal: TerminalResource | null }> {
    const request = renameTerminalRequestSchema.parse(rawRequest);
    return this.#terminalMutation(terminalId, "rename", request, signal);
  }

  endTerminal(
    terminalId: string,
    rawRequest: {
      readonly mutationId: string;
      readonly expectedRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly terminal: TerminalResource | null }> {
    const request = terminalMutationRequestSchema.parse(rawRequest);
    return this.#terminalMutation(terminalId, "end", request, signal);
  }

  deleteTerminal(
    terminalId: string,
    rawRequest: {
      readonly mutationId: string;
      readonly expectedRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly terminal: TerminalResource | null }> {
    const request = terminalMutationRequestSchema.parse(rawRequest);
    return this.#terminalMutation(terminalId, "delete", request, signal);
  }

  #terminalMutation(
    terminalId: string,
    action: "rename" | "end" | "delete",
    request: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly terminal: TerminalResource | null }> {
    return this.#mutation(
      `/api/terminals/${encodeURIComponent(terminalId)}/actions/${action}`,
      terminalMutationResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  operateThread(
    threadId: string,
    rawOperation: ThreadApplicationOperation,
  ): Promise<ThreadApplicationMutationResult> {
    const operation = threadApplicationOperationSchema.parse(rawOperation);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/operations`,
      operation.kind === "deliver"
        ? threadDeliveryMutationResultSchema
        : operation.kind === "cancel_queued_input" ||
            operation.kind === "steer_queued_input"
          ? threadQueueMutationResultSchema
          : threadApplicationMutationResultSchema,
      { method: "POST", body: JSON.stringify(operation) },
    );
  }

  listSkills(threadId: string): Promise<ComposerSkillCatalog> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/skills`,
      {},
      composerSkillCatalogSchema,
    );
  }

  forkThread(
    threadId: string,
    rawRequest: ForkThreadRequest,
  ): Promise<ForkThreadResult> {
    const request = forkThreadRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/forks`,
      forkThreadResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  updateThreadLineagePlacement(
    threadId: string,
    input: {
      readonly mode: "nested_under_source" | "top_level";
      readonly expectedRevision: number;
      readonly mutationId: string;
    },
  ): Promise<NormalizedThreadLineagePlacement> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/lineage/placement`,
      normalizedThreadLineagePlacementSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  listThreadDescendants(
    threadId: string,
    input: { readonly cursor?: string; readonly pageSize?: number } = {},
  ): Promise<NormalizedThreadDescendantsPage> {
    const parameters = new URLSearchParams();
    if (input.cursor) parameters.set("cursor", input.cursor);
    parameters.set("pageSize", String(input.pageSize ?? 50));
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/descendants?${parameters.toString()}`,
      {},
      normalizedThreadDescendantsPageSchema,
    );
  }

  loadOlderHistory(
    threadId: string,
    cursor: string,
    limit: LoadThreadHistoryRequest["limit"],
    activityDetail: ActivityDetailMode,
  ): Promise<ThreadEventEnvelope> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/history`,
      threadEventEnvelopeSchema,
      {
        method: "POST",
        body: JSON.stringify({ cursor, limit, activityDetail }),
      },
    );
  }

  async seekHistoryTurn(
    threadId: string,
    turnId: string,
    activityDetail: ActivityDetailMode,
  ): Promise<ThreadHistorySeekResult> {
    const result = await this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/history/seek`,
      threadHistorySeekResultSchema,
      {
        method: "POST",
        body: JSON.stringify({ turnId, activityDetail }),
      },
    );
    if (result.targetTurnId !== turnId) {
      throw new Error(
        "The targeted history response did not match the requested turn.",
      );
    }
    return result;
  }

  listQuestionRequests(threadId: string): Promise<QuestionRequestsResult> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/questions`,
      {},
      questionRequestsResultSchema,
    );
  }

  listQuestionStatuses(threadId: string, sourceItemIds: string[]): Promise<QuestionStatusesResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/question-statuses`,
      questionStatusesResultSchema,
      { method: "POST", body: JSON.stringify({ sourceItemIds }) },
    );
  }

  respondToQuestion(
    threadId: string,
    questionId: string,
    input: RespondToQuestionRequest,
  ): Promise<RespondToQuestionResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/respond`,
      respondToQuestionResultSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  dismissQuestion(
    threadId: string,
    questionId: string,
    input: DismissQuestionRequest,
  ): Promise<QuestionRequestsResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/dismiss`,
      questionRequestsResultSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listTurnBookmarks(threadId: string): Promise<ListTurnBookmarksResult> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/bookmarks`,
      {},
      listTurnBookmarksResultSchema,
    );
  }

  setTurnBookmark(
    threadId: string,
    turnId: string,
    input: SetTurnBookmarkRequest,
  ): Promise<SetTurnBookmarkResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/bookmarks/${encodeURIComponent(turnId)}`,
      setTurnBookmarkResultSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  listProjects(signal?: AbortSignal): Promise<ListProjectsResult> {
    return this.#request("/api/workspaces", { signal }, listProjectsResultSchema);
  }

  removeProject(id: string, input: RemoveProjectRequest): Promise<ProjectSummary> {
    const request = removeProjectRequestSchema.parse(input);
    return this.#mutation(`/api/workspaces/${encodeURIComponent(id)}/remove`, projectSummarySchema,
      { method: "POST", body: JSON.stringify(request) });
  }

  async openWorkspace(path: string, environmentId: string): Promise<string> {
    const result = await this.#mutation(
      "/api/workspaces/open",
      idResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ path, environmentId }),
      },
    );
    return result.id;
  }

  browseExecutionEnvironmentDirectories(
    environmentId: string,
    rawRequest: DirectoryBrowseRequest,
    signal?: AbortSignal,
  ): Promise<DirectoryBrowseResult> {
    const request = directoryBrowseRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/execution-environments/${encodeURIComponent(environmentId)}/directories/browse`,
      directoryBrowseResultSchema,
      { method: "POST", body: JSON.stringify(request), signal },
    );
  }

  async reopenWorkspace(workspaceId: string): Promise<string> {
    const result = await this.#mutation(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/open`,
      idResponseSchema,
      { method: "POST" },
    );
    return result.id;
  }

  createThread(rawRequest: CreateThreadRequest): Promise<CreateThreadResult> {
    const request = createThreadRequestSchema.parse(rawRequest);
    return this.#mutation("/api/threads", createThreadResultSchema, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  createThreadFromSettings(
    sourceThreadId: string,
    rawRequest: CreateThreadFromSettingsRequest,
  ): Promise<CreateThreadResult> {
    const request = createThreadFromSettingsRequestSchema.parse(rawRequest);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(sourceThreadId)}/configuration-copies`,
      createThreadResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  saveDraft(
    threadId: string,
    draft: NormalizedDraft,
  ): Promise<NormalizedDraft> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/draft`,
      normalizedDraftSchema,
      {
        method: "PUT",
        body: JSON.stringify({
          text: draft.text,
          ...(draft.selectedSkillId
            ? { selectedSkillId: draft.selectedSkillId }
            : {}),
          contextExcerpts: draft.contextExcerpts,
          attachmentIds: draft.attachments.map(({ id }) => id),
          taskReferenceIds: draft.taskReferences.map(({ taskId }) => taskId),
          expectedRevision: draft.revision,
        }),
      },
    );
  }

  uploadComposerAttachment(
    threadId: string,
    attachmentId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<ComposerAttachmentDescriptor> {
    const query = new URLSearchParams({ fileName: file.name });
    if (file.type) query.set("declaredMediaType", file.type);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/composer-attachments/${encodeURIComponent(attachmentId)}?${query.toString()}`,
      putComposerAttachmentResultSchema,
      {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
        signal,
      },
    ).then(({ attachment }) => attachment);
  }

  async loadComposerAttachmentContent(
    threadId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.#loadImageContent(
      `/api/threads/${encodeURIComponent(threadId)}/composer-attachments/${encodeURIComponent(attachmentId)}/content`,
      signal,
    );
  }

  async loadOutputArtifactContent(
    threadId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    return this.#loadImageContent(
      `/api/threads/${encodeURIComponent(threadId)}/output-artifacts/${encodeURIComponent(artifactId)}/content`,
      signal,
    );
  }

  async #loadImageContent(path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.#fetch(path, {
      method: "GET",
      credentials: endpointUsesCrossOriginTransport(this.#endpoint)
        ? "omit"
        : "same-origin",
      redirect: "error",
      headers: {
        Accept: "image/png, image/jpeg, image/gif, image/webp",
      },
      signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as unknown;
      const parsed = apiErrorSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          "invalid_response",
          "The server returned an invalid normalized error response.",
          true,
          parsed.error.flatten(),
        );
      }
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.retryable,
      );
    }
    return response.blob();
  }

  createStash(
    threadId: string,
    expectedDraftRevision: number,
    mutationId: string,
  ): Promise<{ draft: NormalizedDraft; stashes: NormalizedStash[] }> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/stashes`,
      compositionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision, mutationId }),
      },
    );
  }

  restoreStash(
    threadId: string,
    stashId: string,
    expectedDraftRevision: number,
    mutationId: string,
  ): Promise<{ draft: NormalizedDraft; stashes: NormalizedStash[] }> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/stashes/${encodeURIComponent(stashId)}/restore`,
      compositionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision, mutationId }),
      },
    );
  }

  deleteStash(
    threadId: string,
    stashId: string,
  ): Promise<{ stashes: NormalizedStash[] }> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/stashes/${encodeURIComponent(stashId)}`,
      stashesResponseSchema,
      { method: "DELETE" },
    );
  }

  listWorkpads(request: ListWorkpadsRequest) {
    const query = new URLSearchParams({ scopeKind: request.scope.kind });
    if (request.scope.kind === "workspace") query.set("workspaceId", request.scope.workspaceId);
    if (request.scope.kind === "thread") query.set("threadId", request.scope.threadId);
    for (const key of ["scopeMode", "query", "archived", "limit", "cursor"] as const) {
      if (request[key] !== undefined) query.set(key, String(request[key]));
    }
    return this.#request(`/api/workpads?${query}`, {}, workpadListPageSchema);
  }

  async getWorkpad(id: string) {
    return (await this.#request(`/api/workpads/${encodeURIComponent(id)}`, {}, z.object({ workpad: workpadSchema }))).workpad;
  }

  async createWorkpad(request: CreateWorkpadRequest) {
    return (await this.#mutation("/api/workpads", z.object({ workpad: workpadSchema }), { method: "POST", body: JSON.stringify(request) })).workpad;
  }

  async updateWorkpad(id: string, request: UpdateWorkpadRequest) {
    return (await this.#mutation(`/api/workpads/${encodeURIComponent(id)}`, z.object({ workpad: workpadSchema }), { method: "PATCH", body: JSON.stringify(request) })).workpad;
  }

  listWorkpadRevisions(id: string, cursor?: string) {
    return this.#request(`/api/workpads/${encodeURIComponent(id)}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {}, workpadRevisionPageSchema);
  }

  async getWorkpadRevision(id: string, revision: number) {
    return (await this.#request(`/api/workpads/${encodeURIComponent(id)}/revisions/${revision}`, {}, z.object({ revision: workpadRevisionSchema }))).revision;
  }

  async getWorkpadDraft(id: string) {
    return (await this.#request(`/api/workpads/${encodeURIComponent(id)}/draft`, {}, z.object({ draft: workpadDraftSchema }))).draft;
  }

  async saveWorkpadDraft(id: string, request: SaveWorkpadDraftRequest) {
    return (await this.#mutation(`/api/workpads/${encodeURIComponent(id)}/draft`, z.object({ draft: workpadDraftSchema }), { method: "PUT", body: JSON.stringify(request) })).draft;
  }

  async discardWorkpadDraft(id: string, expectedRevision: number) {
    return (await this.#mutation(`/api/workpads/${encodeURIComponent(id)}/draft`, z.object({ draft: workpadDraftSchema }), { method: "DELETE", body: JSON.stringify({ expectedRevision }) })).draft;
  }

  commitWorkpadDraft(id: string, request: CommitWorkpadDraftRequest) {
    return this.#mutation(`/api/workpads/${encodeURIComponent(id)}/draft/commit`, z.object({ workpad: workpadSchema, draft: workpadDraftSchema }), { method: "POST", body: JSON.stringify(request) });
  }

  async createTask(request: CreateTaskRequest): Promise<Task> {
    const result = await this.#mutation(
      "/api/tasks",
      taskMutationResultSchema,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
    return result.task;
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<Task> {
    const result = await this.#mutation(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      taskMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(request) },
    );
    return result.task;
  }

  async moveTask(taskId: string, request: MoveTaskRequest): Promise<Task> {
    const result = await this.#mutation(
      `/api/tasks/${encodeURIComponent(taskId)}/move`,
      taskMutationResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
    return result.task;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.#mutation(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      z.unknown(),
      { method: "DELETE" },
    );
  }

  async mutateInventory(threadId: string, mutation: unknown): Promise<void> {
    await this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/inventory`,
      z.unknown(),
      { method: "PATCH", body: JSON.stringify(mutation) },
    );
  }

  getBulkInventoryImpact(
    rawRequest: BulkInventoryImpactRequest,
  ): Promise<BulkInventoryImpact> {
    const request = bulkInventoryImpactRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/thread-inventory/bulk-impact",
      bulkInventoryImpactSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  mutateBulkInventory(
    rawRequest: BulkInventoryMutationRequest,
  ): Promise<BulkInventoryMutationResult> {
    const request = bulkInventoryMutationRequestSchema.parse(rawRequest);
    return this.#mutation(
      "/api/thread-inventory/bulk",
      bulkInventoryMutationResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  async mutateThreadPin(
    threadId: string,
    mutation: UpdateThreadPinRequest,
  ): Promise<void> {
    await this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/pin`,
      z.unknown(),
      { method: "PATCH", body: JSON.stringify(mutation) },
    );
  }

  mutateThreadGroup(
    threadId: string,
    mutation: UpdateThreadGroupAssignmentRequest,
  ): Promise<ThreadGroupMutationResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/group`,
      threadGroupMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(mutation) },
    );
  }

  mutateGroup(
    groupId: string,
    mutation: UpdateThreadGroupRequest,
  ): Promise<ThreadGroupMutationResult> {
    return this.#mutation(
      `/api/thread-groups/${encodeURIComponent(groupId)}`,
      threadGroupMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(mutation) },
    );
  }

  getThreadArchiveImpact(threadId: string): Promise<ThreadArchiveImpact> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/inventory/archive-impact`,
      {},
      threadArchiveImpactSchema,
    );
  }

  getThreadExecutionWorkspace(
    threadId: string,
  ): Promise<ThreadExecutionWorkspaceResource> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/execution-workspace`,
      {},
      threadExecutionWorkspaceResourceSchema,
    );
  }

  deleteThreadExecutionWorkspace(
    threadId: string,
    input: DeleteThreadExecutionWorkspaceRequest,
  ): Promise<DeleteThreadExecutionWorkspaceResult> {
    const request = deleteThreadExecutionWorkspaceRequestSchema.parse(input);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/execution-workspace`,
      deleteThreadExecutionWorkspaceResultSchema,
      { method: "DELETE", body: JSON.stringify(request) },
    );
  }

  importThreadExecutionWorkspace(
    threadId: string,
    input: ImportThreadExecutionWorkspaceRequest,
  ): Promise<ImportThreadExecutionWorkspaceResult> {
    const request = importThreadExecutionWorkspaceRequestSchema.parse(input);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/execution-workspace/import`,
      importThreadExecutionWorkspaceResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  handoffThreadExecutionWorkspace(
    threadId: string,
    input: HandoffThreadExecutionWorkspaceRequest,
  ): Promise<HandoffThreadExecutionWorkspaceResult> {
    const request = handoffThreadExecutionWorkspaceRequestSchema.parse(input);
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/execution-workspace/handoff`,
      handoffThreadExecutionWorkspaceResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  getThreadForceResetImpact(threadId: string): Promise<ThreadForceResetImpact> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/force-reset-impact`,
      {},
      threadForceResetImpactSchema,
    );
  }

  forceResetThread(
    threadId: string,
    expectedBlockerFingerprint: string,
    mutationId: string,
  ): Promise<ThreadForceResetResult> {
    const request = threadForceResetRequestSchema.parse({
      expectedBlockerFingerprint,
      mutationId,
    });
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/force-reset`,
      threadForceResetResultSchema,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  archiveThreads(
    threadId: string,
    mutation: unknown,
  ): Promise<ThreadArchiveMutationResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/inventory`,
      threadArchiveMutationResultSchema,
      { method: "PATCH", body: JSON.stringify(mutation) },
    );
  }

  async dismissThreadAttention(
    threadId: string,
    attention:
      | { kind: "wake"; wokeAt: string }
      | { kind: "automation_context"; runId: string }
      | { kind: "unseen_completion"; operationId: string }
      | { kind: "queue_failure"; queuedInputId: string },
    mutationId: string,
  ): Promise<void> {
    await this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/attention/dismiss`,
      z.unknown(),
      {
        method: "POST",
        body: JSON.stringify({ ...attention, mutationId }),
      },
    );
  }

  getThreadAutomation(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadAutomationDefinition> {
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      { signal },
      threadAutomationDefinitionSchema,
    );
  }

  createThreadAutomation(
    threadId: string,
    input: {
      prompt: string;
      runMode: AutomationRunMode;
      schedule: AutomationSchedule;
      misfirePolicy: AutomationMisfirePolicy;
      precheck: AutomationPrecheck | null;
      mutationId: string;
    },
  ): Promise<ThreadAutomationDefinition> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      threadAutomationDefinitionSchema,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  updateThreadAutomation(
    threadId: string,
    input: {
      prompt: string;
      runMode: AutomationRunMode;
      schedule: AutomationSchedule;
      misfirePolicy: AutomationMisfirePolicy;
      precheck: AutomationPrecheck | null;
      expectedRevision: number;
      mutationId: string;
    },
  ): Promise<ThreadAutomationDefinition> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      threadAutomationDefinitionSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  setThreadAutomationState(
    threadId: string,
    action: "enable" | "pause",
    expectedRevision: number,
    mutationId: string,
  ): Promise<ThreadAutomationDefinition> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/state`,
      threadAutomationDefinitionSchema,
      {
        method: "PATCH",
        body: JSON.stringify({ action, expectedRevision, mutationId }),
      },
    );
  }

  deleteThreadAutomation(
    threadId: string,
    expectedRevision: number,
    mutationId: string,
  ): Promise<{ deleted: true }> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation`,
      z.strictObject({ deleted: z.literal(true) }),
      {
        method: "DELETE",
        body: JSON.stringify({ expectedRevision, mutationId }),
      },
    );
  }

  runThreadAutomationNow(
    threadId: string,
    mutationId: string,
  ): Promise<ThreadAutomationRun> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/run-now`,
      threadAutomationRunSchema,
      { method: "POST", body: JSON.stringify({ mutationId }) },
    );
  }

  listThreadAutomationRuns(
    threadId: string,
    input: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<PageResult<ThreadAutomationRun>> {
    const parameters = new URLSearchParams();
    if (input.cursor) parameters.set("cursor", input.cursor);
    parameters.set("pageSize", String(input.limit ?? 50));
    return this.#request(
      `/api/threads/${encodeURIComponent(threadId)}/automation/runs?${parameters.toString()}`,
      { signal: input.signal },
      pageResultSchema(threadAutomationRunSchema),
    );
  }

  resolveThreadAutomationRun(
    threadId: string,
    runId: string,
  ): Promise<ThreadAutomationRun> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/runs/${encodeURIComponent(runId)}/resolve`,
      threadAutomationRunSchema,
      {
        method: "POST",
        body: JSON.stringify({ action: "mark_failed" }),
      },
    );
  }

  previewThreadAutomationSchedule(
    threadId: string,
    schedule: AutomationSchedule,
    count = 5,
    signal?: AbortSignal,
  ): Promise<ThreadAutomationSchedulePreview> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/preview`,
      threadAutomationSchedulePreviewSchema,
      {
        method: "POST",
        body: JSON.stringify({ schedule, count }),
        signal,
      },
    );
  }

  testThreadAutomationPrecheck(
    threadId: string,
    prompt: string,
    precheck: AutomationPrecheck,
    signal?: AbortSignal,
  ): Promise<AutomationPrecheckTestResult> {
    return this.#mutation(
      `/api/threads/${encodeURIComponent(threadId)}/automation/precheck/test`,
      automationPrecheckTestResultSchema,
      {
        method: "POST",
        body: JSON.stringify({ prompt, precheck }),
        signal,
      },
    );
  }

  async #mutation<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit,
  ): Promise<T> {
    if (!this.#csrfToken) await this.session();
    try {
      return await this.#request(path, this.#mutationInit(init), schema);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 403 &&
        error.code === "csrf_token_invalid"
      ) {
        await this.session({ refresh: true });
        return this.#request(path, this.#mutationInit(init), schema);
      }
      throw error;
    }
  }

  #mutationInit(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": this.#csrfToken,
        ...init.headers,
      },
    };
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.#fetch(path, {
      credentials: endpointUsesCrossOriginTransport(this.#endpoint)
        ? "omit"
        : "same-origin",
      redirect: "error",
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      if (response.status === 409) {
        const creationConflict =
          toolClientCreationConflictSchema.safeParse(body);
        if (creationConflict.success) {
          throw new ApiError(
            response.status,
            creationConflict.data.error.code,
            creationConflict.data.error.message,
            creationConflict.data.error.retryable,
            { client: creationConflict.data.client },
          );
        }
      }
      const parsed = apiErrorSchema.safeParse(body);
      if (!parsed.success) {
        throw new ApiError(
          response.status,
          "invalid_response",
          "The server returned an invalid normalized error response.",
          true,
          parsed.error.flatten(),
        );
      }
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.retryable,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      if (path === "/api/application/session") {
        const protocolVersion =
          clientProtocolVersionResponseSchema.safeParse(body);
        if (
          protocolVersion.success &&
          protocolVersion.data.clientProtocolVersion !==
            SEDES_CLIENT_PROTOCOL_VERSION
        ) {
          const serverVersion = protocolVersion.data.version;
          throw new ApiError(
            502,
            "client_protocol_mismatch",
            `This app (Sedes ${SEDES_VERSION}) and the Sedes server (${serverVersion ? `Sedes ${serverVersion}` : "version not reported"}) use incompatible protocol versions. Update the app or server so their versions match.`,
            false,
            {
              expected: SEDES_CLIENT_PROTOCOL_VERSION,
              received: protocolVersion.data.clientProtocolVersion,
              clientVersion: SEDES_VERSION,
              ...(serverVersion ? { serverVersion } : {}),
            },
          );
        }
      }
      throw new ApiError(
        502,
        "invalid_response",
        "The server returned an invalid normalized response.",
        true,
        parsed.error.flatten(),
      );
    }
    return parsed.data;
  }
}
