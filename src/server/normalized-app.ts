import { usageAnalyticsRequestSchema } from "../shared/protocol/usage-analytics.js";
import { usageAvailabilityRequestSchema } from "../shared/protocol/usage-accounting.js";
import type { UsageService } from "./usage/usage-service.js";
import { environmentVariablesPreviewQuerySchema, environmentVariablesPreviewResultSchema, threadEnvironmentVariablesResultSchema } from "../shared/protocol/environment-variables.js";
import type { EnvironmentVariablesService } from "./environment-variables/environment-variables-service.js";
import { ProjectManagementService } from "./application/project-management-service.js";
import { listProjectsResultSchema, projectSummarySchema, removeProjectRequestSchema } from "../shared/protocol/projects.js";
import { respondToQuestionResultSchema } from "../shared/protocol/api.js";
import type { QuestionRequestService } from "./domain/question-request-service.js";
import {
  questionRequestsResultSchema,
  questionStatusesRequestSchema,
  questionStatusesResultSchema,
  respondToQuestionRequestSchema,
  dismissQuestionRequestSchema,
} from "../shared/protocol/questions.js";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler, Response } from "express";
import express from "express";
import { z } from "zod";
import type { ContextExcerpt } from "../shared/protocol/context-excerpts.js";
import type { ComposerAttachmentDescriptor } from "../shared/protocol/composer-attachments.js";
import type { ComposerTaskReference } from "../shared/protocol/tasks.js";
import {
  directoryBrowseRequestSchema,
  directoryBrowseResultSchema,
} from "../shared/protocol/directory-browser.js";
import {
  applicationEventStreamQuerySchema,
  automationRunRouteParametersSchema,
  automationStateRequestSchema,
  bulkInventoryImpactRequestSchema,
  bulkInventoryImpactSchema,
  bulkInventoryMutationRequestSchema,
  bulkInventoryMutationResultSchema,
  createAutomationRequestSchema,
  createThreadFromSettingsRequestSchema,
  createThreadRequestSchema,
  createThreadResultSchema,
  deleteThreadExecutionWorkspaceRequestSchema,
  deleteThreadExecutionWorkspaceResultSchema,
  deleteAutomationRequestSchema,
  dismissThreadAttentionRequestSchema,
  forkThreadRequestSchema,
  forkThreadResultSchema,
  handoffThreadExecutionWorkspaceRequestSchema,
  handoffThreadExecutionWorkspaceResultSchema,
  inventoryTransitionSchema,
  importThreadExecutionWorkspaceRequestSchema,
  importThreadExecutionWorkspaceResultSchema,
  loadThreadHistoryRequestSchema,
  listAutomationRunsQuerySchema,
  listThreadDescendantsQuerySchema,
  openWorkspaceRequestSchema,
  previewAutomationScheduleRequestSchema,
  putComposerAttachmentQuerySchema,
  putComposerAttachmentResultSchema,
  resolveAutomationRunRequestSchema,
  restoreStashRequestSchema,
  runAutomationNowRequestSchema,
  saveDraftRequestSchema,
  seekThreadHistoryRequestSchema,
  stashDraftRequestSchema,
  stashRouteParametersSchema,
  testAutomationPrecheckRequestSchema,
  threadArchiveImpactSchema,
  threadExecutionWorkspaceResourceSchema,
  threadForceResetImpactSchema,
  threadForceResetRequestSchema,
  threadForceResetResultSchema,
  threadApplicationOperationSchema,
  threadApplicationMutationResultSchema,
  threadDeliveryMutationResultSchema,
  threadEventStreamQuerySchema,
  threadRouteParametersSchema,
  threadSnapshotQuerySchema,
  updateAutomationRequestSchema,
  updateThreadLineagePlacementRequestSchema,
  updateThreadPinRequestSchema,
} from "../shared/protocol/api.js";
import {
  createSavedAgentRequestSchema,
  deleteSavedAgentRequestSchema,
  resolveSavedAgentRequestSchema,
  resolveSavedAgentResultSchema,
  savedAgentListPageSchema,
  savedAgentListQuerySchema,
  savedAgentMutationResultSchema,
  savedAgentOptionsRequestSchema,
  savedAgentOptionsResultSchema,
  savedAgentRouteParametersSchema,
  savedAgentSchema,
  updateSavedAgentRequestSchema,
} from "../shared/protocol/saved-agents.js";
import {
  createThreadTemplateRequestSchema,
  deleteThreadTemplateRequestSchema,
  threadTemplateListPageSchema,
  threadTemplateListQuerySchema,
  threadTemplateMutationResultSchema,
  threadTemplateRouteParametersSchema,
  threadTemplateSchema,
  updateThreadTemplateRequestSchema,
} from "../shared/protocol/thread-templates.js";
import {
  workspaceFileContentQuerySchema,
  workspaceFileContentResultSchema,
  workspaceFileDirectoryQuerySchema,
  workspaceFileDirectoryResultSchema,
  workspaceFileDownloadQuerySchema,
  workspaceFileLinkResolveRequestSchema,
  workspaceFileLinkResolveResultSchema,
  workspaceFileListQuerySchema,
  workspaceFileListResultSchema,
  workspaceFileRootCreateRequestSchema,
  workspaceFileRootCreateResultSchema,
  workspaceFileRootDeleteRequestSchema,
  workspaceFileRootDeleteResultSchema,
  workspaceFileRootDeleteRouteParametersSchema,
  workspaceFileRootIdSchema,
  workspaceFileRootsResultSchema,
  workspaceFileRouteParametersSchema,
  workspaceFileStatusResultSchema,
  threadPreferredWorktreeUpdateRequestSchema,
  threadPreferredWorktreeUpdateResultSchema,
  workspaceFileWriteRequestSchema,
  workspaceFileWriteResultSchema,
  workspaceLinkedWorktreeDeleteRequestSchema,
  workspaceLinkedWorktreeDeleteResultSchema,
  workspaceLinkedWorktreeDeleteRouteParametersSchema,
  WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS,
  WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
} from "../shared/protocol/workspace-files.js";
import {
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
} from "../shared/protocol/workspace-diffs.js";
import {
  workspaceDiffReviewCommentCreateRequestSchema,
  workspaceDiffReviewCommentDeleteRequestSchema,
  workspaceDiffReviewCommentUpdateRequestSchema,
  workspaceDiffReviewCommentsResultSchema,
  workspaceDiffReviewIdSchema,
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
} from "../shared/protocol/workspace-diff-reviews.js";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
  normalizedThreadDescendantsPageSchema,
  normalizedThreadLineagePlacementSchema,
} from "../shared/protocol/application.js";
import { SEDES_VERSION } from "../shared/version.js";
import {
  applicationPreferencesSchema,
  updateApplicationPreferencesRequestSchema,
} from "../shared/protocol/application-preferences.js";
import {
  composerSkillCatalogSchema,
  normalizedDraftSchema,
  normalizedStashSchema,
  threadHistorySeekResultSchema,
  threadEventEnvelopeSchema,
} from "../shared/protocol/conversation.js";
import {
  createTaskRequestSchema,
  moveTaskRequestSchema,
  taskMutationResultSchema,
  taskRouteParametersSchema,
  updateTaskRequestSchema,
} from "../shared/protocol/tasks.js";
import { THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE } from "../shared/protocol/diagnostics.js";
import type { AppConfig } from "./config/config.js";
import type { ApplicationSnapshotPublicationBoundary } from "./application/application-snapshot-service.js";
import type { ExecutionTargetReader } from "./application/execution-target-reader.js";
import type { SavedAgentApplicationService } from "./application/saved-agent-application-service.js";
import { WorkspaceApplicationService } from "./application/workspace-application-service.js";
import { BackendError } from "./backends/contracts.js";
import type { ConversationLifecycleService } from "./conversations/conversation-lifecycle-service.js";
import type { ThreadApplicationService } from "./conversations/thread-application-service.js";
import type { ThreadHistoryService } from "./conversations/thread-history-service.js";
import {
  projectThreadEventEnvelopeActivity,
  projectThreadHistorySeekActivity,
  projectThreadSnapshotActivity,
} from "./conversations/thread-activity-projection.js";
import type { InventoryService } from "./domain/inventory-service.js";
import type { TaskService } from "./domain/task-service.js";
import type { WorkpadService } from "./domain/workpad-service.js";
import { registerWorkpadRoutes } from "./http/workpad-routes.js";
import type { WorkspaceFileService } from "./domain/workspace-file-service.js";
import {
  resolvedWorkspaceDiffReviewIdentity,
  validatedWorkspaceDiffCommentAnchor,
  type WorkspaceDiffReviewService,
} from "./domain/workspace-diff-review-service.js";
import type {
  WorkspaceDiffResolvedReviewIdentity as PersistedWorkspaceDiffReviewIdentity,
  WorkspaceDiffReviewCommentRecord,
  WorkspaceDiffReviewRecord,
  WorkspaceDiffReviewedFileRecord,
} from "./db/repositories/workspace-diff-review-repository.js";
import type { ThreadArchiveService } from "./domain/thread-archive-service.js";
import type { ThreadBulkInventoryService } from "./domain/thread-bulk-inventory-service.js";
import type { ThreadForceResetService } from "./domain/thread-force-reset-service.js";
import type { PiSandboxLifecycleService } from "./pi-sandbox/pi-sandbox-lifecycle-service.js";
import type { NotificationService } from "./domain/notification-service.js";
import {
  notificationSettingsSchema,
  updateNotificationSettingsRequestSchema,
  setNotificationSilencedRequestSchema,
  testNotificationRequestSchema,
  notificationTestResultSchema,
} from "../shared/protocol/notification.js";
import type { PrincipalApplicationPreferenceService } from "./domain/principal-application-preference-service.js";
import type { AutomationService } from "./domain/automation-service.js";
import { assertAutomationCloneEligible } from "./domain/automation-clone-eligibility.js";
import type { ThreadAttentionService } from "./domain/thread-attention-service.js";
import type { ThreadGroupService } from "./domain/thread-group-service.js";
import {
  threadGroupMutationResultSchema,
  threadGroupRouteParametersSchema,
  updateThreadGroupAssignmentRequestSchema,
  updateThreadGroupRequestSchema,
} from "../shared/protocol/thread-groups.js";
import type { AutomationPrecheckExecutor } from "./runtime/automation-precheck-executor.js";
import type { ExecutionEnvironmentProvider } from "./execution/contracts.js";
import { callRuntime } from "./runtime/runtime-errors.js";
import type {
  RequestScope,
  IdentityProvider,
} from "./identity/identity-provider.js";
import { DomainError } from "./domain/errors.js";
import { serveApplicationEventStream } from "./events/application-sse.js";
import { serveWorkspaceFileEventStream } from "./events/workspace-file-sse.js";
import type { ThreadRuntimeCoordinator } from "./events/thread-runtime-coordinator.js";
import {
  serveThreadEventStream,
  serveThreadLoadError,
} from "./events/thread-sse.js";
import type { ThreadSnapshotPublisher } from "./events/thread-snapshot-publisher.js";
import {
  packagedClientCors,
  csrfGuard,
  hostOriginGuard,
  requestIdMiddleware,
  securityHeaders,
} from "./security/http-security.js";
import { ApiError, errorMiddleware, notFound } from "./http/errors.js";
import type {
  ApplicationDrainController,
  HttpRequestOperationGate,
  LongLivedHttpConnectionRegistry,
} from "./runtime/application-shutdown.js";
import {
  MANAGED_TERMINAL_ADMISSION_ROUTE,
  createManagedTerminalAdmissionHandler,
  type ManagedTerminalAdmissionTokens,
} from "./terminal/managed-terminal-carrier.js";
import {
  createAgentToolRouter,
  type AgentToolRouterDependencies,
} from "./agent-tools/http/agent-tool-router.js";
import {
  SEDES_AGENT_TOOL_CSRF_ROUTE,
  agentToolCsrfResponseSchema,
} from "./agent-tools/http/agent-tool-http-contracts.js";
import { ComposerAttachmentStorageError } from "./composer-attachments/blob-store.js";
import type { ComposerAttachmentService } from "./composer-attachments/service.js";
import { OutputArtifactStorageError } from "./output-artifacts/blob-store.js";
import type { OutputArtifactService } from "./output-artifacts/service.js";
import {
  createToolClientRequestSchema,
  replaceToolClientRequestSchema,
  toolClientCreationConflictSchema,
  toolClientCredentialResultSchema,
  toolClientListPageSchema,
  toolClientListQuerySchema,
  toolClientOptionsSchema,
  toolClientRevisionRequestSchema,
  toolClientRouteParametersSchema,
  toolClientSchema,
} from "../shared/protocol/tool-clients.js";
import { ToolClientCreationConflictError } from "./agent-tools/application/principal-agent-tool-client-service.js";
import type { ThreadTemplateApplicationService } from "./application/thread-template-application-service.js";
import {
  createProviderPulseGateway,
  ProviderPulseGatewayError,
  type ProviderPulseGateway,
} from "./provider-pulse/gateway.js";
import {
  providerPulseAccountIdSchema,
  providerPulseCheckAllResultSchema,
  providerPulseOperationReceiptSchema,
  providerPulseSnapshotResultSchema,
  providerPulseStatusSchema,
} from "../shared/protocol/provider-pulse.js";
import {
  listTurnBookmarksResultSchema,
  setTurnBookmarkRequestSchema,
  setTurnBookmarkResultSchema,
  turnBookmarkRouteParametersSchema,
} from "../shared/protocol/turn-bookmarks.js";
import type { ConversationTurnBookmarkService } from "./domain/conversation-turn-bookmark-service.js";
import {
  cannedPromptLibrarySchema,
  cannedPromptMutationResultSchema,
  cannedPromptRouteParametersSchema,
  createCannedPromptRequestSchema,
  deleteCannedPromptRequestSchema,
  reorderCannedPromptsRequestSchema,
  updateCannedPromptRequestSchema,
} from "../shared/protocol/canned-prompts.js";
import type { CannedPromptService } from "./domain/canned-prompt-service.js";
import { createTerminalRouter } from "./terminals/terminal-http.js";
import type { TerminalAdmissionTokens } from "./terminals/terminal-carrier.js";
import type { TerminalService } from "./terminals/terminal-service.js";
import type { ConfigurationOperationRecoveryService } from "./configuration-admin/configuration-operation-recovery-service.js";
import { registerConfigurationOperationRecoveryRoutes } from "./configuration-admin/configuration-operation-recovery-routes.js";
import type { ConfigurationAdminService } from "./configuration-admin/configuration-admin-service.js";
import { registerConfigurationAdminRoutes } from "./configuration-admin/configuration-admin-routes.js";
import { registerHostPairingRoutes, type HostPairingAdministration } from "./configuration-admin/host-pairing-routes.js";
import { registerOutboundArtifactRoutes } from "./outbound/outbound-artifact-routes.js";
import type { SidecarArtifactRegistration } from "./sidecar/sidecar-artifact.js";
import type { AuthenticationAdmission } from "./authentication/authentication-admission.js";

