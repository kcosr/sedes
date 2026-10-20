import { z } from "zod";
import { recordVoiceDiagnosticEntry } from "../app/diagnostics.js";
import { getDiagnosticCategoryEnabled } from "../app/settings.js";

const events = z.enum([
  "composer_state", "task_staged", "draft_save_started", "draft_save_finished", "draft_save_failed",
  "departure_flush_started", "departure_flush_finished", "departure_flush_failed",
  "foreground_context_requested", "foreground_context_applied", "foreground_context_failed",
  "handoff_received", "handoff_claimed", "handoff_claim_failed", "handoff_route_selected",
  "handoff_adopted", "handoff_declined", "handoff_completed", "handoff_completion_failed",
  "draft_captured", "saved_draft_read_started", "saved_draft_read_finished", "saved_draft_read_failed",
  "saved_draft_save_started", "saved_draft_save_finished", "saved_draft_save_failed", "saved_draft_save_reconciled",
  "delivery_started", "delivery_finished", "delivery_failed", "submission_settled", "submission_failed",
]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const detailsSchema = z.object({
  // The random recording UUID correlates the two buffers without exposing a thread or task ID.
  recordingId: z.uuidv4().optional(),
  connectionGeneration: count.optional(),
  composerInstance: count.optional(),
  active: z.boolean().optional(),
  targetActive: z.boolean().optional(),
  chatVisible: z.boolean().optional(),
  live: z.boolean().optional(),
  tuiActive: z.boolean().optional(),
  ready: z.boolean().optional(),
  documentVisible: z.boolean().optional(),
  composerAvailable: z.boolean().optional(),
  targetMatchesForeground: z.boolean().optional(),
  dirty: z.boolean().optional(),
  taskCount: count.optional(),
  attachmentCount: count.optional(),
  excerptCount: count.optional(),
  pendingUploadCount: count.optional(),
  textCharacters: count.optional(),
  hasSkill: z.boolean().optional(),
  draftRevision: count.optional(),
  submissionPending: z.boolean().optional(),
  source: z.enum(["live", "saved"]).optional(),
  outcome: z.enum(["accepted", "declined"]).optional(),
  mode: z.enum(["submit", "steer", "queue"]).optional(),
});
export type VoiceSendDiagnosticDetails = z.infer<typeof detailsSchema>;

/** Observational only: invalid data or a failed sink must never affect a send. */
export function recordVoiceSendDiagnostic(event: z.infer<typeof events>, details: VoiceSendDiagnosticDetails = {}): void {
  try {
    if (!getDiagnosticCategoryEnabled("voice")) return;
    const parsed = detailsSchema.safeParse(details);
    if (events.safeParse(event).success && parsed.success) recordVoiceDiagnosticEntry(event, parsed.data);
  } catch { /* Diagnostics cannot change submission or recovery. */ }
}

export function voiceDraftCounts(draft: {
  text: string; selectedSkillId?: string; taskReferences: readonly unknown[];
  attachments: readonly unknown[]; contextExcerpts: readonly unknown[];
}): VoiceSendDiagnosticDetails {
  return { textCharacters: draft.text.length, taskCount: draft.taskReferences.length,
    attachmentCount: draft.attachments.length, excerptCount: draft.contextExcerpts.length,
    hasSkill: Boolean(draft.selectedSkillId) };
}
