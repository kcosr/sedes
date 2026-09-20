import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  contextExcerptArraySchema,
  type ContextExcerpt,
} from "../../../shared/protocol/context-excerpts.js";
import type { StagedComposerAttachment } from "../contracts.js";
import {
  materializedTaskContextsSchema,
  type MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";

export const piSubmissionMarkerType = "sedes.backend_submission.v1";
const legacyPiSubmissionMarkerType = "harness.backend_submission.v1";

export function isPiSubmissionMarkerType(value: string): boolean {
  return (
    value === piSubmissionMarkerType || value === legacyPiSubmissionMarkerType
  );
}

export interface PiSubmissionMarker {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly reconciliationToken: string;
  readonly mutationId: string;
  readonly mode: "submit" | "steer";
  readonly requestFingerprint: string;
  readonly textFingerprint: string;
  readonly phase: "intent" | "enqueued" | "rejected" | "lost";
  /** Required for post-enqueue/loss evidence and names the targeted Pi turn. */
  readonly backendTurnId?: string;
}

export function piSubmissionMarker(
  entry: SessionEntry,
): PiSubmissionMarker | undefined {
  if (
    entry.type !== "custom" ||
    !isPiSubmissionMarkerType(entry.customType) ||
    typeof entry.data !== "object" ||
    entry.data === null
  ) {
    return undefined;
  }
  const data = entry.data as Partial<PiSubmissionMarker>;
  const keys = Object.keys(data).sort();
  return keys.join("\0") ===
    [
      "applicationOperationId",
      "backendTurnId",
      "mode",
      "mutationId",
      "phase",
      "reconciliationToken",
      "requestFingerprint",
      "textFingerprint",
      "version",
    ]
      .filter(
        (key) => key !== "backendTurnId" || data.backendTurnId !== undefined,
      )
      .sort()
      .join("\0") &&
    data.version === 1 &&
    typeof data.applicationOperationId === "string" &&
    data.applicationOperationId.length > 0 &&
    data.applicationOperationId.length <= 160 &&
    typeof data.reconciliationToken === "string" &&
    data.reconciliationToken.length > 0 &&
    data.reconciliationToken.length <= 512 &&
    typeof data.mutationId === "string" &&
    data.mutationId.length > 0 &&
    data.mutationId.length <= 160 &&
    typeof data.requestFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(data.requestFingerprint) &&
    typeof data.textFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(data.textFingerprint) &&
    (data.phase === "intent" ||
      data.phase === "enqueued" ||
      data.phase === "rejected" ||
      data.phase === "lost") &&
    (data.backendTurnId === undefined ||
      (typeof data.backendTurnId === "string" &&
        data.backendTurnId.length > 0 &&
        data.backendTurnId.length <= 512)) &&
    (data.mode === "submit" || data.mode === "steer") &&
    ((data.phase !== "enqueued" && data.phase !== "lost") ||
      (data.mode === "steer" && data.backendTurnId !== undefined))
    ? (data as PiSubmissionMarker)
    : undefined;
}

type PiSubmissionFingerprintInput = {
  readonly applicationOperationId: string;
  readonly reconciliationToken: string;
  readonly mutationId: string;
  readonly text: string;
  readonly mode: "submit" | "steer";
  readonly backendTurnId?: string;
  readonly selectedSkillId?: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly attachments: readonly StagedComposerAttachment[];
  readonly taskContexts: readonly MaterializedTaskContext[];
};

export function piSubmissionFingerprint(
  input: PiSubmissionFingerprintInput,
): string {
  const contextExcerpts = contextExcerptArraySchema.parse(
    input.contextExcerpts,
  );
  const taskContexts = materializedTaskContextsSchema.parse(input.taskContexts);
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.applicationOperationId,
        input.reconciliationToken,
        input.mutationId,
        input.mode,
        input.text,
        ...(input.selectedSkillId ? [input.selectedSkillId] : []),
        ...(contextExcerpts.length > 0 ? [contextExcerpts] : []),
        ...(input.attachments.length > 0 ? [input.attachments] : []),
        ...(taskContexts.length > 0 ? [taskContexts] : []),
      ]),
    )
    .digest("hex");
}

export function piSubmissionTextFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createPiSubmissionMarker(
  input: PiSubmissionFingerprintInput & {
    readonly phase?: PiSubmissionMarker["phase"];
  },
): PiSubmissionMarker {
  return {
    version: 1,
    applicationOperationId: input.applicationOperationId,
    reconciliationToken: input.reconciliationToken,
    mutationId: input.mutationId,
    mode: input.mode,
    requestFingerprint: piSubmissionFingerprint(input),
    textFingerprint: piSubmissionTextFingerprint(input.text),
    phase: input.phase ?? "intent",
    ...(input.backendTurnId ? { backendTurnId: input.backendTurnId } : {}),
  };
}

/**
 * Pi persists Sedes markers after input preflight and before the
 * corresponding user message enters branch history. Input handlers may
 * transform the persisted text, so correlations are positional and assigned
 * FIFO rather than matched against the caller's original text.
 */
export function correlatePiSubmissions(
  entries: readonly SessionEntry[],
): ReadonlyMap<
  string,
  {
    readonly marker: PiSubmissionMarker;
    readonly userEntryId?: string;
    readonly providerTurnId?: string;
    readonly rejected: boolean;
    readonly invalid?: "orphan_steer" | "displaced_steer" | "lost_steer";
  }
