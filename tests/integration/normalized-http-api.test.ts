import { UsageService } from "../../src/server/usage/usage-service.js";
import { ScopedThreadEventHubRegistry } from "../../src/server/events/thread-runtime-coordinator.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import { QuestionRequestService } from "../../src/server/domain/question-request-service.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import type { Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Request as ExpressRequest } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  type NormalizedApplicationSnapshot,
} from "../../src/shared/protocol/application.js";
import { SEDES_VERSION } from "../../src/shared/version.js";
import {
  normalizedThreadSnapshotSchema,
  type NormalizedThreadSnapshot,
} from "../../src/shared/protocol/conversation.js";
import { COMPOSER_ATTACHMENT_POLICY } from "../../src/shared/protocol/composer-attachments.js";
import type { NormalizedImage } from "../../src/shared/protocol/output-artifacts.js";
import {
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_DOWNLOAD_BYTES,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
} from "../../src/shared/protocol/workspace-files.js";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import {
  ApplicationDrainController,
  HttpRequestOperationGate,
} from "../../src/server/runtime/application-shutdown.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import {
  CAPACITOR_ANDROID_ORIGIN,
  CAPACITOR_ELECTRON_ORIGIN,
  type AppConfig,
  type PackagedClientOrigin,
} from "../../src/server/config/config.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationTurnBookmarkRepository } from "../../src/server/db/repositories/conversation-turn-bookmark-repository.js";
import { CannedPromptRepository } from "../../src/server/db/repositories/canned-prompt-repository.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { ThreadForceResetRepository } from "../../src/server/db/repositories/thread-force-reset-repository.js";
import { PrincipalApplicationPreferenceRepository } from "../../src/server/db/repositories/principal-application-preference-repository.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceDiffReviewRepository } from "../../src/server/db/repositories/workspace-diff-review-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { ConversationTurnBookmarkService } from "../../src/server/domain/conversation-turn-bookmark-service.js";
import { CannedPromptService } from "../../src/server/domain/canned-prompt-service.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { WorkspaceDiffReviewService } from "../../src/server/domain/workspace-diff-review-service.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { ThreadBulkInventoryService } from "../../src/server/domain/thread-bulk-inventory-service.js";
import { ThreadForceResetService } from "../../src/server/domain/thread-force-reset-service.js";
import { ThreadGroupService } from "../../src/server/domain/thread-group-service.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { PrincipalApplicationPreferenceService } from "../../src/server/domain/principal-application-preference-service.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";
import type { WorkspaceFileProvider } from "../../src/server/workspace-files/contracts.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

import {
  ApplicationSnapshotPublicationBoundary,
  type ApplicationSnapshotService,
  type ApplicationTaskReader,
} from "../../src/server/application/application-snapshot-service.js";
import { presentAssociatedTask } from "../../src/server/application/task-presentation.js";
import type { ConversationLifecycleService } from "../../src/server/conversations/conversation-lifecycle-service.js";
import type { ThreadApplicationService } from "../../src/server/conversations/thread-application-service.js";
import type { ThreadAttentionService } from "../../src/server/domain/thread-attention-service.js";
import type { AutomationPrecheckExecutor } from "../../src/server/runtime/automation-precheck-executor.js";
import type { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import type { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import type { AgentToolRouterDependencies } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { ToolClientCreationConflictError } from "../../src/server/agent-tools/application/principal-agent-tool-client-service.js";
import type { ToolClient } from "../../src/shared/protocol/tool-clients.js";
import type { ComposerAttachmentService } from "../../src/server/composer-attachments/service.js";
import type { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { OutputArtifactStorageError } from "../../src/server/output-artifacts/blob-store.js";
import { ComposerAttachmentStorageError } from "../../src/server/composer-attachments/blob-store.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function summary(
  repository: InventoryRepository,
  scope: RequestScope,
  threadId: string,
) {
  const { thread, inventory } = repository.getThread(scope, threadId);
  const groupAssignment = new ThreadGroupRepository(
    repository.database,
  ).getAssignment(scope, threadId);
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    targetId: thread.connectionProfileId,
    title: { text: thread.title },
    backend: { label: { text: "Primary Pi" }, brand: "pi" as const },
    backingState: thread.backingState,
    inventoryState: inventory.inventoryState,
    inventoryRevision: inventory.inventoryRevision,
    preferredWorktreeRevision: 0,
    preferredWorktree: null,
    pinned: inventory.pinned === 1,
    pinRevision: inventory.pinRevision,
    bookmarkRevision: inventory.bookmarkRevision,
    turnBookmarkCount: 0,
    groupId: groupAssignment.groupId,
    groupAssignmentRevision: groupAssignment.revision,
    threadRevision: thread.revision,
    runState: "idle" as const,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: thread.availability === "available",
    lastActivityAt: new Date(thread.lastActivityAt).toISOString(),
    stateChangedAt: new Date(inventory.stateChangedAt).toISOString(),
    ...(inventory.snoozedUntil === null
      ? {}
      : { snoozedUntil: new Date(inventory.snoozedUntil).toISOString() }),
    automation: null,
  };
}

function threadSnapshot(
  repository: InventoryRepository,
  scope: RequestScope,
  threadId: string,
  canCloneOnRun = true,
  activitySecret?: string,
  outputImage?: NormalizedImage,
): NormalizedThreadSnapshot {
  const { thread, draft, inventory } = repository.getThread(scope, threadId);
  const {
    stashedPromptCount: _stashedPromptCount,
    pendingQuestionCount: _pendingQuestionCount,
    pinned: _pinned,
    pinRevision: _pinRevision,
    preferredWorktreeRevision: _preferredWorktreeRevision,
    preferredWorktree: _preferredWorktree,
    bookmarkRevision: _bookmarkRevision,
    turnBookmarkCount: _turnBookmarkCount,
    terminalSummary: _terminalSummary,
    groupId: _groupId,
    groupAssignmentRevision: _groupAssignmentRevision,
    ...threadSummary
  } = summary(repository, scope, threadId);
  const workspace = repository.getWorkspace(scope, thread.workspaceId);
  const environment = repository.getEnvironment(scope, thread.environmentId);
  return normalizedThreadSnapshotSchema.parse({
    thread: threadSummary,
    executionWorkspace: { kind: "direct" },
    workspace: {
      id: workspace.id,
      environmentId: workspace.environmentId,
      label: { text: workspace.displayName },
      displayPath: { text: workspace.canonicalPath },
      available: workspace.availability === "available",
    },
    environment: {
      id: environment.id,
      kind: environment.kind,
      label: { text: environment.label },
      available: environment.availability === "available",
      directoryBrowsing: "available",
    },
    draft: {
      text: draft.text,
      ...(draft.selectedSkillId === null
        ? {}
        : { selectedSkillId: draft.selectedSkillId }),
      contextExcerpts: [],
      taskReferences: draft.taskReferences,
      attachments: draft.attachments,
      revision: draft.revision,
      updatedAt: new Date(draft.updatedAt).toISOString(),
    },
    stashes: repository.listStashes(scope, threadId).map((stash) => ({
      id: stash.id,
      text: stash.text,
      ...(stash.selectedSkillId === null
        ? {}
        : { selectedSkillId: stash.selectedSkillId }),
      contextExcerpts: [],
      taskReferences: stash.taskReferences,
      attachments: stash.attachments,
      createdAt: new Date(stash.createdAt).toISOString(),
    })),
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [
        {
          id: "context",
          label: { text: "Context" },
          description: { text: "Inspect source context." },
          order: 10,
          tools: [
            {
              id: "agent.context",
              label: { text: "Sedes agent context" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: false,
              available: true,
            },
          ],
        },
        {
          id: "threads",
          label: { text: "Threads" },
          description: { text: "Inspect threads." },
          order: 20,
          tools: [
            {
              id: "thread.status",
              label: { text: "Sedes thread status" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: false,
              available: true,
            },
          ],
        },
      ],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: activitySecret
      ? ["turn-activity"]
      : outputImage
        ? ["turn-output-image"]
        : [],
    turnsById: activitySecret
      ? {
          "turn-activity": {
            id: "turn-activity",
            revision: 1,
            status: "completed",
            endedBy: "agent_settled",
            orderedItemIds: ["reasoning-activity", "reasoning-without-summary"],
          },
        }
      : outputImage
        ? {
            "turn-output-image": {
              id: "turn-output-image",
              revision: 1,
              status: "completed",
              endedBy: "agent_settled",
              orderedItemIds: ["output-image"],
            },
          }
        : {},
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "No completed turn is available." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: { text: "Provider snapshots are unavailable." },
      },
    },
    forksByTurnId: activitySecret
      ? {
          "turn-activity": {
            sourceTurnId: "turn-activity",
            expectedTurnRevision: 1,
            available: false,
            unavailableReason: { text: "Forking is unavailable." },
          },
        }
      : outputImage
        ? {
            "turn-output-image": {
              sourceTurnId: "turn-output-image",
              expectedTurnRevision: 1,
              available: false,
              unavailableReason: { text: "Forking is unavailable." },
            },
          }
        : {},
    itemsById: activitySecret
      ? {
          "reasoning-activity": {
            id: "reasoning-activity",
            turnId: "turn-activity",
            kind: "reasoning",
            status: "completed",
            revision: 1,
            summaryParts: [
              { text: "Preparing normalized activity projection" },
              { text: "Checking browser disclosure boundaries" },
            ],
            markdown: { text: activitySecret },
          },
          "reasoning-without-summary": {
            id: "reasoning-without-summary",
            turnId: "turn-activity",
            kind: "reasoning",
            status: "completed",
            revision: 1,
            markdown: { text: `${activitySecret}:without-summary` },
          },
        }
      : outputImage
        ? {
            "output-image": {
              id: "output-image",
              turnId: "turn-output-image",
              kind: "image",
              status: "completed",
              revision: 1,
              image: outputImage,
            },
          }
        : {},
    history: { hasOlder: false },
    runState: "idle",
    queue: [],
    capabilities: {
      revision: `test-${thread.revision}-${inventory.inventoryRevision}`,
      backend: { label: { text: "Pi" } },
      interactionMode: "interactive",
      runState: "idle",
      operations: [
        {
          id: "interrupt",
          label: { text: "Stop" },
          destructive: false,
          available: true,
          parameters: { kind: "none" },
        },
      ],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: true },
      composerAttachments: {
        fileStaging: { availability: "available" },
        nativeImage: { availability: "available" },
        policy: COMPOSER_ATTACHMENT_POLICY,
      },
      interactions: [],
      providerFeatures: [],
      history: { available: false, paginated: false },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun,
      },
    },
    settings: { revision: 0, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention:
      inventory.wokeAt !== null &&
      (inventory.wakeAcknowledgedAt === null ||
        inventory.wakeAcknowledgedAt < inventory.wokeAt)
        ? {
            wake: {
              wokeAt: new Date(inventory.wokeAt).toISOString(),
              ...(inventory.wakeReminderText === null
                ? {}
                : { text: { text: inventory.wakeReminderText } }),
            },
          }
        : {},
  });
}

async function closeHttpTestServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Pi's Undici dependency can preconnect replacement sockets after fetch aborts.
  // They have no HTTP request for close() to classify as idle. Retire these
  // test-owned sockets after stream assertions and after stopping new accepts.
  server.closeAllConnections();
  await closed;
}

async function readFirstSseEvent(
  server: Server,
  pathname: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{
  readonly event: string;
  readonly data: unknown;
  readonly corsOrigin: string | null;
}> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test_server_address_invalid");
  }
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    headers: { Host: "127.0.0.1:4783", ...headers },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!buffered.includes("\n\n")) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  const event = /^event: (.+)$/m.exec(buffered)?.[1];
  const data = /^data: (.+)$/m.exec(buffered)?.[1];
  if (!event || !data) throw new Error("test_sse_event_missing");
  return {
    event,
    data: JSON.parse(data),
    corsOrigin: response.headers.get("access-control-allow-origin"),
  };
}

async function readThreadSseHandshake(
  server: Server,
  pathname: string,
): Promise<readonly { readonly event: string; readonly data: unknown }[]> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test_server_address_invalid");
  }
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    headers: { Host: "127.0.0.1:4783" },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!buffered.includes("event: thread-live\n")) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return buffered.split("\n\n").flatMap((frame) => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) }] : [];
  });
}