export interface NormalizedAppDependencies {
  readonly usage: Pick<UsageService, "read" | "availability" | "analytics">;
  readonly environmentVariables?: EnvironmentVariablesService;
  /** Production always supplies admission; isolated service fixtures may omit it. */
  readonly authentication?: AuthenticationAdmission;
  readonly hostPairingAdmin?: HostPairingAdministration;
  readonly outboundArtifact?: () => Promise<SidecarArtifactRegistration>;
  readonly outboundConnectorDirectory?: string;
  readonly configurationAdmin?: ConfigurationAdminService;
  readonly configurationOperationRecovery?: ConfigurationOperationRecoveryService;
  readonly config: AppConfig;
  readonly csrfToken: string;
  readonly identity: IdentityProvider<Request>;
  readonly executionTargets: ExecutionTargetReader;
  readonly savedAgents: SavedAgentApplicationService;
  readonly threadTemplates: ThreadTemplateApplicationService;
  readonly applicationSnapshots: ApplicationSnapshotPublicationBoundary;
  readonly principalPreferences: PrincipalApplicationPreferenceService;
  readonly notifications: NotificationService;
  readonly questions: QuestionRequestService;
  readonly cannedPrompts: CannedPromptService;
  readonly threads: ThreadApplicationService;
  readonly history: ThreadHistoryService;
  readonly threadRuntimes: ThreadRuntimeCoordinator;
  readonly threadSnapshots: ThreadSnapshotPublisher;
  readonly lifecycle: ConversationLifecycleService;
  readonly inventory: InventoryService;
  readonly turnBookmarks: Pick<ConversationTurnBookmarkService, "list" | "set">;
  readonly threadGroups: ThreadGroupService;
  readonly composerAttachments: ComposerAttachmentService;
  readonly outputArtifacts: OutputArtifactService;
  readonly tasks: TaskService;
  readonly workpads: WorkpadService;
  readonly workspaceFiles: WorkspaceFileService;
  readonly workspaceDiffReviews: WorkspaceDiffReviewService;
  readonly threadArchives: ThreadArchiveService;
  readonly threadBulkInventory?: ThreadBulkInventoryService;
  readonly threadExecutionWorkspaces: Pick<
    PiSandboxLifecycleService,
    "status" | "delete" | "importBranch" | "handoff"
  >;
  readonly threadForceResets: ThreadForceResetService;
  readonly attention: ThreadAttentionService;
  readonly execution: ExecutionEnvironmentProvider;
  readonly automations: AutomationService;
  readonly automationPrechecks: AutomationPrecheckExecutor;
  readonly agentTools: AgentToolRouterDependencies;
  readonly drain?: ApplicationDrainController;
  readonly requestOperations?: HttpRequestOperationGate;
  readonly longLivedConnections?: LongLivedHttpConnectionRegistry;
  readonly managedTerminalAdmissions?: ManagedTerminalAdmissionTokens;
  readonly terminals?: {
    readonly service: TerminalService;
    readonly admissions: TerminalAdmissionTokens;
  };
  readonly lineage: {
    forkManual(
      input: {
        readonly scope: RequestScope;
        readonly sourceThreadId: string;
      } & z.infer<typeof forkThreadRequestSchema>,
    ): Promise<z.infer<typeof forkThreadResultSchema>>;
    updatePlacement(input: {
      readonly scope: RequestScope;
      readonly childThreadId: string;
      readonly mode: "nested_under_source" | "top_level";
      readonly expectedRevision: number;
      readonly mutationId: string;
    }): Promise<z.infer<typeof normalizedThreadLineagePlacementSchema>>;
    listDescendants(input: {
      readonly scope: RequestScope;
      readonly sourceThreadId: string;
      readonly cursor?: string;
      readonly pageSize: number;
    }): Promise<z.infer<typeof normalizedThreadDescendantsPageSchema>>;
  };
  readonly discoverWorkspace?: (
    scope: RequestScope,
    workspaceId: string,
  ) => Promise<void>;
  readonly clientDirectory?: string;
  readonly providerPulse?: ProviderPulseGateway;
}

const workspaceDiffRouteParametersSchema = z.strictObject({
  workspaceId: z.uuid(),
  rootId: workspaceFileRootIdSchema,
});
const workspaceDiffReviewRouteParametersSchema = z.strictObject({
  reviewId: workspaceDiffReviewIdSchema,
});
const workspaceDiffReviewCommentRouteParametersSchema = z.strictObject({
  reviewId: workspaceDiffReviewIdSchema,
  commentId: z.uuid(),
});

function workspaceDiffReview(record: WorkspaceDiffReviewRecord) {
  return workspaceDiffReviewSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    rootId: record.rootId,
    title: record.title,
    summary: record.summary,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function workspaceDiffReviewComment(record: WorkspaceDiffReviewCommentRecord) {
  return {
    id: record.id,
    reviewId: record.reviewId,
    fileIdentity: record.fileIdentity,
    oldPath: record.oldPath,
    newPath: record.newPath,
    side: record.side,
    startLine: record.startLine,
    endLine: record.endLine,
    selectedText: record.selectedText,
    body: record.body,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function workspaceDiffReviewedFile(record: WorkspaceDiffReviewedFileRecord) {
  return {
    reviewId: record.reviewId,
    fileIdentity: record.fileIdentity,
    filePath: record.filePath,
    contentFingerprint: record.contentFingerprint,
    reviewed: record.reviewed,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sameWorkspaceDiffReviewIdentity(
  record: WorkspaceDiffReviewRecord,
  identity: PersistedWorkspaceDiffReviewIdentity,
): boolean {
  return (
    record.repositoryKey === identity.repositoryKey &&
    record.semantic === identity.semantic &&
    record.baseKind === identity.base.kind &&
    record.baseIdentity === identity.base.identity &&
    record.headKind === identity.head.kind &&
    record.headIdentity === identity.head.identity &&
    record.mergeBaseCommitHash === (identity.mergeBaseCommitHash ?? null) &&
    record.fingerprint === identity.fingerprint
  );
}

function workspaceDiffResolutionError(status: string): DomainError {
  if (status === "stale") {
    return new DomainError(
      "conflict",
      "The workspace comparison changed. Refresh it before continuing.",
    );
  }
  if (status === "unavailable") {
    return new DomainError(
      "runtime_unavailable",
      "The workspace comparison is unavailable.",
      true,
    );
  }
  return new DomainError(
    "invalid_transition",
    "The selected workspace diff lines cannot be reviewed.",
  );
}

function workspaceFileRequestSignal(
  request: Request,
  response: Response,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("workspace_file_http_request_closed"));
    }
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return controller.signal;
}

function draft(record: {
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly attachments: readonly ComposerAttachmentDescriptor[];
  readonly taskReferences: readonly ComposerTaskReference[];
  readonly revision: number;
  readonly updatedAt: number;
}) {
  return normalizedDraftSchema.parse({
    text: record.text,
    ...(record.selectedSkillId === null
      ? {}
      : { selectedSkillId: record.selectedSkillId }),
    contextExcerpts: record.contextExcerpts,
    attachments: record.attachments,
    taskReferences: record.taskReferences,
    revision: record.revision,
    updatedAt: new Date(record.updatedAt).toISOString(),
  });
}

function stashes(
  records: readonly {
    readonly id: string;
    readonly text: string;
    readonly selectedSkillId: string | null;
    readonly contextExcerpts: readonly ContextExcerpt[];
    readonly attachments: readonly ComposerAttachmentDescriptor[];
    readonly taskReferences: readonly ComposerTaskReference[];
    readonly createdAt: number;
  }[],
) {
  return records.map((record) =>
    normalizedStashSchema.parse({
      id: record.id,
      text: record.text,
      ...(record.selectedSkillId === null
        ? {}
        : { selectedSkillId: record.selectedSkillId }),
      contextExcerpts: record.contextExcerpts,
      attachments: record.attachments,
      taskReferences: record.taskReferences,
      createdAt: new Date(record.createdAt).toISOString(),
    }),
  );
}

function attachmentContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string,
): string {
  const asciiFallback =
    fileName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_")
      .slice(0, 180) || "attachment";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function workspaceFileDownloadContentDisposition(fileName: string): string {
  const disposition = attachmentContentDisposition("attachment", fileName);
  // A Linux basename is at most 255 bytes (and percent-encoding expands it to
  // at most 765), but retain an explicit HTTP/client metadata boundary if a
  // provider ever violates that filesystem invariant.
  if (Buffer.byteLength(disposition, "latin1") > 2_048) {
    throw new Error("workspace_file_download_filename_too_large");
  }
  return disposition;
}

function attachmentEtag(attachmentId: string, byteSize: number): string {
  return `"attachment-${attachmentId}-${byteSize}"`;
}

const THREAD_LOAD_DIAGNOSTIC_ERROR_DEPTH = 4;
const THREAD_LOAD_DIAGNOSTIC_ERROR_CHILDREN = 4;
const THREAD_LOAD_DIAGNOSTIC_SUMMARY_BYTES = 1_024;
// Includes backend setup plus a bounded cold history acquisition. Keep the
// route budget above provider read budgets while retaining late-result cleanup.
const THREAD_RUNTIME_ACQUIRE_TIMEOUT_MILLISECONDS = 90_000;

export async function acquireThreadRuntimeWithDiagnostics<
  Result extends { release(): void },
>(
  acquire: () => Promise<Result>,
  input: {
    readonly requestId: string;
    readonly threadId: string;
    readonly routeSetupMilliseconds: number;
    readonly runtimeAcquireStartedAt: number;
    readonly timeoutMilliseconds?: number;
    readonly signal?: AbortSignal;
  },
): Promise<Result> {
  const enabled = Boolean(process.env.SEDES_DEBUG_DELIVERY);
  const prefix = `[delivery-thread-load] request=${diagnosticToken(input.requestId)} thread=${diagnosticToken(input.threadId)}`;
  if (enabled) {
    writeThreadLoadDiagnostic(
      `${prefix} phase=runtime_acquire_start route_ms=${roundedDiagnosticMilliseconds(input.routeSetupMilliseconds)}`,
    );
  }
  const acquisition = Promise.resolve().then(acquire);
  let abandoned = false;
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abandoned = true;
      reject(
        new DomainError(
          "runtime_unavailable",
          "The backend timed out while loading this thread.",
          true,
        ),
      );
    }, input.timeoutMilliseconds ?? THREAD_RUNTIME_ACQUIRE_TIMEOUT_MILLISECONDS);
    timeout.unref();
  });
  const cancellation = input.signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          abandoned = true;
          reject(
            input.signal?.reason ?? new Error("thread_stream_load_cancelled"),
          );
        };
        if (input.signal!.aborted) abortListener();
        else
          input.signal!.addEventListener("abort", abortListener, {
            once: true,
          });
      })
    : undefined;
  void acquisition.then(
    (runtime) => {
      if (abandoned) runtime.release();
    },
    () => undefined,
  );
  try {
    const result = await Promise.race(
      cancellation
        ? [acquisition, deadline, cancellation]
        : [acquisition, deadline],
    );
    if (enabled) {
      writeThreadLoadDiagnostic(
        `${prefix} phase=runtime_acquire_complete ok=1 ms=${roundedDiagnosticMilliseconds(performance.now() - input.runtimeAcquireStartedAt)}`,
      );
    }
    return result;
  } catch (error) {
    if (enabled) {
      writeThreadLoadDiagnostic(
        `${prefix} phase=runtime_acquire_complete ok=0 ms=${roundedDiagnosticMilliseconds(performance.now() - input.runtimeAcquireStartedAt)} error=${safeThreadLoadDiagnosticError(error)}`,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener)
      input.signal?.removeEventListener("abort", abortListener);
  }
}

