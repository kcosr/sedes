import { z } from "zod";
import {
  backendBrandSchema,
  executionWorkspaceNetworkProfileSchema,
  executionWorkspaceSelectionSchema,
  normalizedEnvironmentSummarySchema,
  normalizedThreadSummarySchema,
  normalizedWorkspaceSummarySchema,
} from "./conversation.js";
import {
  boundedDisplayTextSchema,
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  requireSerializedByteLimit,
} from "./payload.js";
import { associatedTaskSchema } from "./tasks.js";
import {
  normalizedThreadGroupSchema,
  threadGroupIdSchema,
} from "./thread-groups.js";
import { workspaceFileLinkedWorktreeRootIdSchema } from "./workspace-files.js";

const applicationGenerationSchema = z.string().min(1).max(160);
const applicationEntityIdSchema = z.string().min(1).max(160);
const safeInventoryCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const normalizedExecutionTargetDescriptorShape = {
  id: applicationEntityIdSchema,
  environmentId: applicationEntityIdSchema,
  label: boundedDisplayTextSchema,
  backend: z.strictObject({
    label: boundedDisplayTextSchema,
    brand: backendBrandSchema,
  }),
  workspaceExecution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("direct_only") }),
    z
      .strictObject({
        kind: z.literal("selectable"),
        default: executionWorkspaceSelectionSchema,
        isolatedNetworkProfiles: z
          .array(executionWorkspaceNetworkProfileSchema)
          .min(1)
          .max(2),
      })
      .superRefine((value, context) => {
        if (
          new Set(value.isolatedNetworkProfiles).size !==
          value.isolatedNetworkProfiles.length
        ) {
          context.addIssue({
            code: "custom",
            message: "Workspace network profiles must be unique.",
            path: ["isolatedNetworkProfiles"],
          });
        }
        if (
          value.default.kind === "isolated" &&
          !value.isolatedNetworkProfiles.includes(value.default.networkProfile)
        ) {
          context.addIssue({
            code: "custom",
            message: "The default workspace network profile must be supported.",
            path: ["default", "networkProfile"],
          });
        }
      }),
  ]),
} as const;
export const normalizedExecutionTargetDescriptorSchema = z.discriminatedUnion(
  "available",
  [
    z.strictObject({
      ...normalizedExecutionTargetDescriptorShape,
      available: z.literal(true),
    }),
    z.strictObject({
      ...normalizedExecutionTargetDescriptorShape,
      available: z.literal(false),
      unavailableReason: boundedDisplayTextSchema,
    }),
  ],
);
export type NormalizedExecutionTargetDescriptor = z.infer<
  typeof normalizedExecutionTargetDescriptorSchema
>;

const installationAdvisoryIdSchema = z
  .string()
  .regex(
    /^(?:backend_instance\/[A-Za-z0-9_.!~*'()%-]+|application)\/[a-z][a-z0-9_.-]{0,79}$/u,
  )
  .max(768);

export const MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES = 256;
export const MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES = 32;
export const MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES = 32;
export const MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES = Math.floor(
  (MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES -
    MAXIMUM_APPLICATION_INSTALLATION_ADVISORIES) /
    MAXIMUM_INSTALLATION_ADVISORY_BACKEND_SOURCES,
);

/**
 * One currently active, installation-owned condition that deserves operator
 * attention without changing backend availability or conversation state.
 * Provider-native release identifiers and assessment details are projected to
 * bounded display text before crossing the browser boundary.
 */
export const normalizedInstallationAdvisorySchema = z
  .strictObject({
    id: installationAdvisoryIdSchema,
    tone: z.enum(["info", "warning", "error"]),
    title: boundedDisplayTextSchema,
    message: boundedDisplayTextSchema,
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("application") }),
      z.strictObject({
        kind: z.literal("backend_instance"),
        backendInstanceId: applicationEntityIdSchema,
        label: boundedDisplayTextSchema,
        environment: z
          .strictObject({
            id: applicationEntityIdSchema,
            label: boundedDisplayTextSchema,
          })
          .optional(),
        backend: backendBrandSchema,
      }),
    ]),
  })
  .superRefine((advisory, context) => {
    const expectedPrefix =
      advisory.source.kind === "application"
        ? "application/"
        : `backend_instance/${encodeURIComponent(
            advisory.source.backendInstanceId,
          )}/`;
    if (!advisory.id.startsWith(expectedPrefix)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Advisory identifier and source scope must match.",
      });
    }
  });
