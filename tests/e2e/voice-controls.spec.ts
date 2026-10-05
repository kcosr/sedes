import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { NativeRecordingRecovery } from "../../src/client/voice/native-voice-plugin.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

test("native dictation keeps its controls reachable on narrow screens and retains saved recovery while Off", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-controls");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page);
  const threadId = threadPath.split("/").at(-1)!;
  const draft = "Keep my independently edited draft here.";
  await fillAndPersistDraft(page, draft);
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const base = voiceFixtureState();
  const title = "Dictation for the release checklist and the remaining deployment verification";
  const active = { id: "interaction", eventKind: "manual", threadId, threadTitle: title, recognitionThreadId: threadId,
    recognitionThreadTitle: title, automatic: false, recording: { id: "recording", keepListening: false, reconnecting: false } };
  await publishVoiceState(page, { phase: "listening", active, actions: { ...base.actions, canStart: false, canStop: true,
    canRetarget: true, canSetKeepListening: true, keepListeningBlockedReason: null } });
  await page.setViewportSize({ width: 320, height: 780 });
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const keep = toolbar.getByRole("button", { name: "Keep listening", exact: true });
  await expect(keep).toHaveAttribute("aria-pressed", "false");
  await keep.focus();
  await keep.press("Space");
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(keep).toBeFocused();
  const send = toolbar.getByRole("button", { name: "Send voice recording" });
  const cancel = toolbar.getByRole("button", { name: "Cancel voice recording" });
  await expect(send).toBeVisible();
  await expect(toolbar).toContainText("Listening");
  await expect(toolbar).not.toContainText(/elapsed|segment|\d+:\d+/iu);
  const change = toolbar.getByRole("button", { name: `Change recording target: ${title}` });
  const [changeBox, keepBox, cancelBox, sendBox] = await Promise.all([change.boundingBox(), keep.boundingBox(), cancel.boundingBox(), send.boundingBox()]);
  expect(keepBox!.x).toBeGreaterThanOrEqual(changeBox!.x + changeBox!.width);
  expect(Math.abs(keepBox!.y + keepBox!.height / 2 - changeBox!.y - changeBox!.height / 2)).toBeLessThan(1);
  expect(sendBox!.x).toBeGreaterThanOrEqual(cancelBox!.x + cancelBox!.width);
  for (const box of [keepBox!, cancelBox!, sendBox!]) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-narrow.png");

  await publishVoiceState(page, { active: { ...active, recording: { id: "recording", keepListening: true, reconnecting: true } } });
  await expect(toolbar.locator(".voice-card-reconnecting")).toHaveText("Reconnecting");
  await expect(toolbar).toContainText("Listening");
  await expect(send).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-reconnecting-narrow.png");
  await expect(composer).toHaveValue(draft);
  await send.click();
  await expect(toolbar).toContainText("Recognizing…");
  await expect(keep).toHaveCount(0);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecording"))).toEqual([
    { method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording" } },
  ]);

  const saved: NativeRecordingRecovery = { recordingId: "recording", revision: 4, threadId, threadTitle: title, stage: "interrupted",
    reason: "Voice was turned off before recognition finished.", hasUnrecognizedAudio: true, captureIncomplete: true,
    canRetryRecognition: false, canSend: false, canCopyRecognizedText: true, canDiscard: true, admission: null };
  await publishVoiceState(page, { active: null, phase: "off", readiness: "off", ready: false,
    settings: { ...base.settings, audioMode: "off" }, actions: { ...base.actions, canStart: false }, recordingRecovery: saved });
  await expect(toolbar).toContainText("Saved dictation");
  await expect(toolbar.getByRole("button", { name: "Retry saved dictation" })).toBeDisabled();
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
  await expect(toolbar.getByRole("button", { name: "Start voice recording" })).toHaveCount(0);
  const savedLabel = toolbar.locator(".voice-card-saved-label");
  expect(await savedLabel.evaluate(label => label.getBoundingClientRect().right <= label.parentElement!.getBoundingClientRect().right)).toBe(true);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-saved-dictation-off-narrow.png");
  await page.reload();
  await expect(toolbar).toContainText("Saved dictation");
  await toolbar.getByRole("button", { name: "Open voice controls" }).click();
  const sheet = page.getByRole("dialog", { name: "Voice", exact: true });
  await expect(sheet).toContainText("The end of this dictation may be missing");
  await expect(sheet.getByRole("button", { name: "Copy recognized text" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /restore|composer/iu })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(composer).toHaveValue(draft);

  await publishVoiceState(page, { phase: "recordingRecovery", ready: true, readiness: "ready", settings: base.settings,
    recordingRecovery: { ...saved, revision: 5, canRetryRecognition: true } });
  await toolbar.getByRole("button", { name: "Retry saved dictation" }).click();
  await expect(toolbar).toContainText("Recognizing saved audio…");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "retryRecordingRecognition").at(-1))).toEqual({
    method: "retryRecordingRecognition", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 5 },
  });
  await publishVoiceState(page, { phase: "off", active: null, ready: false, readiness: "off", settings: { ...base.settings, audioMode: "off" },
    recordingRecovery: { ...saved, revision: 7, stage: "ready", reason: null, hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true } });
  await expect(toolbar).toContainText("Ready to send");
  await expect(toolbar.getByRole("button", { name: "Send saved dictation" })).toBeEnabled();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-ready-dictation-off-narrow.png");
  await toolbar.getByRole("button", { name: "Send saved dictation" }).click();
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecoveredRecording"))).toEqual([
    { method: "sendRecoveredRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 7 } },
  ]);
  await expect(composer).toHaveValue(draft);
});
