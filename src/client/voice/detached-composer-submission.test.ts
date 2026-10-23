import { describe, expect, it, vi } from "vitest";
import { MAXIMUM_THREAD_INPUT_BYTES, type NormalizedDraft, type NormalizedThreadSnapshot, type Task } from "../../shared/index.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import type { VoiceDetachedComposerContext } from "./NativeVoiceStore.js";
import { prepareDetachedVoiceSubmission as prepareSubmission } from "./detached-composer-submission.js";
import { VOICE_CONNECTION } from "./native-voice-test-fixture.js";
import { clearDiagnostics, readDiagnostics } from "../app/diagnostics.js";

const event = { ...VOICE_CONNECTION, connectionGeneration: 1, handoffId: "handoff-1", recordingId: "recording-1",
  threadId: "original-thread", text: "Please explain this", mode: "queue" as const };
const emptyDraft = (revision: number): NormalizedDraft => ({ text: "", contextExcerpts: [], attachments: [], taskReferences: [], revision });
const attachedTask: Task = { id: "ca14ce42-b0cc-47de-86a6-962fb1484431", title: "Example task", details: "Explain the attached source file",
  scope: { kind: "thread", threadId: event.threadId }, pinned: false, backlog: false, files: [], completedAt: null,
  revision: 3, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" };
function prepareDetachedVoiceSubmission(
  api: Parameters<typeof prepareSubmission>[0], offer: Parameters<typeof prepareSubmission>[1], context: VoiceDetachedComposerContext,
  readTasks: () => readonly Task[] | undefined = () => [attachedTask],
) {
  return prepareSubmission(api, offer, context, readTasks);
}
function mutationId(operation: Parameters<ApiClient["operateThread"]>[1]): string {
  if (operation.kind !== "deliver") throw new Error("Expected only a delivery operation.");
  return operation.mutationId;
}

function fixture(patch: Partial<NormalizedThreadSnapshot> = {}) {
  const draft: NormalizedDraft = {
    text: "Existing composer text", selectedSkillId: "selected-skill", revision: 7,
    contextExcerpts: [{ id: "0467f95b-471f-482f-9e59-2c0599765b17", excerpt: "function example() {}", note: "Selected context",
      source: { kind: "workspace_file", rootId: "root", path: "src/example.ts", revision: "file-revision" },
      locator: { kind: "line_range", startLine: 1, endLine: 1 } }],
    attachments: [{ id: "ae312237-ae01-4bbf-8867-693d5cf10dde", kind: "file", fileName: "example.txt", mediaType: "application/octet-stream", byteSize: 64 }],
    taskReferences: [{ taskId: "ca14ce42-b0cc-47de-86a6-962fb1484431", titleSnapshot: "Example task" }],
  };
  // This coordinator only consumes draft, delivery policy and revision fields.
  const snapshot = { thread: { id: event.threadId, threadRevision: 42 }, draft, runState: "idle", activeTurnId: null,
    capabilities: { deliveryModes: [{ id: "submit", available: true }, { id: "queue", available: true },
      { id: "steer", available: true, steerTarget: "turn" }] }, recovery: null, ...patch } as unknown as NormalizedThreadSnapshot;
  const api = {
    readThread: vi.fn<ApiClient["readThread"]>().mockResolvedValue(snapshot),
    saveDraft: vi.fn<ApiClient["saveDraft"]>().mockImplementation(async (_threadId, candidate) => ({ ...candidate, revision: candidate.revision + 1 })),
    operateThread: vi.fn<ApiClient["operateThread"]>().mockImplementation(async (_threadId, operation) => ({
      status: "delivery_accepted", operationId: mutationId(operation), draft: emptyDraft(9),
    }) as Awaited<ReturnType<ApiClient["operateThread"]>>),
  };
  const controller = new AbortController();
  const context: VoiceDetachedComposerContext = { signal: controller.signal, assertCurrent: vi.fn(() => controller.signal.throwIfAborted()),
    beginSave: vi.fn(() => controller.signal.throwIfAborted()) };
  return { api, snapshot, draft, context, controller };
}

describe("detached composer voice submission", () => {
  it("traces the saved draft counts and save-before-delivery order without content", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "true" });
    clearDiagnostics();
    try {
      const { api, context } = fixture();
      const recordingId = "9ff27a42-814a-466b-acef-c8aeb7d017f5";
      const adopted = await prepareDetachedVoiceSubmission(api, { ...event, recordingId }, context);
      await adopted?.submission;
      const entries = readDiagnostics();
      expect(entries.map(entry => entry.event)).toEqual([
        "saved_draft_read_started", "saved_draft_read_finished", "draft_captured",
        "saved_draft_save_started", "saved_draft_save_finished", "delivery_started", "delivery_finished",
      ]);
      expect(entries.find(entry => entry.event === "draft_captured")?.details).toMatchObject({
        recordingId, source: "saved", taskCount: 1, attachmentCount: 1, excerptCount: 1, hasSkill: true,
      });
      expect(JSON.stringify(entries)).not.toMatch(/Example task|Existing composer text|original-thread|example.txt/);
    } finally {
      clearDiagnostics();
      vi.unstubAllGlobals();
    }
  });
  it("sends the original thread's entire saved draft with its fresh draft and thread revisions", async () => {
    const { api, draft, context } = fixture();
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).resolves.toBeUndefined();
    expect(api.readThread).toHaveBeenCalledExactlyOnceWith(event.threadId, context.signal);
    expect(api.saveDraft).toHaveBeenCalledExactlyOnceWith(event.threadId,
      { ...draft, text: "Please explain this\n\nExisting composer text" });
    expect(context.beginSave).toHaveBeenCalledOnce();
    expect(api.operateThread).toHaveBeenCalledExactlyOnceWith(event.threadId, {
      kind: "deliver", mode: "submit", mutationId: expect.any(String), expectedThreadRevision: 42, expectedDraftRevision: 8,
    }, { signal: context.signal });
    expect(draft.text).toBe("Existing composer text");
  });

  it.each(["queue", "steer"] as const)("submits detached voice during a retry delay despite the saved %s preference", async mode => {
    const { api, context, snapshot } = fixture({ runState: "starting" });
    snapshot.capabilities.deliveryModes = snapshot.capabilities.deliveryModes.map(capability => ({
      ...capability, available: capability.id === "submit",
    }));
    const adopted = await prepareDetachedVoiceSubmission(api, { ...event, mode }, context);
    await expect(adopted?.submission).resolves.toBeUndefined();
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).toHaveBeenCalledExactlyOnceWith(event.threadId, {
      kind: "deliver", mode: "submit", mutationId: expect.any(String), expectedThreadRevision: 42, expectedDraftRevision: 8,
    }, { signal: context.signal });
  });

  it.each([
    { mode: "queue" as const, activeTurnId: "active-turn", steerTarget: "turn", expected: { mode: "queue" } },
    { mode: "steer" as const, activeTurnId: "active-turn", steerTarget: "turn", expected: { mode: "steer", steerTarget: { kind: "turn", turnId: "active-turn" } } },
    { mode: "steer" as const, activeTurnId: null, steerTarget: "conversation", expected: { mode: "steer", steerTarget: { kind: "conversation" } } },
    { mode: "steer" as const, activeTurnId: null, steerTarget: "turn", expected: { mode: "queue" } },
  ])("preserves busy-thread delivery policy $expected", async ({ mode, activeTurnId, steerTarget, expected }) => {
    const { api, context, snapshot } = fixture({ runState: "running" });
    snapshot.activeTurnId = activeTurnId ?? undefined;
    snapshot.capabilities.deliveryModes = [{ id: "queue", available: true, steerTarget: null, label: { text: "Queue" } },
      { id: "steer", available: true, steerTarget, label: { text: "Steer" } } as NormalizedThreadSnapshot["capabilities"]["deliveryModes"][number]];
    const adopted = await prepareDetachedVoiceSubmission(api, { ...event, mode }, context);
    await expect(adopted?.submission).resolves.toBeUndefined();
    expect(api.operateThread).toHaveBeenCalledWith(event.threadId, expect.objectContaining(expected), { signal: context.signal });
  });

  it.each(["unavailable", "recovery"] as const)("adopts into the saved draft without delivery when %s", async condition => {
    const { api, context, snapshot } = fixture();
    if (condition === "unavailable") snapshot.capabilities.deliveryModes = [];
    else snapshot.recovery = { kind: "operation_uncertain", operationCategory: "delivery", diagnostic: { text: "Delivery uncertain" },
      submissionMayHaveBeenAccepted: true, recoverable: true };
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).rejects.toThrow(condition === "unavailable" ? "press Send" : "delivery recovery");
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("rejects content exceeding the shared input byte budget before saving or sending", async () => {
    const { api, context, snapshot } = fixture();
    snapshot.draft = { ...emptyDraft(7), text: "é".repeat(MAXIMUM_THREAD_INPUT_BYTES / 2) };
    await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toThrow("exceed the input limit");
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("accounts for full materialized Task details before the write boundary", async () => {
    const { api, context, snapshot } = fixture();
    snapshot.draft = { ...emptyDraft(7), text: "x".repeat(MAXIMUM_THREAD_INPUT_BYTES - 50_000),
      taskReferences: [{ taskId: attachedTask.id, titleSnapshot: attachedTask.title }] };
    const readTasks = vi.fn(() => [{ ...attachedTask, details: "d".repeat(65_536) }]);
    await expect(prepareDetachedVoiceSubmission(api, event, context, readTasks)).rejects.toThrow("exceed the input limit");
    expect(readTasks).toHaveBeenCalledOnce();
    expect(context.beginSave).not.toHaveBeenCalled();
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it.each([undefined, []] as const)("keeps dictation native-owned when an attached Task is unavailable: %j", async tasks => {
    const { api, context } = fixture();
    await expect(prepareDetachedVoiceSubmission(api, event, context, () => tasks)).rejects.toThrow("An attached Task is unavailable");
    expect(context.beginSave).not.toHaveBeenCalled();
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("does not require the Task catalog for a draft without Task references", async () => {
    const { api, context, snapshot } = fixture();
    snapshot.draft = emptyDraft(7);
    const adopted = await prepareDetachedVoiceSubmission(api, event, context, () => undefined);
    await expect(adopted?.submission).resolves.toBeUndefined();
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).toHaveBeenCalledOnce();
  });

  it("declines before PUT without reconciliation when the final write-boundary check returns the live composer", async () => {
    const { api, context } = fixture();
    vi.mocked(context.beginSave).mockImplementationOnce(() => { throw new Error("The original message composer returned"); });
    await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toThrow("The original message composer returned");
    expect(api.readThread).toHaveBeenCalledOnce();
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it.each([new Error("PUT response lost"), new ApiError(503, "unavailable", "Save response failed", true)])(
    "reconciles a lost save acknowledgement without another PUT or any delivery", async error => {
      const { api, context, draft, snapshot } = fixture();
      api.saveDraft.mockRejectedValueOnce(error);
      api.readThread.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot,
        draft: { ...draft, text: `${event.text}\n\n${draft.text}`, revision: 8 } });
      const adopted = await prepareDetachedVoiceSubmission(api, event, context);
      await expect(adopted?.submission).rejects.toThrow("save acknowledgement was lost");
      expect(api.saveDraft).toHaveBeenCalledOnce();
      expect(api.readThread).toHaveBeenCalledTimes(2);
      expect(api.readThread.mock.calls[1]![0]).toBe(event.threadId);
      expect(api.operateThread).not.toHaveBeenCalled();
    },
  );

  it.each(["older revision", "different text", "different attachment", "different task", "unreadable"] as const)(
    "retains native recovery with an explicit uncertainty warning when reconciliation finds %s", async difference => {
      const { api, context, draft, snapshot } = fixture();
      api.saveDraft.mockRejectedValueOnce(new Error("PUT response lost"));
      const reconciled: NormalizedDraft = { ...draft, text: `${event.text}\n\n${draft.text}`, revision: 8 };
      if (difference === "older revision") reconciled.revision = 7;
      if (difference === "different text") reconciled.text = "Changed by another client";
      if (difference === "different attachment") reconciled.attachments = [];
      if (difference === "different task") reconciled.taskReferences = [];
      api.readThread.mockResolvedValueOnce(snapshot);
      if (difference === "unreadable") api.readThread.mockRejectedValueOnce(new Error("Connection lost"));
      else api.readThread.mockResolvedValueOnce({ ...snapshot, draft: reconciled });
      await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toThrow("Speech may already be in the original thread's draft");
      expect(api.saveDraft).toHaveBeenCalledOnce();
      expect(api.operateThread).not.toHaveBeenCalled();
    },
  );

  it("does not reconcile or retry a definitive draft revision conflict", async () => {
    const { api, context } = fixture();
    const conflict = new ApiError(409, "draft_conflict", "Draft changed", false);
    api.saveDraft.mockRejectedValueOnce(conflict);
    await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toBe(conflict);
    expect(api.readThread).toHaveBeenCalledOnce();
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("cancels before fetching when the original interaction is no longer current", async () => {
    const { api, context, controller } = fixture();
    controller.abort(new Error("Recording cancelled"));
    await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toThrow("Recording cancelled");
    expect(api.readThread).not.toHaveBeenCalled();
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("cancels after reading without saving speech", async () => {
    const { api, snapshot, context, controller } = fixture();
    api.readThread.mockImplementationOnce(async () => { controller.abort(new Error("Recording cancelled")); return snapshot; });
    await expect(prepareDetachedVoiceSubmission(api, event, context)).rejects.toThrow("Recording cancelled");
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("keeps ownership after cancellation during a successful save without starting delivery", async () => {
    const { api, context, controller } = fixture();
    api.saveDraft.mockImplementationOnce(async (_threadId, candidate) => {
      controller.abort(new Error("Recording cancelled"));
      return { ...candidate, revision: 8 };
    });
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).rejects.toThrow("Speech was saved in the original thread's draft");
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("waits for an in-flight nonabortable PUT to commit after cancellation and retains durable ownership", async () => {
    const { api, context, controller, draft } = fixture();
    let commit!: () => void;
    api.saveDraft.mockImplementationOnce(async (_threadId, candidate) => {
      await new Promise<void>(resolve => { commit = resolve; });
      return { ...candidate, revision: 8 };
    });
    const pending = prepareDetachedVoiceSubmission(api, event, context);
    await vi.waitFor(() => expect(api.saveDraft).toHaveBeenCalledOnce());
    expect(context.beginSave).toHaveBeenCalledOnce();
    expect(api.saveDraft).toHaveBeenCalledExactlyOnceWith(event.threadId, { ...draft, text: `${event.text}\n\n${draft.text}` });
    controller.abort(new Error("Recording cancelled"));
    commit();
    const adopted = await pending;
    await expect(adopted?.submission).rejects.toThrow("Speech was saved in the original thread's draft");
    expect(api.readThread).toHaveBeenCalledOnce();
    expect(api.operateThread).not.toHaveBeenCalled();
  });

  it("never restages or repeats delivery when its response is uncertain", async () => {
    const { api, context } = fixture();
    api.operateThread.mockRejectedValueOnce(new Error("POST response lost"));
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).rejects.toThrow("Voice delivery could not be confirmed");
    expect(api.readThread).toHaveBeenCalledOnce();
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).toHaveBeenCalledOnce();
  });

  it.each([new ApiError(409, "draft_conflict", "Draft changed", false), new ApiError(422, "invalid_input", "Input cannot be sent", false)])(
    "reports a definite delivery refusal with its saved draft intact", async error => {
      const { api, context } = fixture();
      api.operateThread.mockRejectedValueOnce(error);
      const adopted = await prepareDetachedVoiceSubmission(api, event, context);
      await expect(adopted?.submission).rejects.toThrow(`Speech was saved in the original thread's draft, but was not sent: ${error.message}`);
      expect(api.readThread).toHaveBeenCalledOnce();
      expect(api.saveDraft).toHaveBeenCalledOnce();
      expect(api.operateThread).toHaveBeenCalledOnce();
    },
  );

  it.each([new ApiError(409, "operation_outcome_uncertain", "Outcome unknown", false),
    new ApiError(409, "backend_submission_unknown", "Provider outcome unknown", false),
    new ApiError(503, "unavailable", "Response unavailable", true)])(
    "preserves uncertainty instead of claiming a rejected delivery", async error => {
      const { api, context } = fixture();
      api.operateThread.mockRejectedValueOnce(error);
      const adopted = await prepareDetachedVoiceSubmission(api, event, context);
      await expect(adopted?.submission).rejects.toThrow("Voice delivery could not be confirmed");
      expect(api.readThread).toHaveBeenCalledOnce();
      expect(api.saveDraft).toHaveBeenCalledOnce();
      expect(api.operateThread).toHaveBeenCalledOnce();
    },
  );

  it.each(["queued", "pending materialization"] as const)("accepts a %s receipt without another request", async status => {
    const { api, context } = fixture();
    api.operateThread.mockImplementationOnce(async (_threadId, operation) => (status === "queued"
      ? { status: "delivery_queued", draft: emptyDraft(9) }
      : { status: "delivery_pending_materialization", operationId: mutationId(operation) }) as Awaited<ReturnType<ApiClient["operateThread"]>>);
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).resolves.toBeUndefined();
    expect(api.operateThread).toHaveBeenCalledOnce();
  });

  it.each(["operation mismatch", "draft not cleared", "stale draft revision"] as const)("reports an invalid receipt with %s without retrying", async problem => {
    const { api, context } = fixture();
    api.operateThread.mockImplementationOnce(async (_threadId, operation) => ({ status: "delivery_accepted",
      operationId: problem === "operation mismatch" ? "other-operation" : mutationId(operation),
      draft: { ...emptyDraft(problem === "stale draft revision" ? 8 : 9), text: problem === "draft not cleared" ? "Remaining content" : "" },
    }) as Awaited<ReturnType<ApiClient["operateThread"]>>);
    const adopted = await prepareDetachedVoiceSubmission(api, event, context);
    await expect(adopted?.submission).rejects.toThrow("invalid receipt");
    expect(api.saveDraft).toHaveBeenCalledOnce();
    expect(api.operateThread).toHaveBeenCalledOnce();
  });
});
