import { composerInputUtf8Bytes, composerTaskInputUtf8Bytes, MAXIMUM_THREAD_INPUT_BYTES,
  normalizedDraftSchema, type NormalizedDraft, type NormalizedThreadSnapshot, type Task } from "../../shared/index.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import type { VoiceComposerAdoption, VoiceDetachedComposerContext } from "./NativeVoiceStore.js";
import type { NativeVoiceComposerHandoff } from "./native-voice-plugin.js";
import { prependVoiceToDraft } from "./voice-composer-draft.js";
import { recordVoiceSendDiagnostic, voiceDraftCounts } from "./voice-send-diagnostics.js";

type DraftApi = Pick<ApiClient, "readThread" | "saveDraft" | "operateThread">;

/** A draft save is not idempotent: reconcile a lost acknowledgement without repeating the prepend or PUT. */
function sameContribution(left: NormalizedDraft, right: NormalizedDraft): boolean {
  const content = (draft: NormalizedDraft) => ({
    text: draft.text,
    selectedSkillId: draft.selectedSkillId,
    contextExcerpts: draft.contextExcerpts,
    attachmentIds: draft.attachments.map(({ id }) => id),
    taskReferenceIds: draft.taskReferences.map(({ taskId }) => taskId),
  });
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

function deliveryMode(snapshot: NormalizedThreadSnapshot, event: NativeVoiceComposerHandoff) {
  const submitAvailable = snapshot.capabilities.deliveryModes.some(({ id, available }) => id === "submit" && available);
  const busy = !submitAvailable &&
    ["starting", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(snapshot.runState);
  const steer = snapshot.capabilities.deliveryModes.find(({ id, available }) => id === "steer" && available);
  const steerTarget = steer?.steerTarget === "conversation"
    ? { kind: "conversation" as const }
    : steer?.steerTarget === "turn" && snapshot.activeTurnId
      ? { kind: "turn" as const, turnId: snapshot.activeTurnId }
      : undefined;
  return !busy ? { mode: "submit" as const }
    : event.mode === "steer" && steerTarget ? { mode: "steer" as const, steerTarget }
      : { mode: "queue" as const };
}

/**
 * The original composer's departure flush has already settled. Only the saved
 * draft is read here; no view, thread stream, or browser File is required.
 * Ownership transfers once speech is durably in that draft. Later failures must
 * never return it to native recovery or start a second delivery attempt.
 */
export async function prepareDetachedVoiceSubmission(
  api: DraftApi,
  event: NativeVoiceComposerHandoff,
  context: VoiceDetachedComposerContext,
  readTasks: () => readonly Task[] | undefined,
): Promise<VoiceComposerAdoption> {
  context.assertCurrent();
  const diagnostic = { recordingId: event.recordingId, source: "saved" as const };
  recordVoiceSendDiagnostic("saved_draft_read_started", diagnostic);
  let snapshot: NormalizedThreadSnapshot;
  try {
    snapshot = await api.readThread(event.threadId, context.signal);
  } catch (error) {
    recordVoiceSendDiagnostic("saved_draft_read_failed", diagnostic);
    throw error;
  }
  recordVoiceSendDiagnostic("saved_draft_read_finished", { ...diagnostic, ...voiceDraftCounts(snapshot.draft), draftRevision: snapshot.draft.revision });
  context.assertCurrent();
  const parsed = normalizedDraftSchema.safeParse(prependVoiceToDraft(snapshot.draft, event.text));
  if (!parsed.success) throw new Error("Speech and the saved draft exceed the input limit. Review the original thread before sending.");
  const candidate = parsed.data;
  recordVoiceSendDiagnostic("draft_captured", { ...diagnostic, ...voiceDraftCounts(candidate), draftRevision: candidate.revision });
  const tasks = readTasks();
  const selectedTasks: Task[] = [];
  for (const reference of candidate.taskReferences) {
    const task = tasks?.find(({ id }) => id === reference.taskId);
    if (!task) throw new Error("An attached Task is unavailable. Review the original thread's Tasks before sending the saved dictation.");
    selectedTasks.push(task);
  }
  if (composerInputUtf8Bytes(candidate) + composerTaskInputUtf8Bytes(selectedTasks) > MAXIMUM_THREAD_INPUT_BYTES)
    throw new Error("Speech and the saved draft exceed the input limit. Review the original thread before sending.");
  const operationId = crypto.randomUUID();
  const policy = deliveryMode(snapshot, event);
  // Recheck the live view immediately before the write boundary. After this
  // point a remount or cancellation must not race the PUT's definite outcome.
  context.beginSave();
  let saved: NormalizedDraft;
  try {
    recordVoiceSendDiagnostic("saved_draft_save_started", diagnostic);
    saved = await api.saveDraft(event.threadId, candidate);
    recordVoiceSendDiagnostic("saved_draft_save_finished", { ...diagnostic, ...voiceDraftCounts(saved), draftRevision: saved.revision });
  } catch (error) {
    recordVoiceSendDiagnostic("saved_draft_save_failed", diagnostic);
    // A definitive admission rejection has no saved contribution. A transport or
    // server failure can follow a successful write, so first look for that exact
    // contribution on the original connection, even if navigation was cancelled.
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
    try {
      const current = await api.readThread(event.threadId, AbortSignal.timeout(5_000));
      if (current.draft.revision > candidate.revision && sameContribution(current.draft, candidate)) {
        recordVoiceSendDiagnostic("saved_draft_save_reconciled", { ...diagnostic, draftRevision: current.draft.revision });
        return { submission: Promise.reject(new Error("Speech was saved in the original thread's draft, but its save acknowledgement was lost. Open that thread before sending.")) };
      }
    } catch { /* Keep native recovery when a durable save cannot be established. */ }
    throw new Error("The draft save could not be confirmed. Speech may already be in the original thread's draft; check it before adding the saved dictation again.", { cause: error });
  }

  const submission = (async () => {
    // A successful PUT is adoption even if the user stopped voice, hid the app,
    // or changed connections during the write. Those changes still forbid send.
    try { context.assertCurrent(); }
    catch (error) {
      throw new Error("Speech was saved in the original thread's draft. Open that thread to review it before sending.", { cause: error });
    }
    if (snapshot.recovery) throw new Error("Speech was saved in the original thread's draft. Resolve that thread's delivery recovery before sending.");
    const capability = snapshot.capabilities.deliveryModes.find(({ id }) => id === policy.mode);
    if (!capability?.available) throw new Error("Speech was saved in the original thread's draft. Open that thread and press Send when it is available.");
    let result;
    try {
      recordVoiceSendDiagnostic("delivery_started", { ...diagnostic, mode: policy.mode,
        ...voiceDraftCounts(saved), draftRevision: saved.revision });
      result = await api.operateThread(event.threadId, {
        kind: "deliver",
        mutationId: operationId,
        expectedThreadRevision: snapshot.thread.threadRevision,
        expectedDraftRevision: saved.revision,
        ...policy,
      }, { signal: context.signal });
    } catch (error) {
      recordVoiceSendDiagnostic("delivery_failed", diagnostic);
      // This request may have crossed admission. Do not fetch, prepend, save or
      // send again: normal Chat receipts/recovery own the outcome from here.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 &&
          error.code !== "operation_outcome_uncertain" && error.code !== "backend_submission_unknown")
        throw new Error(`Speech was saved in the original thread's draft, but was not sent: ${error.message}`, { cause: error });
      throw new Error("Voice delivery could not be confirmed. Check the original thread's message, draft, and recovery before sending again.", { cause: error });
    }
    if (result.status === "delivery_accepted" || result.status === "delivery_queued") {
      if ((result.status === "delivery_accepted" && result.operationId !== operationId) ||
          result.draft.revision <= saved.revision || result.draft.text !== "" || result.draft.attachments.length !== 0 ||
          result.draft.contextExcerpts.length !== 0 || result.draft.taskReferences.length !== 0)
        throw new Error("Voice delivery returned an invalid receipt. Check the original thread before sending again.");
      recordVoiceSendDiagnostic("delivery_finished", diagnostic);
      return;
    }
    if (result.status === "delivery_pending_materialization" && result.operationId === operationId) {
      recordVoiceSendDiagnostic("delivery_finished", diagnostic);
      return;
    }
    throw new Error("Check the original thread's draft and delivery recovery before sending the dictation again.");
  })();
  return { submission };
}