async function fixture(
  options: {
    readonly packagedClientOrigins?: readonly PackagedClientOrigin[];
    readonly forkManualGate?: Promise<void>;
    readonly composerAttachments?: ComposerAttachmentService;
    readonly outputArtifacts?: OutputArtifactService;
    readonly workspaceFileProvider?: (
      delegate: LocalWorkspaceFileProvider,
    ) => WorkspaceFileProvider;
    readonly activitySecret?: string;
    readonly outputImage?: NormalizedImage;
    readonly runtimeAcquireError?: unknown;
    readonly quietSnapshotError?: unknown;
    readonly agentTools?: AgentToolRouterDependencies;
    readonly providerPulseEnabled?: boolean;
    readonly experimentalUsageEnabled?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-normalized-http-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  const supplementalPath = path.join(root, "supplemental");
  await mkdir(supplementalPath);
  const secondWorkspacePath = path.join(workspacePath, "second");
  await mkdir(secondWorkspacePath);
  const stateDirectory = path.join(root, "state");
  const database = openOverlayDatabase(
    path.join(stateDirectory, "overlay.sqlite"),
  );
  const seededIdentity = new SingleUserIdentityProvider(database);
  const owner = seededIdentity.getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const legacyEnvironment = legacy.getLocalEnvironment(owner);
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: Date.now(),
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const foreignPrincipalId = randomUUID();
  database
    .prepare(
      `INSERT INTO principals(tenant_id, id, kind, created_at)
       VALUES (?, ?, 'local_human', ?)`,
    )
    .run(owner.tenantId, foreignPrincipalId, Date.now());
  const profile = database
    .prepare(
      `
        SELECT id
        FROM agent_connection_profiles
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND template_id = 'local-primary'
      `,
    )
    .get(owner.tenantId, owner.principalId) as { readonly id: string };
  const repository = new InventoryRepository(database);
  const threadGroupRepository = new ThreadGroupRepository(database);
  const lineageRepository = new ThreadLineageRepository(database);
  const taskRepository = new TaskRepository(database);
  let inventory!: InventoryService;
  const bindings = new ConversationBindingRepository(database);
  const applicationHubs = new ScopedApplicationEventHubs();
  const quietHubs = new ScopedThreadEventHubRegistry();
  const boundHubs = new Map<string, ThreadEventHub>();
  const runtimeEstablishmentCaptures = vi.fn();
  const runtimeReplacementCaptures = vi.fn();
  const threadSnapshotPublications = vi.fn();
  const operationCalls: Array<{ threadId: string; operation: unknown }> = [];
  const attentionCalls: Array<{ threadId: string; request: unknown }> = [];
  const historyCalls: Array<{
    threadId: string;
    cursor: string;
    limit: number;
  }> = [];
  const historySeekCalls: Array<{ threadId: string; turnId: string }> = [];
  const discoveryCalls: string[] = [];
  const forkCalls: unknown[] = [];
  const placementCalls: unknown[] = [];
  const descendantCalls: unknown[] = [];
  let canCloneOnRun = true;
  const identity: IdentityProvider<ExpressRequest> = {
    async resolve(incoming) {
      if (incoming.header("X-Test-Foreign-Principal") === "yes") {
        return {
          tenantId: owner.tenantId,
          principalId: foreignPrincipalId,
        };
      }
      return owner;
    },
  };
  const execution = new LocalExecutionEnvironment({
    environmentId: legacyEnvironment.id,
    scope: owner,
    allowedRoots: [root],
    workspaceTrusted: () => true,
    configurationRevision: 0,
    activeConfigurationRevision: () => 0,
  });
  const snapshots = {
    async skills(scope: RequestScope, threadId: string) {
      repository.getThread(scope, threadId);
      return { skills: [] };
    },
    async snapshot(scope: RequestScope, threadId: string) {
      return threadSnapshot(
        repository,
        scope,
        threadId,
        canCloneOnRun,
        options.activitySecret,
        options.outputImage,
      );
    },
    async snapshotFromActorCapture(scope: RequestScope, threadId: string) {
      return threadSnapshot(
        repository,
        scope,
        threadId,
        canCloneOnRun,
        options.activitySecret,
        options.outputImage,
      );
    },
    async mutate(scope: RequestScope, threadId: string, operation: unknown) {
      repository.getThread(scope, threadId);
      operationCalls.push({ threadId, operation });
      if ((operation as { kind?: string }).kind === "move_draft") {
        const move = operation as {
          workspaceId: string;
          expectedThreadRevision: number;
          mutationId: string;
        };
        bindings.moveUnboundThreadWorkspace(scope, threadId, {
          workspaceId: move.workspaceId,
          expectedThreadRevision: move.expectedThreadRevision,
          mutationId: move.mutationId,
          now: Date.now(),
        });
        await threadSnapshots.publish(scope, threadId);
        return { status: "completed" as const };
      }
      if ((operation as { kind?: string }).kind === "deliver") {
        if (
          (operation as { mutationId?: string }).mutationId ===
          "20202020-2020-4020-8020-202020202020"
        ) {
          return {
            status: "delivery_pending_materialization" as const,
            operationId: "20202020-2020-4020-8020-202020202020",
            resolvedDeliveryMode: "steer" as const,
            threadRevision: 1,
            draft: {
              text: "Retained pending steer",
              contextExcerpts: [] as const,
              taskReferences: [] as const,
              attachments: [] as const,
              revision: 0,
              updatedAt: "2026-08-07T07:00:00.000Z",
            },
          };
        }
        if (
          (operation as { mutationId?: string }).mutationId ===
          "19191919-1919-4191-8191-191919191919"
        ) {
          return {
            status: "recovery_required" as const,
            retryable: false,
            draft: {
              text: "Retained server draft",
              contextExcerpts: [] as const,
              taskReferences: [] as const,
              attachments: [] as const,
              revision: 0,
              updatedAt: "2026-08-07T07:00:00.000Z",
            },
          };
        }
        return {
          status: "delivery_accepted" as const,
          operationId: "operation-accepted",
          resolvedDeliveryMode: "submit" as const,
          threadRevision: 1,
          draft: {
            text: "" as const,
            contextExcerpts: [] as const,
            taskReferences: [] as const,
            attachments: [] as const,
            revision: 1,
            updatedAt: "2026-08-07T07:00:00.000Z",
          },
        };
      }
      return (operation as { kind?: string }).kind === "interrupt"
        ? { status: "aborted" as const }
        : { status: "accepted" as const, operationId: "operation-accepted" };
    },
  };
  const lifecycle = {
    async createServerDraft(
      scope: RequestScope,
      input: {
        workspaceId: string;
        connectionProfileId: string;
        title: string;
      },
    ) {
      const created = bindings.createUnboundThread(scope, {
        workspaceId: input.workspaceId,
        connectionProfileId: input.connectionProfileId,
        title: input.title,
        now: Date.now(),
      });
      return {
        applicationThreadId: created.id,
        draft: repository.getDraft(scope, created.id),
      };
    },
  };
  const application = {
    captureMetadata: new WeakMap<NormalizedApplicationSnapshot, ReadonlyMap<string, boolean>>(),
    tasks: taskRepository as ApplicationTaskReader,
    async capture(scope: RequestScope): Promise<NormalizedApplicationSnapshot> {
      const environment = repository.getLocalEnvironment(scope);
      const workspaces = repository.listWorkspaces(scope);
      const threads = repository
        .listThreadIdsForEnvironment(scope, environment.id)
        .map((threadId) => ({
          ...summary(repository, scope, threadId),
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        }));
      const counts = { active: 0, snoozed: 0, settled: 0, archived: 0 };
      for (const thread of threads) counts[thread.inventoryState] += 1;
      const snapshot: NormalizedApplicationSnapshot = {
        environments: [
          {
            id: environment.id,
            kind: environment.kind,
            label: { text: environment.label },
            available: environment.availability === "available",
            directoryBrowsing: "available",
          },
        ],
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          environmentId: workspace.environmentId,
          label: { text: workspace.displayName },
          displayPath: { text: workspace.canonicalPath },
          available: workspace.availability === "available",
        })),
        threads,
        groups: threadGroupRepository.list(scope).map((group) => ({
          id: group.id,
          name: group.name,
          revision: group.revision,
          memberCount: group.memberCount,
          activeMemberCount: group.activeMemberCount,
        })),
        forkOrigins: [],
        lineagePlacements: [],
        lineageFamilies: [],
        executionTargets: [
          {
            id: profile.id,
            environmentId: environment.id,
            label: { text: "Local Pi SDK" },
            backend: { label: { text: "Primary Pi" }, brand: "pi" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
        ],
        advisories: [],
        defaultNewThreadTargetId: profile.id,
        counts,
        tasks: taskRepository.listAssociated(scope).map(presentAssociatedTask),
      };
      this.captureMetadata.set(snapshot, new Map([[environment.id, false]]));
      return snapshot;
    },
  };
  const applicationSnapshots = new ApplicationSnapshotPublicationBoundary(
    application as ApplicationSnapshotService,
    applicationHubs,
  );
  const threadGroups = new ThreadGroupService(
    threadGroupRepository,
    applicationSnapshots,
  );
  const threadRuntimes = {
    async captureLoadedState() {
      return undefined;
    },
    async runWithRuntimeRetired<Result>(
      _scope: RequestScope,
      _threadId: string,
      operation: () => Promise<Result>,
    ): Promise<Result> {
      return operation();
    },
    async captureLoadedRuntime(_scope: RequestScope, threadId: string) {
      const hub = boundHubs.get(threadId);
      const snapshot = hub?.snapshot;
      const generation = hub?.projectionGeneration;
      if (!snapshot || !generation) return undefined;
      return {
        kind: "conversation_runtime" as const,
        threadId,
        generation,
        runState: snapshot.runState,
        ...(snapshot.activeTurnId
          ? { activeTurnId: snapshot.activeTurnId }
          : {}),
      };
    },
    async forceResetLoadedRuntime(
      scope: RequestScope,
      threadId: string,
      expected: {
        generation: string;
        runState: string;
        activeTurnId?: string;
      },
    ) {
      const hub = boundHubs.get(threadId);
      if (
        !hub?.snapshot ||
        hub.projectionGeneration !== expected.generation ||
        hub.snapshot.runState !== expected.runState ||
        hub.snapshot.activeTurnId !== expected.activeTurnId
      ) {
        return false;
      }
      runtimeReplacementCaptures();
      hub.publish({
        type: "snapshot",
        generation: `projection-${threadId}-reset`,
        snapshot: await snapshots.snapshotFromActorCapture(scope, threadId),
      });
      return true;
    },
    quiet(scope: RequestScope, threadId: string) {
      repository.getThread(scope, threadId);
      const lease = quietHubs.acquire(scope, threadId);
      const hub = lease.hub;
      return {
        hub,
        generation: `application-${threadId}`,
        publishIfUnowned: (snapshot: NormalizedThreadSnapshot) =>
          hub.publish({
            type: "snapshot",
            generation: `application-${threadId}`,
            snapshot,
          }),
        release: lease.release,
      };
    },
    async acquire(scope: RequestScope, threadId: string) {
      const state = repository.getThread(scope, threadId);
      if (state.thread.backingState !== "bound") {
        throw new Error("bound_runtime_expected");
      }
      if (options.runtimeAcquireError) throw options.runtimeAcquireError;
      let hub = boundHubs.get(threadId);
      if (!hub) {
        runtimeEstablishmentCaptures();
        hub = new ThreadEventHub();
        hub.publish({
          type: "snapshot",
          generation: `projection-${threadId}`,
          snapshot: await snapshots.snapshotFromActorCapture(scope, threadId),
        });
        boundHubs.set(threadId, hub);
      }
      const runtimeHub = hub;
      return {
        actor: {},
        hub: runtimeHub,
        publishAuthoritativeReplacement: async () => {
          runtimeReplacementCaptures();
          return runtimeHub.publish({
            type: "snapshot",
            generation: `projection-${threadId}`,
            snapshot: await snapshots.snapshotFromActorCapture(scope, threadId),
          });
        },
        release: () => undefined,
      };
    },
    async publishAuthoritativeReplacementIfLoaded(
      scope: RequestScope,
      threadId: string,
    ) {
      const hub = boundHubs.get(threadId);
      if (!hub) return false;
      runtimeReplacementCaptures();
      hub.publish({
        type: "snapshot",
        generation: `projection-${threadId}`,
        snapshot: await snapshots.snapshotFromActorCapture(scope, threadId),
      });
      return true;
    },
  };
  const threadSnapshots = {
    schedule(scope: RequestScope, threadId: string) {
      void this.publish(scope, threadId);
    },
    async publishAuthoritativeReplacement(
      scope: RequestScope,
      threadId: string,
    ) {
      const quiet = threadRuntimes.quiet(scope, threadId);
      try {
        if (options.quietSnapshotError) throw options.quietSnapshotError;
        return quiet.publishIfUnowned(await snapshots.snapshot(scope, threadId))!;
      } finally {
        quiet.release();
      }
    },
    async publish(scope: RequestScope, threadId: string) {
      threadSnapshotPublications(scope, threadId);
      await this.publishAuthoritativeReplacement(scope, threadId);
    },
    async publishMany(scope: RequestScope, threadIds: readonly string[]) {
      for (const threadId of threadIds) await this.publish(scope, threadId);
      await applicationSnapshots.publishAuthoritativeReplacement(scope);
    },
  };
  inventory = new InventoryService(repository, {
    publishMany: (scope, states) =>
      threadSnapshots.publishMany(
        scope,
        states.map(({ threadId }) => threadId),
      ),
    publishApplicationThread: async (scope) => {
      await applicationSnapshots.publishAuthoritativeReplacement(scope);
    },
  });
  const threadArchives = new ThreadArchiveService({
    inventory: repository,
    lineage: lineageRepository,
    summaries: {
      listByIds: (scope, threadIds) =>
        threadIds.map((threadId) => ({
          ...summary(repository, scope, threadId),
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        })),
    },
    runtimes: threadRuntimes,
    publications: inventory,
    tasks: taskRepository,
    taskPublications: applicationSnapshots,
    executionWorkspaces: directThreadExecutionWorkspaceLifecycle,
  });
  const threadBulkInventory = new ThreadBulkInventoryService({
    inventory: repository,
    summaries: {
      listByIds: (scope, threadIds) =>
        threadIds.map((threadId) => ({
          ...summary(repository, scope, threadId),
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        })),
    },
    runtimes: threadRuntimes,
    publications: inventory,
    tasks: taskRepository,
    taskPublications: applicationSnapshots,
  });
  const tasks = new TaskService(taskRepository, applicationSnapshots);
  const threadForceResets = new ThreadForceResetService({
    repository: new ThreadForceResetRepository(database),
    interactions: {
      listPending: () => [],
      abandonPending: async () => undefined,
    },
    runtimes: threadRuntimes,
    scheduleThreadPublications: (eventScope, threadIds) => {
      for (const affectedThreadId of threadIds) {
        threadSnapshots.schedule(eventScope, affectedThreadId);
      }
    },
    publishTaskChange: (eventScope, taskId) =>
      tasks.publishTaskChange(eventScope, taskId),
  });
  const automationRepository = new AutomationRepository(database);
  const automations = new AutomationService({
    repository: automationRepository,
    inventory: repository,
    publisher: {
      async publish(scope, threadId) {
        await threadSnapshots.publish(scope, threadId);
        await applicationSnapshots.publishThreadChange(scope, threadId);
      },
    },
    executionPolicy: { assertCanAutomate: () => undefined },
  });
  automations.bindDispatcher({
    dispatch: vi.fn().mockResolvedValue(undefined),
  } as never);
  const automationPrechecks = {
    test: vi.fn().mockResolvedValue({
      decision: "invoke",
      exitCode: 0,
      stdoutPreview: "ready",
      stderrPreview: "",
      stdoutWillBeIncluded: true,
      stdoutTruncated: false,
      stderrTruncated: false,
      effectivePromptBytes: 12,
    }),
  };
  const attention = {
    async dismiss(
      scope: RequestScope,
      threadId: string,
      attentionRequest: unknown,
    ) {
      repository.getThread(scope, threadId);
      attentionCalls.push({ threadId, request: attentionRequest });
    },
  };
  const config: AppConfig = {
    experimentalUsageEnabled: options.experimentalUsageEnabled ?? false,
    authenticationRequired: true,
    host: "127.0.0.1",
    port: 4783,
    stateDirectory,
    allowedTailscaleHosts: [],
    packagedClientOrigins: options.packagedClientOrigins ?? [],
    conversationRetentionMilliseconds: 600_000,
    conversationRuntimeBudget: 8,
  };
  const drain = new ApplicationDrainController();
  const requestOperations = new HttpRequestOperationGate();
  const unavailableSavedAgentRoute = () => {
    throw new Error("saved_agent_route_not_configured_in_fixture");
  };
  const workspaceFileRoots = new WorkspaceFileRootRepository(database);
  const questionDispatch = vi.fn(async () => undefined);
  const questions = new QuestionRequestService({
    repository: new QuestionRequestRepository(database, repository),
    inventory: repository,
    queue: new QueuedInputRepository(database),
    dispatch: { dispatchAdmitted: questionDispatch },
    gateway: { withConversation: async () => { throw new Error("runtime unavailable"); } },
    publish: () => undefined,
    onOpened: () => undefined,
  });
  const app = createNormalizedApp({
    usage: new UsageService(database, {enabled: options.experimentalUsageEnabled ?? false}),
    workpads: {} as never,
    questions,
    cannedPrompts: new CannedPromptService(
      new CannedPromptRepository(database),
    ),
    turnBookmarks: new ConversationTurnBookmarkService(
      new ConversationTurnBookmarkRepository(database, repository),
      {
        handoffThreadChange: () => undefined,
      },
    ),
    config,
    csrfToken: "normalized-csrf",
    identity,
    ...(options.providerPulseEnabled === undefined
      ? {}
      : {
          providerPulse: {
            enabled: options.providerPulseEnabled,
            readStatus: async () => {
              throw new Error("provider_pulse_not_used");
            },
            checkAccount: async () => {
              throw new Error("provider_pulse_not_used");
            },
            checkAll: async () => {
              throw new Error("provider_pulse_not_used");
            },
            snapshot: async () => {
              throw new Error("provider_pulse_not_used");
            },
          },
        }),
    agentTools: options.agentTools ?? unavailableAgentToolRouterDependencies(),
    executionTargets: {
      read: async () => ({
        executionTargets: [
          {
            id: profile.id,
            environmentId: legacyEnvironment.id,
            label: { text: "Local Pi SDK" },
            backend: { label: { text: "Primary Pi" }, brand: "pi" },
            workspaceExecution: { kind: "direct_only" },
            available: true,
          },
        ],
        defaultTargetId: profile.id,
      }),
      requireSelectable: async (_scope, targetId) => {
        if (targetId !== profile.id) {
          throw new DomainError(
            "not_found",
            "The selected agent target is not available.",
          );
        }
      },
    },
    savedAgents: {
      list: unavailableSavedAgentRoute,
      get: unavailableSavedAgentRoute,
      createAgent: unavailableSavedAgentRoute,
      updateAgent: unavailableSavedAgentRoute,
      deleteAgent: unavailableSavedAgentRoute,
      options: unavailableSavedAgentRoute,
      resolveAgent: unavailableSavedAgentRoute,
      async createThread(
        scope: RequestScope,
        body: {
          workspaceId: string;
          title: string;
          configuration: { targetId?: string };
        },
      ) {
        const targetId = body.configuration.targetId;
        if (!targetId) {
          throw new DomainError(
            "not_found",
            "The selected agent target is not available.",
          );
        }
        if (targetId !== profile.id) {
          throw new DomainError(
            "not_found",
            "The selected agent target is not available.",
          );
        }
        const created = await lifecycle.createServerDraft(scope, {
          workspaceId: body.workspaceId,
          connectionProfileId: targetId,
          title: body.title,
        });
        return {
          threadId: created.applicationThreadId,
          workspaceId: body.workspaceId,
          targetId,
        };
      },
    } as never,
    threadTemplates: {} as never,
    applicationSnapshots,
    threadGroups,
    notifications: new NotificationService({
      repository: new NotificationRepository(database),
    }),
    principalPreferences: new PrincipalApplicationPreferenceService({
      repository: new PrincipalApplicationPreferenceRepository(database),
      now: () => 1_700_000_000_000,
    }),
    threads: snapshots as unknown as ThreadApplicationService,
    history: {
      async loadOlder(
        scope: RequestScope,
        threadId: string,
        cursor: string,
        limit: number,
      ) {
        repository.getThread(scope, threadId);
        historyCalls.push({ threadId, cursor, limit });
        const activityPage = options.activitySecret
          ? {
              orderedTurnIds: ["turn-history-activity"],
              turnsById: {
                "turn-history-activity": {
                  id: "turn-history-activity",
                  revision: 1,
                  status: "completed" as const,
                  endedBy: "agent_settled" as const,
                  orderedItemIds: [
                    "reasoning-history-activity",
                    "tool-history-activity",
                  ],
                },
              },
              forksByTurnId: {
                "turn-history-activity": {
                  sourceTurnId: "turn-history-activity",
                  expectedTurnRevision: 1,
                  available: false,
                  unavailableReason: { text: "Forking is unavailable." },
                },
              },
              itemsById: {
                "reasoning-history-activity": {
                  id: "reasoning-history-activity",
                  turnId: "turn-history-activity",
                  kind: "reasoning" as const,
                  status: "completed" as const,
                  revision: 1,
                  summaryParts: [
                    { text: "Reviewing older normalized activity" },
                  ],
                  markdown: { text: options.activitySecret },
                },
                "tool-history-activity": {
                  id: "tool-history-activity",
                  turnId: "turn-history-activity",
                  kind: "tool" as const,
                  status: "completed" as const,
                  revision: 1,
                  phase: "completed" as const,
                  toolName: { text: options.activitySecret },
                  title: { text: options.activitySecret },
                  category: "other" as const,
                  arguments: { text: options.activitySecret },
                  result: {
                    content: [
                      {
                        kind: "text" as const,
                        value: { text: options.activitySecret },
                      },
                    ],
                    isError: false,
                  },
                },
              },
            }
          : options.outputImage
            ? {
                orderedTurnIds: ["turn-history-output-image"],
                turnsById: {
                  "turn-history-output-image": {
                    id: "turn-history-output-image",
                    revision: 1,
                    status: "completed" as const,
                    endedBy: "agent_settled" as const,
                    orderedItemIds: ["history-output-image"],
                  },
                },
                forksByTurnId: {
                  "turn-history-output-image": {
                    sourceTurnId: "turn-history-output-image",
                    expectedTurnRevision: 1,
                    available: false,
                    unavailableReason: { text: "Forking is unavailable." },
                  },
                },
                itemsById: {
                  "history-output-image": {
                    id: "history-output-image",
                    turnId: "turn-history-output-image",
                    kind: "image" as const,
                    status: "completed" as const,
                    revision: 1,
                    image: options.outputImage,
                  },
                },
              }
            : {
                orderedTurnIds: [],
                turnsById: {},
                forksByTurnId: {},
                itemsById: {},
              };
        return {
          eventId: "10000000-0000-4000-8000-000000000099.1",
          projectionGeneration: "projection-1",
          event: {
            type: "history_prepend",
            generation: "projection-1",
            page: {
              ...activityPage,
              forkSource: {
                selectedCompletedTurn: {
                  available: false,
                  unavailableReason: { text: "No turns are loaded." },
                },
                latestProviderSnapshot: {
                  available: false,
                  unavailableReason: {
                    text: "Provider snapshots are unavailable.",
                  },
                },
              },
            },
          },
        };
      },
      async seekTurn(scope: RequestScope, threadId: string, turnId: string) {
        repository.getThread(scope, threadId);
        historySeekCalls.push({ threadId, turnId });
        if (options.activitySecret) {
          const snapshot = threadSnapshot(
            repository,
            scope,
            threadId,
            canCloneOnRun,
            options.activitySecret,
            options.outputImage,
          );
          return {
            status: "found" as const,
            targetTurnId: "turn-activity",
            page: {
              orderedTurnIds: ["turn-activity"],
              turnsById: {
                "turn-activity": snapshot.turnsById["turn-activity"]!,
              },
              forkSource: snapshot.forkSource,
              forksByTurnId: {
                "turn-activity": snapshot.forksByTurnId["turn-activity"]!,
              },
              itemsById: {
                "reasoning-activity": snapshot.itemsById["reasoning-activity"]!,
                "reasoning-without-summary":
                  snapshot.itemsById["reasoning-without-summary"]!,
              },
            },
          };
        }
        return { status: "not_found" as const, targetTurnId: turnId };
      },
    } as never,
    threadRuntimes: threadRuntimes as unknown as ThreadRuntimeCoordinator,
    threadSnapshots: threadSnapshots as unknown as ThreadSnapshotPublisher,
    lifecycle: lifecycle as unknown as ConversationLifecycleService,
    inventory,
    composerAttachments:
      options.composerAttachments ??
      ({
        upload: async () => {
          throw new Error(
            "composer_attachment_route_not_configured_in_fixture",
          );
        },
        openContent: async () => {
          throw new Error(
            "composer_attachment_route_not_configured_in_fixture",
          );
        },
      } as unknown as ComposerAttachmentService),
    outputArtifacts:
      options.outputArtifacts ??
      ({
        openImage: async () => {
          throw new Error("output_artifact_route_not_configured_in_fixture");
        },
      } as unknown as OutputArtifactService),
    threadArchives,
    threadBulkInventory,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets,
    tasks,
    workspaceFiles: new WorkspaceFileService(
      repository,
      workspaceFileRoots,
      new WorkspaceFileLinkedWorktreeRepository(database),
      execution,
      options.workspaceFileProvider?.(
        new LocalWorkspaceFileProvider({
          scope: owner,
          environmentId: legacyEnvironment.id,
        }),
      ) ??
        new LocalWorkspaceFileProvider({
          scope: owner,
          environmentId: legacyEnvironment.id,
        }),
      { publishApplicationThreadChanges: async () => undefined },
    ),
    workspaceDiffReviews: new WorkspaceDiffReviewService(
      repository,
      workspaceFileRoots,
      new WorkspaceFileLinkedWorktreeRepository(database),
      new WorkspaceDiffReviewRepository(database),
    ),
    attention: attention as unknown as ThreadAttentionService,
    execution,
    automations,
    automationPrechecks:
      automationPrechecks as unknown as AutomationPrecheckExecutor,
    drain,
    requestOperations,
    lineage: {
      forkManual: async (input) => {
        forkCalls.push(input);
        await options.forkManualGate;
        repository.listWorkspaces(input.scope);
        if (input.mutationId === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee") {
          return {
            status: "recovery_required" as const,
            childThreadId: "11111111-1111-4111-8111-111111111111",
            retryable: false,
            uncertaintyKind: "fork_unknown" as const,
            diagnostic: "Provider creation outcome is unknown.",
          };
        }
        if (input.mutationId === "ffffffff-ffff-4fff-8fff-ffffffffffff") {
          return {
            status: "aborted" as const,
            childThreadId: "11111111-1111-4111-8111-111111111111",
            diagnostic: "Provider proved the fork was not created.",
            restartable: false,
          };
        }
        return {
          status: "created" as const,
          childThreadId: "11111111-1111-4111-8111-111111111111",
        };
      },
      updatePlacement: async (input) => {
        placementCalls.push(input);
        return {
          childThreadId: input.childThreadId,
          mode: input.mode,
          revision: input.expectedRevision + 1,
          updatedAt: new Date(2_000).toISOString(),
        };
      },
      listDescendants: async (input) => {
        descendantCalls.push(input);
        return { descendants: [] };
      },
    },
    discoverWorkspace: async (_scope, workspaceId) => {
      discoveryCalls.push(workspaceId);
    },
  });
  const withHost = (test: request.Test) => test.set("Host", "127.0.0.1:4783");
  const mutate = (test: request.Test) =>
    withHost(test).set("X-CSRF-Token", "normalized-csrf");
  return {
    app,
    questions,
    questionDispatch,
    drain,
    requestOperations,
    owner,
    profile,
    database,
    repository,
    inventory,
    workspacePath,
    supplementalPath,
    secondWorkspacePath,
    environmentId: legacyEnvironment.id,
    operationCalls,
    attentionCalls,
    historyCalls,
    historySeekCalls,
    discoveryCalls,
    forkCalls,
    placementCalls,
    descendantCalls,
    applicationHubs,
    quietHubs,
    runtimeEstablishmentCaptures,
    runtimeReplacementCaptures,
    threadSnapshotPublications,
    async loadBoundHub(threadId: string) {
      const runtime = await threadRuntimes.acquire(owner, threadId);
      runtime.release();
      return runtime.hub;
    },
    disableCloneAutomation() {
      canCloneOnRun = false;
    },
    bindThread(threadId: string) {
      database.transaction(() => {
        database
          .prepare(
            `
              UPDATE application_threads
              SET backing_state = 'bound'
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(owner.tenantId, owner.principalId, threadId);
        database
          .prepare(
            `
              INSERT INTO conversation_bindings(
                tenant_id, owner_principal_id, application_thread_id,
                backend_instance_id, connection_profile_id,
                execution_environment_id, backend_conversation_id, created_at
              )
              SELECT tenant_id, owner_principal_id, id, backend_instance_id,
                connection_profile_id, environment_id, ?, ?
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .run(
            `backend-${threadId}`,
            Date.now(),
            owner.tenantId,
            owner.principalId,
            threadId,
          );
      })();
    },
    withHost,
    mutate,
    close() {
      execution.close();
      database.close();
    },
  };
}

describe("normalized HTTP application contract", () => {
  it("disables all experimental usage reports by default before parsing or reading accounting", async () => {
    const current = await fixture();
    const reads = vi.spyOn(UsageService.prototype, "read");
    const availability = vi.spyOn(UsageService.prototype, "availability");
    const analytics = vi.spyOn(UsageService.prototype, "analytics");
    try {
      const session = await current.withHost(request(current.app).get("/api/application/session")).expect(200);
      expect(session.body.experimentalUsageEnabled).toBe(false);
      const id = "00000000-0000-4000-8000-000000000099";
      const responses = [
        await current.withHost(request(current.app).get(`/api/threads/${id}/usage`)).expect(403),
        await current.withHost(request(current.app).get(`/api/threads/${id}/usage/turns/turn`)).expect(403),
        await current.mutate(request(current.app).post(`/api/threads/${id}/usage/turn-availability`)).send({invalid:true}).expect(403),
        await current.mutate(request(current.app).post("/api/usage/analytics")).send({invalid:true}).expect(403),
      ];
      for (const response of responses) expect(response.body).toMatchObject({error:{code:"experimental_usage_disabled",message:"Experimental usage accounting is disabled on this server.",retryable:false}});
      expect(reads).not.toHaveBeenCalled(); expect(availability).not.toHaveBeenCalled(); expect(analytics).not.toHaveBeenCalled();
      expect(current.runtimeEstablishmentCaptures).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); availability.mockRestore(); analytics.mockRestore(); await current.close(); }
  });
  it("reads durable usage and known empty turns without acquiring a provider", async () => {
    const current=await fixture({experimentalUsageEnabled: true});
    try {
      const workspace=await current.mutate(request(current.app).post("/api/workspaces/open")).send({environmentId:current.environmentId,path:current.workspacePath}).expect(201);
      const created=await current.mutate(request(current.app).post("/api/threads")).send({workspaceId:workspace.body.id,configuration:{kind:"custom",targetId:current.profile.id},executionWorkspace:{kind:"direct"},title:"Usage"}).expect(201);
      const threadId=created.body.threadId;
      const usage=new UsageService(current.database, {enabled: true});
      usage.registerVisibleTurns(current.owner,threadId,[{id:"known-turn",revision:1,status:"completed",orderedItemIds:[]}]);
      const session=await current.withHost(request(current.app).get(`/api/threads/${threadId}/usage`)).expect(200);
      expect(session.headers["cache-control"]).toBe("no-store");
      expect(session.body.state).toBe("unavailable");
      expect(session.body.summary.metrics.input.value).toBeNull();
      const turn=await current.withHost(request(current.app).get(`/api/threads/${threadId}/usage/turns/known-turn`)).expect(200);
      expect(turn.body.turnState).toBe("completed");
      await current.withHost(request(current.app).get(`/api/threads/${threadId}/usage/turns/foreign-turn`)).expect(404);
      await current.withHost(request(current.app).get(`/api/threads/00000000-0000-4000-8000-000000000099/usage`)).expect(404);
      const availability=await current.mutate(request(current.app).post(`/api/threads/${threadId}/usage/turn-availability`)).send({turnIds:["known-turn","foreign-turn"]}).expect(200);
      expect(availability.headers["cache-control"]).toBe("no-store");
      expect(availability.body.turns).toEqual([{turnId:"known-turn",available:false},{turnId:"foreign-turn",available:false}]);
      await current.mutate(request(current.app).post(`/api/threads/${threadId}/usage/turn-availability`)).send({turnIds:["known-turn"],principalId:"forged"}).expect(400);
      await current.mutate(request(current.app).post(`/api/threads/00000000-0000-4000-8000-000000000099/usage/turn-availability`)).send({turnIds:["known-turn"]}).expect(404);
      expect(current.runtimeEstablishmentCaptures).not.toHaveBeenCalled();
    } finally {await current.close();}
  });

  it("aggregates principal usage analytics with labels from the real schema", async () => {
    const current=await fixture({experimentalUsageEnabled: true});
    try {
      const workspace=await current.mutate(request(current.app).post("/api/workspaces/open")).send({environmentId:current.environmentId,path:current.workspacePath}).expect(201);
      const created=await current.mutate(request(current.app).post("/api/threads")).send({workspaceId:workspace.body.id,configuration:{kind:"custom",targetId:current.profile.id},executionWorkspace:{kind:"direct"},title:"Analytics"}).expect(201);
      const threadId=created.body.threadId as string;
      const thread=current.database.prepare("SELECT backend_instance_id AS backend, environment_id AS environment FROM application_threads WHERE id=?").get(threadId) as {backend:string;environment:string};
      const db=current.database;
      db.prepare("INSERT INTO usage_thread_state(tenant_id,principal_id,thread_id) VALUES(?,?,?)").run(current.owner.tenantId,current.owner.principalId,threadId);
      db.prepare(`INSERT INTO usage_sources(id,tenant_id,principal_id,thread_id,backend_id,environment_id,workspace_id,native_namespace,native_session,epoch,normalization_version,baseline,capture_state)
        VALUES('analytics-source',?,?,?,?,?,?,'store','native','epoch','v1','unknown','idle')`).run(current.owner.tenantId,current.owner.principalId,threadId,thread.backend,thread.environment,workspace.body.id);
      db.prepare(`INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,occurred_at,received_at)
        VALUES('analytics-source','entry','1','fingerprint','{"facts":[]}','v1','2026-09-02T12:00:00.000Z','2026-09-02T12:00:01.000Z')`).run();
      db.prepare(`INSERT INTO usage_increments(tenant_id,principal_id,thread_id,source_id,fact_id,observation_id,observation_revision,backend_id,backend_kind,environment_id,workspace_id,
          agent_role,activity,provider,model,effort,placement,occurred_at,input,output,cost_units,currency,cost_kind,costed)
        VALUES(?,?,?,'analytics-source','fact','entry','1',?,'pi',?,?,'main','model','anthropic','claude','high','reported','2026-09-02T12:00:00.000Z',120,30,2500000000000,'USD','estimated',1)`)
        .run(current.owner.tenantId,current.owner.principalId,threadId,thread.backend,thread.environment,workspace.body.id);
      const body={from:"2026-09-01T00:00:00.000Z",to:"2026-09-03T00:00:00.000Z",timeZone:"America/Chicago",bucket:"auto",filters:{effort:["high"]},groupBy:"thread",crossBy:"model",breakdownLimit:10,facets:true};
      await current.withHost(request(current.app).post("/api/usage/analytics")).send(body).expect(403);
      const response=await current.mutate(request(current.app).post("/api/usage/analytics")).send(body).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatchObject({bucket:"hour",totals:{tokens:"150",costs:[{currency:"USD",amount:"2.5",kind:"estimated"}]},
        timeline:{series:[{key:threadId,totals:{input:"120"}}]},matrix:{cells:[{row:threadId,column:"claude"}]}});
      expect(response.body.labels.thread[threadId]).toMatchObject({label:"Analytics",kind:"pi",retired:false,workspaceId:workspace.body.id});
      expect(response.body.labels.workspace[workspace.body.id].label).toBe(db.prepare("SELECT display_name FROM workspaces WHERE id=?").pluck().get(workspace.body.id));
      expect(response.body.labels.environment[thread.environment].label).toBeTruthy();
      expect(response.body.labels.backend[thread.backend]).toMatchObject({kind:"pi"});
      const filtered=await current.mutate(request(current.app).post("/api/usage/analytics")).send({...body,filters:{effort:[null]}}).expect(200);
      expect(filtered.body.totals.increments).toBe("0");
      await current.mutate(request(current.app).post("/api/usage/analytics")).send({...body,principalId:"forged"}).expect(400);
      await current.mutate(request(current.app).post("/api/usage/analytics")).send({...body,timeZone:"Nowhere/Invalid"}).expect(400);
      expect(current.runtimeEstablishmentCaptures).not.toHaveBeenCalled();
    } finally {await current.close();}
  });

  it("manages retained projects and restores the same identity through Add project", async () => {
    const current = await fixture();
    try {
      const opened = await current.mutate(request(current.app).post("/api/workspaces/open"))
        .send({ environmentId: current.environmentId, path: current.workspacePath }).expect(201);
      const id = opened.body.id;
      const projects = await current.withHost(request(current.app).get("/api/workspaces")).expect(200);
      const project = projects.body.projects.find((entry: { id: string }) => entry.id === id);
      expect(project).toMatchObject({ removed: false, path: current.workspacePath });
      await current.withHost(request(current.app).post(`/api/workspaces/${id}/remove`))
        .send({ expectedRevision: project.revision }).expect(403);
      await current.mutate(request(current.app).post(`/api/workspaces/${id}/remove`))
        .send({ expectedRevision: project.revision, principalId: "forged" }).expect(400);
      await current.mutate(request(current.app).post(`/api/workspaces/${id}/remove`))
        .send({ expectedRevision: project.revision + 1 }).expect(409);
      const removed = await current.mutate(request(current.app).post(`/api/workspaces/${id}/remove`))
        .send({ expectedRevision: project.revision }).expect(200);
      expect(removed.body).toMatchObject({ id, removed: true });
      const snapshot = await current.withHost(request(current.app).get("/api/application/snapshot")).expect(200);
      expect(snapshot.body.workspaces.some((entry: { id: string }) => entry.id === id)).toBe(false);
      const restored = await current.mutate(request(current.app).post("/api/workspaces/open"))
        .send({ environmentId: current.environmentId, path: current.workspacePath }).expect(201);
      expect(restored.body.id).toBe(id);
      const repeated = await current.mutate(request(current.app).post("/api/workspaces/open"))
        .send({ environmentId: current.environmentId, path: current.workspacePath }).expect(201);
      expect(repeated.body.id).toBe(id);
      expect(current.repository.listProjects(current.owner).filter(entry => entry.id === id)).toHaveLength(1);
    } finally { current.close(); }
  });

  it("lists, dismisses, and responds to scoped questions without changing the composer", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const threadIds: string[] = [];
      for (const title of ["Questions", "Other thread"]) {
        const created = await current
          .mutate(request(current.app).post("/api/threads"))
          .send({
            workspaceId: workspace.body.id,
            configuration: { kind: "custom", targetId: current.profile.id },
            executionWorkspace: { kind: "direct" },
            title,
          })
          .expect(201);
        threadIds.push(created.body.threadId);
      }
      const threadId = threadIds[0]!;
      current.bindThread(threadId);
      const endpoint = `/api/threads/${threadId}/questions`;
      current.questions.observe(current.owner, threadId, "question-tool-1", {
        questions: [{ title: "Which color?", options: ["Blue", "Green"] }],
      });
      const listed = await current
        .withHost(request(current.app).get(endpoint))
        .expect(200);
      expect(listed.body.requests).toHaveLength(1);
      const question = listed.body.requests[0];
      expect(question.questions[0].title).toBe("Which color?");
      await current
        .withHost(
          request(current.app).get(`/api/threads/${randomUUID()}/questions`),
        )
        .expect(404);
      await current
        .withHost(
          request(current.app).post(`${endpoint}/${question.id}/dismiss`),
        )
        .send({ revision: 1 })
        .expect(403);
      await current
        .mutate(request(current.app).post(`${endpoint}/${question.id}/dismiss`))
        .send({ revision: 2 })
        .expect(409);
      await current
        .mutate(request(current.app).post(`${endpoint}/${question.id}/respond`))
        .send({ revision: 1, answers: [{ questionIndex: 0, answer: " " }] })
        .expect(400);
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${threadIds[1]}/questions/${question.id}/respond`,
          ),
        )
        .send({ revision: 1, answers: [{ questionIndex: 0, answer: "Blue" }] })
        .expect(409);
      expect(
        current.questions.list(current.owner, threadId).requests,
      ).toHaveLength(1);
      const dismissed = await current
        .mutate(request(current.app).post(`${endpoint}/${question.id}/dismiss`))
        .send({ revision: 1 })
        .expect(200);
      expect(dismissed.body.requests).toEqual([]);
      expect(current.questionDispatch).not.toHaveBeenCalled();

      current.questions.observe(current.owner, threadId, "question-tool-2", {
        questions: [{ title: "Which size?", options: null }],
      });
      const pending = current.questions.list(current.owner, threadId)
        .requests[0]!;
      const drafts = new ConversationDraftRepository(current.database);
      const draft = drafts.save(current.owner, threadId, {
        text: "Unfinished message",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: drafts.get(current.owner, threadId).revision,
        now: Date.now(),
      });
      const answered = await current
        .mutate(request(current.app).post(`${endpoint}/${pending.id}/respond`))
        .send({ revision: 1, answers: [{ questionIndex: 0, answer: "Large" }] })
        .expect(200);
      expect(answered.body.requests).toEqual([]);
      const statuses = await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/question-statuses`))
        .send({ sourceItemIds: ["question-tool-1", "question-tool-2", "unknown"] })
        .expect(200);
      expect(statuses.body.statuses).toEqual([
        { sourceItemId: "question-tool-1", questions: [{ index: 0, status: "dismissed" }] },
        { sourceItemId: "question-tool-2", questions: [{ index: 0, status: "answered" }] },
      ]);
      await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/question-statuses`))
        .send({ sourceItemIds: Array(101).fill("question-tool-1") })
        .expect(400);
      const unrelatedStatuses = await current
        .mutate(request(current.app).post(`/api/threads/${threadIds[1]}/question-statuses`))
        .send({ sourceItemIds: ["question-tool-1"] }).expect(200);
      expect(unrelatedStatuses.body.statuses).toEqual([]);
      expect(answered.body).toMatchObject({
        deliveryOperationId: `question:${pending.id}:1`,
        queuedInput: {
          deliveryOperationId: `question:${pending.id}:1`,
          state: "pending",
          inputOrigin: { kind: "question_response", requestId: pending.id },
        },
      });
      expect(drafts.get(current.owner, threadId)).toEqual(draft);
      expect(
        new QueuedInputRepository(current.database).list(
          current.owner,
          threadId,
        ),
      ).toMatchObject([
        {
          text: "User responded to a question:\nQuestion: Which size?\nAnswer: Large",
          triggerKind: "user",
          inputOrigin: {
            kind: "question_response",
            requestId: pending.id,
            sourceItemId: "question-tool-2",
            answers: [
              { questionIndex: 0, question: "Which size?", answer: "Large" },
            ],
          },
          state: "pending",
        },
      ]);
      expect(current.questionDispatch).toHaveBeenCalledWith(
        current.owner,
        threadId,
      );
    } finally {
      current.close();
    }
  });

  it("creates, filters through snapshots, preserves, and explicitly deletes thread groups", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const createdThread = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Design thread",
        })
        .expect(201);
      const threadId = createdThread.body.threadId as string;
      const createdGroup = await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/group`))
        .send({
          action: "create",
          name: "Design",
          expectedRevision: 0,
          mutationId: randomUUID(),
        })
        .expect(200);
      const groupId = createdGroup.body.groupId as string;

      const grouped = await current
        .withHost(request(current.app).get("/api/application/snapshot"))
        .expect(200);
      expect(grouped.body.groups).toEqual([
        expect.objectContaining({
          id: groupId,
          name: "Design",
          memberCount: 1,
          activeMemberCount: 1,
        }),
      ]);
      expect(
        grouped.body.threads.find(
          (thread: { id: string }) => thread.id === threadId,
        ),
      ).toMatchObject({ groupId, groupAssignmentRevision: 1 });

      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/group`))
        .send({
          action: "remove",
          expectedRevision: 1,
          mutationId: randomUUID(),
        })
        .expect(200);
      const empty = await current
        .withHost(request(current.app).get("/api/application/snapshot"))
        .expect(200);
      expect(empty.body.groups).toEqual([
        expect.objectContaining({ id: groupId, memberCount: 0 }),
      ]);

      await current
        .mutate(request(current.app).patch(`/api/thread-groups/${groupId}`))
        .send({
          action: "rename",
          name: "Persistent design",
          expectedRevision: 0,
          mutationId: randomUUID(),
        })
        .expect(200);
      await current
        .mutate(request(current.app).patch(`/api/thread-groups/${groupId}`))
        .send({
          action: "delete",
          expectedRevision: 1,
          expectedMemberCount: 0,
          mutationId: randomUUID(),
        })
        .expect(200);
      const deleted = await current
        .withHost(request(current.app).get("/api/application/snapshot"))
        .expect(200);
      expect(deleted.body.groups).toEqual([]);
    } finally {
      current.close();
    }
  });

  it("retains only output-artifact image metadata in full and summary snapshot, history, and SSE", async () => {
    const image = {
      representation: "artifact" as const,
      artifactId: randomUUID(),
      mimeType: "image/png" as const,
      byteSize: 9,
      sha256: "a".repeat(64),
      alt: { text: "Generated chart" },
      fileName: { text: "generated.png" },
    };
    const current = await fixture({ outputImage: image });
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Output image projection",
        })
        .expect(201);
      const threadId = created.body.threadId as string;
      const assertMetadataOnly = (value: unknown) => {
        const serialized = JSON.stringify(value);
        expect(serialized).not.toContain("dataBase64");
        expect(serialized).not.toContain("savedPath");
        expect(serialized).not.toContain("providerUrl");
      };

      for (const activityDetail of ["full", "summary"] as const) {
        const snapshot = await current
          .withHost(
            request(current.app).get(
              `/api/threads/${threadId}?activityDetail=${activityDetail}`,
            ),
          )
          .expect(200);
        expect(snapshot.body.itemsById["output-image"]).toEqual({
          id: "output-image",
          turnId: "turn-output-image",
          kind: "image",
          status: "completed",
          revision: 1,
          image,
        });
        assertMetadataOnly(snapshot.body);

        const history = await current
          .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
          .send({
            cursor: "history_application_cursor",
            limit: 10,
            activityDetail,
          })
          .expect(200);
        expect(
          history.body.event.page.itemsById["history-output-image"].image,
        ).toEqual(image);
        assertMetadataOnly(history.body);
      }

      const sse = await readFirstSseEvent(
        server,
        `/api/threads/${threadId}/events?activityDetail=summary`,
      );
      const sseData = sse.data as {
        snapshot: { itemsById: Record<string, { image?: unknown }> };
      };
      expect(sse.event).toBe("thread-checkpoint");
      expect(sseData.snapshot.itemsById["output-image"]?.image).toEqual(
        image,
      );
      assertMetadataOnly(sseData);
    } finally {
      await closeHttpTestServer(server);
      current.close();
    }
  });

  it("preserves explicit reasoning summaries while omitting raw activity detail from snapshot, history, seek, and SSE", async () => {
    const secret = "HTTP_ACTIVITY_DETAIL_MUST_NOT_REACH_BROWSER";
    const current = await fixture({ activitySecret: secret });
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Activity projection",
        })
        .expect(201);
      const threadId = created.body.threadId as string;

      const summarySnapshot = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${threadId}?activityDetail=summary`,
          ),
        )
        .expect(200);
      expect(summarySnapshot.text).not.toContain(secret);
      expect(
        summarySnapshot.body.itemsById["reasoning-activity"],
      ).toMatchObject({
        kind: "activity_summary",
        activityKind: "reasoning",
        summaryParts: [
          { text: "Preparing normalized activity projection" },
          { text: "Checking browser disclosure boundaries" },
        ],
      });
      expect(
        summarySnapshot.body.itemsById["reasoning-without-summary"],
      ).toEqual(
        expect.objectContaining({
          kind: "activity_summary",
          activityKind: "reasoning",
        }),
      );
      expect(
        summarySnapshot.body.itemsById["reasoning-without-summary"],
      ).not.toHaveProperty("summaryParts");
      const fullSnapshot = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${threadId}?activityDetail=full`,
          ),
        )
        .expect(200);
      expect(fullSnapshot.text).toContain(secret);
      expect(fullSnapshot.body.itemsById["reasoning-activity"]).toMatchObject({
        kind: "reasoning",
        markdown: { text: secret },
        summaryParts: [
          { text: "Preparing normalized activity projection" },
          { text: "Checking browser disclosure boundaries" },
        ],
      });

      const history = await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
        .send({
          cursor: "history_application_cursor",
          limit: 10,
          activityDetail: "summary",
        })
        .expect(200);
      expect(history.text).not.toContain(secret);
      expect(
        history.body.event.page.itemsById["reasoning-history-activity"],
      ).toMatchObject({
        kind: "activity_summary",
        activityKind: "reasoning",
        summaryParts: [{ text: "Reviewing older normalized activity" }],
      });
      expect(
        history.body.event.page.itemsById["tool-history-activity"],
      ).toMatchObject({ kind: "activity_summary", activityKind: "tool" });
      expect(
        history.body.event.page.itemsById["tool-history-activity"],
      ).not.toHaveProperty("toolName");
      expect(
        history.body.event.page.itemsById["tool-history-activity"],
      ).not.toHaveProperty("title");
      expect(
        history.body.event.page.itemsById["tool-history-activity"],
      ).not.toHaveProperty("arguments");
      expect(
        history.body.event.page.itemsById["tool-history-activity"],
      ).not.toHaveProperty("result");

      const fullHistory = await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
        .send({
          cursor: "history_application_cursor",
          limit: 10,
          activityDetail: "full",
        })
        .expect(200);
      expect(fullHistory.text).toContain(secret);
      expect(
        fullHistory.body.event.page.itemsById["reasoning-history-activity"],
      ).toMatchObject({
        kind: "reasoning",
        markdown: { text: secret },
        summaryParts: [{ text: "Reviewing older normalized activity" }],
      });
      expect(
        fullHistory.body.event.page.itemsById["tool-history-activity"],
      ).toMatchObject({
        kind: "tool",
        toolName: { text: secret },
        title: { text: secret },
        arguments: { text: secret },
        result: {
          content: [{ kind: "text", value: { text: secret } }],
        },
      });

      const seek = await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/history/seek`),
        )
        .send({ turnId: "turn-activity", activityDetail: "summary" })
        .expect(200);
      expect(seek.text).not.toContain(secret);
      expect(seek.body.page.itemsById["reasoning-activity"]).toMatchObject({
        kind: "activity_summary",
        activityKind: "reasoning",
        summaryParts: [
          { text: "Preparing normalized activity projection" },
          { text: "Checking browser disclosure boundaries" },
        ],
      });
      expect(
        seek.body.page.itemsById["reasoning-without-summary"],
      ).not.toHaveProperty("summaryParts");

      const sse = await readFirstSseEvent(
        server,
        `/api/threads/${threadId}/events?activityDetail=summary`,
      );
      expect(JSON.stringify(sse.data)).not.toContain(secret);
      expect(sse.event).toBe("thread-checkpoint");
      expect(sse.data).toMatchObject({
        snapshot: {
            itemsById: {
              "reasoning-activity": {
                kind: "activity_summary",
                activityKind: "reasoning",
                summaryParts: [
                  { text: "Preparing normalized activity projection" },
                  { text: "Checking browser disclosure boundaries" },
                ],
              },
              "reasoning-without-summary": {
                kind: "activity_summary",
                activityKind: "reasoning",
              },
            },
        },
      });
      expect(
        (
          sse.data as {
            snapshot: { itemsById: Record<string, unknown> };
          }
        ).snapshot.itemsById["reasoning-without-summary"],
      ).not.toHaveProperty("summaryParts");
    } finally {
      await closeHttpTestServer(server);
      current.close();
    }
  });

  it("browses bounded execution-environment directories through the normalized route", async () => {
    const current = await fixture();
    try {
      await mkdir(path.join(current.workspacePath, "alpha"));
      await mkdir(path.join(current.workspacePath, "bravo"));
      const first = await current
        .mutate(
          request(current.app).post(
            `/api/execution-environments/${current.environmentId}/directories/browse`,
          ),
        )
        .send({
          location: { kind: "directory", path: current.workspacePath },
          pageSize: 1,
        })
        .expect(200);
      expect(first.body).toMatchObject({
        location: {
          kind: "directory",
          path: current.workspacePath,
          parentPath: path.dirname(current.workspacePath),
        },
        entries: [
          { name: "alpha", path: path.join(current.workspacePath, "alpha") },
        ],
        truncated: false,
      });
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await current
        .mutate(
          request(current.app).post(
            `/api/execution-environments/${current.environmentId}/directories/browse`,
          ),
        )
        .send({
          location: { kind: "directory", path: current.workspacePath },
          pageSize: 1,
          cursor: first.body.nextCursor,
        })
        .expect(200);
      expect(second.body).toMatchObject({
        location: {
          kind: "directory",
          path: current.workspacePath,
          parentPath: path.dirname(current.workspacePath),
        },
        entries: [
          { name: "bravo", path: path.join(current.workspacePath, "bravo") },
        ],
        truncated: false,
      });
      expect(second.body.nextCursor).toEqual(expect.any(String));
    } finally {
      current.close();
    }
  });

  it("normalizes denied paths, stale cursors, and wrong-scope browsing", async () => {
    const current = await fixture();
    try {
      const endpoint = `/api/execution-environments/${current.environmentId}/directories/browse`;
      await current
        .mutate(request(current.app).post(endpoint))
        .send({
          location: { kind: "directory", path: os.tmpdir() },
          pageSize: 50,
        })
        .expect(400)
        .expect({
          error: {
            code: "invalid_transition",
            message:
              "The directory cannot be browsed in this execution environment.",
            retryable: false,
          },
        });
      await current
        .mutate(request(current.app).post(endpoint))
        .send({
          location: { kind: "directory", path: current.workspacePath },
          pageSize: 50,
          cursor: "not-a-valid-cursor",
        })
        .expect(409)
        .expect({
          error: {
            code: "cursor_invalid",
            message:
              "The directory page changed or its continuation is no longer valid.",
            retryable: false,
          },
        });
      await current
        .mutate(
          request(current.app)
            .post(endpoint)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({ location: { kind: "roots" }, pageSize: 50 })
        .expect(503)
        .expect({
          error: {
            code: "runtime_unavailable",
            message:
              "The execution environment could not complete the operation.",
            retryable: true,
          },
        });
    } finally {
      current.close();
    }
  });

  it("cancels an in-flight workspace comparison when the HTTP client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const current = await fixture({
      workspaceFileProvider: (delegate) =>
        new Proxy(delegate, {
          get(target, property, receiver) {
            if (property === "diffRepositories") {
              return async (
                _scope: RequestScope,
                _root: unknown,
                signal?: AbortSignal,
              ) => {
                observedSignal = signal;
                started();
                return await new Promise((_resolve, reject) => {
                  signal?.addEventListener(
                    "abort",
                    () => reject(signal.reason),
                    { once: true },
                  );
                });
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    try {
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const httpRequest = current.withHost(
        request(current.app).get(
          `/api/workspaces/${workspaceId}/file-roots/primary/diff/repositories`,
        ),
      );
      const pending = httpRequest.then(
        () => undefined,
        () => undefined,
      );

      await operationStarted;
      httpRequest.abort();
      await pending;

      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
      expect(observedSignal?.reason).toMatchObject({
        message: "workspace_file_http_request_closed",
      });
    } finally {
      current.close();
    }
  });

  it("cancels an in-flight workspace file download when the HTTP client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const current = await fixture({
      workspaceFileProvider: (delegate) =>
        new Proxy(delegate, {
          get(target, property, receiver) {
            if (property === "withDownload") {
              return async (
                _scope: RequestScope,
                _root: unknown,
                input: { path: string; expectedRevision: string },
                operation: (source: {
                  path: string;
                  fileName: string;
                  sizeBytes: number;
                  revision: string;
                  stream(
                    write: (chunk: Uint8Array) => Promise<void>,
                    signal?: AbortSignal,
                  ): Promise<void>;
                }) => Promise<unknown>,
                signal?: AbortSignal,
              ) => {
                observedSignal = signal;
                return operation({
                  path: input.path,
                  fileName: "blocked.bin",
                  sizeBytes: 1024,
                  revision: input.expectedRevision,
                  stream: async (_write, streamSignal = signal) => {
                    started();
                    return await new Promise((_resolve, reject) => {
                      streamSignal?.addEventListener(
                        "abort",
                        () => reject(streamSignal.reason),
                        { once: true },
                      );
                    });
                  },
                });
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    try {
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const httpRequest = current.withHost(
        request(current.app)
          .get(`/api/workspaces/${workspaceId}/files/download`)
          .query({
            rootId: "primary",
            path: "blocked.bin",
            expectedRevision: "revision-1",
          }),
      );
      const pending = httpRequest.then(
        () => undefined,
        () => undefined,
      );
      await operationStarted;
      httpRequest.abort();
      await pending;
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
      expect(observedSignal?.reason).toMatchObject({
        message: "workspace_file_http_request_closed",
      });
    } finally {
      current.close();
    }
  });

  it("streams an immutable raw attachment upload behind Host and CSRF guards", async () => {
    const attachmentId = randomUUID();
    const threadId = randomUUID();
    const uploaded = Buffer.from("raw\0attachment");
    const upload = vi.fn(async (input: { body: AsyncIterable<Buffer> }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(uploaded);
      return {
        id: attachmentId,
        fileName: "payload.bin",
        kind: "file" as const,
        mediaType: "application/octet-stream" as const,
        byteSize: uploaded.byteLength,
      };
    });
    const current = await fixture({
      composerAttachments: {
        upload,
      } as unknown as ComposerAttachmentService,
    });
    try {
      await current
        .withHost(
          request(current.app)
            .put(
              `/api/threads/${threadId}/composer-attachments/${attachmentId}?fileName=payload.bin`,
            )
            .set("Content-Type", "application/octet-stream")
            .send(uploaded),
        )
        .expect(403)
        .expect(({ body }) =>
          expect(body.error.code).toBe("csrf_token_invalid"),
        );

      await current
        .mutate(
          request(current.app)
            .put(
              `/api/threads/${threadId}/composer-attachments/${attachmentId}?fileName=payload.bin`,
            )
            .set("Content-Type", "application/octet-stream")
            .send(uploaded),
        )
        .expect(201)
        .expect({
          attachment: {
            id: attachmentId,
            fileName: "payload.bin",
            kind: "file",
            mediaType: "application/octet-stream",
            byteSize: uploaded.byteLength,
          },
        });
      expect(upload).toHaveBeenCalledOnce();
      expect(upload.mock.calls[0]![0]).toMatchObject({
        threadId,
        attachmentId,
        fileName: "payload.bin",
        contentLength: uploaded.byteLength,
      });
    } finally {
      current.close();
    }
  });

  it("rejects mislabeled or encoded attachment uploads before the service", async () => {
    const upload = vi.fn();
    const current = await fixture({
      composerAttachments: {
        upload,
      } as unknown as ComposerAttachmentService,
    });
    const route = `/api/threads/${randomUUID()}/composer-attachments/${randomUUID()}?fileName=file.bin`;
    try {
      await current
        .mutate(request(current.app).put(route))
        .send({ binary: false })
        .expect(415);
      await current
        .mutate(
          request(current.app)
            .put(route)
            .set("Content-Type", "application/octet-stream")
            .set("Content-Encoding", "gzip")
            .send(Buffer.from("bytes")),
        )
        .expect(415);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      current.close();
    }
  });

  it("reports the normalized attachment payload limit with HTTP 413", async () => {
    const upload = vi.fn(async () => {
      throw new ComposerAttachmentStorageError(
        "attachment_too_large",
        "The attachment exceeded the file size limit.",
      );
    });
    const current = await fixture({
      composerAttachments: {
        upload,
      } as unknown as ComposerAttachmentService,
    });
    try {
      await current
        .mutate(
          request(current.app)
            .put(
              `/api/threads/${randomUUID()}/composer-attachments/${randomUUID()}?fileName=large.bin`,
            )
            .set("Content-Type", "application/octet-stream")
            .send(Buffer.from("bytes")),
        )
        .expect(413)
        .expect(({ body }) => {
          expect(body.error).toMatchObject({
            code: "attachment_payload_too_large",
            retryable: false,
          });
        });
    } finally {
      current.close();
    }
  });

  it("serves only service-authorized image bytes for GET and HEAD", async () => {
    const contentRoot = await mkdtemp(
      path.join(os.tmpdir(), "sedes-attachment-http-"),
    );
    roots.push(contentRoot);
    const contentPath = path.join(contentRoot, "preview.png");
    const bytes = Buffer.from("image bytes");
    await writeFile(contentPath, bytes);
    const attachmentId = randomUUID();
    const threadId = randomUUID();
    const openContent = vi.fn(async () => ({
      descriptor: {
        id: attachmentId,
        fileName: "preview.png",
        kind: "image" as const,
        mediaType: "image/png" as const,
        byteSize: bytes.byteLength,
      },
      handle: await open(contentPath, "r"),
    }));
    const current = await fixture({
      composerAttachments: {
        openContent,
      } as unknown as ComposerAttachmentService,
    });
    const route = `/api/threads/${threadId}/composer-attachments/${attachmentId}/content`;
    try {
      const fetched = await current
        .withHost(request(current.app).get(route))
        .expect(200)
        .expect("Content-Type", "image/png")
        .expect("Content-Length", String(bytes.byteLength))
        .expect(bytes);
      const contentSecurityPolicy = fetched.headers[
        "content-security-policy"
      ] as string;
      expect(contentSecurityPolicy).toContain("img-src 'self' data: blob:");
      expect(contentSecurityPolicy).toContain("connect-src 'self' data:");
      expect(contentSecurityPolicy).not.toContain(
        "connect-src 'self' data: blob:",
      );
      expect(fetched.headers["cache-control"]).toBe(
        "private, max-age=3600, immutable",
      );
      expect(fetched.headers.etag).toBe(
        `"attachment-${attachmentId}-${bytes.byteLength}"`,
      );
      expect(fetched.headers["content-disposition"]).toBe(
        `inline; filename="preview.png"; filename*=UTF-8''preview.png`,
      );
      expect(fetched.headers["x-content-type-options"]).toBe("nosniff");
      await current
        .withHost(request(current.app).head(route))
        .expect(200)
        .expect("Content-Type", "image/png")
        .expect("Content-Length", String(bytes.byteLength));
      expect(openContent).toHaveBeenCalledTimes(2);
    } finally {
      current.close();
    }
  });

  it("downloads live-owned generic files opaquely with safe immutable headers", async () => {
    const contentRoot = await mkdtemp(
      path.join(os.tmpdir(), "sedes-attachment-download-"),
    );
    roots.push(contentRoot);
    const contentPath = path.join(contentRoot, "opaque.bin");
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(contentPath, bytes);
    const attachmentId = randomUUID();
    const threadId = randomUUID();
    const descriptor = {
      id: attachmentId,
      fileName: "évidence.bin",
      kind: "file" as const,
      mediaType: "application/octet-stream" as const,
      byteSize: bytes.byteLength,
    };
    const openContent = vi.fn(async () => ({
      descriptor,
      handle: await open(contentPath, "r"),
    }));
    const current = await fixture({
      composerAttachments: {
        openContent,
      } as unknown as ComposerAttachmentService,
    });
    const route = `/api/threads/${threadId}/composer-attachments/${attachmentId}/content`;
    try {
      const downloaded = await current
        .withHost(request(current.app).get(route))
        .expect(200)
        .expect("Content-Type", "application/octet-stream")
        .expect("Content-Length", String(bytes.byteLength))
        .expect(bytes);
      expect(downloaded.headers["content-disposition"]).toBe(
        `attachment; filename="e_vidence.bin"; filename*=UTF-8''%C3%A9vidence.bin`,
      );
      expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
      const etag = downloaded.headers.etag as string;
      await current
        .withHost(request(current.app).head(route))
        .set("If-None-Match", etag)
        .expect(304)
        .expect("ETag", etag);
      expect(openContent).toHaveBeenCalledTimes(2);
    } finally {
      current.close();
    }
  });

  it("serves immutable output images by server-derived scope and thread", async () => {
    const contentRoot = await mkdtemp(
      path.join(os.tmpdir(), "sedes-output-artifact-content-"),
    );
    roots.push(contentRoot);
    const contentPath = path.join(contentRoot, "generated.png");
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    await writeFile(contentPath, bytes);
    const threadId = randomUUID();
    const artifactId = randomUUID();
    const descriptor = {
      artifactId,
      mediaType: "image/png" as const,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const closeHandles: Array<ReturnType<typeof vi.spyOn>> = [];
    const openImage = vi.fn(
      async (
        _scope: RequestScope,
        requestedThreadId: string,
        requestedArtifactId: string,
      ) => {
        if (
          requestedThreadId !== threadId ||
          requestedArtifactId !== artifactId
        ) {
          throw new DomainError(
            "not_found",
            "The output artifact was not found.",
          );
        }
        const handle = await open(contentPath, "r");
        closeHandles.push(vi.spyOn(handle, "close"));
        return { descriptor, handle };
      },
    );
    const current = await fixture({
      outputArtifacts: { openImage } as unknown as OutputArtifactService,
    });
    const route = `/api/threads/${threadId}/output-artifacts/${artifactId}/content`;
    try {
      const fetched = await current
        .withHost(request(current.app).get(route))
        .expect(200)
        .expect("Content-Type", "image/png")
        .expect("Content-Length", String(bytes.byteLength))
        .expect(bytes);
      expect(fetched.headers["cache-control"]).toBe(
        "private, max-age=3600, immutable",
      );
      expect(fetched.headers.etag).toBe(`"sha256-${descriptor.sha256}"`);
      expect(fetched.headers["content-disposition"]).toBe(
        `inline; filename="${artifactId}.png"; filename*=UTF-8''${artifactId}.png`,
      );
      expect(fetched.headers["x-content-type-options"]).toBe("nosniff");

      await current
        .withHost(request(current.app).head(route))
        .expect(200)
        .expect("Content-Type", "image/png")
        .expect("Content-Length", String(bytes.byteLength));
      await current
        .withHost(
          request(current.app)
            .get(route)
            .set("If-None-Match", `"sha256-${descriptor.sha256}"`),
        )
        .expect(304)
        .expect("ETag", `"sha256-${descriptor.sha256}"`);
      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${randomUUID()}/output-artifacts/${artifactId}/content`,
          ),
        )
        .expect(404)
        .expect(({ body }) => {
          expect(body.error.code).toBe("not_found");
        });
      expect(openImage).toHaveBeenCalledTimes(4);
      expect(openImage.mock.calls[0]?.[0]).toEqual(current.owner);
      expect(closeHandles).toHaveLength(3);
      for (const closeHandle of closeHandles) {
        expect(closeHandle).toHaveBeenCalled();
      }
    } finally {
      current.close();
    }
  });

  it("reports retained output-artifact corruption as a generic server failure", async () => {
    const current = await fixture({
      outputArtifacts: {
        openImage: async () => {
          throw new OutputArtifactStorageError(
            "artifact_blob_corrupt",
            "private artifact storage detail",
          );
        },
      } as unknown as OutputArtifactService,
    });
    try {
      const response = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${randomUUID()}/output-artifacts/${randomUUID()}/content`,
          ),
        )
        .expect(500);
      expect(response.body).toEqual({
        error: {
          code: "internal_error",
          message: "The output artifact failed its integrity check.",
          retryable: false,
        },
      });
      expect(response.text).not.toContain("private artifact storage detail");
    } finally {
      current.close();
    }
  });

  it("maps missing retained output-artifact bytes to a scoped not-found response", async () => {
    const openImage = vi.fn(
      async (_scope: RequestScope, _threadId: string, _artifactId: string) => {
        throw new OutputArtifactStorageError(
          "artifact_blob_missing",
          "private artifact storage detail",
        );
      },
    );
    const current = await fixture({
      outputArtifacts: { openImage } as unknown as OutputArtifactService,
    });
    const route = `/api/threads/${randomUUID()}/output-artifacts/${randomUUID()}/content`;
    try {
      const fetched = await current
        .withHost(request(current.app).get(route))
        .expect(404);
      expect(fetched.body).toEqual({
        error: {
          code: "not_found",
          message: "The output artifact was not found.",
          retryable: false,
        },
      });
      expect(fetched.text).not.toContain("private artifact storage detail");
      await current.withHost(request(current.app).head(route)).expect(404);
      expect(openImage).toHaveBeenCalledTimes(2);
      for (const [requestedScope] of openImage.mock.calls) {
        expect(requestedScope).toEqual(current.owner);
      }
    } finally {
      current.close();
    }
  });

  it("scopes notification configuration and silence, rejects stale edits and requires CSRF", async () => {
    const current = await fixture();
    const route = "/api/application/notifications";
    try {
      const initial = await current
        .withHost(request(current.app).get(route))
        .expect(200);
      expect(initial.headers["cache-control"]).toBe("no-store");
      expect(initial.body).toMatchObject({
        enabled: false,
        silenced: false,
        revision: 0,
      });
      const config = {
        enabled: true,
        assistantResultPhases: [],
        scriptPath: "/usr/local/bin/sedes-notify",
        arguments: ["--mobile"],
        timeoutSeconds: 15,
        events: ["turn.completed", "automation.started"],
        expectedRevision: 0,
      };
      await current
        .withHost(request(current.app).put(route))
        .send(config)
        .expect(403);
      const saved = await current
        .mutate(request(current.app).put(route))
        .send(config)
        .expect(200);
      expect(saved.body).toMatchObject({
        enabled: true,
        silenced: false,
        revision: 1,
      });
      await current
        .mutate(request(current.app).put(route))
        .send(config)
        .expect(409);
      await current
        .mutate(request(current.app).put(route))
        .send({ ...config, expectedRevision: 1, principalId: "foreign" })
        .expect(400);
      await current
        .mutate(request(current.app).put(route))
        .send({ ...config, expectedRevision: 1, scriptPath: "relative-script" })
        .expect(400);
      await current
        .mutate(request(current.app).put(route))
        .send({ ...config, expectedRevision: 1, events: ["read.receipt"] })
        .expect(400);
      await current
        .withHost(request(current.app).put(`${route}/silence`))
        .send({ silenced: true })
        .expect(403);
      const silenced = await current
        .mutate(request(current.app).put(`${route}/silence`))
        .send({ silenced: true })
        .expect(200);
      expect(silenced.body).toMatchObject({
        enabled: true,
        silenced: true,
        scriptPath: config.scriptPath,
      });
      const foreign = await current
        .withHost(
          request(current.app)
            .get(route)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(200);
      expect(foreign.body).toMatchObject({
        enabled: false,
        silenced: false,
        scriptPath: "",
      });
      await current
        .withHost(request(current.app).post(`${route}/test`))
        .send({ scriptPath: "/bin/cat", arguments: [], timeoutSeconds: 1 })
        .expect(403);
      await current
        .mutate(request(current.app).post(`${route}/test`))
        .send({ scriptPath: "relative", arguments: [], timeoutSeconds: 1 })
        .expect(400);
      const tested = await current
        .mutate(request(current.app).post(`${route}/test`))
        .send({ scriptPath: "/bin/cat", arguments: [], timeoutSeconds: 1 })
        .expect(200);
      expect(tested.body).toMatchObject({
        success: true,
        exitCode: 0,
        timedOut: false,
      });
      const afterTest = await current
        .withHost(request(current.app).get(route))
        .expect(200);
      expect(afterTest.body).toEqual(silenced.body);
    } finally {
      current.close();
    }
  });

  it("persists the OpenAI composer-skill preference per authenticated principal", async () => {
    const current = await fixture();
    try {
      await current
        .withHost(request(current.app).get("/api/application/preferences"))
        .expect(200)
        .expect({ showOpenAIComposerSkills: false, revision: 0 });

      await current
        .withHost(request(current.app).put("/api/application/preferences"))
        .send({ showOpenAIComposerSkills: true, expectedRevision: 0 })
        .expect(403);

      await current
        .mutate(request(current.app).put("/api/application/preferences"))
        .send({ showOpenAIComposerSkills: true, expectedRevision: 0 })
        .expect(200)
        .expect({ showOpenAIComposerSkills: true, revision: 1 });

      await current
        .withHost(
          request(current.app)
            .get("/api/application/preferences")
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(200)
        .expect({ showOpenAIComposerSkills: false, revision: 0 });

      await current
        .mutate(
          request(current.app)
            .put("/api/application/preferences")
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({ showOpenAIComposerSkills: true, expectedRevision: 0 })
        .expect(200)
        .expect({ showOpenAIComposerSkills: true, revision: 1 });

      await current
        .mutate(request(current.app).put("/api/application/preferences"))
        .send({ showOpenAIComposerSkills: false, expectedRevision: 1 })
        .expect(200)
        .expect({ showOpenAIComposerSkills: false, revision: 2 });

      await current
        .withHost(
          request(current.app)
            .get("/api/application/preferences")
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(200)
        .expect({ showOpenAIComposerSkills: true, revision: 1 });

      await current
        .mutate(request(current.app).put("/api/application/preferences"))
        .send({ showOpenAIComposerSkills: true, expectedRevision: 1 })
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe("conflict"));
    } finally {
      current.close();
    }
  });

  it("discovers linked Git worktrees and routes thread-relative files through the preferred root", async () => {
    const current = await fixture();
    try {
      const linkedWorktreePath = path.join(
        path.dirname(current.workspacePath),
        "workspace-feature",
      );
      await mkdir(path.join(current.workspacePath, "src"));
      await writeFile(
        path.join(current.workspacePath, "src", "choice.ts"),
        "export const choice = 'primary';\n",
      );
      await execFile("git", ["init", "-b", "main"], {
        cwd: current.workspacePath,
      });
      await execFile("git", ["config", "user.email", "test@example.invalid"], {
        cwd: current.workspacePath,
      });
      await execFile("git", ["config", "user.name", "Sedes Test"], {
        cwd: current.workspacePath,
      });
      await execFile("git", ["add", "src/choice.ts"], {
        cwd: current.workspacePath,
      });
      await execFile("git", ["commit", "-m", "initial"], {
        cwd: current.workspacePath,
      });
      await execFile(
        "git",
        [
          "worktree",
          "add",
          "-b",
          "feature/http-preference",
          linkedWorktreePath,
        ],
        { cwd: current.workspacePath },
      );
      await writeFile(
        path.join(linkedWorktreePath, "src", "choice.ts"),
        "export const choice = 'linked';\n",
      );

      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const createdThread = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Linked worktree files",
        })
        .expect(201);
      const threadId = createdThread.body.threadId as string;

      const roots = await current
        .withHost(
          request(current.app).get(`/api/workspaces/${workspaceId}/file-roots`),
        )
        .expect(200);
      const linkedRoot = roots.body.roots.find(
        (root: { kind: string }) => root.kind === "linked_worktree",
      ) as
        | {
            rootId: string;
            kind: string;
            branch: string | null;
            availability: string;
            revision: number;
          }
        | undefined;
      expect(linkedRoot).toMatchObject({
        kind: "linked_worktree",
        branch: "feature/http-preference",
        availability: "available",
      });
      expect(linkedRoot?.rootId).toBeTypeOf("string");
      const linkedRootId = linkedRoot?.rootId as string;

      await current
        .mutate(
          request(current.app).put(
            `/api/threads/${threadId}/preferred-worktree`,
          ),
        )
        .send({
          rootId: linkedRootId,
          expectedRevision: 0,
          mutationId: randomUUID(),
        })
        .expect(200)
        .expect({ preference: { rootId: linkedRootId, revision: 1 } });

      const preferred = await current
        .mutate(
          request(current.app).post(
            `/api/threads/${threadId}/file-links/resolve`,
          ),
        )
        .send({
          reference: { kind: "workspace_relative", path: "src/choice.ts" },
        })
        .expect(200);
      expect(preferred.body).toEqual({
        status: "resolved",
        rootId: linkedRootId,
        path: "src/choice.ts",
        rootVisibility: "listed",
      });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: linkedRootId, path: "src/choice.ts" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.content).toBe("export const choice = 'linked';\n");
        });

      await current
        .mutate(
          request(current.app).put(
            `/api/threads/${threadId}/preferred-worktree`,
          ),
        )
        .send({
          rootId: null,
          expectedRevision: 1,
          mutationId: randomUUID(),
        })
        .expect(200)
        .expect({ preference: { rootId: null, revision: 2 } });

      const primary = await current
        .mutate(
          request(current.app).post(
            `/api/threads/${threadId}/file-links/resolve`,
          ),
        )
        .send({
          reference: { kind: "workspace_relative", path: "src/choice.ts" },
        })
        .expect(200);
      expect(primary.body).toEqual({
        status: "resolved",
        rootId: "primary",
        path: "src/choice.ts",
        rootVisibility: "listed",
      });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "src/choice.ts" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.content).toBe("export const choice = 'primary';\n");
        });

      await current
        .mutate(
          request(current.app).delete(
            `/api/workspaces/${workspaceId}/linked-worktrees/${linkedRootId}`,
          ),
        )
        .send({
          expectedRevision: linkedRoot!.revision,
          mutationId: randomUUID(),
          confirmation: true,
        })
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe("conflict"));
      await execFile("git", ["checkout", "--", "src/choice.ts"], {
        cwd: linkedWorktreePath,
      });
      await current
        .mutate(
          request(current.app).delete(
            `/api/workspaces/${workspaceId}/linked-worktrees/${linkedRootId}`,
          ),
        )
        .send({
          expectedRevision: linkedRoot!.revision,
          mutationId: randomUUID(),
          confirmation: true,
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            rootId: linkedRootId,
            outcome: "removed",
            clearedThreadIds: [],
          });
        });
      await expect(stat(linkedWorktreePath)).rejects.toThrow();
    } finally {
      current.close();
    }
  });

  it("attaches, addresses, resolves, and removes a supplemental file root", async () => {
    const current = await fixture();
    try {
      await writeFile(
        path.join(current.supplementalPath, "notes.md"),
        "context\n",
      );
      await writeFile(
        path.join(current.workspacePath, "README.md"),
        "primary\n",
      );
      const linkedWorktreePath = path.join(
        path.dirname(current.workspacePath),
        "linked-worktree",
      );
      await mkdir(path.join(linkedWorktreePath, ".git"), { recursive: true });
      await mkdir(path.join(linkedWorktreePath, "src"));
      await writeFile(
        path.join(linkedWorktreePath, "src", "linked.ts"),
        "export const linked = true;\n",
      );
      const linkedDirectoryPath = path.join(
        path.dirname(current.workspacePath),
        "linked-directory",
      );
      await mkdir(linkedDirectoryPath);
      await writeFile(
        path.join(linkedDirectoryPath, "copied.ts"),
        "export const copied = true;\n",
      );
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      await current
        .withHost(
          request(current.app).get(`/api/workspaces/${workspaceId}/file-roots`),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.roots).toEqual([
            expect.objectContaining({ rootId: "primary", revision: 0 }),
          ]);
        });
      const attachMutationId = randomUUID();
      const attachBody = {
        mutationId: attachMutationId,
        path: current.supplementalPath,
        displayLabel: "Context",
      };
      const attached = await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-roots`,
          ),
        )
        .send(attachBody)
        .expect(201);
      const rootId = attached.body.root.rootId as string;
      expect(attached.body.root).toMatchObject({
        availability: "available",
        displayLabel: "Context",
      });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/file-roots`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(404);
      await current
        .mutate(
          request(current.app)
            .post(`/api/workspaces/${workspaceId}/file-roots`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send(attachBody)
        .expect(404);
      await current
        .mutate(
          request(current.app)
            .delete(`/api/workspaces/${workspaceId}/file-roots/${rootId}`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          mutationId: randomUUID(),
          expectedRevision: attached.body.root.revision,
        })
        .expect(404);
      await current
        .mutate(
          request(current.app)
            .post(`/api/workspaces/${workspaceId}/file-links/resolve`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(current.supplementalPath, "notes.md"),
          },
        })
        .expect(404);
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/events`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(404);
      const deleteMutationId = randomUUID();
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files`)
            .query({ rootId }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({ rootId, entries: ["notes.md"] });
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(current.supplementalPath, "notes.md"),
          },
        })
        .expect(200)
        .expect({
          status: "resolved",
          rootId,
          path: "notes.md",
          rootVisibility: "listed",
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "root_relative",
            rootId,
            path: "notes.md",
          },
        })
        .expect(200)
        .expect({
          status: "resolved",
          rootId,
          path: "notes.md",
          rootVisibility: "listed",
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "root_relative",
            rootId: "root-from-another-workspace",
            path: "notes.md",
          },
        })
        .expect(200)
        .expect({ status: "not_found" });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: { kind: "workspace_relative", path: "README.md" },
        })
        .expect(200)
        .expect({
          status: "resolved",
          rootId: "primary",
          path: "README.md",
          rootVisibility: "listed",
        });
      const linked = await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(linkedWorktreePath, "src", "linked.ts"),
          },
        })
        .expect(200);
      expect(linked.body).toMatchObject({
        status: "resolved",
        rootId: expect.stringMatching(/^link-/),
        path: "src/linked.ts",
        rootVisibility: "link_only",
      });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: linked.body.rootId, path: linked.body.path }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            rootId: linked.body.rootId,
            path: "src/linked.ts",
            content: "export const linked = true;\n",
          });
        });
      const copied = await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(linkedDirectoryPath, "copied.ts"),
          },
        })
        .expect(200);
      expect(copied.body).toMatchObject({
        status: "resolved",
        rootId: expect.stringMatching(/^link-/),
        path: "copied.ts",
        rootVisibility: "link_only",
      });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: copied.body.rootId, path: copied.body.path }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            rootId: copied.body.rootId,
            path: "copied.ts",
            content: "export const copied = true;\n",
          });
        });
      await current
        .withHost(
          request(current.app).get(`/api/workspaces/${workspaceId}/file-roots`),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(
            body.roots.map(
              ({ rootId: candidate }: { rootId: string }) => candidate,
            ),
          ).toEqual(["primary", rootId]);
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({ path: path.join(current.supplementalPath, "notes.md") })
        .expect(400);
      await current
        .mutate(
          request(current.app).delete(
            `/api/workspaces/${workspaceId}/file-roots/${rootId}`,
          ),
        )
        .send({
          mutationId: deleteMutationId,
          expectedRevision: attached.body.root.revision,
        })
        .expect(200)
        .expect({ rootId });
      await current
        .mutate(
          request(current.app)
            .delete(`/api/workspaces/${workspaceId}/file-roots/${rootId}`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          mutationId: deleteMutationId,
          expectedRevision: attached.body.root.revision,
        })
        .expect(404);
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files`)
            .query({ rootId }),
        )
        .expect(404);
      const dotDotDataPath = path.join(
        path.dirname(current.workspacePath),
        "..data",
      );
      await mkdir(dotDotDataPath);
      const dotDotAttached = await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-roots`,
          ),
        )
        .send({ mutationId: randomUUID(), path: dotDotDataPath })
        .expect(201)
        .expect(({ body }) => {
          expect(body.root).toMatchObject({ displayLabel: "..data" });
        });
      await current
        .withHost(
          request(current.app).get(`/api/workspaces/${workspaceId}/file-roots`),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.roots).toContainEqual(
            expect.objectContaining({
              rootId: dotDotAttached.body.root.rootId,
              availability: "available",
            }),
          );
        });
    } finally {
      current.close();
    }
  });

  it("attaches an ancestor root and resolves overlapping links through the most-specific root", async () => {
    const current = await fixture();
    try {
      const ancestorPath = path.dirname(current.workspacePath);
      await writeFile(
        path.join(current.workspacePath, "README.md"),
        "primary\n",
      );
      await writeFile(path.join(ancestorPath, "home-note.md"), "home\n");
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const attached = await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-roots`,
          ),
        )
        .send({
          mutationId: randomUUID(),
          path: ancestorPath,
          displayLabel: "Home",
        })
        .expect(201);
      const ancestorRootId = attached.body.root.rootId as string;

      await current
        .withHost(
          request(current.app).get(`/api/workspaces/${workspaceId}/file-roots`),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.roots).toEqual([
            expect.objectContaining({
              rootId: "primary",
              availability: "available",
            }),
            expect.objectContaining({
              rootId: ancestorRootId,
              displayLabel: "Home",
              availability: "available",
            }),
          ]);
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(current.workspacePath, "README.md"),
          },
        })
        .expect(200)
        .expect({
          status: "resolved",
          rootId: "primary",
          path: "README.md",
          rootVisibility: "listed",
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-links/resolve`,
          ),
        )
        .send({
          reference: {
            kind: "absolute",
            path: path.join(ancestorPath, "home-note.md"),
          },
        })
        .expect(200)
        .expect({
          status: "resolved",
          rootId: ancestorRootId,
          path: "home-note.md",
          rootVisibility: "listed",
        });
    } finally {
      current.close();
    }
  });

  it("keeps workspace comparisons root-qualified, strict, and fail-closed", async () => {
    const current = await fixture();
    try {
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const prefix = `/api/workspaces/${workspaceId}/file-roots/primary/diff`;

      await current
        .withHost(request(current.app).get(`${prefix}/repositories`))
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            status: "available",
            repositories: [],
          });
          expect(JSON.stringify(body)).not.toContain(current.workspacePath);
        });
      await current
        .withHost(
          request(current.app).get(`${prefix}/refs`).query({
            repositoryId: "repository-opaque",
            pageSize: 25,
            unexpected: "rejected",
          }),
        )
        .expect(400);
      await current
        .mutate(request(current.app).post(`${prefix}/comparisons`))
        .send({
          repositoryId: "repository-opaque",
          mode: "direct",
          base: { kind: "revision", revisionId: "revision-opaque" },
          head: { kind: "working_tree" },
          rawRevisionExpression: "HEAD^",
        })
        .expect(400);
      await current
        .withHost(
          request(current.app).get(
            `/api/workspaces/${workspaceId}/file-roots/root-from-another-workspace/diff/repositories`,
          ),
        )
        .expect(404);
      await current
        .withHost(request(current.app).get(`${prefix}/repositories`))
        .set("X-Test-Foreign-Principal", "yes")
        .expect(404);
    } finally {
      current.close();
    }
  });

  it("persists workspace diff reviews using only engine-validated identities", async () => {
    const current = await fixture();
    try {
      await execFile("git", ["init", "-q", current.workspacePath]);
      await execFile("git", [
        "-C",
        current.workspacePath,
        "config",
        "user.name",
        "Review Test",
      ]);
      await execFile("git", [
        "-C",
        current.workspacePath,
        "config",
        "user.email",
        "review@example.invalid",
      ]);
      await writeFile(path.join(current.workspacePath, "review.ts"), "one\n");
      await execFile("git", ["-C", current.workspacePath, "add", "review.ts"]);
      await execFile("git", [
        "-C",
        current.workspacePath,
        "commit",
        "-qm",
        "initial",
      ]);
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const prefix = `/api/workspaces/${workspaceId}/file-roots/primary/diff`;
      const repositories = await current
        .withHost(request(current.app).get(`${prefix}/repositories`))
        .expect(200);
      const repositoryId = repositories.body.repositories[0]
        .repositoryId as string;
      const refs = await current
        .withHost(
          request(current.app)
            .get(`${prefix}/refs`)
            .query({ repositoryId, pageSize: 100 }),
        )
        .expect(200);
      const revisionId = refs.body.revisions[0].revisionId as string;
      await writeFile(path.join(current.workspacePath, "review.ts"), "two\n");
      const comparisonResponse = await current
        .mutate(request(current.app).post(`${prefix}/comparisons`))
        .send({
          repositoryId,
          mode: "direct",
          base: { kind: "revision", revisionId },
          head: { kind: "working_tree" },
        })
        .expect(201);
      const comparison = comparisonResponse.body.comparison as {
        comparisonId: string;
        fingerprint: string;
      };
      const files = await current
        .withHost(
          request(current.app).get(`${prefix}/files`).query({
            comparisonId: comparison.comparisonId,
            fingerprint: comparison.fingerprint,
            pageSize: 25,
          }),
        )
        .expect(200);
      const fileId = files.body.files[0].fileId as string;
      const reviewResponse = await current
        .mutate(request(current.app).post(`${prefix}/reviews`))
        .send({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          title: "Current review",
          mutationId: randomUUID(),
        })
        .expect(201);
      expect(reviewResponse.body).not.toHaveProperty("tenantId");
      expect(reviewResponse.body).not.toHaveProperty("repositoryKey");
      const reviewId = reviewResponse.body.id as string;

      await current
        .withHost(
          request(current.app)
            .get(`${prefix}/review-history`)
            .query({ repositoryId }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.reviews).toMatchObject([{ id: reviewId }]);
        });
      await current
        .withHost(
          request(current.app).get(`${prefix}/reviews`).query({
            comparisonId: comparison.comparisonId,
            fingerprint: comparison.fingerprint,
          }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.reviews).toMatchObject([{ id: reviewId }]);
        });
      const commentResponse = await current
        .mutate(
          request(current.app).post(`${prefix}/reviews/${reviewId}/comments`),
        )
        .send({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          fileId,
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "Check this change",
          expectedReviewRevision: reviewResponse.body.revision,
          mutationId: randomUUID(),
        })
        .expect(201);
      expect(commentResponse.body.comment).toMatchObject({
        oldPath: "review.ts",
        newPath: "review.ts",
        selectedText: "two",
        body: "Check this change",
      });
      expect(commentResponse.body.comment).not.toHaveProperty("oldContentId");
      const reviewedResponse = await current
        .mutate(
          request(current.app).put(
            `${prefix}/reviews/${reviewId}/reviewed-files`,
          ),
        )
        .send({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          fileId,
          reviewed: true,
          expectedReviewRevision: commentResponse.body.review.revision,
          expectedFileRevision: null,
          mutationId: randomUUID(),
        })
        .expect(200);
      expect(reviewedResponse.body.file).toMatchObject({
        filePath: "review.ts",
        reviewed: true,
      });
      await current
        .withHost(
          request(current.app).get(
            `/api/workspace-diff-reviews/${reviewId}/reviewed-files`,
          ),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.files).toMatchObject([{ reviewed: true }]);
        });
      await current
        .withHost(
          request(current.app).get(
            `/api/workspace-diff-reviews/${reviewId}/comments`,
          ),
        )
        .set("X-Test-Foreign-Principal", "yes")
        .expect(404);
      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspaceId}/file-roots/root-from-another-workspace/diff/reviews/${reviewId}/comments`,
          ),
        )
        .send({
          comparisonId: comparison.comparisonId,
          fingerprint: comparison.fingerprint,
          fileId,
          side: "new",
          startLine: 1,
          endLine: 1,
          body: "Must not cross roots",
          expectedReviewRevision: reviewedResponse.body.review.revision,
          mutationId: randomUUID(),
        })
        .expect(404);
    } finally {
      current.close();
    }
  });

  it("lists and reads workspace files while denying wrong-scope and invalid paths", async () => {
    const current = await fixture();
    try {
      await writeFile(
        path.join(current.workspacePath, "hello.ts"),
        "export const hello = true;\n",
      );
      await writeFile(
        path.join(current.workspacePath, ".env"),
        "TOKEN=secret\n",
      );
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;

      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files`)
            .query({ rootId: "primary" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            rootId: "primary",
            entries: ["hello.ts"],
            scanTruncated: false,
          });
        });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "hello.ts" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            rootId: "primary",
            path: "hello.ts",
            contentKind: "text",
            content: "export const hello = true;\n",
            editable: true,
            revision: expect.any(String),
          });
        });
      const editable = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "hello.ts" }),
        )
        .expect(200);
      const saved = await current
        .mutate(
          request(current.app).put(
            `/api/workspaces/${workspaceId}/files/content`,
          ),
        )
        .send({
          rootId: "primary",
          path: "hello.ts",
          content: "export const hello = false;\n",
          expectedRevision: editable.body.revision,
        })
        .expect(200);
      expect(saved.body).toMatchObject({
        availability: "available",
        rootId: "primary",
        path: "hello.ts",
        sizeBytes: 28,
        revision: expect.any(String),
      });
      const pngSignature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const pngBytes = Buffer.concat([pngSignature, Buffer.from("http-image")]);
      await writeFile(
        path.join(current.workspacePath, "preview.PNG"),
        pngBytes,
      );
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "preview.PNG" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            rootId: "primary",
            path: "preview.PNG",
            contentKind: "image",
            previewState: "available",
            mediaType: "image/png",
            contentEncoding: "base64",
            content: pngBytes.toString("base64"),
            sizeBytes: pngBytes.byteLength,
            editable: false,
            revision: expect.any(String),
          });
          expect(body).not.toHaveProperty("truncation");
        });
      const oversizedPng = Buffer.alloc(
        WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
        0x61,
      );
      pngSignature.copy(oversizedPng);
      await writeFile(
        path.join(current.workspacePath, "oversized.png"),
        oversizedPng,
      );
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "oversized.png" }),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            contentKind: "image",
            previewState: "too_large",
            mediaType: "image/png",
            sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
            editable: false,
          });
          expect(body).not.toHaveProperty("content");
          expect(body).not.toHaveProperty("contentEncoding");
          expect(body).not.toHaveProperty("truncation");
        });
      for (const fixtureFile of [
        { path: "nul.bin", bytes: Buffer.from([0x61, 0x00, 0x62]) },
        { path: "invalid.bin", bytes: Buffer.from([0xc3, 0x28]) },
      ]) {
        const filename = path.join(current.workspacePath, fixtureFile.path);
        await writeFile(filename, fixtureFile.bytes);
        const binary = await current
          .withHost(
            request(current.app)
              .get(`/api/workspaces/${workspaceId}/files/content`)
              .query({ rootId: "primary", path: fixtureFile.path }),
          )
          .expect(200);
        expect(binary.body).toMatchObject({
          contentKind: "binary",
          editable: false,
          revision: expect.any(String),
        });
        await current
          .mutate(
            request(current.app).put(
              `/api/workspaces/${workspaceId}/files/content`,
            ),
          )
          .send({
            rootId: "primary",
            path: fixtureFile.path,
            content: "replacement text",
            expectedRevision: binary.body.revision,
          })
          .expect(404);
        await expect(readFile(filename)).resolves.toEqual(fixtureFile.bytes);
      }
      await current
        .mutate(
          request(current.app).put(
            `/api/workspaces/${workspaceId}/files/content`,
          ),
        )
        .send({
          rootId: "primary",
          path: "hello.ts",
          content: "stale\n",
          expectedRevision: editable.body.revision,
        })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toEqual({
            error: {
              code: "workspace_file_revision_conflict",
              message: "The workspace file changed before it could be saved.",
              retryable: false,
            },
          });
        });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: ".env" }),
        )
        .expect(404);
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "../outside" }),
        )
        .expect(400);
      await current
        .mutate(
          request(current.app)
            .put(`/api/workspaces/${workspaceId}/files/content`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          rootId: "primary",
          path: "hello.ts",
          content: "denied\n",
          expectedRevision: saved.body.revision,
        })
        .expect(404);
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files`)
            .query({ rootId: "primary" })
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(404);
    } finally {
      current.close();
    }
  });

  it("streams exact workspace-file downloads with revision and HTTP safety", async () => {
    const current = await fixture();
    try {
      const bytes = Buffer.alloc(WORKSPACE_FILE_MAX_CONTENT_BYTES + 1, 0x5a);
      bytes[0] = 0;
      await writeFile(path.join(current.workspacePath, "large.bin"), bytes);
      await writeFile(path.join(current.workspacePath, ".env"), "secret");
      const unusualName = 'odd\n"é.bin';
      await writeFile(path.join(current.workspacePath, unusualName), "safe");
      await symlink("large.bin", path.join(current.workspacePath, "link.bin"));
      await mkdir(path.join(current.workspacePath, "directory"));
      const oversizedPath = path.join(current.workspacePath, "oversized.bin");
      await writeFile(oversizedPath, "");
      await truncate(oversizedPath, WORKSPACE_FILE_MAX_DOWNLOAD_BYTES + 1);
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const content = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "large.bin" }),
        )
        .expect(200);
      const revision = content.body.revision as string;
      const query = {
        rootId: "primary",
        path: "large.bin",
        expectedRevision: revision,
      };
      await current
        .withHost(
          request(current.app)
            .head(`/api/workspaces/${workspaceId}/files/download`)
            .query(query),
        )
        .expect(200)
        .expect("Content-Type", "application/octet-stream")
        .expect("Content-Length", String(bytes.byteLength))
        .expect("Cache-Control", "private, no-store")
        .expect("X-Content-Type-Options", "nosniff")
        .expect("X-Sedes-Workspace-File-Revision", revision)
        .expect(
          "Content-Disposition",
          "attachment; filename=\"large.bin\"; filename*=UTF-8''large.bin",
        );
      const unusualContent = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: unusualName }),
        )
        .expect(200);
      const unusualHead = await current
        .withHost(
          request(current.app)
            .head(`/api/workspaces/${workspaceId}/files/download`)
            .query({
              rootId: "primary",
              path: unusualName,
              expectedRevision: unusualContent.body.revision,
            }),
        )
        .expect(200);
      expect(unusualHead.headers["content-disposition"]).toBe(
        "attachment; filename=\"odd__e_.bin\"; filename*=UTF-8''odd%0A%22%C3%A9.bin",
      );
      const downloaded = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/download`)
            .query(query)
            .buffer(true),
        )
        .expect(200);
      expect(Buffer.isBuffer(downloaded.body)).toBe(true);
      expect((downloaded.body as Buffer).byteLength).toBe(bytes.byteLength);
      expect(createHash("sha256").update(downloaded.body).digest("hex")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/download`)
            .query({ ...query, expectedRevision: "stale" }),
        )
        .expect(409)
        .expect(({ body }) => {
          expect(body.error.code).toBe("workspace_file_revision_conflict");
        });
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/download`)
            .set("Range", "bytes=0-1")
            .query(query),
        )
        .expect(416)
        .expect(({ body }) => {
          expect(body.error.code).toBe("range_not_supported");
        });
      for (const deniedPath of [".env", "link.bin", "directory"]) {
        await current
          .withHost(
            request(current.app)
              .get(`/api/workspaces/${workspaceId}/files/download`)
              .query({
                rootId: "primary",
                path: deniedPath,
                expectedRevision: revision,
              }),
          )
          .expect(404);
      }
      await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/download`)
            .set("X-Test-Foreign-Principal", "yes")
            .query(query),
        )
        .expect(404);
      const oversized = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "oversized.bin" }),
        )
        .expect(200);
      await current
        .withHost(
          request(current.app)
            .head(`/api/workspaces/${workspaceId}/files/download`)
            .query({
              rootId: "primary",
              path: "oversized.bin",
              expectedRevision: oversized.body.revision,
            }),
        )
        .expect(413);
    } finally {
      current.close();
    }
  });

  it("terminates an incomplete HTTP download when the opened source mutates after headers", async () => {
    let mutationOccurred = false;
    const current = await fixture({
      workspaceFileProvider: (delegate) =>
        new Proxy(delegate, {
          get(target, property, receiver) {
            if (property === "withDownload") {
              return async (
                scope: RequestScope,
                root: {
                  canonicalPath: string;
                },
                input: { path: string; expectedRevision: string },
                operation: Parameters<WorkspaceFileProvider["withDownload"]>[3],
                signal?: AbortSignal,
              ) =>
                delegate.withDownload(
                  scope,
                  root as never,
                  input,
                  async (source) =>
                    operation({
                      ...source,
                      stream: async (write, streamSignal = signal) =>
                        source.stream(async (chunk) => {
                          await write(chunk);
                          if (mutationOccurred) return;
                          mutationOccurred = true;
                          await writeFile(
                            path.join(root.canonicalPath, input.path),
                            Buffer.alloc(600 * 1_024, 0x62),
                          );
                        }, streamSignal),
                    }),
                  signal,
                );
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    try {
      await writeFile(
        path.join(current.workspacePath, "mutating.bin"),
        Buffer.alloc(600 * 1_024, 0x61),
      );
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const content = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "mutating.bin" }),
        )
        .expect(200);
      const outcome = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/download`)
            .query({
              rootId: "primary",
              path: "mutating.bin",
              expectedRevision: content.body.revision,
            }),
        )
        .then(
          () => ({ completed: true as const }),
          (error: unknown) => ({ completed: false as const, error }),
        );
      expect(mutationOccurred).toBe(true);
      expect(outcome.completed).toBe(false);
      if (outcome.completed) throw new Error("expected incomplete response");
      expect(outcome.error).toBeInstanceOf(Error);
    } finally {
      current.close();
    }
  });

  it("accepts a maximum-byte save whose control characters expand in JSON", async () => {
    const current = await fixture();
    try {
      const filename = path.join(current.workspacePath, "maximum.txt");
      await writeFile(filename, "initial");
      const opened = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const workspaceId = opened.body.id as string;
      const read = await current
        .withHost(
          request(current.app)
            .get(`/api/workspaces/${workspaceId}/files/content`)
            .query({ rootId: "primary", path: "maximum.txt" }),
        )
        .expect(200);
      const content = "\n".repeat(WORKSPACE_FILE_MAX_CONTENT_BYTES);
      await current
        .mutate(
          request(current.app).put(
            `/api/workspaces/${workspaceId}/files/content`,
          ),
        )
        .send({
          rootId: "primary",
          path: "maximum.txt",
          content,
          expectedRevision: read.body.revision,
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            availability: "available",
            sizeBytes: WORKSPACE_FILE_MAX_CONTENT_BYTES,
          });
        });
      await expect(readFile(filename, "utf8")).resolves.toBe(content);
    } finally {
      current.close();
    }
  });

  it("mounts the required agent-tool router behind CSRF and drain admission", async () => {
    const value = await fixture();
    const sourceCapability = "test_source_capability_0000000000000001";

    await request(value.app)
      .get("/api/agent-tool-csrf")
      .set("Host", "127.0.0.1:4783")
      .expect("Cache-Control", "no-store")
      .expect(200)
      .expect({ csrfToken: "normalized-csrf" });

    await request(value.app)
      .get("/api/agent-tools")
      .set("Host", "127.0.0.1:4783")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("not_found"));

    await request(value.app)
      .post("/api/agent-tool-invocations")
      .set("Host", "127.0.0.1:4783")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability)
      .send({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "request-1",
        input: {},
      })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe("csrf_token_invalid"));

    value.drain.beginDrain();
    await request(value.app)
      .get("/api/agent-tools")
      .set("Host", "127.0.0.1:4783")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability)
      .expect(503)
      .expect(({ body }) =>
        expect(body.error.code).toBe("application_draining"),
      );
  });

  it("preflights and archives a family through the normalized inventory route", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Archive family root",
        })
        .expect(201);
      created.body.id = created.body.threadId;

      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.id}/inventory/archive-impact`,
          ),
        )
        .expect(200)
        .expect({
          descendantCount: 0,
          pendingQuestions: { root: 0, descendants: 0 },
          stashedPrompts: { root: 0, descendants: 0 },
          openTasks: {
            root: { items: [], total: 0, omitted: 0 },
            descendants: { items: [], total: 0, omitted: 0 },
          },
          executionWorkspace: { kind: "direct" },
          archiveOnly: { available: true },
          archiveAll: { available: true },
        });
      await current
        .withHost(
          request(current.app)
            .get(`/api/threads/${created.body.id}/inventory/archive-impact`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(404);
      await current
        .mutate(
          request(current.app)
            .patch(`/api/threads/${created.body.id}/inventory`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          action: "archive_family",
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          executionWorkspaceDisposition: { kind: "keep" },
          mutationId: randomUUID(),
        })
        .expect(404);
      expect(
        current.repository.getInventory(current.owner, created.body.id)
          .inventoryState,
      ).toBe("active");
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "archive_family",
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          executionWorkspaceDisposition: { kind: "keep" },
          mutationId: randomUUID(),
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body.archivedThreadIds).toEqual([created.body.id]);
        });
      expect(
        current.repository.getInventory(current.owner, created.body.id),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });
    } finally {
      current.close();
    }
  });

  it("preflights and atomically settles an explicit visible stack", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const threadIds: string[] = [];
      for (const title of ["Bulk first", "Bulk second"]) {
        const created = await current
          .mutate(request(current.app).post("/api/threads"))
          .send({
            workspaceId: workspace.body.id,
            configuration: { kind: "custom", targetId: current.profile.id },
            executionWorkspace: { kind: "direct" },
            title,
          })
          .expect(201);
        threadIds.push(created.body.threadId);
      }

      const impact = await current
        .mutate(request(current.app).post("/api/thread-inventory/bulk-impact"))
        .send({ action: "settle", threadIds })
        .expect(200);
      expect(impact.body).toMatchObject({
        action: "settle",
        targets: threadIds.map((threadId) => ({
          threadId,
          expectedRevision: 0,
        })),
        targetCount: 2,
        affectedCount: 2,
        unchangedCount: 0,
        blockers: { items: [], total: 0, omitted: 0 },
        openTasks: { items: [], total: 0, omitted: 0 },
        stashedPromptCount: 0,
        pendingQuestionCount: 0,
        available: true,
      });

      await current
        .mutate(
          request(current.app)
            .post("/api/thread-inventory/bulk")
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          action: "settle",
          targets: impact.body.targets,
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
          mutationId: randomUUID(),
        })
        .expect(404);
      expect(
        threadIds.map(
          (threadId) =>
            current.repository.getInventory(current.owner, threadId)
              .inventoryState,
        ),
      ).toEqual(["active", "active"]);

      await current
        .mutate(request(current.app).post("/api/thread-inventory/bulk"))
        .send({
          action: "settle",
          targets: impact.body.targets,
          expectedStashedPromptCount: 0,
          expectedOpenTaskCount: 0,
          mutationId: randomUUID(),
        })
        .expect(200)
        .expect(({ body }) => expect(body.changedThreadIds).toEqual(threadIds));
      for (const threadId of threadIds) {
        expect(
          current.repository.getInventory(current.owner, threadId),
        ).toMatchObject({ inventoryState: "settled", inventoryRevision: 1 });
      }

      await current
        .mutate(request(current.app).post("/api/thread-inventory/bulk-impact"))
        .send({ action: "settle", threadIds })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            affectedCount: 0,
            unchangedCount: 2,
            available: false,
          });
        });
    } finally {
      current.close();
    }
  });

  it("pins an archived principal-owned thread through the normalized route", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Pin route target",
        })
        .expect(201);
      const threadId = created.body.threadId;
      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/pin`))
        .send({
          pinned: true,
          expectedRevision: 0,
          mutationId: randomUUID(),
          unexpected: true,
        })
        .expect(400);
      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/pin`))
        .send({ expectedRevision: 0, mutationId: randomUUID() })
        .expect(400);
      await current
        .mutate(
          request(current.app).patch(`/api/threads/${threadId}/inventory`),
        )
        .send({
          action: "archive",
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          executionWorkspaceDisposition: { kind: "keep" },
          mutationId: randomUUID(),
        })
        .expect(204);

      const mutationId = randomUUID();
      await current
        .mutate(
          request(current.app)
            .patch(`/api/threads/${threadId}/pin`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({ pinned: true, expectedRevision: 0, mutationId })
        .expect(404);
      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/pin`))
        .send({ pinned: true, expectedRevision: 0, mutationId })
        .expect(204);
      expect(
        current.repository.getInventory(current.owner, threadId),
      ).toMatchObject({
        inventoryState: "archived",
        inventoryRevision: 1,
        pinned: 1,
        pinRevision: 1,
      });
      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/pin`))
        .send({ pinned: true, expectedRevision: 0, mutationId })
        .expect(204);
      await current
        .mutate(request(current.app).patch(`/api/threads/${threadId}/pin`))
        .send({
          pinned: false,
          expectedRevision: 0,
          mutationId: randomUUID(),
        })
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("pin_revision_conflict"),
        );
    } finally {
      current.close();
    }
  });

  it("lists and explicitly sets principal-owned turn bookmarks", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Bookmark route target",
        })
        .expect(201);
      const threadId = created.body.threadId as string;
      const mutationId = randomUUID();
      const body = {
        bookmarked: true,
        expectedRevision: 0,
        mutationId,
        userPreview: "Can I return to this prompt?",
        assistantPreview: "Yes, the enclosing turn is durable.",
        responseState: "responded",
      };
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${threadId}/bookmarks/turn-durable-one`,
          ),
        )
        .send({ ...body, unexpected: true })
        .expect(400);
      const bookmark = await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${threadId}/bookmarks/turn-durable-one`,
          ),
        )
        .send(body)
        .expect(200);
      expect(bookmark.body).toMatchObject({
        revision: 1,
        replayed: false,
        bookmark: {
          turnId: "turn-durable-one",
          userPreview: body.userPreview,
          assistantPreview: body.assistantPreview,
          responseState: "responded",
        },
      });
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${threadId}/bookmarks/turn-durable-one`,
          ),
        )
        .send(body)
        .expect(200)
        .expect(({ body: replay }) => expect(replay.replayed).toBe(true));
      await current
        .withHost(
          request(current.app).get(`/api/threads/${threadId}/bookmarks`),
        )
        .expect(200)
        .expect(({ body: list }) => {
          expect(list.revision).toBe(1);
          expect(list.bookmarks).toEqual([bookmark.body.bookmark]);
        });
      await current
        .mutate(
          request(current.app)
            .patch(`/api/threads/${threadId}/bookmarks/turn-durable-one`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .send({
          bookmarked: false,
          expectedRevision: 1,
          mutationId: randomUUID(),
        })
        .expect(404);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${threadId}/bookmarks/turn-durable-one`,
          ),
        )
        .send({
          bookmarked: false,
          expectedRevision: 0,
          mutationId: randomUUID(),
        })
        .expect(409)
        .expect(({ body: conflict }) =>
          expect(conflict.error.code).toBe("bookmark_revision_conflict"),
        );
    } finally {
      current.close();
    }
  });

  it("previews and commits a scoped user-authoritative force reset", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Force reset target",
        })
        .expect(201);
      created.body.id = created.body.threadId;
      current.bindThread(created.body.id);
      current.database
        .prepare(
          `INSERT INTO mutation_receipts(
             tenant_id, principal_id, thread_id, mutation_id, operation_kind,
             request_fingerprint, result_code, result_json, replayable,
             created_at
           ) VALUES (?, ?, ?, ?, 'conversation_interrupt', ?, 'uncertain',
             ?, 0, ?)`,
        )
        .run(
          current.owner.tenantId,
          current.owner.principalId,
          created.body.id,
          randomUUID(),
          "0".repeat(64),
          JSON.stringify({
            version: 1,
            applicationOperationId: randomUUID(),
            expectedActiveTurnId: "turn-1",
          }),
          Date.now(),
        );

      const loadedHub = await current.loadBoundHub(created.body.id);
      loadedHub.publish({
        type: "run_state",
        generation: loadedHub.projectionGeneration!,
        state: "running",
        activeTurnId: "stale-turn",
      });
      expect(loadedHub.snapshot).toMatchObject({
        runState: "running",
        activeTurnId: "stale-turn",
      });

      const impact = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.id}/force-reset-impact`,
          ),
        )
        .expect(200);
      expect(impact.body).toMatchObject({
        resettable: true,
        blockers: [
          { kind: "conversation_operation", count: 1 },
          { kind: "conversation_runtime", count: 1 },
        ],
        affectedThreads: [{ threadId: created.body.id, title: expect.any(String), runtime: expect.any(Object) }],
      });
      expect(
        impact.body.warnings.map(({ code }: { code: string }) => code),
      ).toEqual(
        expect.arrayContaining([
          "provider_side_effects_may_remain",
          "provider_activity_may_reappear",
        ]),
      );
      await current
        .withHost(
          request(current.app)
            .get(`/api/threads/${created.body.id}/force-reset-impact`)
            .set("X-Test-Foreign-Principal", "yes"),
        )
        .expect(404);

      const mutationId = randomUUID();
      const reset = await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/force-reset`,
          ),
        )
        .send({
          expectedBlockerFingerprint: impact.body.blockerFingerprint,
          mutationId,
        })
        .expect(200);
      expect(reset.body).toMatchObject({
        blockerFingerprint: impact.body.blockerFingerprint,
        resetBlockers: [
          { kind: "conversation_operation", count: 1 },
          { kind: "conversation_runtime", count: 1 },
        ],
        affectedThreadIds: [created.body.id],
      });
      expect(loadedHub.snapshot).toMatchObject({
        runState: "idle",
      });
      expect(loadedHub.snapshot?.activeTurnId).toBeUndefined();
      expect(current.runtimeReplacementCaptures).toHaveBeenCalledOnce();
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/force-reset`,
          ),
        )
        .send({
          expectedBlockerFingerprint: impact.body.blockerFingerprint,
          mutationId,
        })
        .expect(200)
        .expect(reset.body);
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/force-reset`,
          ),
        )
        .send({
          expectedBlockerFingerprint: impact.body.blockerFingerprint,
          mutationId: randomUUID(),
        })
        .expect(409)
        .expect(({ body }) => expect(body.error.code).toBe("conflict"));

      const runtimeOnlyImpact = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.id}/force-reset-impact`,
          ),
        )
        .expect(200);
      expect(runtimeOnlyImpact.body).toMatchObject({
        resettable: true,
        blockers: [{ kind: "conversation_runtime", count: 1 }],
      });
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/force-reset`,
          ),
        )
        .send({
          expectedBlockerFingerprint: runtimeOnlyImpact.body.blockerFingerprint,
          mutationId: randomUUID(),
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.resetBlockers).toEqual([
            { kind: "conversation_runtime", count: 1 },
          ]),
        );
      expect(current.runtimeReplacementCaptures).toHaveBeenCalledTimes(2);

      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.id}/inventory/archive-impact`,
          ),
        )
        .expect(200)
        .expect(({ body }) =>
          expect(body.archiveOnly).toEqual({ available: true }),
        );
    } finally {
      current.close();
    }
  });

  it("identifies the running build in the health response", async () => {
    const current = await fixture();
    try {
      await current
        .withHost(request(current.app).get("/api/health"))
        .expect(200)
        .expect({ status: "ok", version: SEDES_VERSION });
    } finally {
      current.close();
    }
  });

  it("reports drain health and rejects new work consistently", async () => {
    const current = await fixture();
    try {
      current.drain.beginDrain();
      await current
        .withHost(request(current.app).get("/api/health"))
        .expect(503)
        .expect({ status: "draining", version: SEDES_VERSION });
      await current
        .withHost(request(current.app).get("/api/application/session"))
        .expect(503)
        .expect({
          error: {
            code: "application_draining",
            message: "The application is shutting down.",
            retryable: true,
          },
        });
    } finally {
      current.close();
    }
  });

  it.each([
    ["Android", CAPACITOR_ANDROID_ORIGIN],
    ["Electron", CAPACITOR_ELECTRON_ORIGIN],
  ])(
    "serves session, preflight, and SSE to the opted-in %s origin",
    async (_platform, origin) => {
      const current = await fixture({ packagedClientOrigins: [origin] });
      let server: Server | undefined;
      try {
        const session = await current
          .withHost(request(current.app).get("/api/application/session"))
          .set("Origin", origin)
          .set("Sec-Fetch-Site", "cross-site")
          .expect(200);
        expect(session.headers["access-control-allow-origin"]).toBe(origin);
        expect(session.headers.vary).toContain("Origin");
        expect(session.body.clientProtocolVersion).toBe(
          SEDES_CLIENT_PROTOCOL_VERSION,
        );
        expect(session.body.providerPulseEnabled).toBe(true);

        const preflight = await current
          .withHost(request(current.app).options("/api/threads"))
          .set("Origin", origin)
          .set("Sec-Fetch-Site", "cross-site")
          .set("Access-Control-Request-Method", "POST")
          .set("Access-Control-Request-Headers", "content-type, x-csrf-token")
          .expect(204);
        expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
        expect(
          preflight.headers["access-control-allow-credentials"],
        ).toBeUndefined();

        server = await new Promise<Server>((resolve) => {
          const listening = current.app.listen(0, "127.0.0.1", () =>
            resolve(listening),
          );
        });
        const event = await readFirstSseEvent(
          server,
          "/api/application/events",
          {
            Origin: origin,
            "Sec-Fetch-Site": "cross-site",
          },
        );
        expect(event.event).toBe("application");
        expect(event.corsOrigin).toBe(origin);
      } finally {
        if (server) {
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        }
        current.close();
      }
    },
  );

  it("exposes only normalized lineage identifiers and forwards fork, placement, and descendant requests", async () => {
    const current = await fixture();
    try {
      const sourceThreadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const sourceTurnId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const forkBody = {
        boundary: "selected_completed_turn" as const,
        sourceTurnId,
        expectedTurnRevision: 7,
        mutationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      };
      await current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send({
          ...forkBody,
          backendConversationId: "provider-identity-must-not-cross-http",
        })
        .expect(400);
      expect(current.forkCalls).toEqual([]);

      await current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send(forkBody)
        .expect(201)
        .expect({
          status: "created",
          childThreadId: "11111111-1111-4111-8111-111111111111",
        });
      expect(current.forkCalls).toEqual([
        {
          scope: current.owner,
          sourceThreadId,
          ...forkBody,
        },
      ]);

      const latestSnapshotBody = {
        boundary: "latest_provider_snapshot" as const,
        mutationId: "abababab-abab-4bab-8bab-abababababab",
      };
      await current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send(latestSnapshotBody)
        .expect(201)
        .expect({
          status: "created",
          childThreadId: "11111111-1111-4111-8111-111111111111",
        });
      expect(current.forkCalls.at(-1)).toEqual({
        scope: current.owner,
        sourceThreadId,
        ...latestSnapshotBody,
      });

      for (const invalidBody of [
        {
          ...latestSnapshotBody,
          sourceTurnId,
          expectedTurnRevision: 7,
        },
        {
          sourceTurnId,
          expectedTurnRevision: 7,
          mutationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        },
      ]) {
        await current
          .mutate(
            request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
          )
          .send(invalidBody)
          .expect(400);
      }
      expect(current.forkCalls).toHaveLength(2);

      await current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send({
          ...forkBody,
          mutationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        })
        .expect(202)
        .expect({
          status: "recovery_required",
          childThreadId: "11111111-1111-4111-8111-111111111111",
          retryable: false,
          uncertaintyKind: "fork_unknown",
          diagnostic: "Provider creation outcome is unknown.",
        });
      await current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send({
          ...forkBody,
          mutationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        })
        .expect(200)
        .expect({
          status: "aborted",
          childThreadId: "11111111-1111-4111-8111-111111111111",
          diagnostic: "Provider proved the fork was not created.",
          restartable: false,
        });

      const childThreadId = "11111111-1111-4111-8111-111111111111";
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${childThreadId}/lineage/placement`,
          ),
        )
        .send({
          mode: "top_level",
          expectedRevision: 2,
          mutationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        })
        .expect(200)
        .expect({
          childThreadId,
          mode: "top_level",
          revision: 3,
          updatedAt: new Date(2_000).toISOString(),
        });
      expect(current.placementCalls).toEqual([
        {
          scope: current.owner,
          childThreadId,
          mode: "top_level",
          expectedRevision: 2,
          mutationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
      ]);

      await current
        .withHost(
          request(current.app)
            .get(`/api/threads/${sourceThreadId}/descendants`)
            .query({ cursor: "opaque-cursor", pageSize: 2 }),
        )
        .expect(200)
        .expect({ descendants: [] });
      expect(current.descendantCalls).toEqual([
        {
          scope: current.owner,
          sourceThreadId,
          cursor: "opaque-cursor",
          pageSize: 2,
        },
      ]);
    } finally {
      current.close();
    }
  });

  it("owns a fork handler after its client socket is destroyed", async () => {
    let releaseFork!: () => void;
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    const current = await fixture({ forkManualGate: forkGate });
    let closed = false;
    try {
      const sourceThreadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const pendingRequest = current
        .mutate(
          request(current.app).post(`/api/threads/${sourceThreadId}/forks`),
        )
        .send({
          boundary: "selected_completed_turn",
          sourceTurnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          expectedTurnRevision: 7,
          mutationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        });
      const requestOutcome = pendingRequest.then(
        () => undefined,
        () => undefined,
      );
      await vi.waitFor(() => expect(current.forkCalls).toHaveLength(1));

      pendingRequest.abort();
      let requestDrainSettled = false;
      const shutdown = current.requestOperations.close().then(() => {
        requestDrainSettled = true;
        current.close();
        closed = true;
      });
      await Promise.resolve();
      expect(requestDrainSettled).toBe(false);

      releaseFork();
      await shutdown;
      await requestOutcome;
      expect(requestDrainSettled).toBe(true);
    } finally {
      releaseFork();
      if (!closed) current.close();
    }
  });

  it("rejects an unselectable target before creating a draft", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);

      await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: "foreign-target" },
          executionWorkspace: { kind: "direct" },
          title: "Unavailable target",
        })
        .expect(404)
        .expect({
          error: {
            code: "not_found",
            message: "The selected agent target is not available.",
            retryable: false,
          },
        });
      expect(
        current.repository.listThreadIdsForEnvironment(
          current.owner,
          current.environmentId,
        ),
      ).toEqual([]);
    } finally {
      current.close();
    }
  });

  it("rejects missing and overlong create titles without creating a draft", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      for (const body of [
        {
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
        },
        {
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "x".repeat(241),
        },
      ]) {
        await current
          .mutate(request(current.app).post("/api/threads"))
          .send(body)
          .expect(400);
      }
      expect(
        current.repository.listThreadIdsForEnvironment(
          current.owner,
          current.environmentId,
        ),
      ).toEqual([]);
    } finally {
      current.close();
    }
  });

  it("reports disabled Provider Pulse availability in the strict session", async () => {
    const current = await fixture({ providerPulseEnabled: false });
    try {
      const session = await current
        .withHost(request(current.app).get("/api/application/session"))
        .expect(200);

      expect(session.body.providerPulseEnabled).toBe(false);
    } finally {
      current.close();
    }
  });

  it("persists server drafts, stashes, and inventory after workspace discovery and reopen", async () => {
    const current = await fixture();
    try {
      const [initialSession, initialSnapshot] = await Promise.all([
        current
          .withHost(request(current.app).get("/api/application/session"))
          .expect(200),
        current
          .withHost(request(current.app).get("/api/application/snapshot"))
          .expect(200),
      ]);
      expect(initialSession.body).toMatchObject({
        clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
        version: SEDES_VERSION,
        csrfToken: "normalized-csrf",
        providerPulseEnabled: true,
      });
      expect(initialSnapshot.body).toMatchObject({
        workspaces: [],
        threads: [],
        counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
      });

      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      expect(current.discoveryCalls).toEqual([workspace.body.id]);

      await current
        .mutate(
          request(current.app).post(
            `/api/workspaces/${workspace.body.id}/open`,
          ),
        )
        .expect(200);
      expect(current.discoveryCalls).toEqual([
        workspace.body.id,
        workspace.body.id,
      ]);

      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "New thread",
        })
        .expect(201);
      created.body.id = created.body.threadId;
      expect(created.body.id).toEqual(expect.any(String));
      expect(
        current.repository.getThread(current.owner, created.body.id),
      ).toMatchObject({
        thread: {
          backingState: "unbound",
          title: "New thread",
        },
        draft: { text: "", revision: 0 },
        inventory: { inventoryState: "active", inventoryRevision: 0 },
      });

      const named = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "  Custom draft\nname  ",
        })
        .expect(201);
      named.body.id = named.body.threadId;
      expect(
        current.repository.getThread(current.owner, named.body.id),
      ).toMatchObject({
        thread: {
          backingState: "unbound",
          title: "Custom draft name",
        },
      });

      const secondWorkspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.secondWorkspacePath,
        })
        .expect(201);
      const moveMutationId = randomUUID();
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/operations`,
          ),
        )
        .send({
          kind: "move_draft",
          workspaceId: secondWorkspace.body.id,
          expectedThreadRevision: 0,
          mutationId: moveMutationId,
        })
        .expect(200)
        .expect({ status: "completed" });
      expect(
        current.repository.getThread(current.owner, created.body.id).thread,
      ).toMatchObject({
        backingState: "unbound",
        workspaceId: secondWorkspace.body.id,
        revision: 1,
      });
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${created.body.id}/operations`,
          ),
        )
        .send({
          kind: "move_draft",
          workspaceId: secondWorkspace.body.id,
          expectedThreadRevision: 0,
          mutationId: moveMutationId,
        })
        .expect(200);
      expect(
        current.repository.getThread(current.owner, created.body.id).thread
          .revision,
      ).toBe(1);

      await current
        .mutate(
          request(current.app).put(`/api/threads/${created.body.id}/draft`),
        )
        .send({
          text: "Queued idea",
          selectedSkillId: "opaque-skill-1",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: 0,
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            text: "Queued idea",
            selectedSkillId: "opaque-skill-1",
            revision: 1,
          });
        });
      await current
        .withHost(
          request(current.app).get(`/api/threads/${created.body.id}/skills`),
        )
        .expect(200)
        .expect({ skills: [] });
      const stashed = await current
        .mutate(
          request(current.app).post(`/api/threads/${created.body.id}/stashes`),
        )
        .send({
          expectedDraftRevision: 1,
          mutationId: randomUUID(),
        })
        .expect(201);
      expect(stashed.body).toMatchObject({
        draft: { text: "", revision: 2 },
        stashes: [{ text: "Queued idea", selectedSkillId: "opaque-skill-1" }],
      });
      current.threadSnapshotPublications.mockClear();

      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "settle",
          expectedRevision: 0,
          expectedStashedPromptCount: 1,
          mutationId: randomUUID(),
        })
        .expect(204);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "unsettle",
          expectedRevision: 1,
          mutationId: randomUUID(),
        })
        .expect(204);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "remind",
          wakeReminder: "  Review this now  ",
          expectedRevision: 2,
          mutationId: randomUUID(),
        })
        .expect(204);
      expect(
        current.repository.getThread(current.owner, created.body.id).inventory,
      ).toMatchObject({
        inventoryState: "active",
        snoozedAt: null,
        snoozedUntil: null,
        wakeReason: "manual",
        wakeAcknowledgedAt: null,
        wakeReminderText: "Review this now",
      });
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "snooze",
          snoozedUntil: "2099-07-30T12:00:00.000Z",
          wakeReminder: "Review the queued idea",
          expectedRevision: 3,
          mutationId: randomUUID(),
        })
        .expect(204);
      expect(
        current.repository.getThread(current.owner, created.body.id).inventory,
      ).toMatchObject({
        inventoryState: "snoozed",
        wakeReminderText: "Review the queued idea",
      });
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "wake",
          expectedRevision: 4,
          mutationId: randomUUID(),
        })
        .expect(204);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "archive",
          expectedRevision: 5,
          expectedStashedPromptCount: 1,
          executionWorkspaceDisposition: { kind: "keep" },
          mutationId: randomUUID(),
        })
        .expect(204);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "restore",
          expectedRevision: 6,
          mutationId: randomUUID(),
        })
        .expect(204);
      await current
        .mutate(
          request(current.app).patch(
            `/api/threads/${created.body.id}/inventory`,
          ),
        )
        .send({
          action: "settle",
          expectedRevision: 7,
          expectedStashedPromptCount: 1,
          mutationId: randomUUID(),
        })
        .expect(204);
      expect(current.threadSnapshotPublications).toHaveBeenCalledTimes(8);
      expect(
        current.repository.getThread(current.owner, created.body.id).inventory
          .inventoryState,
      ).toBe("settled");

      const restartedInventory = new InventoryService(current.repository, {
        publishMany() {},
        publishApplicationThread() {},
      });
      expect(
        restartedInventory.repository.getThread(current.owner, created.body.id),
      ).toMatchObject({
        draft: { text: "", revision: 2 },
        inventory: { inventoryState: "settled" },
      });
      expect(
        restartedInventory.repository.listStashes(
          current.owner,
          created.body.id,
        ),
      ).toMatchObject([{ text: "Queued idea" }]);
    } finally {
      current.close();
    }
  });

  it("does not disclose foreign threads and routes normalized operations, Stop, attention, and automations", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "New thread",
        })
        .expect(201);
      const threadId = created.body.threadId as string;

      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${threadId}?activityDetail=full`,
          ),
        )
        .set("X-Test-Foreign-Principal", "yes")
        .expect(404);
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/operations`),
        )
        .set("X-Test-Foreign-Principal", "yes")
        .send({ kind: "interrupt", operationId: "stop-foreign" })
        .expect(404);
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/history/seek`),
        )
        .set("X-Test-Foreign-Principal", "yes")
        .send({ turnId: "private-turn", activityDetail: "full" })
        .expect(404);
      await current
        .withHost(
          request(current.app).get(`/api/threads/${threadId}/automation`),
        )
        .set("X-Test-Foreign-Principal", "yes")
        .expect(404);
      expect(current.operationCalls).toHaveLength(0);
      expect(current.historySeekCalls).toHaveLength(0);

      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/operations`),
        )
        .send({
          kind: "deliver",
          mode: "submit",
          mutationId: randomUUID(),
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        })
        .expect(200)
        .expect({
          status: "delivery_accepted",
          operationId: "operation-accepted",
          resolvedDeliveryMode: "submit",
          threadRevision: 1,
          draft: {
            text: "",
            contextExcerpts: [],
            taskReferences: [],
            attachments: [],
            revision: 1,
            updatedAt: "2026-08-07T07:00:00.000Z",
          },
        });
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/operations`),
        )
        .send({
          kind: "deliver",
          mode: "submit",
          mutationId: "19191919-1919-4191-8191-191919191919",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        })
        .expect(200)
        .expect({
          status: "recovery_required",
          retryable: false,
          draft: {
            text: "Retained server draft",
            contextExcerpts: [],
            taskReferences: [],
            attachments: [],
            revision: 0,
            updatedAt: "2026-08-07T07:00:00.000Z",
          },
        });
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/operations`),
        )
        .send({
          kind: "deliver",
          mode: "steer",
          mutationId: "20202020-2020-4020-8020-202020202020",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
          steerTarget: { kind: "turn", turnId: "active-turn" },
        })
        .expect(200)
        .expect({
          status: "delivery_pending_materialization",
          operationId: "20202020-2020-4020-8020-202020202020",
          resolvedDeliveryMode: "steer",
          threadRevision: 1,
          draft: {
            text: "Retained pending steer",
            contextExcerpts: [],
            taskReferences: [],
            attachments: [],
            revision: 0,
            updatedAt: "2026-08-07T07:00:00.000Z",
          },
        });
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/operations`),
        )
        .send({ kind: "interrupt", operationId: "stop-operation" })
        .expect(200)
        .expect({ status: "aborted" });
      await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
        .send({ cursor: "history_application_cursor", activityDetail: "full" })
        .expect(400);
      await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
        .send({
          cursor: "history_application_cursor",
          limit: 11,
          activityDetail: "full",
        })
        .expect(400);
      expect(current.historyCalls).toHaveLength(0);
      await current
        .mutate(request(current.app).post(`/api/threads/${threadId}/history`))
        .send({
          cursor: "history_application_cursor",
          limit: 10,
          activityDetail: "full",
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            eventId: expect.any(String),
            event: { type: "history_prepend" },
          });
        });
      expect(current.historyCalls).toEqual([
        {
          threadId,
          cursor: "history_application_cursor",
          limit: 10,
        },
      ]);
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/history/seek`),
        )
        .send({
          turnId: "turn-outside-live-window",
          activityDetail: "full",
        })
        .expect(200)
        .expect({
          status: "not_found",
          targetTurnId: "turn-outside-live-window",
        });
      expect(current.historySeekCalls).toEqual([
        { threadId, turnId: "turn-outside-live-window" },
      ]);
      expect(
        current.operationCalls.map(({ operation }) => operation),
      ).toMatchObject([
        { kind: "deliver", mode: "submit" },
        { kind: "deliver", mode: "submit" },
        { kind: "deliver", mode: "steer" },
        { kind: "interrupt", operationId: "stop-operation" },
      ]);

      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${threadId}/attention/dismiss`,
          ),
        )
        .send({
          kind: "unseen_completion",
          operationId: "completed-turn",
          mutationId: randomUUID(),
        })
        .expect(204);
      expect(current.attentionCalls).toMatchObject([
        {
          threadId,
          request: {
            kind: "unseen_completion",
            operationId: "completed-turn",
          },
        },
      ]);

      current.threadSnapshotPublications.mockClear();
      const definition = await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/automation`),
        )
        .send({
          prompt: "Run scheduled checks",
          runMode: "same_thread",
          schedule: {
            kind: "date_time",
            runAt: "2099-07-30T12:00:00.000Z",
          },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        })
        .expect(201);
      expect(definition.body).toMatchObject({
        prompt: "Run scheduled checks",
        runMode: "same_thread",
        status: "paused",
      });
      await vi.waitFor(() =>
        expect(current.threadSnapshotPublications).toHaveBeenCalledWith(
          current.owner,
          threadId,
        ),
      );
      await current
        .withHost(
          request(current.app).get(`/api/threads/${threadId}/automation`),
        )
        .expect(200)
        .expect(({ body }) => {
          expect(body.id).toBe(definition.body.id);
        });
      await current
        .mutate(
          request(current.app).post(
            `/api/threads/${threadId}/automation/precheck/test`,
          ),
        )
        .send({
          prompt: "Run scheduled checks",
          precheck: {
            command: "printf ready",
            timeoutSeconds: 5,
            includeStdout: true,
          },
        })
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            decision: "invoke",
            exitCode: 0,
            stdoutPreview: "ready",
          });
        });
    } finally {
      current.close();
    }
  });

  it("rejects clone-mode automation when the thread capability allows only same-thread runs", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "New thread",
        })
        .expect(201);
      const threadId = created.body.threadId as string;
      current.disableCloneAutomation();

      const baseDefinition = {
        prompt: "Run scheduled checks",
        schedule: {
          kind: "date_time" as const,
          runAt: "2099-07-30T12:00:00.000Z",
        },
        misfirePolicy: "coalesce" as const,
        precheck: null,
      };
      await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/automation`),
        )
        .send({
          ...baseDefinition,
          runMode: "clone",
          mutationId: randomUUID(),
        })
        .expect(400)
        .expect({
          error: {
            code: "invalid_transition",
            message: "Clone-mode automation is not available for this thread.",
            retryable: false,
          },
        });

      const sameThread = await current
        .mutate(
          request(current.app).post(`/api/threads/${threadId}/automation`),
        )
        .send({
          ...baseDefinition,
          runMode: "same_thread",
          mutationId: randomUUID(),
        })
        .expect(201);
      await current
        .mutate(
          request(current.app).patch(`/api/threads/${threadId}/automation`),
        )
        .send({
          ...baseDefinition,
          runMode: "clone",
          expectedRevision: sameThread.body.revision,
          mutationId: randomUUID(),
        })
        .expect(400)
        .expect({
          error: {
            code: "invalid_transition",
            message: "Clone-mode automation is not available for this thread.",
            retryable: false,
          },
        });
    } finally {
      current.close();
    }
  });

  it("serves normalized application and thread handshake events", async () => {
    const current = await fixture();
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "New thread",
        })
        .expect(201);

      const applicationEvent = await readFirstSseEvent(
        server,
        "/api/application/events?handshake=authoritative_replacement",
      );
      expect(applicationEvent).toMatchObject({
        event: "application",
        data: {
          event: {
            type: "snapshot",
            snapshot: {
              threads: [{ id: created.body.threadId }],
            },
          },
        },
      });
      const workspaceFilesEvent = await readFirstSseEvent(
        server,
        `/api/workspaces/${workspace.body.id}/files/events`,
      );
      expect(workspaceFilesEvent).toMatchObject({
        event: "workspace-files-invalidated",
        data: {},
      });
      const threadEvent = await readFirstSseEvent(
        server,
        `/api/threads/${created.body.threadId}/events?activityDetail=full`,
      );
      expect(threadEvent).toMatchObject({
        event: "thread-checkpoint",
        data: {
          snapshot: {
            thread: { id: created.body.threadId },
            capabilities: {
              operations: [{ id: "interrupt", label: { text: "Stop" } }],
            },
          },
        },
      });
      await vi.waitFor(() => expect(current.quietHubs.size).toBe(0));
      const latest = current.repository.getThread(
        current.owner,
        created.body.threadId,
      );
      current.repository.renameThread(current.owner, created.body.threadId, {
        title: "Fresh after reconnect",
        expectedRevision: latest.thread.revision,
        mutationId: randomUUID(),
        now: Date.now(),
      });
      const reloaded = await readFirstSseEvent(
        server,
        `/api/threads/${created.body.threadId}/events?activityDetail=full`,
      );
      expect(reloaded).toMatchObject({
        event: "thread-checkpoint",
        data: {
          snapshot: { thread: { title: { text: "Fresh after reconnect" } } },
        },
      });
      await vi.waitFor(() => expect(current.quietHubs.size).toBe(0));
    } finally {
      await closeHttpTestServer(server);
      current.close();
    }
  });

  it("releases a quiet hub when initial stream snapshot composition fails", async () => {
    const current = await fixture({
      quietSnapshotError: new DomainError(
        "workspace_missing",
        "Workspace missing",
      ),
    });
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Snapshot failure",
        })
        .expect(201);
      const response = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full`,
          ),
        )
        .expect(200);
      expect(response.text).toContain("event: thread-load-error");
      await vi.waitFor(() => expect(current.quietHubs.size).toBe(0));
    } finally {
      current.close();
    }
  });

  it("resumes the scoped application stream from an explicit retained cursor", async () => {
    const current = await fixture();
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const initial = await readFirstSseEvent(
        server,
        "/api/application/events",
      );
      const baseline = initial.data as {
        readonly eventId: string;
        readonly applicationGeneration: string;
      };
      const ownerHub = current.applicationHubs.application(current.owner);
      await vi.waitFor(() => expect(ownerHub.subscriberCount).toBe(0));
      const update = ownerHub.publish({
        type: "inventory_counts_changed",
        generation: ownerHub.generation,
        counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
      });
      const watermarkBeforeSnapshotRead = ownerHub.watermark;
      await current
        .withHost(request(current.app).get("/api/application/snapshot"))
        .expect(200);
      expect(ownerHub.watermark).toBe(watermarkBeforeSnapshotRead);

      const resumed = await readFirstSseEvent(
        server,
        `/api/application/events?replayCursor=${encodeURIComponent(baseline.eventId)}`,
      );
      expect(resumed).toMatchObject({ event: "application", data: update });

      const watermarkBeforeCursorlessRead = ownerHub.watermark;
      const cursorless = await readFirstSseEvent(
        server,
        "/api/application/events",
      );
      expect(cursorless).toMatchObject({
        event: "application",
        data: {
          eventId: ownerHub.eventIdAt(watermarkBeforeCursorlessRead),
          event: { type: "snapshot", snapshot: { counts: { active: 1 } } },
        },
      });
      expect(ownerHub.watermark).toBe(watermarkBeforeCursorlessRead);

      for (let active = 2; active <= 500; active++) ownerHub.publish({
        type: "inventory_counts_changed", generation: ownerHub.generation,
        counts: { active, snoozed: 0, settled: 0, archived: 0 },
      });
      const longGap = await readFirstSseEvent(server, `/api/application/events?replayCursor=${encodeURIComponent(baseline.eventId)}`);
      expect(longGap).toMatchObject({ event: "application", data: {
        eventId: ownerHub.eventIdAt(ownerHub.watermark),
        event: { type: "snapshot", snapshot: { counts: { active: 500 } } },
      } });

      const watermarkBeforeReplacement = ownerHub.watermark;
      const replaced = await readFirstSseEvent(
        server,
        "/api/application/events?handshake=authoritative_replacement",
      );
      expect(replaced).toMatchObject({
        event: "application",
        data: {
          eventId: ownerHub.eventIdAt(watermarkBeforeReplacement + 1),
          event: { type: "snapshot" },
        },
      });
      expect(ownerHub.watermark).toBe(watermarkBeforeReplacement + 1);
    } finally {
      await closeHttpTestServer(server);
      current.close();
    }
  });

  it("rejects malformed application replay queries before opening SSE", async () => {
    const current = await fixture();
    try {
      const validCursor = "10000000-0000-4000-8000-000000000001.1";
      for (const query of [
        "replayCursor=not-an-event-id",
        `replayCursor=${"a".repeat(241)}`,
        `replayCursor=${validCursor}&replayCursor=${validCursor}`,
        "handshake=fresh",
        "handshake=authoritative_replacement&handshake=authoritative_replacement",
        `replayCursor=${validCursor}&handshake=authoritative_replacement`,
        `replayCursor=${validCursor}&unexpected=yes`,
      ]) {
        await current
          .withHost(
            request(current.app).get(`/api/application/events?${query}`),
          )
          .expect(400);
      }
      expect(current.applicationHubs.retainedHubCount).toBe(0);
    } finally {
      current.close();
    }
  });

  it("uses a current runtime checkpoint for initial SSE without provider recapture", async () => {
    const current = await fixture();
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "New thread",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      const events = await readThreadSseHandshake(
        server,
        `/api/threads/${created.body.threadId}/events?activityDetail=full&diagnostics=thread_load`,
      );

      expect(events[0]).toEqual({
        event: "thread-handshake-diagnostic",
        data: {
          format: "sedes-thread-handshake-server-v1",
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          routeSetupMilliseconds: expect.any(Number),
          runtimeAcquireMilliseconds: expect.any(Number),
          requestToHeadersMilliseconds: expect.any(Number),
        },
      });
      expect(events[1]).toMatchObject({
        event: "thread-checkpoint",
        data: {
          snapshot: { thread: { id: created.body.threadId } },
        },
      });
      expect(events[2]).toMatchObject({
        event: "thread-load-diagnostic",
        data: {
          format: "sedes-thread-load-server-v1",
          handshake: "current_checkpoint",
          turnCount: expect.any(Number),
          itemCount: expect.any(Number),
          snapshotFrameBytes: expect.any(Number),
        },
      });
      expect(events[3]).toEqual({ event: "thread-live", data: {} });

      const anchorEventId = (events[1]?.data as { readonly eventId?: string })
        .eventId;
      expect(anchorEventId).toEqual(expect.any(String));
      const hub = await current.loadBoundHub(created.body.threadId);
      const update = hub.publish({
        type: "run_state",
        generation: `projection-${created.body.threadId}`,
        state: "running",
      });
      const resumed = await readThreadSseHandshake(
        server,
        `/api/threads/${created.body.threadId}/events?activityDetail=full&diagnostics=thread_load&replayCursor=${encodeURIComponent(anchorEventId!)}`,
      );
      expect(resumed[0]).toMatchObject({
        event: "thread-handshake-diagnostic",
        data: { format: "sedes-thread-handshake-server-v1" },
      });
      expect(resumed.slice(1)).toEqual([
        {
          event: "thread",
          data: update,
        },
        {
          event: "thread-replay-diagnostic",
          data: {
            format: "sedes-thread-replay-server-v1",
            cursorSource: "explicit_query",
            outcome: "replayed",
            replayedEventCount: 1,
          },
        },
        { event: "thread-live", data: {} },
      ]);

      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full&diagnostics=unknown`,
          ),
        )
        .expect(200)
        .expect((response) => {
          expect(response.text).toContain("event: thread-load-error");
          expect(response.text).toContain('\"code\":\"bad_request\"');
        });
      expect(current.runtimeEstablishmentCaptures).toHaveBeenCalledOnce();
      expect(current.runtimeReplacementCaptures).not.toHaveBeenCalled();
    } finally {
      await closeHttpTestServer(server);
      current.close();
    }
  });

  it("logs correlated bounded thread runtime acquisition diagnostics when enabled", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const current = await fixture();
    const server = current.app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Thread load diagnostic success",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      await readFirstSseEvent(
        server,
        `/api/threads/${created.body.threadId}/events?activityDetail=full`,
      );

      const records = consoleError.mock.calls.map(([record]) => String(record));
      const loadRecords = records.filter((record) =>
        record.startsWith("[delivery-thread-load] "),
      );
      expect(loadRecords).toHaveLength(2);
      expect(loadRecords[0]).toMatch(
        new RegExp(
          `^\\[delivery-thread-load\\] request=[0-9a-f-]+ thread=${created.body.threadId} phase=runtime_acquire_start route_ms=\\d+(?:\\.\\d+)?$`,
        ),
      );
      expect(loadRecords[1]).toMatch(
        new RegExp(
          `^\\[delivery-thread-load\\] request=[0-9a-f-]+ thread=${created.body.threadId} phase=runtime_acquire_complete ok=1 ms=\\d+(?:\\.\\d+)?$`,
        ),
      );
      expect(loadRecords[1]!.split(" request=")[1]!.split(" ")[0]).toBe(
        loadRecords[0]!.split(" request=")[1]!.split(" ")[0],
      );
      const streamRecords = records.filter((record) =>
        record.startsWith("[delivery-stream] "),
      );
      expect(streamRecords).toHaveLength(1);
      expect(streamRecords[0]).toMatch(
        new RegExp(
          `^\\[delivery-stream\\] thread=${created.body.threadId} open handshake=current_checkpoint ms=\\d+ snapshotBytes=\\d+$`,
        ),
      );
      await vi.waitFor(() => {
        const closeRecord = consoleError.mock.calls
          .map(([record]) => String(record))
          .find((record) =>
            record.startsWith(
              `[delivery-stream] thread=${created.body.threadId} close `,
            ),
          );
        expect(closeRecord).toMatch(
          new RegExp(
            `^\\[delivery-stream\\] thread=${created.body.threadId} close reason=client_closed live=1 pendingEvents=\\d+ pendingBytes=\\d+$`,
          ),
        );
      });
    } finally {
      await closeHttpTestServer(server);
      current.close();
      consoleError.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("returns a classified SSE error when a bound workspace is missing", async () => {
    const current = await fixture({
      runtimeAcquireError: new DomainError(
        "workspace_missing",
        "The workspace directory was moved or removed.",
      ),
    });
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Moved workspace",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      const response = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full`,
          ),
        )
        .expect(200)
        .expect("Content-Type", /text\/event-stream/);

      expect(response.text).toContain("event: thread-load-error");
      expect(response.text).toContain(
        JSON.stringify({
          format: "sedes-thread-load-error-v1",
          requestId: response.headers["x-request-id"],
          error: {
            code: "workspace_missing",
            message: "The workspace directory was moved or removed.",
            retryable: false,
          },
        }),
      );
      expect(response.text).not.toContain("thread-live");
    } finally {
      current.close();
    }
  });

  it("preserves retryability in a transient runtime load error", async () => {
    const current = await fixture({
      runtimeAcquireError: new BackendError({
        category: "overloaded",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage: "The backend is temporarily overloaded.",
        backendCode: "private_overload_code",
      }),
    });
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Transient runtime failure",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      const response = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full`,
          ),
        )
        .expect(200);
      expect(response.text).toContain(
        JSON.stringify({
          format: "sedes-thread-load-error-v1",
          requestId: response.headers["x-request-id"],
          error: {
            code: "backend_overloaded",
            message: "The backend is temporarily overloaded.",
            retryable: true,
          },
        }),
      );
      expect(response.text).not.toContain("private_overload_code");
      expect(response.text).not.toContain("thread-live");
    } finally {
      current.close();
    }
  });

  it("logs safe correlated runtime acquisition failures without exception content", async () => {
    const activitySecret = "provider prompt and /private/provider/path";
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const primaryError = new BackendError({
      category: "unavailable",
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage: "This thread is too large to display safely.",
      backendCode: "history_too_large",
    });
    const current = await fixture({
      runtimeAcquireError: new AggregateError(
        [primaryError, new Error(activitySecret)],
        "Runtime acquisition and cleanup failed.",
        { cause: primaryError },
      ),
    });
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Thread load diagnostic failure",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      const response = await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full`,
          ),
        )
        .expect(200)
        .expect("Content-Type", /text\/event-stream/);

      const event = /^event: (.+)$/m.exec(response.text)?.[1];
      const data = JSON.parse(
        /^data: (.+)$/m.exec(response.text)?.[1] ?? "null",
      ) as unknown;
      expect(event).toBe("thread-load-error");
      expect(data).toEqual({
        format: "sedes-thread-load-error-v1",
        requestId: response.headers["x-request-id"],
        error: {
          code: "backend_unavailable",
          message: "This thread is too large to display safely.",
          retryable: false,
        },
      });
      expect(response.text).not.toContain("thread-live");
      expect(response.text).not.toContain(activitySecret);

      const records = consoleError.mock.calls.map(([record]) => String(record));
      expect(records).toHaveLength(2);
      expect(records[0]).toContain(
        `request=${response.headers["x-request-id"]} thread=${created.body.threadId} phase=runtime_acquire_start`,
      );
      expect(records[1]).toContain(
        `request=${response.headers["x-request-id"]} thread=${created.body.threadId} phase=runtime_acquire_complete ok=0`,
      );
      expect(records[1]).toContain(
        "AggregateError[count=2,errors=BackendError[category=unavailable,code=history_too_large,retryable=0]|Error[code=unavailable]]",
      );
      expect(records.join("\n")).not.toContain(activitySecret);
      expect(records.join("\n")).not.toContain("/private/provider/path");
    } finally {
      current.close();
      consoleError.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps thread runtime acquisition diagnostics silent when disabled", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const current = await fixture({
      runtimeAcquireError: new Error("thread_runtime_failure_secret"),
    });
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Thread load diagnostics disabled",
        })
        .expect(201);
      current.bindThread(created.body.threadId);

      await current
        .withHost(
          request(current.app).get(
            `/api/threads/${created.body.threadId}/events?activityDetail=full`,
          ),
        )
        .expect(200)
        .expect((response) => {
          expect(response.text).toContain("event: thread-load-error");
          expect(response.text).toContain('\"code\":\"internal_error\"');
          expect(response.text).not.toContain("thread_runtime_failure_secret");
        });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      current.close();
      consoleError.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("serves the bounded tool-client management contract with no-store responses", async () => {
    const clientId = "11111111-1111-4111-8111-111111111111";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
    const client: ToolClient = {
      id: clientId,
      creationRequestId: requestId,
      name: "External CLI",
      state: "enabled",
      availability: "available",
      toolIds: ["thread.status"],
      tools: [{ id: "thread.status", available: true }],
      defaultEnvironmentId: environmentId,
      allowedEnvironmentIds: [environmentId],
      environments: [{ id: environmentId, available: true }],
      defaultWorkspaceId: null,
      defaultWorkspaceAvailable: null,
      defaultThreadId: null,
      defaultThreadAvailable: null,
      policyRevision: 1,
      credentialGeneration: 1,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
    const credential = `hatc1_${clientId}_1_${"A".repeat(43)}`;
    const agentTools = unavailableAgentToolRouterDependencies();
    const options = vi.fn(() => ({
      environments: [
        {
          id: environmentId,
          label: "Local",
          kind: "local" as const,
          available: true,
        },
      ],
      groups: [
        {
          id: "threads",
          label: "Threads",
          description: "Thread tools",
          order: 10,
          tools: [
            {
              id: "thread.status",
              label: "Thread status",
              description: "Reads current thread status.",
              order: 10,
              effects: {
                application: "read" as const,
                modelUsage: "none" as const,
                external: "none" as const,
              },
              available: true,
            },
          ],
        },
      ],
    }));
    const list = vi.fn(() => ({ items: [client] }));
    const get = vi.fn(() => client);
    const createForManagement = vi
      .fn()
      .mockReturnValueOnce({ client, credential })
      .mockImplementationOnce(() => {
        throw new ToolClientCreationConflictError(client);
      });
    const replaceForManagement = vi.fn(() => ({
      ...client,
      state: "disabled" as const,
      policyRevision: 2,
    }));
    const rotateForManagement = vi.fn(() => ({
      client: { ...client, policyRevision: 2, credentialGeneration: 2 },
      credential: `hatc1_${clientId}_2_${"B".repeat(43)}`,
    }));
    const revokeForManagement = vi.fn(() => ({
      ...client,
      state: "revoked" as const,
      availability: "available" as const,
      toolIds: [],
      tools: [],
      defaultEnvironmentId: null,
      allowedEnvironmentIds: [],
      environments: [],
      policyRevision: 2,
      revokedAt: "2026-08-15T12:01:00.000Z",
    }));
    Object.assign(agentTools.clients, {
      options,
      list,
      get,
      createForManagement,
      replaceForManagement,
      rotateForManagement,
      revokeForManagement,
    });
    const current = await fixture({ agentTools });
    const noStore = (response: request.Response) => {
      expect(response.headers["cache-control"]).toBe("no-store");
    };
    try {
      await current
        .withHost(request(current.app).get("/api/tool-clients/options"))
        .expect(200)
        .expect(noStore);
      await current
        .withHost(
          request(current.app).get(
            `/api/tool-clients?creationRequestId=${requestId}`,
          ),
        )
        .expect(200)
        .expect(noStore);
      expect(list).toHaveBeenCalledWith(current.owner, {
        creationRequestId: requestId,
        pageSize: 50,
      });
      await current
        .withHost(request(current.app).get(`/api/tool-clients/${clientId}`))
        .expect(200)
        .expect(noStore)
        .expect(({ body }) => expect(body).toEqual(client));
      expect(get).toHaveBeenCalledWith(current.owner, clientId);
      await current
        .withHost(
          request(current.app).get(
            `/api/tool-clients?creationRequestId=${requestId}&cursor=cursor`,
          ),
        )
        .expect(400)
        .expect(noStore);
      await current
        .withHost(request(current.app).get("/api/tool-clients/not-a-client"))
        .expect(400)
        .expect(noStore);
      const createBody = {
        requestId,
        name: "External CLI",
        toolIds: ["thread.status"],
        defaultEnvironmentId: environmentId,
        allowedEnvironmentIds: [environmentId],
      };
      await current
        .mutate(request(current.app).post("/api/tool-clients"))
        .send(createBody)
        .expect(201)
        .expect(noStore)
        .expect(({ body }) => expect(body).toEqual({ client, credential }));
      await current
        .mutate(request(current.app).post("/api/tool-clients"))
        .send(createBody)
        .expect(409)
        .expect(noStore)
        .expect(({ body }) => expect(body.client).toEqual(client));
      await current
        .mutate(request(current.app).put(`/api/tool-clients/${clientId}`))
        .send({
          name: "External CLI",
          toolIds: ["thread.status"],
          defaultEnvironmentId: environmentId,
          allowedEnvironmentIds: [environmentId],
          enabled: false,
          expectedRevision: 1,
        })
        .expect(200)
        .expect(noStore)
        .expect(({ body }) => expect(body.state).toBe("disabled"));
      await current
        .mutate(
          request(current.app).post(`/api/tool-clients/${clientId}/rotate`),
        )
        .send({ expectedRevision: 1 })
        .expect(200)
        .expect(noStore)
        .expect(({ body }) => expect(body.client.credentialGeneration).toBe(2));
      await current
        .mutate(
          request(current.app).post(`/api/tool-clients/${clientId}/revoke`),
        )
        .send({ expectedRevision: 1 })
        .expect(200)
        .expect(noStore)
        .expect(({ body }) => expect(body.state).toBe("revoked"));
      await current
        .withHost(request(current.app).post("/api/tool-clients"))
        .send(createBody)
        .expect(403)
        .expect(noStore);
      expect(options).toHaveBeenCalledWith(current.owner);
    } finally {
      current.close();
    }
  });

  it("rejects malformed thread replay queries before acquiring a bound runtime", async () => {
    const current = await fixture();
    try {
      const workspace = await current
        .mutate(request(current.app).post("/api/workspaces/open"))
        .send({
          environmentId: current.environmentId,
          path: current.workspacePath,
        })
        .expect(201);
      const created = await current
        .mutate(request(current.app).post("/api/threads"))
        .send({
          workspaceId: workspace.body.id,
          configuration: { kind: "custom", targetId: current.profile.id },
          executionWorkspace: { kind: "direct" },
          title: "Replay validation",
        })
        .expect(201);
      current.bindThread(created.body.threadId);
      const validCursor = "10000000-0000-4000-8000-000000000001.1";

      for (const query of [
        "activityDetail=full&replayCursor=not-an-event-id",
        `activityDetail=full&replayCursor=${"a".repeat(241)}`,
        `activityDetail=full&replayCursor=${validCursor}&replayCursor=${validCursor}`,
        `activityDetail=full&replayCursor=${validCursor}&unexpected=yes`,
        "activityDetail=full&diagnostics=unknown",
      ]) {
        await current
          .withHost(
            request(current.app).get(
              `/api/threads/${created.body.threadId}/events?${query}`,
            ),
          )
          .expect(200)
          .expect((response) => {
            expect(response.text).toContain("event: thread-load-error");
            expect(response.text).toContain('\"code\":\"bad_request\"');
          });
      }

      expect(current.runtimeEstablishmentCaptures).not.toHaveBeenCalled();
      expect(current.runtimeReplacementCaptures).not.toHaveBeenCalled();
    } finally {
      current.close();
    }
  });
});