export type NormalizedInstallationAdvisory = z.infer<
  typeof normalizedInstallationAdvisorySchema
>;

export const normalizedInventoryCountsSchema = z.strictObject({
  active: safeInventoryCountSchema,
  snoozed: safeInventoryCountSchema,
  settled: safeInventoryCountSchema,
  archived: safeInventoryCountSchema,
});
export type NormalizedInventoryCounts = z.infer<
  typeof normalizedInventoryCountsSchema
>;

/**
 * The application stream only needs enough attention state to render durable
 * sidebar badges. Full reminder text, diagnostics, and operation identifiers
 * remain on the authorized thread snapshot.
 */
export const normalizedSidebarAttentionSchema = z.strictObject({
  wake: z.boolean(),
  automationContext: z.enum(["triggered", "failed"]).nullable(),
  unseenCompletion: z.boolean(),
  queueFailure: z.boolean(),
});
export type NormalizedSidebarAttention = z.infer<
  typeof normalizedSidebarAttentionSchema
>;

export const normalizedApplicationThreadSummarySchema = z.strictObject({
  ...normalizedThreadSummarySchema.shape,
  /** Opaque copy-only ID from the durable binding; absent before binding. */
  backendSessionId: z.string().min(1).max(128).optional(),
  terminalSummary: z.strictObject({
    runningCount: safeInventoryCountSchema,
    retainedCount: safeInventoryCountSchema,
  }),
  pinned: z.boolean(),
  pinRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  preferredWorktreeRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  preferredWorktree: z
    .strictObject({
      rootId: workspaceFileLinkedWorktreeRootIdSchema,
      displayLabel: z.string().min(1).max(240),
      branch: z.string().min(1).max(1_024).nullable(),
      availability: z.enum(["available", "unavailable"]),
    })
    .nullable(),
  bookmarkRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  turnBookmarkCount: safeInventoryCountSchema,
  groupId: threadGroupIdSchema.nullable(),
  groupAssignmentRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  stashedPromptCount: safeInventoryCountSchema,
  pendingQuestionCount: safeInventoryCountSchema,
  attention: normalizedSidebarAttentionSchema,
});
export type NormalizedApplicationThreadSummary = z.infer<
  typeof normalizedApplicationThreadSummarySchema
>;

export const normalizedThreadForkOriginSchema = z
  .strictObject({
    childThreadId: applicationEntityIdSchema,
    sourceThreadId: applicationEntityIdSchema.nullable(),
    sourceTurnId: applicationEntityIdSchema.nullable(),
    sourceTurnCompletedAt: z.iso.datetime().nullable(),
    boundaryKind: z.enum([
      "completed_turn_inclusive",
      "provider_snapshot_at_acceptance",
    ]),
    originKind: z.enum([
      "user_fork",
      "automation_fork",
      "agent_fork",
      "principal_client_fork",
      "imported_native_fork",
    ]),
    initiatingAgentThreadId: applicationEntityIdSchema.nullable(),
    initiatingToolClientId: z.uuid().nullable(),
    branchMethod: z.enum(["provider_native", "provider_history_import"]),
    createdAt: z.iso.datetime(),
  })
  .superRefine((origin, context) => {
    const hasAgentThread = origin.initiatingAgentThreadId !== null;
    const hasToolClient = origin.initiatingToolClientId !== null;
    if (
      (origin.originKind === "agent_fork" &&
        (!hasAgentThread || hasToolClient)) ||
      (origin.originKind === "principal_client_fork" &&
        (!hasToolClient || hasAgentThread)) ||
      ((origin.originKind === "user_fork" ||
        origin.originKind === "automation_fork" ||
        origin.originKind === "imported_native_fork") &&
        (hasAgentThread || hasToolClient))
    ) {
      context.addIssue({
        code: "custom",
        path: ["originKind"],
        message: "Fork origin and initiating caller must match.",
      });
    }
    if (
      origin.sourceTurnCompletedAt !== null &&
      (origin.sourceThreadId === null || origin.sourceTurnId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceTurnCompletedAt"],
        message: "Fork-point time requires a resolved source turn.",
      });
    }
    if (
      origin.boundaryKind === "provider_snapshot_at_acceptance" &&
      (origin.sourceThreadId === null ||
        origin.sourceTurnId !== null ||
        origin.sourceTurnCompletedAt !== null ||
        origin.originKind !== "user_fork")
    ) {
      context.addIssue({
        code: "custom",
        path: ["boundaryKind"],
        message:
          "A provider snapshot user fork requires a resolved source thread and no exact source turn.",
      });
    }
  });
