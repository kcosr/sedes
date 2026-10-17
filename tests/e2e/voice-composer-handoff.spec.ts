import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { normalizedThreadSnapshotSchema } from "../../src/shared/index.js";
import { formatThreadReferenceText } from "../../src/shared/thread-references.js";
import type { NativeVoiceComposerHandoff } from "../../src/client/voice/native-voice-plugin.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, fillAndPersistDraft, openWorkspaceDirectory, selectCustomNewThreadTarget, sendCurrentDraft } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

async function openVoiceWorkspace(page: Page, name: string): Promise<void> {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, name);
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await openWorkspaceDirectory(page, workspace);
}

async function createCodexThread(page: Page, title: string): Promise<string> {
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  await page.getByRole("textbox", { name: "Thread name" }).fill(title);
  const created = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page.getByRole("textbox", { name: /^Message Codex/u })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}

async function expectVoiceComposer(page: Page, threadId: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__voiceFixture.state.foreground)).toMatchObject({
    visible: true, threadId, composerAvailable: true,
  });
}

async function offerSpeech(page: Page, threadId: string, text: string): Promise<NativeVoiceComposerHandoff> {
  return page.evaluate(({ threadId, text, handoffId, recordingId }) => {
    const state = window.__voiceFixture.state;
    if (!state.profileId || !state.serverOrigin || !state.identity) throw new Error("Voice connection is not ready.");
    const event: NativeVoiceComposerHandoff = { profileId: state.profileId, serverOrigin: state.serverOrigin, identity: state.identity,
      connectionGeneration: state.connectionGeneration, handoffId, recordingId, threadId, text, mode: "queue" };
    window.__voiceFixture.emitComposerHandoff(event);
    return event;
  }, { threadId, text, handoffId: randomUUID(), recordingId: randomUUID() });
}

async function expectHandoff(page: Page, event: NativeVoiceComposerHandoff, outcome: "accepted" | "declined", submissionPending = outcome === "accepted"): Promise<void> {
  await expect.poll(() => page.evaluate(handoffId => window.__voiceFixture.calls.find(call =>
    call.method === "completeComposerHandoff" && call.args.handoffId === handoffId)?.args, event.handoffId)).toMatchObject({ outcome, submissionPending });
  expect(await page.evaluate(handoffId => window.__voiceFixture.calls.filter(call =>
    call.method === "claimComposerHandoff" && call.args.handoffId === handoffId).length, event.handoffId)).toBe(1);
}

async function submissionSettlements(page: Page, event: NativeVoiceComposerHandoff) {
  return page.evaluate(handoffId => window.__voiceFixture.calls.filter(call =>
    call.method === "settleComposerSubmission" && call.args.handoffId === handoffId).map(call => call.args), event.handoffId);
}

async function expectSubmissionSettled(page: Page, event: NativeVoiceComposerHandoff): Promise<void> {
  await expect.poll(() => submissionSettlements(page, event)).toEqual([
    { expectedConnectionGeneration: event.connectionGeneration, handoffId: event.handoffId },
  ]);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function deliveredTo(page: Page, threadId: string) {
  return page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === `/api/threads/${threadId}/operations` &&
    response.request().postDataJSON().kind === "deliver" && response.ok());
}

async function uploadNotes(page: Page, fileName: string): Promise<void> {
  const linked = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/draft") && response.ok() && response.request().postDataJSON().attachmentIds?.length === 1);
  await page.getByTestId("composer").locator('input[type="file"]').setInputFiles({
    name: fileName, mimeType: "text/plain", buffer: Buffer.from("Supplemental information that cannot be dictated.\n    Preserve indentation.\n"),
  });
  await linked;
  await expect(page.getByTestId("composer").getByLabel("Attachments").getByText(fileName, { exact: true })).toBeVisible();
  await expect(page.getByTestId("composer").getByLabel("Attachments").locator("[data-upload-id]")).toHaveCount(0);
}

