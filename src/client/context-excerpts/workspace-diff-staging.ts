import {
  contextExcerptSchema,
  type ContextExcerpt,
  type WorkspaceDiffComparisonId,
  type WorkspaceDiffContextSource,
  type WorkspaceDiffFileId,
  type WorkspaceDiffFingerprint,
} from "../../shared/index.js";
import type {
  ContextExcerptStageResult,
  ContextExcerptStagingTarget,
} from "./coordinator.js";

type DiffLineRange = Extract<
  ContextExcerpt["locator"],
  { kind: "diff_line_range" }
>;

/**
 * The Compare view derives this status from the response that supplied the
 * currently rendered patch. This client freshness guard prevents staging a
 * selection after that response is replaced. The resulting excerpt is durable
 * display context only and is never repository-operation authority.
 */
export type WorkspaceDiffContextSourceStatus =
  | {
      readonly status: "available";
      readonly comparisonId: WorkspaceDiffComparisonId;
      readonly comparisonFingerprint: WorkspaceDiffFingerprint;
      readonly fileId: WorkspaceDiffFileId;
    }
  | {
      readonly status: "stale";
      readonly currentFingerprint?: WorkspaceDiffFingerprint;
    }
  | { readonly status: "unavailable"; readonly reason?: string };

export interface WorkspaceDiffContextExcerptCandidate {
  readonly id?: string;
  readonly excerpt: string;
  readonly note?: string;
  readonly source: WorkspaceDiffContextSource;
  readonly locator: DiffLineRange;
}

export function stageWorkspaceDiffContextExcerpt(input: {
  readonly target?: ContextExcerptStagingTarget;
  readonly sourceStatus: WorkspaceDiffContextSourceStatus;
  readonly candidate: WorkspaceDiffContextExcerptCandidate;
  readonly sendImmediately?: boolean;
}): ContextExcerptStageResult {
  const { target, sourceStatus, candidate, sendImmediately = false } = input;
  if (sourceStatus.status === "stale") {
    return {
      ok: false,
      reason: "The comparison changed. Select the diff lines again.",
    };
  }
  if (sourceStatus.status === "unavailable") {
    return {
      ok: false,
      reason:
        sourceStatus.reason ??
        "The comparison is unavailable. Select the diff lines again when it reloads.",
    };
  }
  if (
    sourceStatus.comparisonId !== candidate.source.comparisonId ||
    sourceStatus.comparisonFingerprint !==
      candidate.source.comparisonFingerprint ||
    sourceStatus.fileId !== candidate.source.fileId
  ) {
    return {
      ok: false,
      reason: "The displayed diff changed. Select the diff lines again.",
    };
  }
  if (!target) {
    return { ok: false, reason: "The message composer is unavailable." };
  }
  if (target.workspaceId !== candidate.source.workspaceId) {
    return {
      ok: false,
      reason: "This comparison is not in the active thread workspace.",
    };
  }
  const targetStatus = target.getSnapshot();
  if (!targetStatus.available) {
    return {
      ok: false,
      reason: targetStatus.reason ?? "The message composer is unavailable.",
    };
  }
  const normalizedNote = candidate.note?.trim();
  const parsed = contextExcerptSchema.safeParse({
    id: candidate.id ?? globalThis.crypto.randomUUID(),
    excerpt: candidate.excerpt,
    ...(normalizedNote ? { note: normalizedNote } : {}),
    source: candidate.source,
    locator: candidate.locator,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        parsed.error.issues[0]?.message ??
        "That diff selection cannot be attached.",
    };
  }
  return sendImmediately
    ? target.attachAndSubmit(parsed.data)
    : target.stage(parsed.data);
}