> {
  const results = new Map<
    string,
    {
      marker: PiSubmissionMarker;
      userEntryId?: string;
      providerTurnId?: string;
      rejected: boolean;
      invalid?: "orphan_steer" | "displaced_steer" | "lost_steer";
    }
  >();
  const pending: Array<{
    readonly marker: PiSubmissionMarker;
    readonly providerTurnId?: string;
  }> = [];
  let currentProviderTurnId: string | undefined;
  for (const entry of entries) {
    const marker = piSubmissionMarker(entry);
    if (marker) {
      if (marker.phase === "rejected" || marker.phase === "lost") {
        const index = pending.findIndex(
          (candidate) =>
            candidate.marker.applicationOperationId ===
              marker.applicationOperationId &&
            candidate.marker.requestFingerprint === marker.requestFingerprint &&
            candidate.marker.reconciliationToken ===
              marker.reconciliationToken &&
            candidate.marker.mutationId === marker.mutationId &&
            candidate.marker.mode === marker.mode,
        );
        if (index >= 0) {
          const [closedPending] = pending.splice(index, 1);
          if (
            (marker.phase === "rejected" &&
              closedPending?.marker.phase !== "intent") ||
            (marker.phase === "lost" &&
              (closedPending?.marker.mode !== "steer" ||
                marker.backendTurnId !== closedPending.providerTurnId))
          ) {
            throw new Error(
              marker.phase === "rejected"
                ? "pi_submission_rejection_marker_invalid"
                : "pi_submission_loss_marker_invalid",
            );
          }
          results.set(marker.applicationOperationId, {
            marker,
            rejected: true,
            ...(marker.phase === "lost"
              ? { invalid: "lost_steer" as const }
              : {}),
          });
          continue;
        }
        const closed = results.get(marker.applicationOperationId);
        if (
          !closed ||
          closed.userEntryId ||
          closed.marker.requestFingerprint !== marker.requestFingerprint ||
          closed.marker.reconciliationToken !== marker.reconciliationToken ||
          closed.marker.mutationId !== marker.mutationId ||
          closed.marker.mode !== marker.mode ||
          (marker.phase === "rejected" && !closed.rejected) ||
          (marker.phase === "lost" && closed.invalid !== "lost_steer")
        ) {
          throw new Error(
            marker.phase === "rejected"
              ? "pi_submission_rejection_marker_invalid"
              : "pi_submission_loss_marker_invalid",
          );
        }
        results.set(marker.applicationOperationId, {
          marker,
          rejected: true,
          ...(marker.phase === "lost"
            ? { invalid: "lost_steer" as const }
            : {}),
        });
        continue;
      }
      if (marker.phase === "enqueued") {
        const index = pending.findIndex(
          (candidate) =>
            candidate.marker.applicationOperationId ===
              marker.applicationOperationId &&
            candidate.marker.requestFingerprint === marker.requestFingerprint &&
            candidate.marker.reconciliationToken ===
              marker.reconciliationToken &&
            candidate.marker.mutationId === marker.mutationId &&
            candidate.marker.mode === marker.mode,
        );
        if (index >= 0) {
          const candidate = pending[index]!;
          if (candidate.providerTurnId !== marker.backendTurnId) {
            throw new Error("pi_submission_enqueue_marker_target_mismatch");
          }
          pending[index] = { ...candidate, marker };
          const prior = results.get(marker.applicationOperationId);
          results.set(marker.applicationOperationId, {
            marker,
            rejected: false,
            ...(candidate.providerTurnId
              ? { providerTurnId: candidate.providerTurnId }
              : {}),
            ...(prior?.invalid ? { invalid: prior.invalid } : {}),
          });
          continue;
        }
        const materialized = results.get(marker.applicationOperationId);
        if (
          !materialized?.userEntryId ||
          materialized.marker.requestFingerprint !==
            marker.requestFingerprint ||
          materialized.marker.reconciliationToken !==
            marker.reconciliationToken ||
          materialized.marker.mutationId !== marker.mutationId ||
          materialized.marker.mode !== "steer" ||
          materialized.providerTurnId !== marker.backendTurnId
        ) {
          throw new Error("pi_submission_enqueue_marker_invalid");
        }
        results.set(marker.applicationOperationId, {
          ...materialized,
          marker,
        });
        continue;
      }
      const previous = results.get(marker.applicationOperationId);
      if (previous && !previous.rejected) {
        throw new Error("pi_submission_intent_marker_duplicate");
      }
      for (const displaced of pending.splice(0)) {
        results.set(displaced.marker.applicationOperationId, {
          marker: displaced.marker,
          rejected: false,
          ...(displaced.marker.mode === "steer"
            ? { invalid: "displaced_steer" as const }
            : {}),
        });
      }
      const providerTurnId =
        marker.mode === "steer" ? currentProviderTurnId : undefined;
      pending.push({ marker, providerTurnId });
      results.set(marker.applicationOperationId, {
        marker,
        rejected: false,
        ...(marker.mode === "steer" && !providerTurnId
          ? { invalid: "orphan_steer" as const }
          : {}),
      });
      continue;
    }
    if (
      entry.type === "message" &&
      entry.message.role === "user" &&
      pending.length > 0
    ) {
      const accepted = pending[0]!;
      pending.shift();
      const invalid =
        accepted.marker.mode === "steer" && !accepted.providerTurnId
          ? "orphan_steer"
          : undefined;
      results.set(accepted.marker.applicationOperationId, {
        marker: accepted.marker,
        userEntryId: entry.id,
        ...(accepted.marker.mode === "submit"
          ? { providerTurnId: entry.id }
          : accepted.providerTurnId
            ? { providerTurnId: accepted.providerTurnId }
            : {}),
        rejected: false,
        ...(invalid ? { invalid } : {}),
      });
      if (accepted.marker.mode === "submit") {
        currentProviderTurnId = entry.id;
      }
      continue;
    }
    if (entry.type === "message" && entry.message.role === "user") {
      currentProviderTurnId = entry.id;
      continue;
    }
  }
  return results;
}