test("foreground dictation sends the live full draft as one composer input without requiring text focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openVoiceWorkspace(page, "voice-full-draft");
  const referencePath = await createDraftThread(page, "Supplemental reference thread");
  const referenceId = referencePath.split("/").at(-1)!;
  const threadId = await createCodexThread(page, "Voice and supplemental context");
  const composer = page.getByRole("textbox", { name: /^Message Codex/u });
  const sourceText = "Original instructions used as quoted context.";
  await fillAndPersistDraft(page, sourceText, "Message Codex TCP");
  await sendCurrentDraft(page);
  await expect(page.locator(".conversation-turn").last()).toHaveAttribute("data-turn-status", "completed");
  await uploadNotes(page, "voice-supplement.txt");
  const skillSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/draft") && response.ok() && typeof response.request().postDataJSON().selectedSkillId === "string");
  await page.getByRole("button", { name: "Choose skill", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose a skill", exact: true }).getByText("Review Changes", { exact: true }).click();
  const selectedSkillId = (await skillSaved).request().postDataJSON().selectedSkillId as string;
  const session = await (await page.request.get("/api/application/session")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const taskResult = await page.request.post("/api/tasks", { headers, data: { mutationId: randomUUID(), title: "Review supplemental snippet",
    details: "Keep this task context in the same input.", scope: { kind: "thread", threadId } } });
  expect(taskResult.status()).toBe(201);
  const taskId = (await taskResult.json()).task.id as string;
  const snapshot = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`/api/threads/${threadId}?activityDetail=full`)).json());
  const source = Object.values(snapshot.itemsById).find(item => item.kind === "user_message")!;
  const excerpt = { id: randomUUID(), excerpt: sourceText, note: "Check this quotation with the snippet.",
    source: { kind: "conversation_message" as const, itemId: source.id, itemRevision: source.revision }, locator: { kind: "text_quote" as const } };
  const references = [{ threadId: referenceId, title: "Supplemental reference thread" }];
  const seeded = await page.request.put(`/api/threads/${threadId}/draft`, { headers, data: {
    text: formatThreadReferenceText("Older saved text.", references), selectedSkillId, contextExcerpts: [excerpt],
    attachmentIds: snapshot.draft.attachments.map(attachment => attachment.id), taskReferenceIds: [taskId], expectedRevision: snapshot.draft.revision,
  } });
  expect(seeded.ok()).toBe(true);
  await page.reload();
  await expect(composer).toHaveValue("Older saved text.");
  await expect(page.getByTestId("selected-skill")).toContainText("Review Changes");
  await expect(page.getByTestId("composer").getByLabel("Context excerpts")).toContainText(excerpt.note);
  await expect(page.getByTestId("composer").getByLabel("Attached tasks")).toContainText("Review supplemental snippet");
  await expectVoiceComposer(page, threadId);
  const speech = "Please inspect this supplemental information.";
  const snippet = "function supplemental() {\n    return 'keep this indentation';\n}\n";
  const combined = formatThreadReferenceText(`${speech}\n\n${snippet}`, references);
  const saveEntered = gate(), saveGate = gate(), sendEntered = gate(), sendGate = gate();
  const draftPattern = `**/api/threads/${threadId}/draft`;
  const sendPattern = `**/api/threads/${threadId}/operations`;
  await page.route(draftPattern, async route => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().text === combined) {
      saveEntered.release();
      await saveGate.promise;
    }
    await route.continue();
  });
  await page.route(sendPattern, async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().kind === "deliver") {
      sendEntered.release();
      await sendGate.promise;
    }
    await route.continue();
  });
  const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith(`/threads/${threadId}/draft`) && response.ok() && response.request().postDataJSON().text === combined);
  const sent = deliveredTo(page, threadId);
  expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
  try {
    // Offer before the two-second autosave debounce; focus is on a voice control.
    await composer.fill(snippet);
    await page.getByRole("button", { name: "Open voice controls", exact: true }).focus();
    await expect(composer).not.toBeFocused();
    const event = await offerSpeech(page, threadId, speech);
    await expectHandoff(page, event, "accepted");
    await saveEntered.promise;
    await expect(composer).toHaveValue("");
    await expect(page.locator('[data-item-kind="user_message"]').last()).toContainText(speech);
    await expect(page.locator('[data-item-kind="user_message"]').last()).toContainText("voice-supplement.txt");
    expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
    expect(await submissionSettlements(page, event)).toEqual([]);
    saveGate.release();
    await expect(page.getByRole("button", { name: "Open voice controls", exact: true })).toBeFocused();
    expect((await saved).request().postDataJSON()).toMatchObject({ text: combined, selectedSkillId,
      contextExcerpts: [excerpt], attachmentIds: snapshot.draft.attachments.map(attachment => attachment.id), taskReferenceIds: [taskId] });
    await sendEntered.promise;
    await expect(composer).toHaveValue("");
    expect(await submissionSettlements(page, event)).toEqual([]);
    sendGate.release();
    expect((await sent).request().postDataJSON()).toMatchObject({ kind: "deliver", mode: "submit" });
    await expectSubmissionSettled(page, event);
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("composer").getByLabel("Attachments")).toHaveCount(0);
    await expect(page.getByTestId("composer").getByLabel("Context excerpts")).toHaveCount(0);
    await expect(page.getByTestId("composer").getByLabel("Attached tasks")).toHaveCount(0);
    await expect(page.getByTestId("selected-skill")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(2);
    await expect(page.locator(".conversation-turn").last()).toContainText(speech);
    await expect(page.locator(".conversation-turn").last()).toContainText("voice-supplement.txt");
    expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
    await expect(page.getByRole("button", { name: "Saved dictation", exact: true })).toHaveCount(0);
    await capture(page, testInfo, "voice-full-draft-streaming.png");
  } finally {
    saveGate.release();
    sendGate.release();
    await page.unroute(draftPattern);
    await page.unroute(sendPattern);
    expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
  }
  await expect(page.locator(".conversation-turn").last()).toHaveAttribute("data-turn-status", "completed");
  await capture(page, testInfo, "voice-full-draft-completed.png");
});