export type NormalizedThreadForkOrigin = z.infer<
  typeof normalizedThreadForkOriginSchema
>;

export const normalizedThreadLineagePlacementSchema = z.strictObject({
  childThreadId: applicationEntityIdSchema,
  mode: z.enum(["nested_under_source", "top_level"]),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type NormalizedThreadLineagePlacement = z.infer<
  typeof normalizedThreadLineagePlacementSchema
>;

export const normalizedThreadLineageFamilySchema = z.strictObject({
  sourceThreadId: applicationEntityIdSchema,
  descendantCount: safeInventoryCountSchema.refine((count) => count > 0, {
    message: "A lineage family summary requires at least one descendant.",
  }),
});
export type NormalizedThreadLineageFamily = z.infer<
  typeof normalizedThreadLineageFamilySchema
>;

export const normalizedThreadDescendantSchema = z.strictObject({
  thread: normalizedApplicationThreadSummarySchema,
  origin: normalizedThreadForkOriginSchema,
  placement: normalizedThreadLineagePlacementSchema,
});
export type NormalizedThreadDescendant = z.infer<
  typeof normalizedThreadDescendantSchema
>;

export const normalizedThreadDescendantsPageSchema = z
  .strictObject({
    descendants: z.array(normalizedThreadDescendantSchema).max(100),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .superRefine((page, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < page.descendants.length; index += 1) {
      const descendant = page.descendants[index]!;
      const childThreadId = descendant.thread.id;
      if (
        descendant.origin.childThreadId !== childThreadId ||
        descendant.placement.childThreadId !== childThreadId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Descendant thread, origin, and placement identifiers must match.",
          path: ["descendants", index],
        });
      }
      if (seen.has(childThreadId)) {
        context.addIssue({
          code: "custom",
          message:
            "Descendant thread identifiers must be unique within a page.",
          path: ["descendants", index, "thread", "id"],
        });
      }
      seen.add(childThreadId);
    }
  });
export type NormalizedThreadDescendantsPage = z.infer<
  typeof normalizedThreadDescendantsPageSchema
>;

function requireUniqueIds(
  values: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const id = values[index]!.id;
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${path} identifier.`,
        path: [path, index, "id"],
      });
    }
    seen.add(id);
  }
}

export const normalizedApplicationSnapshotSchema = z
  .strictObject({
    environments: z.array(normalizedEnvironmentSummarySchema).max(256),
    workspaces: z.array(normalizedWorkspaceSummarySchema).max(10_000),
    threads: z.array(normalizedApplicationThreadSummarySchema).max(10_000),
    groups: z.array(normalizedThreadGroupSchema).max(10_000),
    forkOrigins: z.array(normalizedThreadForkOriginSchema).max(10_000),
    lineagePlacements: z
      .array(normalizedThreadLineagePlacementSchema)
      .max(10_000),
    lineageFamilies: z.array(normalizedThreadLineageFamilySchema).max(10_000),
    executionTargets: z
      .array(normalizedExecutionTargetDescriptorSchema)
      .max(256),
    advisories: z
      .array(normalizedInstallationAdvisorySchema)
      .max(MAXIMUM_ACTIVE_INSTALLATION_ADVISORIES),
    defaultNewThreadTargetId: applicationEntityIdSchema.nullable(),
    counts: normalizedInventoryCountsSchema,
    tasks: z.array(associatedTaskSchema).max(10_000),
  })
  .superRefine((snapshot, context) => {
    requireSerializedByteLimit(
      snapshot,
      context,
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
      "Normalized application snapshot exceeds the serialized byte limit.",
    );
    requireUniqueIds(snapshot.environments, context, "environments");
    requireUniqueIds(snapshot.workspaces, context, "workspaces");
    requireUniqueIds(snapshot.threads, context, "threads");
    requireUniqueIds(snapshot.groups, context, "groups");
    requireUniqueIds(snapshot.executionTargets, context, "executionTargets");
    requireUniqueIds(snapshot.advisories, context, "advisories");

    const environmentIds = new Set(
      snapshot.environments.map((environment) => environment.id),
    );
    for (let index = 0; index < snapshot.workspaces.length; index += 1) {
      if (!environmentIds.has(snapshot.workspaces[index]!.environmentId)) {
        context.addIssue({
          code: "custom",
          message: "Workspace references an unknown environment.",
          path: ["workspaces", index, "environmentId"],
        });
      }
    }

    for (let index = 0; index < snapshot.executionTargets.length; index += 1) {
      if (
        !environmentIds.has(snapshot.executionTargets[index]!.environmentId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Execution target references an unknown environment.",
          path: ["executionTargets", index, "environmentId"],
        });
      }
    }
    // Environment availability describes its primary execution channel. A
    // target may instead use independently configured operations whose live
    // reachability is checked only when active work starts.

    const targetById = new Map(
      snapshot.executionTargets.map((target) => [target.id, target]),
    );
    if (
      snapshot.defaultNewThreadTargetId !== null &&
      !targetById.get(snapshot.defaultNewThreadTargetId)?.available
    ) {
      context.addIssue({
        code: "custom",
        message: "The default new-thread target is not available.",
        path: ["defaultNewThreadTargetId"],
      });
    }

    const workspaceById = new Map(
      snapshot.workspaces.map((workspace) => [workspace.id, workspace]),
    );
    const groupIds = new Set(snapshot.groups.map(({ id }) => id));
    for (let index = 0; index < snapshot.threads.length; index += 1) {
      const thread = snapshot.threads[index]!;
      if (thread.groupId !== null && !groupIds.has(thread.groupId)) {
        context.addIssue({
          code: "custom",
          message: "Thread references an unknown group.",
          path: ["threads", index, "groupId"],
        });
      }
      const workspace = workspaceById.get(thread.workspaceId);
      if (!workspace) {
        context.addIssue({
          code: "custom",
          message: "Thread references an unknown workspace.",
          path: ["threads", index, "workspaceId"],
        });
      }
      const target = targetById.get(thread.targetId);
      if (!target) {
        context.addIssue({
          code: "custom",
          message: "Thread references an unknown execution target.",
          path: ["threads", index, "targetId"],
        });
      } else if (
        workspace &&
        target.environmentId !== workspace.environmentId
      ) {
        context.addIssue({
          code: "custom",
          message: "Thread target and workspace environments must match.",
          path: ["threads", index, "targetId"],
        });
      } else if (
        target.backend.brand !== thread.backend.brand ||
        target.backend.label.text !== thread.backend.label.text
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Thread and execution-target backend presentation must match.",
          path: ["threads", index, "backend"],
        });
      }
    }

    const workspaceIds = new Set(workspaceById.keys());
    const taskThreadById = new Map(
      snapshot.threads.map((thread) => [thread.id, thread] as const),
    );
    requireUniqueIds(snapshot.tasks, context, "tasks");
    for (let index = 0; index < snapshot.tasks.length; index += 1) {
      const task = snapshot.tasks[index]!;
      const taskScope = task.scope;
      if (
        task.associatedWorkspaceId !== null &&
        !workspaceIds.has(task.associatedWorkspaceId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Task association references an unknown workspace.",
          path: ["tasks", index, "associatedWorkspaceId"],
        });
      }
      if (taskScope.kind !== "thread") continue;
      // Archived or otherwise omitted threads remain valid. When a thread is
      // present, the task association must agree with the same authoritative
      // workspace projection.
      const thread = taskThreadById.get(taskScope.threadId);
      if (thread && task.associatedWorkspaceId !== thread.workspaceId) {
        context.addIssue({
          code: "custom",
          message: "Task and thread workspace associations must match.",
          path: ["tasks", index, "associatedWorkspaceId"],
        });
      }
    }

    const threadIds = new Set(snapshot.threads.map(({ id }) => id));
    const originChildIds = new Set<string>();
    const sourceByChild = new Map<string, string>();
    for (let index = 0; index < snapshot.forkOrigins.length; index += 1) {
      const origin = snapshot.forkOrigins[index]!;
      if (!threadIds.has(origin.childThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Fork origin references an unknown child thread.",
          path: ["forkOrigins", index, "childThreadId"],
        });
      }
      if (
        origin.sourceThreadId !== null &&
        !threadIds.has(origin.sourceThreadId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Fork origin references an unknown source thread.",
          path: ["forkOrigins", index, "sourceThreadId"],
        });
      }
      if (origin.sourceThreadId === origin.childThreadId) {
        context.addIssue({
          code: "custom",
          message: "A fork origin cannot reference its child as its source.",
          path: ["forkOrigins", index, "sourceThreadId"],
        });
      }
      if (originChildIds.has(origin.childThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Fork origin child identifiers must be unique.",
          path: ["forkOrigins", index, "childThreadId"],
        });
      }
      originChildIds.add(origin.childThreadId);
      if (origin.sourceThreadId !== null) {
        sourceByChild.set(origin.childThreadId, origin.sourceThreadId);
      }
    }
    const checkedOrigins = new Set<string>();
    for (const childThreadId of sourceByChild.keys()) {
      if (checkedOrigins.has(childThreadId)) continue;
      const seen = new Set<string>();
      const path: string[] = [];
      let current: string | undefined = childThreadId;
      while (
        current &&
        sourceByChild.has(current) &&
        !checkedOrigins.has(current)
      ) {
        if (seen.has(current)) {
          context.addIssue({
            code: "custom",
            message: "Fork origins must not contain an ancestry cycle.",
            path: ["forkOrigins"],
          });
          break;
        }
        seen.add(current);
        path.push(current);
        current = sourceByChild.get(current);
      }
      for (const id of path) checkedOrigins.add(id);
    }
    const placementChildIds = new Set<string>();
    for (let index = 0; index < snapshot.lineagePlacements.length; index += 1) {
      const placement = snapshot.lineagePlacements[index]!;
      if (!originChildIds.has(placement.childThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Lineage placement references an unknown fork origin.",
          path: ["lineagePlacements", index, "childThreadId"],
        });
      }
      if (placementChildIds.has(placement.childThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Lineage placement child identifiers must be unique.",
          path: ["lineagePlacements", index, "childThreadId"],
        });
      }
      placementChildIds.add(placement.childThreadId);
    }
    for (let index = 0; index < snapshot.forkOrigins.length; index += 1) {
      const childThreadId = snapshot.forkOrigins[index]!.childThreadId;
      if (!placementChildIds.has(childThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Every fork origin requires a lineage placement.",
          path: ["forkOrigins", index, "childThreadId"],
        });
      }
    }
    const familySourceIds = new Set<string>();
    for (let index = 0; index < snapshot.lineageFamilies.length; index += 1) {
      const family = snapshot.lineageFamilies[index]!;
      if (!threadIds.has(family.sourceThreadId)) {
        context.addIssue({
          code: "custom",
          message:
            "Lineage family summary references an unknown source thread.",
          path: ["lineageFamilies", index, "sourceThreadId"],
        });
      }
      if (familySourceIds.has(family.sourceThreadId)) {
        context.addIssue({
          code: "custom",
          message: "Lineage family source identifiers must be unique.",
          path: ["lineageFamilies", index, "sourceThreadId"],
        });
      }
      familySourceIds.add(family.sourceThreadId);
    }
  });
export type NormalizedApplicationSnapshot = z.infer<
  typeof normalizedApplicationSnapshotSchema
>;

export const workpadChangedEventSchema = z.strictObject({
  type: z.literal("workpad_changed"),
  generation: applicationGenerationSchema,
  workpadId: applicationEntityIdSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  change: z.enum(["document", "draft"]),
});
export type WorkpadChangedEvent = z.infer<typeof workpadChangedEventSchema>;

export const normalizedApplicationEventSchema = z.discriminatedUnion("type", [
  workpadChangedEventSchema,
  z.strictObject({
    type: z.literal("snapshot"),
    generation: applicationGenerationSchema,
    snapshot: normalizedApplicationSnapshotSchema,
  }),
  z.strictObject({
    type: z.literal("environment_upsert"),
    generation: applicationGenerationSchema,
    environment: normalizedEnvironmentSummarySchema,
  }),
  z.strictObject({
    type: z.literal("environment_remove"),
    generation: applicationGenerationSchema,
    environmentId: applicationEntityIdSchema,
  }),
  z.strictObject({
    type: z.literal("workspace_upsert"),
    generation: applicationGenerationSchema,
    workspace: normalizedWorkspaceSummarySchema,
  }),
  z.strictObject({
    type: z.literal("workspace_remove"),
    generation: applicationGenerationSchema,
    workspaceId: applicationEntityIdSchema,
  }),
  z.strictObject({
    type: z.literal("thread_upsert"),
    generation: applicationGenerationSchema,
    thread: normalizedApplicationThreadSummarySchema,
    counts: normalizedInventoryCountsSchema,
  }),
  z.strictObject({
    type: z.literal("thread_remove"),
    generation: applicationGenerationSchema,
    threadId: applicationEntityIdSchema,
    counts: normalizedInventoryCountsSchema,
  }),
  z.strictObject({
    type: z.literal("inventory_counts_changed"),
    generation: applicationGenerationSchema,
    counts: normalizedInventoryCountsSchema,
  }),
  z.strictObject({
    type: z.literal("task_upsert"),
    generation: applicationGenerationSchema,
    task: associatedTaskSchema,
  }),
  z.strictObject({
    type: z.literal("task_remove"),
    generation: applicationGenerationSchema,
    taskId: applicationEntityIdSchema,
  }),
]);
export type NormalizedApplicationEvent = z.infer<
  typeof normalizedApplicationEventSchema
>;

export const applicationEventIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:0|[1-9][0-9]*)$/,
  )
  .max(240)
  .refine((eventId) => {
    const sequence = Number(eventId.slice(eventId.lastIndexOf(".") + 1));
    return Number.isSafeInteger(sequence) && sequence >= 0;
  }, "Application event sequence must be a safe nonnegative integer.");

export const applicationEventEnvelopeSchema = z
  .strictObject({
    eventId: applicationEventIdSchema,
    applicationGeneration: applicationGenerationSchema,
    event: normalizedApplicationEventSchema,
  })
  .superRefine((envelope, context) => {
    if (envelope.applicationGeneration !== envelope.event.generation) {
      context.addIssue({
        code: "custom",
        message: "Envelope and event application generations must match.",
        path: ["applicationGeneration"],
      });
    }
  });
export type ApplicationEventEnvelope = z.infer<
  typeof applicationEventEnvelopeSchema
>;

export const SEDES_CLIENT_PROTOCOL_VERSION = 115 as const;

export const normalizedApplicationSessionSchema = z.strictObject({
  clientProtocolVersion: z.literal(SEDES_CLIENT_PROTOCOL_VERSION),
  /** The server's Sedes product version, for bug reports and mismatch remedies. */
  version: z.string().min(1).max(64),
  csrfToken: z.string().min(1).max(512),
  providerPulseEnabled: z.boolean(),
});
export type NormalizedApplicationSession = z.infer<
  typeof normalizedApplicationSessionSchema
>;
