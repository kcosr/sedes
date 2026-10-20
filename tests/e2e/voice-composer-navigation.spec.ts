import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { NativeVoiceComposerHandoff } from "../../src/client/voice/native-voice-plugin.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/index.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, fillAndPersistDraft, openWorkspaceDirectory, selectCustomNewThreadTarget } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
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

async function offerSpeech(page: Page, threadId: string, recordingId: string, text: string): Promise<NativeVoiceComposerHandoff> {
  return page.evaluate(({ threadId, recordingId, text, handoffId }) => {
    const state = window.__voiceFixture.state;
    if (!state.profileId || !state.serverOrigin || !state.identity) throw new Error("Voice connection is not ready.");
    const event: NativeVoiceComposerHandoff = { profileId: state.profileId, serverOrigin: state.serverOrigin, identity: state.identity,
      connectionGeneration: state.connectionGeneration, handoffId, recordingId, threadId, text, mode: "queue" };
    window.__voiceFixture.emitComposerHandoff(event);
    return event;
  }, { threadId, recordingId, text, handoffId: randomUUID() });
}

for (const timing of ["before handoff", "during claim", "back during claim", "back before ready"] as const) {
  test(`voice sends the original saved composer with its attachment when navigating ${timing}`, async ({ page }, testInfo) => {
    const roundTrip = timing.startsWith("back ");
    const resumePending = timing === "back before ready";
    await page.setViewportSize({ width: 1280, height: 1000 });
    const workspace = path.join(loadE2ERunContext().workspacesDirectory, `voice-navigation-${timing.replaceAll(" ", "-")}`);
    await mkdir(workspace, { recursive: true });
    await installVoiceFixture(page);
    await openWorkspaceDirectory(page, workspace);
    const otherPath = await createDraftThread(page, "Other draft remains untouched");
    const otherId = otherPath.split("/").at(-1)!;
    const otherText = "Keep these separate instructions in the other thread.";
    await fillAndPersistDraft(page, otherText);
    const originalId = await createCodexThread(page, "Original voice destination");
    const composer = page.getByRole("textbox", { name: /^Message Codex/u });
    const fileName = "original-voice-context.txt";
    const linked = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().endsWith(`/threads/${originalId}/draft`) && response.ok() && response.request().postDataJSON().attachmentIds?.length === 1);
    await page.getByTestId("composer").locator('input[type="file"]').setInputFiles({
      name: fileName, mimeType: "text/plain", buffer: Buffer.from("Completed upload belongs to the original voice message.\n"),
    });
    await linked;
    await expect(page.getByTestId("composer").getByLabel("Attachments").locator("[data-upload-id]")).toHaveCount(0);
    await fillAndPersistDraft(page, "Older persisted composer text.", "Message Codex TCP");
    const before = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`/api/threads/${originalId}?activityDetail=full`)).json());
    const attachmentIds = before.draft.attachments.map(attachment => attachment.id);
    expect(attachmentIds).toHaveLength(1);
    await expect.poll(() => page.evaluate(() => window.__voiceFixture.state.foreground)).toMatchObject({
      visible: true, threadId: originalId, composerAvailable: true,
    });

    const recordingId = randomUUID();
    const base = voiceFixtureState();
    await publishVoiceState(page, { phase: "listening", active: { id: randomUUID(), eventKind: "manual", threadId: originalId,
      threadTitle: "Original voice destination", recognitionThreadId: originalId, recognitionThreadTitle: "Original voice destination",
      automatic: false, recording: { id: recordingId, keepListening: false, reconnecting: false } },
      actions: { ...base.actions, canStart: false, canStop: true, canRetarget: true, canSetKeepListening: true,
        canSend: true, keepListeningBlockedReason: null } });
    const dirtyText = "function unsavedContext() {\n    return 'save this final edit';\n}";
    const latestText = roundTrip && !resumePending ? `${dirtyText}\n// Latest edit after returning to the original thread.` : dirtyText;
    const speech = "Please review this function and its attached notes.";
    const combined = `${speech}\n\n${latestText}`;
    const flushEntered = gate(), flushGate = gate();
    const resumeEntered = gate(), resumeGate = gate();
    const draftPattern = `**/api/threads/${originalId}/draft`;
    const resumePattern = (url: URL) => url.pathname === `/api/threads/${originalId}/events`;
    const deliveries: { threadId: string; body: unknown }[] = [];
    const draftWrites: string[] = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "PUT" && pathname === `/api/threads/${originalId}/draft`)
        draftWrites.push(request.postDataJSON().text);
      const match = /^\/api\/threads\/([^/]+)\/operations$/u.exec(pathname);
      if (request.method() === "POST" && match && request.postDataJSON().kind === "deliver")
        deliveries.push({ threadId: match[1]!, body: request.postDataJSON() });
    });
    await page.route(draftPattern, async route => {
      if (route.request().method() === "PUT" && route.request().postDataJSON().text === dirtyText) {
        flushEntered.release();
        await flushGate.promise;
      }
      await route.continue();
    });
    const combinedSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().endsWith(`/threads/${originalId}/draft`) && response.ok() && response.request().postDataJSON().text === combined);
    const delivered = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/threads/${originalId}/operations` &&
      response.request().postDataJSON().kind === "deliver" && response.ok());
    let claimHeld = false;
    let foregroundHeld = false;
    expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
    try {
      // Navigate before the autosave debounce; the departing composer's final
      // save is deliberately held so fallback cannot rely on lucky HTTP timing.
      await composer.fill(dirtyText);
      await page.getByRole("button", { name: "Send voice recording", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecording").length)).toBe(1);
      let event: NativeVoiceComposerHandoff | undefined;
      if (timing !== "before handoff") {
        await page.evaluate(() => window.__voiceFixture.holdComposerClaim());
        claimHeld = true;
        event = await offerSpeech(page, originalId, recordingId, speech);
        await expect.poll(() => page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "claimComposerHandoff").length)).toBe(1);
      }
      // Use client-side navigation: a full reload would discard the pending JS owner.
      await page.getByTestId("desktop-sidebar").locator(`[data-thread-id="${otherId}"]`).getByTestId("thread-row-link").click();
      await expect(page).toHaveURL(otherPath);
      const otherComposer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
      await expect(otherComposer).toHaveValue(otherText);
      await flushEntered.promise;
      if (claimHeld && !roundTrip) {
        await page.evaluate(() => window.__voiceFixture.settleComposerClaim());
        claimHeld = false;
      } else if (!claimHeld) event = await offerSpeech(page, originalId, recordingId, speech);
      const handoff = event!;
      await expect.poll(() => page.evaluate(handoffId => window.__voiceFixture.calls.filter(call =>
        call.method === "claimComposerHandoff" && call.args.handoffId === handoffId).length, handoff.handoffId)).toBe(1);
      expect(deliveries).toEqual([]);
      expect(await page.evaluate(handoffId => window.__voiceFixture.calls.filter(call =>
        call.method === "completeComposerHandoff" && call.args.handoffId === handoffId), handoff.handoffId)).toEqual([]);
      expect((await (await page.request.get(`/api/threads/${originalId}?activityDetail=full`)).json()).draft.text).toBe(before.draft.text);
      await expect(otherComposer).toHaveValue(otherText);
      if (roundTrip) {
        const departed = page.waitForResponse(response => response.request().method() === "PUT" &&
          response.url().endsWith(`/threads/${originalId}/draft`) && response.ok() && response.request().postDataJSON().text === dirtyText);
        flushGate.release();
        await departed;
        await expect.poll(() => page.evaluate(() => window.__voiceFixture.state.foreground.threadId)).toBe(otherId);
        if (resumePending) {
          await page.route(resumePattern, async route => {
            resumeEntered.release();
            await resumeGate.promise;
            await route.continue();
          });
        } else {
          await page.evaluate(threadId => window.__voiceFixture.holdForegroundContext(threadId), originalId);
          foregroundHeld = true;
        }
        await page.getByTestId("desktop-sidebar").locator(`[data-thread-id="${originalId}"]`).getByTestId("thread-row-link").click();
        if (resumePending) {
          // Cached content can mount before its new stream becomes authoritative.
          // Release the handoff at that boundary, without waiting for readiness.
          await resumeEntered.promise;
          await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
          await expect.poll(() => page.evaluate(() => window.__voiceFixture.state.foreground)).toMatchObject({
            visible: true, threadId: originalId, composerAvailable: true,
          });
        } else {
          await expect(composer).toHaveValue(dirtyText);
          await composer.fill(latestText);
          // The newly mounted composer is current even while native still reports
          // the other thread. Its latest local edit must win over a detached read.
          expect(await page.evaluate(() => window.__voiceFixture.state.foreground.threadId)).toBe(otherId);
        }
        await page.evaluate(() => window.__voiceFixture.settleComposerClaim());
        claimHeld = false;
      } else flushGate.release();
      expect((await combinedSaved).request().postDataJSON()).toMatchObject({ text: combined, attachmentIds });
      if (foregroundHeld) {
        await page.evaluate(() => window.__voiceFixture.settleForegroundContext());
        foregroundHeld = false;
      }
      await expect.poll(() => page.evaluate(handoffId => window.__voiceFixture.calls.find(call =>
        call.method === "completeComposerHandoff" && call.args.handoffId === handoffId)?.args, handoff.handoffId)).toMatchObject({
        outcome: "accepted", submissionPending: true,
      });
      expect((await delivered).request().postDataJSON()).toMatchObject({ kind: "deliver", mode: "submit" });
      resumeGate.release();
      await expect.poll(() => page.evaluate(handoffId => window.__voiceFixture.calls.filter(call =>
        call.method === "settleComposerSubmission" && call.args.handoffId === handoffId).length, handoff.handoffId)).toBe(1);
      if (!roundTrip) await expect(otherComposer).toHaveValue(otherText);
      expect((await (await page.request.get(`/api/threads/${otherId}?activityDetail=full`)).json()).draft.text).toBe(otherText);
      expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery)).toBeNull();
      await expect(page.getByRole("button", { name: "Saved dictation", exact: true })).toHaveCount(0);
      await page.getByTestId("desktop-sidebar").locator(`[data-thread-id="${originalId}"]`).getByTestId("thread-row-link").click();
      await expect(composer).toHaveValue("");
      await expect(page.locator('[data-item-kind="user_message"]')).toHaveCount(1);
      await expect(page.locator('[data-item-kind="user_message"]')).toContainText(speech);
      await expect(page.locator('[data-item-kind="user_message"]')).toContainText(latestText);
      await expect(page.locator(".conversation-turn").last()).toContainText(fileName);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await capture(page, testInfo, `voice-navigation-${timing.replaceAll(" ", "-")}-streaming.png`);
    } finally {
      flushGate.release();
      resumeGate.release();
      if (claimHeld) await page.evaluate(() => window.__voiceFixture.settleComposerClaim());
      if (foregroundHeld) await page.evaluate(() => window.__voiceFixture.settleForegroundContext());
      await page.unroute(draftPattern);
      if (resumePending) await page.unroute(resumePattern);
      expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
    }
    await expect(page.locator(".conversation-turn").last()).toHaveAttribute("data-turn-status", "completed");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.threadId).toBe(originalId);
    expect(draftWrites).toEqual([dirtyText, combined]);
    await capture(page, testInfo, `voice-navigation-${timing.replaceAll(" ", "-")}-completed.png`);
  });
}