test("voice uses an empty visible composer and declines stale offers for another thread or a hidden app", async ({ page }) => {
  await openVoiceWorkspace(page, "voice-handoff-eligibility");
  const targetPath = await createDraftThread(page, "Unviewed voice target");
  const targetId = targetPath.split("/").at(-1)!;
  await fillAndPersistDraft(page, "Keep the target draft.");
  const viewedPath = await createDraftThread(page, "Viewed voice target");
  const viewedId = viewedPath.split("/").at(-1)!;
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  await fillAndPersistDraft(page, "Keep the viewed draft.");
  await expectVoiceComposer(page, viewedId);
  // A late native offer is rechecked against the current view before consuming it.
  const wrongThread = await offerSpeech(page, targetId, "Do not consume either draft.");
  await expectHandoff(page, wrongThread, "declined");
  await expect(composer).toHaveValue("Keep the viewed draft.");
  expect((await (await page.request.get(`/api/threads/${targetId}?activityDetail=full`)).json()).draft.text).toBe("Keep the target draft.");
  expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery?.recordingId)).toBe(wrongThread.recordingId);
  await publishVoiceState(page, { active: null, recordingRecovery: null, phase: "idle", actions: voiceFixtureState().actions });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.__voiceFixture.state.foreground.visible)).toBe(false);
  const hidden = await offerSpeech(page, viewedId, "Hidden speech must stay native.");
  await expectHandoff(page, hidden, "declined");
  await expect(composer).toHaveValue("Keep the viewed draft.");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await publishVoiceState(page, { active: null, recordingRecovery: null, phase: "idle", actions: voiceFixtureState().actions });
  await fillAndPersistDraft(page, "");
  await expectVoiceComposer(page, viewedId);
  const sent = deliveredTo(page, viewedId);
  const empty = await offerSpeech(page, viewedId, "Speech alone still belongs to the composer.");
  await expectHandoff(page, empty, "accepted");
  await sent;
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(1);
  await expect(page.locator('[data-item-kind="user_message"]')).toContainText(empty.text);
  expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
});