function writeThreadLoadDiagnostic(record: string): void {
  try {
    console.error(record);
  } catch {
    // An optional diagnostic must never alter thread runtime acquisition.
  }
}

function safeThreadLoadDiagnosticError(error: unknown): string {
  try {
    return threadLoadDiagnosticError(error);
  } catch {
    return "diagnostic_unavailable";
  }
}

function threadLoadDiagnosticError(error: unknown, depth = 0): string {
  if (depth >= THREAD_LOAD_DIAGNOSTIC_ERROR_DEPTH) return "depth_limit";
  if (error instanceof BackendError) {
    const cause = error.cause
      ? `,cause=${threadLoadDiagnosticError(error.cause, depth + 1)}`
      : "";
    return boundedDiagnosticSummary(
      `BackendError[category=${diagnosticToken(error.category)},code=${diagnosticToken(error.backendCode ?? "unavailable")},retryable=${error.retryable ? 1 : 0}${cause}]`,
    );
  }
  if (error instanceof AggregateError) {
    const errors = Array.from(error.errors);
    const displayed = errors
      .slice(0, THREAD_LOAD_DIAGNOSTIC_ERROR_CHILDREN)
      .map((child) => threadLoadDiagnosticError(child, depth + 1));
    if (errors.length > displayed.length) displayed.push("truncated");
    return boundedDiagnosticSummary(
      `AggregateError[count=${errors.length},errors=${displayed.join("|")}]`,
    );
  }
  if (error instanceof Error) {
    const machineCode = diagnosticMachineCode(error);
    const cause = error.cause
      ? `,cause=${threadLoadDiagnosticError(error.cause, depth + 1)}`
      : "";
    return boundedDiagnosticSummary(
      `${diagnosticToken(error.name || "Error")}[code=${machineCode}${cause}]`,
    );
  }
  return `NonError[type=${diagnosticToken(typeof error)}]`;
}

function diagnosticMachineCode(error: Error): string {
  const propertyCode = (error as Error & { readonly code?: unknown }).code;
  for (const candidate of [propertyCode, error.message]) {
    if (
      typeof candidate === "string" &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(candidate)
    ) {
      return candidate;
    }
  }
  return "unavailable";
}

function diagnosticToken(value: string): string {
  return (
    value.slice(0, 160).replace(/[^A-Za-z0-9_.:-]/gu, "_") || "unavailable"
  );
}

function boundedDiagnosticSummary(value: string): string {
  return Buffer.byteLength(value, "utf8") <=
    THREAD_LOAD_DIAGNOSTIC_SUMMARY_BYTES
    ? value
    : `${value.slice(0, THREAD_LOAD_DIAGNOSTIC_SUMMARY_BYTES - 10)}:truncated`;
}

function roundedDiagnosticMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createNormalizedApp(dependencies: NormalizedAppDependencies) {
  const app = express();
  const workspaceManagement = () =>
    new WorkspaceApplicationService({
      inventory: dependencies.inventory.repository,
      execution: dependencies.execution,
      publications: dependencies.applicationSnapshots,
      discoverWorkspace: dependencies.discoverWorkspace,
    });
  const providerPulse =
    dependencies.providerPulse ??
    createProviderPulseGateway(dependencies.config.providerPulseUrl);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(requestIdMiddleware);
  app.use(securityHeaders);
  app.use(hostOriginGuard(dependencies.config));
  app.use(packagedClientCors(dependencies.config));
  if (dependencies.authentication) {
    app.use("/api/auth", dependencies.authentication.router());
    app.use(dependencies.authentication.middleware());
  } else {
    app.get("/api/auth/status", (_request, response) => response.json({ required: false, authenticated: false }));
  }
  app.use(
    "/api/tasks",
    express.json({
      limit: "512kb",
      strict: true,
      type: "application/json",
    }),
  );
  app.use("/api/workpads", express.json({ limit: "2mb", strict: true }));
  app.use("/api/configuration", express.json({ limit: "600kb", strict: true }));
  app.use("/api/workpads", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/api/workspaces/:workspaceId/files/content",
    express.json({
      limit: WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
      strict: true,
      type: "application/json",
    }),
  );
  app.use(
    express.json({
      limit: "256kb",
      strict: true,
      type: "application/json",
    }),
  );
  app.use("/api/tool-clients", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/application/canned-prompts", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((request, response, next) => csrfGuard(
    ["/api/agent-tools", "/api/agent-tool-descriptions", "/api/agent-tool-invocations", "/api/agent-tool-csrf"].includes(request.path.toLowerCase().replace(/\/$/u, ""))
      ? dependencies.csrfToken
      : dependencies.authentication?.csrfForRequest(request) ?? dependencies.csrfToken,
    new Set(["/api/agent-tool-descriptions"]),
  )(request, response, next));

  const scope = (request: Request) => dependencies.identity.resolve(request);
  const publish = (requestScope: RequestScope, threadId: string) =>
    dependencies.threadSnapshots.schedule(requestScope, threadId);
  // These three SSE handlers remain alive for the connection lifetime and are
  // drained by LongLivedHttpConnectionRegistry. Every ordinary route instead
  // retains its actual handler promise after the client socket disappears.
  const longLivedHandlers = new WeakSet<RequestHandler>();
  const longLived = <T extends RequestHandler>(handler: T): T => {
    longLivedHandlers.add(handler);
    return handler;
  };
  const register = (
    method: "get" | "head" | "post" | "put" | "patch" | "delete",
    routePath: string,
    handlers: readonly RequestHandler[],
  ): void => {
    const finalHandler = handlers.at(-1);
    if (!finalHandler) throw new Error("normalized_route_handler_required");
    const ownedFinal: RequestHandler = longLivedHandlers.has(finalHandler)
      ? finalHandler
      : (request, response, next) =>
          dependencies.requestOperations
            ? dependencies.requestOperations.run(() =>
                finalHandler(request, response, next),
              )
            : finalHandler(request, response, next);
    const preceding = handlers.slice(0, -1);
    const registrar = app[method].bind(app) as (
      path: string,
      ...routeHandlers: RequestHandler[]
    ) => unknown;
    registrar(routePath, ...preceding, ownedFinal);
  };
  const routes = {
    get: (routePath: string, ...handlers: RequestHandler[]) =>
      register("get", routePath, handlers),
    head: (routePath: string, ...handlers: RequestHandler[]) =>
      register("head", routePath, handlers),
    post: (routePath: string, ...handlers: RequestHandler[]) =>
      register("post", routePath, handlers),
    put: (routePath: string, ...handlers: RequestHandler[]) =>
      register("put", routePath, handlers),
    patch: (routePath: string, ...handlers: RequestHandler[]) =>
      register("patch", routePath, handlers),
    delete: (routePath: string, ...handlers: RequestHandler[]) =>
      register("delete", routePath, handlers),
  };
  const attachmentRouteParametersSchema = z.strictObject({
    threadId: z.uuid(),
    attachmentId: z.uuid(),
  });
  const outputArtifactRouteParametersSchema = z.strictObject({
    threadId: z.uuid(),
    artifactId: z.uuid(),
  });
  const attachmentStorageApiError = (
    error: ComposerAttachmentStorageError,
  ): ApiError => {
    switch (error.code) {
      case "attachment_too_large":
        return new ApiError(
          413,
          "attachment_payload_too_large",
          error.message,
          false,
        );
      case "attachment_upload_busy":
        return new ApiError(429, "invalid_transition", error.message, true);
      case "attachment_upload_aborted":
        return new ApiError(400, "bad_request", error.message, true);
      case "attachment_blob_missing":
        return new ApiError(404, "not_found", error.message, false);
      case "attachment_blob_corrupt":
        return new ApiError(500, "internal_error", error.message, false);
    }
  };
  const outputArtifactStorageApiError = (
    error: OutputArtifactStorageError,
  ): ApiError => {
    switch (error.code) {
      case "artifact_blob_missing":
        return new ApiError(
          404,
          "not_found",
          "The output artifact was not found.",
          false,
        );
      case "artifact_too_large":
      case "artifact_blob_corrupt":
        return new ApiError(
          500,
          "internal_error",
          "The output artifact failed its integrity check.",
          false,
        );
    }
  };

  routes.get("/api/health", (_request, response) => {
    const draining = dependencies.drain?.isDraining === true;
    response.status(draining ? 503 : 200).json({
      status: draining ? "draining" : "ok",
      version: SEDES_VERSION,
    });
  });

  app.use((request, _response, next) => {
    if (!dependencies.drain?.isDraining) {
      next();
      return;
    }
    next(
      new ApiError(
        503,
        "application_draining",
        "The application is shutting down.",
        true,
      ),
    );
  });

  routes.get(SEDES_AGENT_TOOL_CSRF_ROUTE, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(
      agentToolCsrfResponseSchema.parse({ csrfToken: dependencies.csrfToken }),
    );
  });

  routes.put(
    "/api/threads/:threadId/composer-attachments/:attachmentId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, attachmentId } = attachmentRouteParametersSchema.parse(
        request.params,
      );
      const query = putComposerAttachmentQuerySchema.parse(request.query);
      // declaredMediaType is intentionally non-authoritative. Exact bytes,
      // the sanitized basename, and the server signature classifier alone
      // decide whether content is a safe raster preview or an opaque file.
      if (request.header("Content-Type") !== "application/octet-stream") {
        throw new ApiError(
          415,
          "bad_request",
          "Attachment uploads require application/octet-stream.",
          false,
        );
      }
      const contentEncoding = request.header("Content-Encoding");
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        throw new ApiError(
          415,
          "bad_request",
          "Encoded attachment request bodies are not supported.",
          false,
        );
      }
      const rawContentLength = request.header("Content-Length");
      const contentLength =
        rawContentLength === undefined ? undefined : Number(rawContentLength);
      if (
        contentLength !== undefined &&
        (!Number.isSafeInteger(contentLength) || contentLength < 0)
      ) {
        throw new ApiError(
          400,
          "bad_request",
          "The attachment Content-Length is invalid.",
          false,
        );
      }
      try {
        const attachment = await dependencies.composerAttachments.upload({
          scope: requestScope,
          threadId,
          attachmentId,
          fileName: query.fileName,
          body: request,
          ...(contentLength === undefined ? {} : { contentLength }),
        });
        response
          .status(201)
          .json(putComposerAttachmentResultSchema.parse({ attachment }));
      } catch (error) {
        if (error instanceof ComposerAttachmentStorageError) {
          throw attachmentStorageApiError(error);
        }
        throw error;
      }
    },
  );

  routes.get(
    "/api/threads/:threadId/composer-attachments/:attachmentId/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, attachmentId } = attachmentRouteParametersSchema.parse(
        request.params,
      );
      let opened;
      try {
        opened = await dependencies.composerAttachments.openContent(
          requestScope,
          threadId,
          attachmentId,
        );
      } catch (error) {
        if (error instanceof ComposerAttachmentStorageError) {
          throw attachmentStorageApiError(error);
        }
        throw error;
      }
      const { descriptor, handle } = opened;
      const etag = attachmentEtag(descriptor.id, descriptor.byteSize);
      response.setHeader("Cache-Control", "private, max-age=3600, immutable");
      response.setHeader("ETag", etag);
      response.setHeader(
        "Content-Disposition",
        attachmentContentDisposition(
          descriptor.kind === "image" ? "inline" : "attachment",
          descriptor.fileName,
        ),
      );
      response.setHeader("Content-Type", descriptor.mediaType);
      response.setHeader("Content-Length", String(descriptor.byteSize));
      if (
        request
          .header("If-None-Match")
          ?.split(",")
          .map((value) => value.trim())
          .includes(etag)
      ) {
        await handle.close();
        response.removeHeader("Content-Length");
        response.status(304).end();
        return;
      }
      if (request.method === "HEAD") {
        await handle.close();
        response.status(200).end();
        return;
      }
      try {
        await pipeline(handle.createReadStream({ autoClose: false }), response);
      } catch (error) {
        // Headers already describe image bytes, so a mid-stream filesystem or
        // client failure cannot safely be converted into a JSON API response.
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  );

  routes.get(
    "/api/threads/:threadId/output-artifacts/:artifactId/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, artifactId } =
        outputArtifactRouteParametersSchema.parse(request.params);
      let opened;
      try {
        opened = await dependencies.outputArtifacts.openImage(
          requestScope,
          threadId,
          artifactId,
        );
      } catch (error) {
        if (error instanceof OutputArtifactStorageError) {
          throw outputArtifactStorageApiError(error);
        }
        throw error;
      }
      const { descriptor, handle } = opened;
      const extension =
        descriptor.mediaType === "image/png"
          ? "png"
          : descriptor.mediaType === "image/jpeg"
            ? "jpg"
            : descriptor.mediaType === "image/gif"
              ? "gif"
              : "webp";
      const etag = `"sha256-${descriptor.sha256}"`;
      response.setHeader("Cache-Control", "private, max-age=3600, immutable");
      response.setHeader("ETag", etag);
      response.setHeader(
        "Content-Disposition",
        attachmentContentDisposition(
          "inline",
          `${descriptor.artifactId}.${extension}`,
        ),
      );
      response.setHeader("Content-Type", descriptor.mediaType);
      response.setHeader("Content-Length", String(descriptor.byteSize));
      if (
        request
          .header("If-None-Match")
          ?.split(",")
          .map((value) => value.trim())
          .includes(etag)
      ) {
        await handle.close();
        response.removeHeader("Content-Length");
        response.status(304).end();
        return;
      }
      if (request.method === "HEAD") {
        await handle.close();
        response.status(200).end();
        return;
      }
      try {
        await pipeline(handle.createReadStream({ autoClose: false }), response);
      } catch (error) {
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  );

  if (dependencies.managedTerminalAdmissions) {
    routes.post(
      MANAGED_TERMINAL_ADMISSION_ROUTE,
      createManagedTerminalAdmissionHandler({
        authentication: dependencies.authentication,
        identity: dependencies.identity,
        admissions: dependencies.managedTerminalAdmissions,
        drain: dependencies.drain,
      }),
    );
  }

  if (dependencies.terminals) {
    app.use(
      createTerminalRouter({
        authentication: dependencies.authentication,
        identity: dependencies.identity,
        service: dependencies.terminals.service,
        admissions: dependencies.terminals.admissions,
        requestOperations: dependencies.requestOperations,
      }),
    );
  }

  routes.post("/api/threads/:threadId/usage/turn-availability", async (request, response) => {
    const requestScope = await scope(request);
    if (!dependencies.config.experimentalUsageEnabled) throw new ApiError(403, "experimental_usage_disabled", "Experimental usage accounting is disabled on this server.", false);
    response.setHeader("Cache-Control", "no-store");
    const {threadId}=threadRouteParametersSchema.parse(request.params);
    const {turnIds}=usageAvailabilityRequestSchema.parse(request.body);
    response.json(dependencies.usage.availability(requestScope,threadId,turnIds));
  });

  routes.post("/api/usage/analytics", async (request, response) => {
    const requestScope = await scope(request);
    if (!dependencies.config.experimentalUsageEnabled) throw new ApiError(403, "experimental_usage_disabled", "Experimental usage accounting is disabled on this server.", false);
    response.setHeader("Cache-Control", "no-store");
    response.json(dependencies.usage.analytics(requestScope, usageAnalyticsRequestSchema.parse(request.body)));
  });

  routes.get("/api/threads/:threadId/usage", async (request, response) => {
    const requestScope = await scope(request);
    if (!dependencies.config.experimentalUsageEnabled) throw new ApiError(403, "experimental_usage_disabled", "Experimental usage accounting is disabled on this server.", false);
    response.setHeader("Cache-Control", "no-store");
    response.json(dependencies.usage.read(requestScope, threadRouteParametersSchema.parse(request.params).threadId));
  });
  routes.get("/api/threads/:threadId/usage/turns/:turnId", async (request, response) => {
    const requestScope = await scope(request);
    if (!dependencies.config.experimentalUsageEnabled) throw new ApiError(403, "experimental_usage_disabled", "Experimental usage accounting is disabled on this server.", false);
    response.setHeader("Cache-Control", "no-store");
    const {threadId,turnId}=threadRouteParametersSchema.extend({turnId:z.string().min(1).max(160)}).parse(request.params);
    response.json(dependencies.usage.read(requestScope, threadId, turnId));
  });

  routes.get("/api/application/session", async (request, response) => {
    await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      normalizedApplicationSessionSchema.parse({
        clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
        version: SEDES_VERSION,
        csrfToken: dependencies.authentication?.csrfForRequest(request) ?? dependencies.csrfToken,
        providerPulseEnabled: providerPulse.enabled,
        experimentalUsageEnabled: dependencies.config.experimentalUsageEnabled,
      }),
    );
  });

  routes.get("/api/application/snapshot", async (request, response) => {
    const requestScope = await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      normalizedApplicationSnapshotSchema.parse(
        await dependencies.applicationSnapshots.capture(requestScope),
      ),
    );
  });

  routes.get("/api/application/notifications", async (request, response) => {
    const requestScope = await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      notificationSettingsSchema.parse(
        dependencies.notifications.read(requestScope),
      ),
    );
  });

  routes.put("/api/application/notifications", async (request, response) => {
    const requestScope = await scope(request);
    const input = updateNotificationSettingsRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      notificationSettingsSchema.parse(
        dependencies.notifications.update(requestScope, input),
      ),
    );
  });

  routes.put(
    "/api/application/notifications/silence",
    async (request, response) => {
      const requestScope = await scope(request);
      const input = setNotificationSilencedRequestSchema.parse(request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        notificationSettingsSchema.parse(
          dependencies.notifications.setSilenced(requestScope, input.silenced),
        ),
      );
    },
  );

  routes.post(
    "/api/application/notifications/test",
    async (request, response) => {
      const requestScope = await scope(request);
      const input = testNotificationRequestSchema.parse(request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        notificationTestResultSchema.parse(
          await dependencies.notifications.test(requestScope, input),
        ),
      );
    },
  );

  routes.get("/api/application/preferences", async (request, response) => {
    const requestScope = await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      applicationPreferencesSchema.parse(
        dependencies.principalPreferences.read(requestScope),
      ),
    );
  });

  routes.put("/api/application/preferences", async (request, response) => {
    const requestScope = await scope(request);
    const input = updateApplicationPreferencesRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      applicationPreferencesSchema.parse(
        dependencies.principalPreferences.update(requestScope, input),
      ),
    );
  });

  routes.get("/api/application/canned-prompts", async (request, response) => {
    const requestScope = await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      cannedPromptLibrarySchema.parse(
        dependencies.cannedPrompts.list(requestScope),
      ),
    );
  });

  routes.post("/api/application/canned-prompts", async (request, response) => {
    const requestScope = await scope(request);
    const input = createCannedPromptRequestSchema.parse(request.body);
    response.setHeader("Cache-Control", "no-store");
    response
      .status(201)
      .json(
        cannedPromptMutationResultSchema.parse(
          dependencies.cannedPrompts.create(requestScope, input),
        ),
      );
  });

  routes.put(
    "/api/application/canned-prompts/order",
    async (request, response) => {
      const requestScope = await scope(request);
      const input = reorderCannedPromptsRequestSchema.parse(request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        cannedPromptMutationResultSchema.parse(
          dependencies.cannedPrompts.reorder(requestScope, input),
        ),
      );
    },
  );

  routes.put(
    "/api/application/canned-prompts/:promptId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { promptId } = cannedPromptRouteParametersSchema.parse(
        request.params,
      );
      const input = updateCannedPromptRequestSchema.parse(request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        cannedPromptMutationResultSchema.parse(
          dependencies.cannedPrompts.update(requestScope, promptId, input),
        ),
      );
    },
  );

  routes.delete(
    "/api/application/canned-prompts/:promptId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { promptId } = cannedPromptRouteParametersSchema.parse(
        request.params,
      );
      const input = deleteCannedPromptRequestSchema.parse(request.body);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        cannedPromptMutationResultSchema.parse(
          dependencies.cannedPrompts.delete(requestScope, promptId, input),
        ),
      );
    },
  );

  routes.get(
    "/api/application/events",
    longLived(async (request, response) => {
      const query = applicationEventStreamQuerySchema.parse(request.query);
      const untrack = dependencies.longLivedConnections?.track(response);
      if (untrack) response.once("close", untrack);
      const requestScope = await scope(request);
      const hub = dependencies.applicationSnapshots.hub(requestScope);
      const release = () =>
        dependencies.applicationSnapshots.release(requestScope);
      await serveApplicationEventStream(
        request,
        response,
        hub,
        (force) => dependencies.applicationSnapshots.checkpoint(requestScope, hub, force),
        {
          onReplay: () => dependencies.applicationSnapshots.resumed(requestScope, hub),
          ...(query.replayCursor
            ? { explicitReplayCursor: query.replayCursor }
            : {}),
          ...(query.handshake ? { initialHandshake: query.handshake } : {}),
        },
      );
      release();
      request.once("close", release);
      response.once("close", release);
    }),
  );

  routes.get(
    "/api/workspaces/:workspaceId/files/events",
    longLived(async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const untrack = dependencies.longLivedConnections?.track(response);
      if (untrack) response.once("close", untrack);
      await serveWorkspaceFileEventStream(request, response, (listener) =>
        dependencies.workspaceFiles.watch(requestScope, workspaceId, listener),
      );
    }),
  );

  routes.get(
    "/api/threads/:threadId/events",
    longLived(async (request, response) => {
      const requestStartedAt = performance.now();
      const untrack = dependencies.longLivedConnections?.track(response);
      if (untrack) response.once("close", untrack);
      const requestId =
        typeof response.locals.requestId === "string"
          ? response.locals.requestId
          : "unavailable";
      try {
        const query = threadEventStreamQuerySchema.parse(request.query);
        const loadDiagnosticsRequested =
          query.diagnostics === THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE;
        const requestScope = await scope(request);
        const { threadId } = threadRouteParametersSchema.parse(request.params);
        const state = dependencies.inventory.repository.getThread(
          requestScope,
          threadId,
        );
        if (state.thread.backingState === "bound") {
          const runtimeAcquireStartedAt = performance.now();
          const acquisitionAbort = new AbortController();
          const cancelAcquisition = () =>
            acquisitionAbort.abort(new Error("thread_stream_load_cancelled"));
          response.once("close", cancelAcquisition);
          let runtime: Awaited<
            ReturnType<NormalizedAppDependencies["threadRuntimes"]["acquire"]>
          >;
          try {
            runtime = await acquireThreadRuntimeWithDiagnostics(
              () => dependencies.threadRuntimes.acquire(requestScope, threadId),
              {
                requestId,
                threadId,
                routeSetupMilliseconds:
                  runtimeAcquireStartedAt - requestStartedAt,
                runtimeAcquireStartedAt,
                signal: acquisitionAbort.signal,
              },
            );
          } catch (error) {
            response.off("close", cancelAcquisition);
            throw error;
          }
          const runtimeAcquireMilliseconds =
            performance.now() - runtimeAcquireStartedAt;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            runtime.release();
          };
          request.once("close", release);
          response.once("close", release);
          response.off("close", cancelAcquisition);
          if (response.destroyed || response.writableEnded) {
            release();
            return;
          }
          try {
            await serveThreadEventStream(
              request,
              response,
              runtime.hub,
              {
                publishAuthoritativeReplacement:
                  runtime.publishAuthoritativeReplacement,
              },
              {
                requestId,
                threadId,
                activityDetail: query.activityDetail,
                ...(query.replayCursor
                  ? { explicitReplayCursor: query.replayCursor }
                  : {}),
                ...(loadDiagnosticsRequested
                  ? {
                      loadDiagnostics: {
                        requestStartedAt,
                        routeSetupMilliseconds:
                          runtimeAcquireStartedAt - requestStartedAt,
                        runtimeAcquireMilliseconds,
                      },
                    }
                  : {}),
              },
            );
          } finally {
            // The established hub subscription retains the runtime for viewing.
            // A reader must not hold an execution borrow that blocks explicit Stop.
            release();
          }
          return;
        }
        const quiet = dependencies.threadRuntimes.quiet(requestScope, threadId);
        const replacement = async () =>
          dependencies.threadSnapshots.publishAuthoritativeReplacement(
            requestScope,
            threadId,
          );
        let releaseOnClose = false;
        try {
          await serveThreadEventStream(
            request,
            response,
            quiet.hub,
            { publishAuthoritativeReplacement: replacement },
            {
              requestId,
              threadId,
              activityDetail: query.activityDetail,
              ...(query.replayCursor
                ? { explicitReplayCursor: query.replayCursor }
                : {}),
              ...(loadDiagnosticsRequested
                ? {
                    loadDiagnostics: {
                      requestStartedAt,
                      routeSetupMilliseconds:
                        performance.now() - requestStartedAt,
                      runtimeAcquireMilliseconds: 0,
                    },
                  }
                : {}),
            },
          );
          if (!response.destroyed && !response.writableEnded) {
            // Transfer the publication lease to the live stream. Register after
            // thread-sse cleanup so its subscriber is removed before release.
            request.once("close", quiet.release);
            releaseOnClose = true;
          }
        } finally {
          // Failed or already closed handshakes have no future close to own
          // cleanup. A live stream retains its lease until subscriber removal.
          if (!releaseOnClose) quiet.release();
        }
      } catch (error) {
        serveThreadLoadError(response, error, requestId);
      }
    }),
  );

  routes.get("/api/threads/:threadId/questions", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    response.json(
      questionRequestsResultSchema.parse(
        dependencies.questions.list(requestScope, threadId),
      ),
    );
  });
  routes.post(
    "/api/threads/:threadId/question-statuses",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const { sourceItemIds } = questionStatusesRequestSchema.parse(
        request.body,
      );
      response.json(
        questionStatusesResultSchema.parse(
          dependencies.questions.statuses(
            requestScope,
            threadId,
            sourceItemIds,
          ),
        ),
      );
    },
  );
  const questionParametersSchema = z.strictObject({
    threadId: z.string().min(1).max(160),
    questionId: z.string().min(1).max(160),
  });
  routes.post(
    "/api/threads/:threadId/questions/:questionId/dismiss",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, questionId } = questionParametersSchema.parse(
        request.params,
      );
      response.json(
        questionRequestsResultSchema.parse(
          dependencies.questions.dismiss(
            requestScope,
            threadId,
            questionId,
            dismissQuestionRequestSchema.parse(request.body),
          ),
        ),
      );
    },
  );
  routes.post(
    "/api/threads/:threadId/questions/:questionId/respond",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, questionId } = questionParametersSchema.parse(
        request.params,
      );
      response.json(
        respondToQuestionResultSchema.parse(
          await dependencies.questions.respond(
            requestScope,
            threadId,
            questionId,
            respondToQuestionRequestSchema.parse(request.body),
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/operations",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const operation = threadApplicationOperationSchema.parse(request.body);
      const result = await dependencies.threads.mutate(
        requestScope,
        threadId,
        operation,
      );
      response.json(
        (operation.kind === "deliver"
          ? threadDeliveryMutationResultSchema
          : threadApplicationMutationResultSchema
        ).parse(result),
      );
    },
  );

  routes.get("/api/threads/:threadId/skills", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    response.json(
      composerSkillCatalogSchema.parse(
        await dependencies.threads.skills(requestScope, threadId),
      ),
    );
  });

  routes.post("/api/threads/:threadId/history", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const { cursor, limit, activityDetail } =
      loadThreadHistoryRequestSchema.parse(request.body);
    response.json(
      threadEventEnvelopeSchema.parse(
        projectThreadEventEnvelopeActivity(
          await dependencies.history.loadOlder(
            requestScope,
            threadId,
            cursor,
            limit,
          ),
          activityDetail,
        ),
      ),
    );
  });

  routes.post(
    "/api/threads/:threadId/history/seek",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const { turnId, activityDetail } = seekThreadHistoryRequestSchema.parse(
        request.body,
      );
      response.json(
        threadHistorySeekResultSchema.parse(
          projectThreadHistorySeekActivity(
            await dependencies.history.seekTurn(requestScope, threadId, turnId),
            activityDetail,
          ),
        ),
      );
    },
  );

  routes.post("/api/threads/:threadId/forks", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const body = forkThreadRequestSchema.parse(request.body);
    const result = forkThreadResultSchema.parse(
      await dependencies.lineage.forkManual({
        scope: requestScope,
        sourceThreadId: threadId,
        ...body,
      }),
    );
    response
      .status(
        result.status === "created"
          ? 201
          : result.status === "recovery_required"
            ? 202
            : 200,
      )
      .json(result);
  });

  routes.patch(
    "/api/threads/:threadId/lineage/placement",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = updateThreadLineagePlacementRequestSchema.parse(
        request.body,
      );
      response.json(
        normalizedThreadLineagePlacementSchema.parse(
          await dependencies.lineage.updatePlacement({
            scope: requestScope,
            childThreadId: threadId,
            ...body,
          }),
        ),
      );
    },
  );

  routes.get(
    "/api/threads/:threadId/descendants",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const query = listThreadDescendantsQuerySchema.parse(request.query);
      response.json(
        normalizedThreadDescendantsPageSchema.parse(
          await dependencies.lineage.listDescendants({
            scope: requestScope,
            sourceThreadId: threadId,
            ...query,
          }),
        ),
      );
    },
  );

  routes.get("/api/threads/:threadId", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const { activityDetail } = threadSnapshotQuerySchema.parse(request.query);
    response.json(
      projectThreadSnapshotActivity(
        await dependencies.threads.snapshot(requestScope, threadId),
        activityDetail,
      ),
    );
  });

  routes.get("/api/workspaces", async (request, response) => {
    response.json(listProjectsResultSchema.parse({ projects: dependencies.inventory.repository.listProjects(await scope(request)) }));
  });

  routes.post("/api/workspaces/:workspaceId/remove", async (request, response) => {
    const requestScope = await scope(request);
    const workspaceId = z.uuid().parse(request.params.workspaceId);
    const body = removeProjectRequestSchema.parse(request.body);
    const service = new ProjectManagementService({
      inventory: dependencies.inventory.repository,
      runtimes: dependencies.threadRuntimes,
      files: dependencies.workspaceFiles,
      ...(dependencies.terminals ? { terminals: dependencies.terminals.service } : {}),
      publications: dependencies.applicationSnapshots,
    });
    response.json(projectSummarySchema.parse(await service.remove(requestScope, workspaceId, body)));
  });

  routes.post("/api/workspaces/open", async (request, response) => {
    const requestScope = await scope(request);
    const body = openWorkspaceRequestSchema.parse(request.body);
    const workspace = await workspaceManagement().openWorkspace(
      requestScope,
      body,
    );
    response.status(201).json({ id: workspace.workspaceId });
  });

  routes.post(
    "/api/execution-environments/:environmentId/directories/browse",
    async (request, response) => {
      const requestScope = await scope(request);
      const environmentId = z
        .string()
        .min(1)
        .max(160)
        .parse(request.params.environmentId);
      const body = directoryBrowseRequestSchema.parse(request.body);
      const result = await callRuntime(() =>
        dependencies.execution.browseDirectories(requestScope, {
          environmentId,
          ...body,
          signal: workspaceFileRequestSignal(request, response),
        }),
      );
      response.json(directoryBrowseResultSchema.parse(result));
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/open",
    async (request, response) => {
      const requestScope = await scope(request);
      const workspaceId = z.uuid().parse(request.params.workspaceId);
      const current = dependencies.inventory.repository.getWorkspace(
        requestScope,
        workspaceId,
      );
      const workspace = await workspaceManagement().openWorkspace(requestScope, {
        environmentId: current.environmentId,
        path: current.canonicalPath,
      });
      response.json({ id: workspace.workspaceId });
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceFileListQuerySchema.parse(request.query);
      response.json(
        workspaceFileListResultSchema.parse(
          await dependencies.workspaceFiles.list(
            requestScope,
            workspaceId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/files/directory",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceFileDirectoryQuerySchema.parse(request.query);
      response.json(
        workspaceFileDirectoryResultSchema.parse(
          await dependencies.workspaceFiles.listDirectory(
            requestScope,
            workspaceId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      response.json(
        workspaceFileRootsResultSchema.parse(
          await dependencies.workspaceFiles.listRoots(
            requestScope,
            workspaceId,
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceFileRootCreateRequestSchema.parse(request.body);
      response
        .status(201)
        .json(
          workspaceFileRootCreateResultSchema.parse(
            await dependencies.workspaceFiles.attachRoot(
              requestScope,
              workspaceId,
              input,
            ),
          ),
        );
    },
  );

  routes.delete(
    "/api/workspaces/:workspaceId/file-roots/:rootId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } =
        workspaceFileRootDeleteRouteParametersSchema.parse(request.params);
      const input = workspaceFileRootDeleteRequestSchema.parse(request.body);
      response.json(
        workspaceFileRootDeleteResultSchema.parse(
          await dependencies.workspaceFiles.deleteRoot(
            requestScope,
            workspaceId,
            rootId,
            input,
          ),
        ),
      );
    },
  );

  routes.delete(
    "/api/workspaces/:workspaceId/linked-worktrees/:rootId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } =
        workspaceLinkedWorktreeDeleteRouteParametersSchema.parse(
          request.params,
        );
      const input = workspaceLinkedWorktreeDeleteRequestSchema.parse(
        request.body,
      );
      response.json(
        workspaceLinkedWorktreeDeleteResultSchema.parse(
          await dependencies.workspaceFiles.deleteLinkedWorktree(
            requestScope,
            workspaceId,
            rootId,
            input,
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-links/resolve",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceFileLinkResolveRequestSchema.parse(request.body);
      response.json(
        workspaceFileLinkResolveResultSchema.parse(
          await dependencies.workspaceFiles.resolveWorkspaceFileLink(
            requestScope,
            workspaceId,
            input,
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/file-links/resolve",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const input = workspaceFileLinkResolveRequestSchema.parse(request.body);
      response.json(
        workspaceFileLinkResolveResultSchema.parse(
          await dependencies.workspaceFiles.resolveThreadFileLink(
            requestScope,
            threadId,
            input,
          ),
        ),
      );
    },
  );

  routes.put(
    "/api/threads/:threadId/preferred-worktree",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const input = threadPreferredWorktreeUpdateRequestSchema.parse(
        request.body,
      );
      // Refresh discovery before accepting an opaque selector so stale or
      // wrong-workspace IDs fail closed at the durable mutation boundary.
      const thread = dependencies.inventory.repository.getThread(
        requestScope,
        threadId,
      );
      if (input.rootId !== null) {
        await dependencies.workspaceFiles.requireAvailableLinkedWorktree(
          requestScope,
          thread.thread.workspaceId,
          input.rootId,
        );
      }
      response.json(
        threadPreferredWorktreeUpdateResultSchema.parse(
          await dependencies.inventory.setPreferredWorktree(
            requestScope,
            threadId,
            input,
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/files/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const { rootId, path: relativePath } =
        workspaceFileContentQuerySchema.parse(request.query);
      response.json(
        workspaceFileContentResultSchema.parse(
          await dependencies.workspaceFiles.read(
            requestScope,
            workspaceId,
            rootId,
            relativePath,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  const serveWorkspaceFileDownload: RequestHandler = async (
    request,
    response,
  ) => {
    const requestScope = await scope(request);
    const { workspaceId } = workspaceFileRouteParametersSchema.parse(
      request.params,
    );
    const query = workspaceFileDownloadQuerySchema.parse(request.query);
    if (request.header("Range") !== undefined) {
      throw new ApiError(
        416,
        "range_not_supported",
        "Workspace file downloads do not support byte ranges.",
      );
    }
    const signal = workspaceFileRequestSignal(request, response);
    const durationController = new AbortController();
    const durationTimeout = setTimeout(
      () =>
        durationController.abort(
          new Error("workspace_file_download_duration_exceeded"),
        ),
      WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS,
    );
    durationTimeout.unref();
    const downloadSignal = AbortSignal.any([signal, durationController.signal]);
    try {
      await dependencies.workspaceFiles.withDownload(
        requestScope,
        workspaceId,
        query,
        async (source) => {
          response.status(200);
          response.setHeader("Cache-Control", "private, no-store");
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Content-Length", String(source.sizeBytes));
          response.setHeader(
            "Content-Disposition",
            workspaceFileDownloadContentDisposition(source.fileName),
          );
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader(
            "X-Sedes-Workspace-File-Revision",
            source.revision,
          );
          if (request.method === "HEAD") return;
          await source.stream(async (chunk) => {
            downloadSignal.throwIfAborted();
            if (response.write(chunk)) return;
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => {
                response.off("drain", onDrain);
                response.off("error", onError);
                response.off("close", onClose);
              };
              const onDrain = () => {
                cleanup();
                resolve();
              };
              const onError = (error: Error) => {
                cleanup();
                reject(error);
              };
              const onClose = () => {
                cleanup();
                reject(new Error("workspace_file_http_request_closed"));
              };
              response.once("drain", onDrain);
              response.once("error", onError);
              response.once("close", onClose);
            });
          }, downloadSignal);
        },
        downloadSignal,
      );
      if (!response.destroyed) response.end();
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }
      throw error;
    } finally {
      clearTimeout(durationTimeout);
    }
  };
  routes.head(
    "/api/workspaces/:workspaceId/files/download",
    serveWorkspaceFileDownload,
  );
  routes.get(
    "/api/workspaces/:workspaceId/files/download",
    serveWorkspaceFileDownload,
  );

  routes.put(
    "/api/workspaces/:workspaceId/files/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceFileWriteRequestSchema.parse(request.body);
      response.json(
        workspaceFileWriteResultSchema.parse(
          await dependencies.workspaceFiles.write(
            requestScope,
            workspaceId,
            input,
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/files/status",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId } = workspaceFileRouteParametersSchema.parse(
        request.params,
      );
      response.json(
        workspaceFileStatusResultSchema.parse(
          await dependencies.workspaceFiles.status(
            requestScope,
            workspaceId,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/repositories",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      response.json(
        workspaceDiffRepositoriesResultSchema.parse(
          await dependencies.workspaceFiles.diffRepositories(
            requestScope,
            workspaceId,
            rootId,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/refs",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffRefCatalogQuerySchema.parse(request.query);
      response.json(
        workspaceDiffRefCatalogResultSchema.parse(
          await dependencies.workspaceFiles.diffRefCatalog(
            requestScope,
            workspaceId,
            rootId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/comparisons",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffComparisonCreateRequestSchema.parse(
        request.body,
      );
      response
        .status(201)
        .json(
          workspaceDiffComparisonCreateResultSchema.parse(
            await dependencies.workspaceFiles.diffCreateComparison(
              requestScope,
              workspaceId,
              rootId,
              input,
              workspaceFileRequestSignal(request, response),
            ),
          ),
        );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffChangedFilesQuerySchema.parse(request.query);
      response.json(
        workspaceDiffChangedFilesResultSchema.parse(
          await dependencies.workspaceFiles.diffChangedFiles(
            requestScope,
            workspaceId,
            rootId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/patch",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffFileRequestSchema.parse(request.query);
      response.json(
        workspaceDiffPatchResultSchema.parse(
          await dependencies.workspaceFiles.diffPatch(
            requestScope,
            workspaceId,
            rootId,
            input,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffFileContentRequestSchema.parse(request.query);
      response.json(
        workspaceDiffFileContentResultSchema.parse(
          await dependencies.workspaceFiles.diffFileContent(
            requestScope,
            workspaceId,
            rootId,
            input,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/review-history",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffReviewRepositoryListQuerySchema.parse(
        request.query,
      );
      const resolved =
        await dependencies.workspaceFiles.diffReviewRepositoryIdentity(
          requestScope,
          workspaceId,
          rootId,
          query,
          workspaceFileRequestSignal(request, response),
        );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      response.json(
        workspaceDiffReviewListResultSchema.parse({
          reviews: dependencies.workspaceDiffReviews
            .listReviews(requestScope, {
              workspaceId,
              rootId,
              repositoryKey: resolved.repositoryKey,
            })
            .map(workspaceDiffReview),
        }),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffReviewListQuerySchema.parse(request.query);
      const resolved = await dependencies.workspaceFiles.diffReviewIdentity(
        requestScope,
        workspaceId,
        rootId,
        query,
        workspaceFileRequestSignal(request, response),
      );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      const identity = resolvedWorkspaceDiffReviewIdentity(
        workspaceId,
        rootId,
        resolved.identity,
      );
      response.json(
        workspaceDiffReviewListResultSchema.parse({
          reviews: dependencies.workspaceDiffReviews
            .listReviews(requestScope, {
              workspaceId,
              rootId,
              repositoryKey: identity.repositoryKey,
            })
            .filter((review) =>
              sameWorkspaceDiffReviewIdentity(review, identity),
            )
            .map(workspaceDiffReview),
        }),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffReviewOpenRequestSchema.parse(request.body);
      const resolved = await dependencies.workspaceFiles.diffReviewIdentity(
        requestScope,
        workspaceId,
        rootId,
        input,
        workspaceFileRequestSignal(request, response),
      );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      response.status(201).json(
        workspaceDiffReview(
          dependencies.workspaceDiffReviews.openReview(
            requestScope,
            resolvedWorkspaceDiffReviewIdentity(
              workspaceId,
              rootId,
              resolved.identity,
            ),
            {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.summary === undefined
                ? {}
                : { summary: input.summary }),
              mutationId: input.mutationId,
            },
          ),
        ),
      );
    },
  );

  routes.patch(
    "/api/workspace-diff-reviews/:reviewId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffReviewUpdateRequestSchema.parse(request.body);
      response.json(
        workspaceDiffReview(
          dependencies.workspaceDiffReviews.updateReview(
            requestScope,
            reviewId,
            input,
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspace-diff-reviews/:reviewId/comments",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      response.json(
        workspaceDiffReviewCommentsResultSchema.parse({
          comments: dependencies.workspaceDiffReviews
            .listComments(requestScope, reviewId)
            .map(workspaceDiffReviewComment),
        }),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews/:reviewId/comments",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId, reviewId } =
        workspaceDiffRouteParametersSchema
          .extend({ reviewId: workspaceDiffReviewIdSchema })
          .parse(request.params);
      const input = workspaceDiffReviewCommentCreateRequestSchema.parse(
        request.body,
      );
      const review = dependencies.workspaceDiffReviews.getReview(
        requestScope,
        reviewId,
      );
      if (review.workspaceId !== workspaceId || review.rootId !== rootId) {
        throw new DomainError(
          "not_found",
          "The workspace diff review was not found.",
        );
      }
      const validated =
        await dependencies.workspaceFiles.diffValidateReviewAnchor(
          requestScope,
          workspaceId,
          rootId,
          input,
          workspaceFileRequestSignal(request, response),
        );
      if (validated.status !== "available") {
        throw workspaceDiffResolutionError(validated.status);
      }
      if (
        validated.anchor.repositoryKey !== review.repositoryKey ||
        validated.anchor.comparisonFingerprint !== review.fingerprint
      ) {
        throw new DomainError(
          "conflict",
          "The workspace comparison no longer matches this review.",
        );
      }
      const result = dependencies.workspaceDiffReviews.createComment(
        requestScope,
        reviewId,
        {
          ...validatedWorkspaceDiffCommentAnchor(validated.anchor),
          body: input.body,
          ...(input.state === undefined ? {} : { state: input.state }),
          expectedReviewRevision: input.expectedReviewRevision,
          mutationId: input.mutationId,
        },
      );
      response.status(201).json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.patch(
    "/api/workspace-diff-reviews/:reviewId/comments/:commentId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId, commentId } =
        workspaceDiffReviewCommentRouteParametersSchema.parse(request.params);
      const input = workspaceDiffReviewCommentUpdateRequestSchema.parse(
        request.body,
      );
      const result = dependencies.workspaceDiffReviews.updateComment(
        requestScope,
        reviewId,
        commentId,
        input,
      );
      response.json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.delete(
    "/api/workspace-diff-reviews/:reviewId/comments/:commentId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId, commentId } =
        workspaceDiffReviewCommentRouteParametersSchema.parse(request.params);
      const input = workspaceDiffReviewCommentDeleteRequestSchema.parse(
        request.body,
      );
      const result = dependencies.workspaceDiffReviews.deleteComment(
        requestScope,
        reviewId,
        commentId,
        input,
      );
      response.json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.get(
    "/api/workspace-diff-reviews/:reviewId/reviewed-files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      response.json(
        workspaceDiffReviewedFilesResultSchema.parse({
          files: dependencies.workspaceDiffReviews
            .listReviewedFiles(requestScope, reviewId)
            .map(workspaceDiffReviewedFile),
        }),
      );
    },
  );

  routes.put(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews/:reviewId/reviewed-files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId, reviewId } =
        workspaceDiffRouteParametersSchema
          .extend({ reviewId: workspaceDiffReviewIdSchema })
          .parse(request.params);
      const input = workspaceDiffReviewedFileSetRequestSchema.parse(
        request.body,
      );
      const review = dependencies.workspaceDiffReviews.getReview(
        requestScope,
        reviewId,
      );
      if (review.workspaceId !== workspaceId || review.rootId !== rootId) {
        throw new DomainError(
          "not_found",
          "The workspace diff review was not found.",
        );
      }
      const validated =
        await dependencies.workspaceFiles.diffValidateReviewedFile(
          requestScope,
          workspaceId,
          rootId,
          input,
          workspaceFileRequestSignal(request, response),
        );
      if (validated.status !== "available") {
        throw workspaceDiffResolutionError(validated.status);
      }
      if (
        validated.file.repositoryKey !== review.repositoryKey ||
        validated.file.comparisonFingerprint !== review.fingerprint
      ) {
        throw new DomainError(
          "conflict",
          "The workspace comparison no longer matches this review.",
        );
      }
      const result = dependencies.workspaceDiffReviews.setReviewedFile(
        requestScope,
        reviewId,
        {
          fileIdentity: validated.file.reviewFileIdentity,
          filePath: validated.file.path,
          contentFingerprint: validated.file.contentFingerprint,
          reviewed: input.reviewed,
          expectedReviewRevision: input.expectedReviewRevision,
          expectedFileRevision: input.expectedFileRevision,
          mutationId: input.mutationId,
        },
      );
      response.json(
        workspaceDiffReviewedFileMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          file: workspaceDiffReviewedFile(result.value),
        }),
      );
    },
  );

  routes.get("/api/agents", async (request, response) => {
    const requestScope = await scope(request);
    const query = savedAgentListQuerySchema.parse(request.query);
    response.json(
      savedAgentListPageSchema.parse(
        dependencies.savedAgents.list(requestScope, query),
      ),
    );
  });

  routes.post("/api/agents", async (request, response) => {
    const requestScope = await scope(request);
    const body = createSavedAgentRequestSchema.parse(request.body);
    const agent = await dependencies.savedAgents.createAgent(
      requestScope,
      body,
    );
    response.status(201).json(savedAgentMutationResultSchema.parse({ agent }));
  });

  routes.post("/api/agents/options", async (request, response) => {
    const requestScope = await scope(request);
    const body = savedAgentOptionsRequestSchema.parse(request.body);
    response.json(
      savedAgentOptionsResultSchema.parse(
        await dependencies.savedAgents.options(requestScope, body),
      ),
    );
  });

  routes.get("/api/agents/:agentId", async (request, response) => {
    const requestScope = await scope(request);
    const { agentId } = savedAgentRouteParametersSchema.parse(request.params);
    response.json(
      savedAgentSchema.parse(
        dependencies.savedAgents.get(requestScope, agentId),
      ),
    );
  });

  routes.patch("/api/agents/:agentId", async (request, response) => {
    const requestScope = await scope(request);
    const { agentId } = savedAgentRouteParametersSchema.parse(request.params);
    const body = updateSavedAgentRequestSchema.parse(request.body);
    const agent = await dependencies.savedAgents.updateAgent(
      requestScope,
      agentId,
      body,
    );
    response.json(savedAgentMutationResultSchema.parse({ agent }));
  });

  routes.delete("/api/agents/:agentId", async (request, response) => {
    const requestScope = await scope(request);
    const { agentId } = savedAgentRouteParametersSchema.parse(request.params);
    const body = deleteSavedAgentRequestSchema.parse(request.body);
    response.json(
      dependencies.savedAgents.deleteAgent(
        requestScope,
        agentId,
        body.expectedRevision,
      ),
    );
  });

  routes.post("/api/agents/:agentId/resolve", async (request, response) => {
    const requestScope = await scope(request);
    const { agentId } = savedAgentRouteParametersSchema.parse(request.params);
    const body = resolveSavedAgentRequestSchema.parse(request.body);
    response.json(
      resolveSavedAgentResultSchema.parse(
        await dependencies.savedAgents.resolveAgent(
          requestScope,
          agentId,
          body,
        ),
      ),
    );
  });

  routes.get("/api/thread-templates", async (request, response) => {
    const requestScope = await scope(request);
    const query = threadTemplateListQuerySchema.parse(request.query);
    response.json(
      threadTemplateListPageSchema.parse(
        dependencies.threadTemplates.list(requestScope, query),
      ),
    );
  });

  routes.post("/api/thread-templates", async (request, response) => {
    const requestScope = await scope(request);
    const body = createThreadTemplateRequestSchema.parse(request.body);
    const template = await dependencies.threadTemplates.create(
      requestScope,
      body,
    );
    response
      .status(201)
      .json(threadTemplateMutationResultSchema.parse({ template }));
  });

  routes.get("/api/thread-templates/:templateId", async (request, response) => {
    const requestScope = await scope(request);
    const { templateId } = threadTemplateRouteParametersSchema.parse(
      request.params,
    );
    response.json(
      threadTemplateSchema.parse(
        dependencies.threadTemplates.get(requestScope, templateId),
      ),
    );
  });

  routes.patch(
    "/api/thread-templates/:templateId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { templateId } = threadTemplateRouteParametersSchema.parse(
        request.params,
      );
      const body = updateThreadTemplateRequestSchema.parse(request.body);
      const template = await dependencies.threadTemplates.update(
        requestScope,
        templateId,
        body,
      );
      response.json(threadTemplateMutationResultSchema.parse({ template }));
    },
  );

  routes.delete(
    "/api/thread-templates/:templateId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { templateId } = threadTemplateRouteParametersSchema.parse(
        request.params,
      );
      const body = deleteThreadTemplateRequestSchema.parse(request.body);
      response.json(
        dependencies.threadTemplates.delete(
          requestScope,
          templateId,
          body.expectedRevision,
        ),
      );
    },
  );

  routes.get("/api/environment-variables/preview", async (request, response) => {
    const requestScope = await scope(request);
    const query = environmentVariablesPreviewQuerySchema.parse(request.query);
    if (!dependencies.environmentVariables) throw new DomainError("runtime_unavailable", "Environment variables are unavailable.");
    response.json(environmentVariablesPreviewResultSchema.parse(dependencies.environmentVariables.preview(requestScope, query.targetId, query.agentId)));
  });
  routes.get("/api/threads/:threadId/environment-variables", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    if (!dependencies.environmentVariables) throw new DomainError("runtime_unavailable", "Environment variables are unavailable.");
    response.json(threadEnvironmentVariablesResultSchema.parse({snapshot: dependencies.environmentVariables.get(requestScope, threadId), editable: false}));
  });

  routes.post("/api/threads", async (request, response) => {
    const requestScope = await scope(request);
    const body = createThreadRequestSchema.parse(request.body);
    const created = await dependencies.savedAgents.createThread(
      requestScope,
      body,
      { kind: "http_ui" },
    );
    response.status(201).json(createThreadResultSchema.parse(created));
  });

  routes.post(
    "/api/threads/:threadId/configuration-copies",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = createThreadFromSettingsRequestSchema.parse(request.body);
      const created = await dependencies.savedAgents.createThreadFromSettings(
        requestScope,
        threadId,
        body,
      );
      response.status(201).json(createThreadResultSchema.parse(created));
    },
  );

  routes.put("/api/threads/:threadId/draft", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const body = saveDraftRequestSchema.parse(request.body);
    const changed = dependencies.inventory.saveDraft(
      requestScope,
      threadId,
      body,
    );
    await publish(requestScope, threadId);
    response.json(draft(changed));
  });

  routes.post("/api/threads/:threadId/stashes", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const body = stashDraftRequestSchema.parse(request.body);
    const result = dependencies.inventory.stashDraft(
      requestScope,
      threadId,
      body,
    );
    await publish(requestScope, threadId);
    response.status(result.replayed ? 200 : 201).json({
      draft: draft(result.draft),
      stashes: stashes(
        dependencies.inventory.repository.listStashes(requestScope, threadId),
      ),
    });
  });

  routes.post(
    "/api/threads/:threadId/stashes/:stashId/restore",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, stashId } = stashRouteParametersSchema.parse(
        request.params,
      );
      const body = restoreStashRequestSchema.parse(request.body);
      const result = dependencies.inventory.restoreStash(
        requestScope,
        threadId,
        stashId,
        body,
      );
      await publish(requestScope, threadId);
      response.json({
        draft: draft(result.draft),
        stashes: stashes(
          dependencies.inventory.repository.listStashes(requestScope, threadId),
        ),
      });
    },
  );

  routes.delete(
    "/api/threads/:threadId/stashes/:stashId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, stashId } = stashRouteParametersSchema.parse(
        request.params,
      );
      dependencies.inventory.repository.deleteStash(
        requestScope,
        threadId,
        stashId,
      );
      await publish(requestScope, threadId);
      response.json({
        stashes: stashes(
          dependencies.inventory.repository.listStashes(requestScope, threadId),
        ),
      });
    },
  );

  routes.post("/api/tasks", async (request, response) => {
    const requestScope = await scope(request);
    const body = createTaskRequestSchema.parse(request.body);
    const task = await dependencies.tasks.create(requestScope, body);
    response.status(201).json(taskMutationResultSchema.parse({ task }));
  });
  registerWorkpadRoutes(routes, scope, dependencies.workpads);
  if (dependencies.hostPairingAdmin) {
    registerHostPairingRoutes(routes, scope, dependencies.hostPairingAdmin);
  }
  if (dependencies.outboundArtifact) registerOutboundArtifactRoutes(routes, dependencies.outboundArtifact, {
    connectorDirectory: dependencies.outboundConnectorDirectory,
  });
  if (dependencies.configurationOperationRecovery) {
    registerConfigurationOperationRecoveryRoutes(routes, scope, dependencies.configurationOperationRecovery);
  }
  if (dependencies.configurationAdmin) {
    registerConfigurationAdminRoutes(
      routes,
      scope,
      dependencies.configurationAdmin,
    );
  }

  routes.patch("/api/tasks/:taskId", async (request, response) => {
    const requestScope = await scope(request);
    const { taskId } = taskRouteParametersSchema.parse(request.params);
    const body = updateTaskRequestSchema.parse(request.body);
    const task = await dependencies.tasks.update(requestScope, taskId, body);
    response.json(taskMutationResultSchema.parse({ task }));
  });

  routes.post("/api/tasks/:taskId/move", async (request, response) => {
    const requestScope = await scope(request);
    const { taskId } = taskRouteParametersSchema.parse(request.params);
    const body = moveTaskRequestSchema.parse(request.body);
    const task = await dependencies.tasks.move(requestScope, taskId, body);
    response.json(taskMutationResultSchema.parse({ task }));
  });

  routes.delete("/api/tasks/:taskId", async (request, response) => {
    const requestScope = await scope(request);
    const { taskId } = taskRouteParametersSchema.parse(request.params);
    await dependencies.tasks.remove(requestScope, taskId);
    response.status(204).end();
  });

  routes.get(
    "/api/threads/:threadId/force-reset-impact",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      response.json(
        threadForceResetImpactSchema.parse(
          await dependencies.threadForceResets.impact(requestScope, threadId),
        ),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/force-reset",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = threadForceResetRequestSchema.parse(request.body);
      response.json(
        threadForceResetResultSchema.parse(
          await dependencies.threadForceResets.forceReset(
            requestScope,
            threadId,
            body,
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/threads/:threadId/inventory/archive-impact",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      response.json(
        threadArchiveImpactSchema.parse(
          await dependencies.threadArchives.impact(requestScope, threadId),
        ),
      );
    },
  );

  routes.post(
    "/api/thread-inventory/bulk-impact",
    async (request, response) => {
      const requestScope = await scope(request);
      const body = bulkInventoryImpactRequestSchema.parse(request.body);
      if (!dependencies.threadBulkInventory) {
        throw new Error("thread_bulk_inventory_service_missing");
      }
      response.json(
        bulkInventoryImpactSchema.parse(
          await dependencies.threadBulkInventory.impact(requestScope, body),
        ),
      );
    },
  );

  routes.post("/api/thread-inventory/bulk", async (request, response) => {
    const requestScope = await scope(request);
    const body = bulkInventoryMutationRequestSchema.parse(request.body);
    if (!dependencies.threadBulkInventory) {
      throw new Error("thread_bulk_inventory_service_missing");
    }
    response.json(
      bulkInventoryMutationResultSchema.parse(
        await dependencies.threadBulkInventory.transition(requestScope, body),
      ),
    );
  });

  routes.get(
    "/api/threads/:threadId/execution-workspace",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      response.json(
        threadExecutionWorkspaceResourceSchema.parse(
          await dependencies.threadExecutionWorkspaces.status(
            requestScope,
            threadId,
          ),
        ),
      );
    },
  );

  routes.delete(
    "/api/threads/:threadId/execution-workspace",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = deleteThreadExecutionWorkspaceRequestSchema.parse(
        request.body,
      );
      dependencies.threadArchives.assertExecutionWorkspaceDeletionAllowed(
        requestScope,
        threadId,
      );
      response.json(
        deleteThreadExecutionWorkspaceResultSchema.parse(
          await dependencies.threadExecutionWorkspaces.delete(
            requestScope,
            threadId,
            body,
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/execution-workspace/import",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = importThreadExecutionWorkspaceRequestSchema.parse(
        request.body,
      );
      response.json(
        importThreadExecutionWorkspaceResultSchema.parse(
          await dependencies.threadExecutionWorkspaces.importBranch(
            requestScope,
            threadId,
            body,
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/execution-workspace/handoff",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = handoffThreadExecutionWorkspaceRequestSchema.parse(
        request.body,
      );
      response.json(
        handoffThreadExecutionWorkspaceResultSchema.parse(
          await dependencies.threadExecutionWorkspaces.handoff(
            requestScope,
            threadId,
            body,
          ),
        ),
      );
    },
  );

  routes.patch("/api/threads/:threadId/pin", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const body = updateThreadPinRequestSchema.parse(request.body);
    await dependencies.inventory.setPinned(requestScope, threadId, body);
    response.status(204).end();
  });

  routes.get("/api/threads/:threadId/bookmarks", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    response.json(
      listTurnBookmarksResultSchema.parse(
        dependencies.turnBookmarks.list(requestScope, threadId),
      ),
    );
  });

  routes.patch(
    "/api/threads/:threadId/bookmarks/:turnId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, turnId } = turnBookmarkRouteParametersSchema.parse(
        request.params,
      );
      const body = setTurnBookmarkRequestSchema.parse(request.body);
      response.json(
        setTurnBookmarkResultSchema.parse(
          await dependencies.turnBookmarks.set(
            requestScope,
            threadId,
            turnId,
            body,
          ),
        ),
      );
    },
  );

  routes.patch("/api/threads/:threadId/group", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    const body = updateThreadGroupAssignmentRequestSchema.parse(request.body);
    response.json(
      threadGroupMutationResultSchema.parse(
        await dependencies.threadGroups.updateAssignment(
          requestScope,
          threadId,
          body,
        ),
      ),
    );
  });

  routes.patch("/api/thread-groups/:groupId", async (request, response) => {
    const requestScope = await scope(request);
    const { groupId } = threadGroupRouteParametersSchema.parse(request.params);
    const body = updateThreadGroupRequestSchema.parse(request.body);
    response.json(
      threadGroupMutationResultSchema.parse(
        await dependencies.threadGroups.updateGroup(
          requestScope,
          groupId,
          body,
        ),
      ),
    );
  });

  routes.patch(
    "/api/threads/:threadId/inventory",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = inventoryTransitionSchema.parse(request.body);
      if (body.action === "archive" || body.action === "archive_family") {
        const archivedThreadIds = await dependencies.threadArchives.archive(
          requestScope,
          threadId,
          {
            expectedRevision: body.expectedRevision,
            mutationId: body.mutationId,
            includeDescendants: body.action === "archive_family",
            expectedStashedPromptCount: body.expectedStashedPromptCount,
            openTaskDisposition: body.openTaskDisposition,
            executionWorkspaceDisposition: body.executionWorkspaceDisposition,
          },
        );
        if (body.action === "archive_family") {
          response.json({ archivedThreadIds });
        } else {
          response.status(204).end();
        }
        return;
      } else if (body.action === "settle") {
        await dependencies.threadArchives.settle(requestScope, threadId, {
          expectedRevision: body.expectedRevision,
          mutationId: body.mutationId,
          expectedStashedPromptCount: body.expectedStashedPromptCount,
          openTaskDisposition: body.openTaskDisposition,
        });
      } else {
        await dependencies.inventory.transition(requestScope, threadId, {
          expectedRevision: body.expectedRevision,
          mutationId: body.mutationId,
          change:
            body.action === "snooze"
              ? {
                  action: "snooze",
                  snoozedUntil: Date.parse(body.snoozedUntil),
                  wakeReminderText: body.wakeReminder?.trim() || null,
                }
              : body.action === "remind"
                ? {
                    action: "remind",
                    wakeReminderText: body.wakeReminder.trim(),
                  }
                : { action: body.action },
        });
      }
      response.status(204).end();
    },
  );

  const runProviderPulse = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof ProviderPulseGatewayError) {
        throw new ApiError(
          error.status,
          error.code,
          error.message,
          error.retryable,
        );
      }
      throw error;
    }
  };

  routes.get("/api/provider-pulse/status", async (request, response) => {
    await scope(request);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      providerPulseStatusSchema.parse(
        await runProviderPulse(() => providerPulse.readStatus()),
      ),
    );
  });
  routes.post(
    "/api/provider-pulse/accounts/:accountId/check",
    async (request, response) => {
      await scope(request);
      const { accountId } = z
        .strictObject({ accountId: providerPulseAccountIdSchema })
        .parse(request.params);
      response
        .status(202)
        .json(
          providerPulseOperationReceiptSchema.parse(
            await runProviderPulse(() => providerPulse.checkAccount(accountId)),
          ),
        );
    },
  );
  routes.post("/api/provider-pulse/check-all", async (request, response) => {
    await scope(request);
    response
      .status(202)
      .json(
        providerPulseCheckAllResultSchema.parse(
          await runProviderPulse(() => providerPulse.checkAll()),
        ),
      );
  });
  routes.post("/api/provider-pulse/snapshot", async (request, response) => {
    await scope(request);
    response.json(
      providerPulseSnapshotResultSchema.parse(
        await runProviderPulse(() => providerPulse.snapshot()),
      ),
    );
  });

  routes.post(
    "/api/threads/:threadId/attention/dismiss",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = dismissThreadAttentionRequestSchema.parse(request.body);
      await dependencies.attention.dismiss(requestScope, threadId, body);
      // The dismissal already publishes its incremental update through the
      // thread stream; the client discards this response, so a full snapshot
      // capture here would be pure waste on every visible completion.
      response.status(204).end();
    },
  );

  routes.post(
    "/api/threads/:threadId/automation/preview",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      dependencies.inventory.repository.getThread(requestScope, threadId);
      const body = previewAutomationScheduleRequestSchema.parse(request.body);
      response.json({
        occurrences: dependencies.automations.preview(
          body.schedule,
          body.count,
        ),
      });
    },
  );

  routes.post(
    "/api/threads/:threadId/automation/precheck/test",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = testAutomationPrecheckRequestSchema.parse(request.body);
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.json(
        await dependencies.automationPrechecks.test({
          scope: requestScope,
          threadId,
          prompt: body.prompt,
          precheck: body.precheck,
          signal: controller.signal,
        }),
      );
    },
  );

  routes.post(
    "/api/threads/:threadId/automation",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = createAutomationRequestSchema.parse(request.body);
      if (body.runMode === "clone") {
        const snapshot = await dependencies.threads.snapshot(
          requestScope,
          threadId,
        );
        assertAutomationCloneEligible({
          runMode: body.runMode,
          canCloneOnRun: snapshot.capabilities.automation.canCloneOnRun,
        });
      }
      response
        .status(201)
        .json(dependencies.automations.create(requestScope, threadId, body));
    },
  );
  routes.get("/api/threads/:threadId/automation", async (request, response) => {
    const requestScope = await scope(request);
    const { threadId } = threadRouteParametersSchema.parse(request.params);
    response.json(dependencies.automations.get(requestScope, threadId));
  });
  routes.patch(
    "/api/threads/:threadId/automation",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = updateAutomationRequestSchema.parse(request.body);
      if (body.runMode === "clone") {
        const snapshot = await dependencies.threads.snapshot(
          requestScope,
          threadId,
        );
        assertAutomationCloneEligible({
          runMode: body.runMode,
          canCloneOnRun: snapshot.capabilities.automation.canCloneOnRun,
        });
      }
      response.json(
        dependencies.automations.update(requestScope, threadId, body),
      );
    },
  );
  routes.patch(
    "/api/threads/:threadId/automation/state",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      response.json(
        dependencies.automations.setState(
          requestScope,
          threadId,
          automationStateRequestSchema.parse(request.body),
        ),
      );
    },
  );
  routes.delete(
    "/api/threads/:threadId/automation",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      dependencies.automations.delete(
        requestScope,
        threadId,
        deleteAutomationRequestSchema.parse(request.body),
      );
      response.json({ deleted: true });
    },
  );
  routes.post(
    "/api/threads/:threadId/automation/run-now",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      const body = runAutomationNowRequestSchema.parse(request.body);
      response
        .status(202)
        .json(
          await dependencies.automations.runNow(
            requestScope,
            threadId,
            body.mutationId,
          ),
        );
    },
  );
  routes.get(
    "/api/threads/:threadId/automation/runs",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId } = threadRouteParametersSchema.parse(request.params);
      response.json(
        dependencies.automations.listRuns(
          requestScope,
          threadId,
          listAutomationRunsQuerySchema.parse(request.query),
        ),
      );
    },
  );
  routes.post(
    "/api/threads/:threadId/automation/runs/:runId/resolve",
    async (request, response) => {
      const requestScope = await scope(request);
      const { threadId, runId } = automationRunRouteParametersSchema.parse(
        request.params,
      );
      resolveAutomationRunRequestSchema.parse(request.body);
      response.json(
        dependencies.automations.resolveUncertainRun(
          requestScope,
          threadId,
          runId,
        ),
      );
    },
  );

  routes.get("/api/tool-clients/options", async (request, response) => {
    z.strictObject({}).parse(request.query);
    const requestScope = await scope(request);
    response.json(
      toolClientOptionsSchema.parse(
        dependencies.agentTools.clients.options(requestScope),
      ),
    );
  });
  routes.get("/api/tool-clients", async (request, response) => {
    const requestScope = await scope(request);
    const query = toolClientListQuerySchema.parse(request.query);
    response.json(
      toolClientListPageSchema.parse(
        dependencies.agentTools.clients.list(requestScope, query),
      ),
    );
  });
  routes.get("/api/tool-clients/:clientId", async (request, response) => {
    z.strictObject({}).parse(request.query);
    const requestScope = await scope(request);
    const { clientId } = toolClientRouteParametersSchema.parse(request.params);
    response.json(
      toolClientSchema.parse(
        dependencies.agentTools.clients.get(requestScope, clientId),
      ),
    );
  });
  routes.post("/api/tool-clients", async (request, response) => {
    const requestScope = await scope(request);
    const input = createToolClientRequestSchema.parse(request.body);
    try {
      const created = dependencies.agentTools.clients.createForManagement(
        requestScope,
        input,
      );
      response
        .status(201)
        .json(toolClientCredentialResultSchema.parse(created));
    } catch (error) {
      if (!(error instanceof ToolClientCreationConflictError)) throw error;
      response.status(409).json(
        toolClientCreationConflictSchema.parse({
          error: {
            code: "conflict",
            message: error.message,
            retryable: false,
          },
          client: error.client,
        }),
      );
    }
  });
  routes.put("/api/tool-clients/:clientId", async (request, response) => {
    const requestScope = await scope(request);
    const { clientId } = toolClientRouteParametersSchema.parse(request.params);
    const input = replaceToolClientRequestSchema.parse(request.body);
    response.json(
      toolClientSchema.parse(
        dependencies.agentTools.clients.replaceForManagement(
          requestScope,
          clientId,
          input,
        ),
      ),
    );
  });
  routes.post(
    "/api/tool-clients/:clientId/rotate",
    async (request, response) => {
      const requestScope = await scope(request);
      const { clientId } = toolClientRouteParametersSchema.parse(
        request.params,
      );
      const { expectedRevision } = toolClientRevisionRequestSchema.parse(
        request.body,
      );
      response.json(
        toolClientCredentialResultSchema.parse(
          dependencies.agentTools.clients.rotateForManagement(
            requestScope,
            clientId,
            expectedRevision,
          ),
        ),
      );
    },
  );
  routes.post(
    "/api/tool-clients/:clientId/revoke",
    async (request, response) => {
      const requestScope = await scope(request);
      const { clientId } = toolClientRouteParametersSchema.parse(
        request.params,
      );
      const { expectedRevision } = toolClientRevisionRequestSchema.parse(
        request.body,
      );
      response.json(
        toolClientSchema.parse(
          dependencies.agentTools.clients.revokeForManagement(
            requestScope,
            clientId,
            expectedRevision,
          ),
        ),
      );
    },
  );

  // Agent tools share the management listener's admission, JSON, CSRF, and
  // shutdown boundaries. Mount after the management routes so a router-local
  // parameter cannot affect another normalized route.
  app.use(
    createAgentToolRouter(
      dependencies.agentTools,
      dependencies.requestOperations,
    ),
  );

  app.use("/api", () => {
    throw notFound();
  });
  if (dependencies.clientDirectory) {
    app.use(express.static(dependencies.clientDirectory));
    routes.get("/{*path}", (_request, response) => {
      response.sendFile(path.join(dependencies.clientDirectory!, "index.html"));
    });
  }
  app.use(() => {
    throw notFound();
  });
  app.use(errorMiddleware);
  return app;
}