test("a rejected voice composer send restores the full contribution alongside later typing without voice recovery", async ({ page, browserDiagnostics }, testInfo) => {
  await openVoiceWorkspace(page, "voice-composer-rejection");
  const threadPath = await createDraftThread(page, "Voice send rejection");
  const threadId = threadPath.split("/").at(-1)!;
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  await uploadNotes(page, "voice-recovery.txt");
  await fillAndPersistDraft(page, "Original pasted context.");
  await expectVoiceComposer(page, threadId);
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  browserDiagnostics.allowedConsoleErrors.push(/Failed to load resource: the server responded with a status of 409/u);
  const pattern = `**/api/threads/${threadId}/operations`;
  await page.route(pattern, async route => {
    if (route.request().postDataJSON().kind !== "deliver") { await route.continue(); return; }
    enter();
    await gate;
    await route.fulfill({ status: 409, json: { error: { code: "backend_rejected", message: "The fixture proved this input was not accepted.", retryable: false } } });
  });
  try {
    const event = await offerSpeech(page, threadId, "Please examine this snippet.");
    await expectHandoff(page, event, "accepted");
    await entered;
    await expect(composer).toHaveValue("");
    expect(await submissionSettlements(page, event)).toEqual([]);
    await composer.fill("New typing while the send is pending.");
    release();
    await expect(composer).toHaveValue("Please examine this snippet.\n\nOriginal pasted context.\n\nNew typing while the send is pending.");
    await expectSubmissionSettled(page, event);
    await expect(page.getByTestId("composer").getByLabel("Attachments")).toContainText("voice-recovery.txt");
    expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
    await expect(page.getByRole("button", { name: "Saved dictation", exact: true })).toHaveCount(0);
    await capture(page, testInfo, "voice-composer-rejection-recovered.png");
  } finally {
    release();
    await page.unroute(pattern);
  }
  const sent = deliveredTo(page, threadId);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await sent;
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(1);
});

test("voice holds a pending attachment in the composer until the user sends the complete draft", async ({ page }, testInfo) => {
  await openVoiceWorkspace(page, "voice-composer-pending-upload");
  const threadPath = await createDraftThread(page, "Voice with uploading context");
  const threadId = threadPath.split("/").at(-1)!;
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  await fillAndPersistDraft(page, "Pasted upload context.");
  await expectVoiceComposer(page, threadId);
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pattern = "**/api/threads/*/composer-attachments/*";
  await page.route(pattern, async route => {
    if (route.request().method() === "PUT") { enter(); await gate; }
    await route.continue();
  });
  const deliveries: unknown[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/threads/${threadId}/operations` && request.postDataJSON().kind === "deliver")
      deliveries.push(request.postDataJSON());
  });
  const linked = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/draft") &&
    response.ok() && response.request().postDataJSON().attachmentIds?.length === 1);
  try {
    await page.getByTestId("composer").locator('input[type="file"]').setInputFiles({
      name: "uploading-voice-context.txt", mimeType: "text/plain", buffer: Buffer.from("Keep this attachment with the dictated instruction."),
    });
    await entered;
    const event = await offerSpeech(page, threadId, "Read the uploaded supplement.");
    await expectHandoff(page, event, "accepted", false);
    await expect(composer).toHaveValue("Read the uploaded supplement.\n\nPasted upload context.");
    await expect(page.getByTestId("composer")).toContainText("Wait for attachment uploads to finish, then press Send.");
    await expect(page.getByTestId("composer").getByLabel("Attachments").locator("[data-upload-id]")).toHaveCount(1);
    expect(deliveries).toEqual([]);
    expect(await submissionSettlements(page, event)).toEqual([]);
    expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
    await capture(page, testInfo, "voice-pending-upload-owned-by-composer.png");
  } finally {
    release();
  }
  await linked;
  await page.unroute(pattern);
  await expect(page.getByTestId("composer").getByLabel("Attachments").locator("[data-upload-id]")).toHaveCount(0);
  expect(deliveries).toEqual([]);
  await sendCurrentDraft(page);
  expect(deliveries).toHaveLength(1);
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(1);
  await expect(page.locator(".conversation-turn").last()).toContainText("uploading-voice-context.txt");
});
