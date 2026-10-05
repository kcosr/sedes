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
  const threadPath = await createDraftThread(page, "Voice navigation source");
  const threadId = threadPath.split("/").at(-1)!;
  const draft = "Keep my independently edited draft here.";
  await fillAndPersistDraft(page, draft);
  const otherThreadPath = await createDraftThread(page, "Voice navigation destination");
  const otherThreadId = otherThreadPath.split("/").at(-1)!;
  await fillAndPersistDraft(page, "A separate draft in the voice destination.");
  await page.goto(threadPath);
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const heights: Record<string, number> = {};
  const viewports: Record<string, number> = {};
  const leftOffsets: Record<string, { tile: number; title: number; status: number; tileTextGap: number }> = {};
  const measureRow = async (state: string) => {
    viewports[state] = page.viewportSize()!.width;
    heights[state] = (await toolbar.boundingBox())!.height;
    expect(heights[state], `${state} preserves the original 60px row`).toBe(60);
    const [tile, title, status] = await Promise.all([
      toolbar.locator(".voice-card-tile").boundingBox(), toolbar.locator(".voice-card-title").boundingBox(), toolbar.locator(".voice-card-sub").boundingBox(),
    ]);
    leftOffsets[state] = { tile: tile!.x, title: title!.x, status: status!.x, tileTextGap: title!.x - tile!.x - tile!.width };
    expect(leftOffsets[state], `${state} preserves the Ready-state icon and text positions`).toEqual(leftOffsets.idleBeforeRecording);
    expect(leftOffsets[state].tileTextGap, `${state} preserves the Ready-state icon/text gap`).toBe(8);
  };
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(toolbar).toBeVisible();
  await measureRow("idleBeforeRecording");
  await capture(page, testInfo, "voice-ready-spacing-narrow.png");
  const base = voiceFixtureState();
  const idleChooser = toolbar.getByRole("button", { name: "Choose target thread: Voice navigation source", exact: true });
  await expect(idleChooser).toBeVisible();
  await toolbar.locator(".voice-card-title").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${threadPath}$`, "u"));
  const targetPicker = page.getByRole("dialog", { name: "Choose target thread", exact: true });
  await idleChooser.click();
  await expect(targetPicker).toHaveAttribute("data-slot", "popover-content");
  await expect(targetPicker.getByRole("searchbox", { name: "Search voice threads" })).not.toBeFocused();
  await targetPicker.getByRole("button", { name: "Voice navigation destination", exact: true }).click();
  await expect(targetPicker).toHaveCount(0);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Voice navigation destination");
  await expect(page).toHaveURL(new RegExp(`${threadPath}$`, "u"));
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "setNextRecordingTarget"))).toEqual([
    { method: "setNextRecordingTarget", args: { expectedConnectionGeneration: 1, threadId: otherThreadId, threadTitle: "Voice navigation destination" } },
  ]);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => ["startManualListen", "retargetActiveRecognition", "updateSettings"].includes(call.method)))).toEqual([]);
  expect(await page.evaluate(() => ({ nextRecordingTarget: window.__voiceFixture.state.nextRecordingTarget,
    savedDefault: window.__voiceFixture.state.settings.voiceThreadId }))).toEqual({
    nextRecordingTarget: { threadId: otherThreadId, threadTitle: "Voice navigation destination" }, savedDefault: null,
  });
  await publishVoiceState(page, { nextRecordingTarget: null });
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Voice navigation source");
  await publishVoiceState(page, { settings: { ...base.settings, keepListeningByDefault: true } });
  const heldStart = toolbar.getByRole("button", { name: "Start recording with Keep listening", exact: true });
  await expect(heldStart.locator(".lucide-infinity")).toBeVisible();
  await expect(heldStart).not.toHaveAttribute("aria-pressed");
  await measureRow("idleKeepListeningDefault");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-idle-keep-listening-default-narrow.png");
  const title = "Dictation for the release checklist and the remaining deployment verification";
  const active = { id: "interaction", eventKind: "manual", threadId: otherThreadId, threadTitle: title, recognitionThreadId: otherThreadId,
    recognitionThreadTitle: title, automatic: false, recording: { id: "recording", keepListening: false, reconnecting: false } };
  const startBox = (await heldStart.boundingBox())!;
  for (const phase of ["validating", "arming"] as const) {
    await publishVoiceState(page, { phase, active: { ...active, recording: null }, actions: { ...base.actions, canStart: false, canStop: true } });
    await expect(toolbar.getByRole("button", { name: "Cancel voice recording" })).toBeEnabled();
    await page.mouse.click(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
    await measureRow(phase);
  }
  await publishVoiceState(page, { phase: "listening", settings: base.settings, active, actions: { ...base.actions, canStart: false, canStop: true,
    canRetarget: true, canSetKeepListening: true, keepListeningBlockedReason: null } });
  const change = toolbar.getByRole("button", { name: `Change recording thread: ${title}` });
  await expect(toolbar.locator(".voice-card-title")).toHaveText(title);
  await expect(change.locator(".lucide-chevron-down")).toBeVisible();
  await expect(change).toHaveText("");
  // The title/status overlay navigates; only the separate chevron retargets.
  const titleBox = (await toolbar.locator(".voice-card-title").boundingBox())!;
  await page.mouse.click(titleBox.x + 12, titleBox.y + titleBox.height / 2);
  await expect(page).toHaveURL(new RegExp(`${otherThreadPath}$`, "u"));
  await expect(targetPicker).toHaveCount(0);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "retargetActiveRecognition"))).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await change.click();
  await expect(targetPicker.getByRole("searchbox", { name: "Search voice threads" })).toBeFocused();
  await targetPicker.press("Escape");
  await expect(targetPicker).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 780 });
  await change.click();
  await expect(targetPicker).toContainText("Recognized text will be sent to the thread you select.");
  await expect(targetPicker).toBeFocused();
  await expect(targetPicker.getByRole("searchbox", { name: "Search voice threads" })).not.toBeFocused();
  await capture(page, testInfo, "voice-thread-picker-mobile-browsing.png");
  await targetPicker.getByRole("button", { name: "Voice navigation source", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${otherThreadPath}$`, "u"));
  await expect(toolbar.getByRole("button", { name: /^Open thread:/u })).toBeVisible();
  const statusBox = (await toolbar.locator(".voice-card-sub").boundingBox())!;
  await page.mouse.click(statusBox.x + 12, statusBox.y + statusBox.height / 2);
  await expect(page).toHaveURL(new RegExp(`${threadPath}$`, "u"));
  await expect(targetPicker).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await toolbar.getByRole("button", { name: /^Change recording thread:/u }).click();
  await targetPicker.getByRole("button", { name: "Voice navigation destination", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath}$`, "u"));
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "retargetActiveRecognition").map(call => ({
    method: call.method, args: { expectedConnectionGeneration: call.args.expectedConnectionGeneration, recordingId: call.args.recordingId, threadId: call.args.threadId },
  })))).toEqual([
    { method: "retargetActiveRecognition", args: { expectedConnectionGeneration: 1, recordingId: "recording", threadId } },
    { method: "retargetActiveRecognition", args: { expectedConnectionGeneration: 1, recordingId: "recording", threadId: otherThreadId } },
  ]);
  await publishVoiceState(page, { active });
  const keep = toolbar.getByRole("button", { name: "Keep listening", exact: true });
  await expect(keep).toHaveAttribute("aria-pressed", "false");
  await measureRow("ordinaryListening");
  const send = toolbar.getByRole("button", { name: "Send voice recording" });
  const cancel = toolbar.getByRole("button", { name: "Cancel voice recording" });
  const assertSafeKeepToggle = async () => {
    await expect(keep).toHaveAttribute("aria-pressed", "false");
    await expect(send).toHaveCount(0);
    const ordinaryKeep = (await keep.boundingBox())!;
    const ordinaryCancel = (await cancel.boundingBox())!;
    await keep.focus();
    await keep.press("Space");
    await expect(keep).toHaveAttribute("aria-pressed", "true");
    await expect(keep).toBeFocused();
    await expect(send).toBeVisible();
    await expect.poll(() => keep.boundingBox()).toEqual(ordinaryKeep);
    await expect.poll(() => cancel.boundingBox()).toEqual(ordinaryCancel);
    // A second tap at the original infinity coordinates toggles it off;
    // Cancel must never move into this hit region as Send appears.
    await page.mouse.click(ordinaryKeep.x + ordinaryKeep.width / 2, ordinaryKeep.y + ordinaryKeep.height / 2);
    await expect(keep).toHaveAttribute("aria-pressed", "false");
    await expect(send).toHaveCount(0);
    await expect.poll(() => keep.boundingBox()).toEqual(ordinaryKeep);
    await expect.poll(() => cancel.boundingBox()).toEqual(ordinaryCancel);
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
    await keep.press("Space");
    await expect(keep).toHaveAttribute("aria-pressed", "true");
  };
  await assertSafeKeepToggle();
  await expect(send).toBeVisible();
  await expect(toolbar).toContainText("Listening");
  await expect(toolbar).not.toContainText(/elapsed|segment|\d+:\d+/iu);
  const tile = toolbar.getByRole("button", { name: "Open voice controls" });
  await expect(tile.locator(".voice-card-menu-mark")).toBeVisible();
  await expect(tile.locator(".lucide-mic")).toBeVisible();
  const body = toolbar.getByRole("button", { name: `Open thread: ${title}` });
  const controlGaps: Record<string, { bodyTarget: number | null; targetKeep: number | null; bodyKeep: number | null; keepCancel: number; cancelSend: number }> = {};
  const measureControlGaps = async (state: string) => {
    const target = toolbar.locator(".voice-card-target");
    const [bodyBox, targetBox, keepBox, cancelBox, sendBox] = await Promise.all([
      body.boundingBox(), await target.count() ? target.boundingBox() : null, keep.boundingBox(), cancel.boundingBox(), send.boundingBox(),
    ]);
    for (const box of [bodyBox, targetBox, keepBox, cancelBox, sendBox].filter(box => box !== null)) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    return controlGaps[state] = {
      bodyTarget: targetBox ? targetBox.x - bodyBox!.x - bodyBox!.width : null,
      targetKeep: targetBox ? keepBox!.x - targetBox.x - targetBox.width : null,
      bodyKeep: targetBox ? null : keepBox!.x - bodyBox!.x - bodyBox!.width,
      keepCancel: cancelBox!.x - keepBox!.x - keepBox!.width,
      cancelSend: sendBox!.x - cancelBox!.x - cancelBox!.width,
    };
  };
  const [tileBox, bodyBox, changeBox, keepBox, cancelBox, sendBox] = await Promise.all([tile.boundingBox(), body.boundingBox(), change.boundingBox(), keep.boundingBox(), cancel.boundingBox(), send.boundingBox()]);
  expect(tileBox!.x + tileBox!.width + 8).toBe(bodyBox!.x);
  expect(bodyBox!.x + bodyBox!.width + 1).toBeLessThanOrEqual(changeBox!.x);
  expect(changeBox!.x + changeBox!.width + 1).toBeLessThanOrEqual(keepBox!.x);
  expect(keepBox!.x + keepBox!.width + 4).toBeLessThanOrEqual(cancelBox!.x);
  expect(sendBox!.x - cancelBox!.x - cancelBox!.width).toBeGreaterThanOrEqual(6);
  expect(sendBox!.x - cancelBox!.x - cancelBox!.width).toBeLessThanOrEqual(12);
  const phaseBox = (await toolbar.locator(".voice-card-phase").boundingBox())!;
  const infinityBox = (await keep.locator("svg").boundingBox())!;
  expect(phaseBox.x + phaseBox.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width);
  expect(await toolbar.locator(".voice-card-sub").evaluate(status => status.scrollWidth <= status.clientWidth)).toBe(true);
  expect(infinityBox.x - phaseBox.x - phaseBox.width).toBeGreaterThanOrEqual(6);
  expect(await toolbar.locator(".voice-card-title > span").evaluate(title => title.scrollWidth > title.clientWidth)).toBe(true);
  expect(keepBox!.height).toBe(cancelBox!.height);
  expect(keepBox!.width).toBe(cancelBox!.width);
  expect(keepBox!.y).toBe(cancelBox!.y);
  expect(await keep.evaluate(button => getComputedStyle(button).borderRadius)).toBe(await cancel.evaluate(button => getComputedStyle(button).borderRadius));
  for (const box of [tileBox!, bodyBox!, changeBox!, keepBox!, cancelBox!, sendBox!]) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await measureRow("heldListening");
  expect(await measureControlGaps("heldListening")).toEqual({ bodyTarget: 1, targetKeep: 1, bodyKeep: null, keepCancel: 4, cancelSend: 6 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-narrow.png");

  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 780 });
    await publishVoiceState(page, { active });
    await assertSafeKeepToggle();
    if (width === 360) {
      await measureRow("heldListening360");
      const cardBox = (await toolbar.boundingBox())!;
      expect(cardBox.x).toBe(9);
      expect(width - cardBox.x - cardBox.width).toBe(9);
      expect(await measureControlGaps("heldListening360")).toEqual({ bodyTarget: 4, targetKeep: 4, bodyKeep: null, keepCancel: 4, cancelSend: 6 });
      expect(await toolbar.locator(".voice-card-sub").evaluate(status => status.scrollWidth <= status.clientWidth)).toBe(true);
      await capture(page, testInfo, "voice-held-listening-360.png");
    }
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 480, height: 780 });
  const widerDock = (await page.locator(".voice-dock").boundingBox())!;
  expect(widerDock.width).toBeGreaterThanOrEqual(360);
  expect(widerDock.width).toBeLessThanOrEqual(599);
  await expect(change).toBeVisible();
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(cancel).toBeEnabled();
  await expect(send).toBeEnabled();
  await measureRow("heldListening480");
  expect(await measureControlGaps("heldListening480")).toEqual({ bodyTarget: 4, targetKeep: 4, bodyKeep: null, keepCancel: 4, cancelSend: 6 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-wider.png");
  await page.setViewportSize({ width: 320, height: 780 });

  // Native disables retargeting while a Keep listening change is pending.
  // With that chooser absent, every remaining control keeps its normal gap.
  await publishVoiceState(page, { actions: { ...base.actions, canStart: false, canStop: true,
    canRetarget: false, canSetKeepListening: false, canSend: false, keepListeningBlockedReason: "operation_pending" } });
  await expect(change).toHaveCount(0);
  await expect(keep).toBeDisabled();
  await expect(keep).toHaveAttribute("aria-pressed", "true");
  await expect(keep).toHaveAttribute("title", "A voice action is in progress");
  await expect(cancel).toBeEnabled();
  await expect(send).toBeDisabled();
  await expect(toolbar).toContainText("Listening");
  await measureRow("heldListeningMutationPending");
  expect(await measureControlGaps("heldListeningMutationPending")).toEqual({ bodyTarget: null, targetKeep: null, bodyKeep: 4, keepCancel: 4, cancelSend: 6 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-pending-narrow.png");
  await publishVoiceState(page, { actions: { ...base.actions, canStart: false, canStop: true,
    canRetarget: true, canSetKeepListening: true, canSend: true, keepListeningBlockedReason: null } });
  await expect(change).toBeVisible();
  await expect(keep).toBeEnabled();

  await publishVoiceState(page, { active: { ...active, recording: { id: "recording", keepListening: true, reconnecting: true } } });
  await expect(toolbar.locator(".voice-card-reconnecting")).toHaveText("Reconnecting");
  await expect(toolbar.locator(".voice-card-title-reconnecting")).toBeVisible();
  await expect(toolbar).toContainText("Listening");
  await expect(send).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expectNoPageOverflow(page);
  await measureRow("reconnecting");
  await capture(page, testInfo, "voice-reconnecting-narrow.png");
  await expect(composer).toHaveValue(draft);
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height: 780 });
    await publishVoiceState(page, { phase: "listening", active: { ...active, recording: { ...active.recording, keepListening: true } },
      actions: { ...base.actions, canStart: false, canStop: true, canRetarget: true, canSetKeepListening: true, canSend: true } });
    const originalSend = (await send.boundingBox())!;
    const originalCancel = (await cancel.boundingBox())!;
    await send.click();
    await expect(toolbar).toContainText("Recognizing…");
    await expect(keep).toHaveCount(0);
    await expect(send).toHaveCount(0);
    await expect.poll(() => cancel.boundingBox()).toEqual(originalCancel);
    await page.mouse.click(originalSend.x + originalSend.width / 2, originalSend.y + originalSend.height / 2);
    await expect(toolbar).toContainText("Recognizing…");
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
    if (width === 320) await capture(page, testInfo, "voice-finishing-recording-narrow.png");
    await publishVoiceState(page, { phase: "submitting", actions: { ...base.actions, canStart: false, canStop: true } });
    await expect.poll(() => toolbar.getByRole("button", { name: "Stop voice interaction" }).boundingBox()).toEqual(originalCancel);
    await page.mouse.click(originalSend.x + originalSend.width / 2, originalSend.y + originalSend.height / 2);
    await expect(toolbar).toContainText("Sending…");
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
  }
  await page.setViewportSize({ width: 320, height: 780 });
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecording"))).toEqual([
    { method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording" } },
    { method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording" } },
    { method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording" } },
  ]);
  // Native keeps ordinary live work out of recordingRecovery while its admission
  // POST is in flight. The original interaction remains independently stoppable.
  await publishVoiceState(page, { phase: "submitting",
    active: { ...active, recording: { id: "recording", keepListening: true, reconnecting: false } },
    actions: { ...base.actions, canStart: false, canStop: true }, recordingRecovery: null });
  await expect(toolbar).toContainText("Sending…");
  await expect(toolbar.getByRole("button", { name: "Stop voice interaction" })).toBeEnabled();
  await expect(toolbar.locator(".voice-card-target")).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toHaveCount(0);
  await expect(toolbar).not.toContainText("Saved dictation");
  await measureRow("liveSendSubmitting");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-live-send-submitting-narrow.png");

  const saved: NativeRecordingRecovery = { recordingId: "recording", revision: 4, threadId: otherThreadId, threadTitle: title, stage: "interrupted",
    reason: "Voice was turned off before recognition finished.", hasUnrecognizedAudio: true, captureIncomplete: true,
    canRetryRecognition: false, canSend: false, canCopyRecognizedText: true, canDiscard: true, admission: null };
  await publishVoiceState(page, { active: null, phase: "off", readiness: "off", ready: false,
    settings: { ...base.settings, audioMode: "off" }, actions: { ...base.actions, canStart: false }, recordingRecovery: saved });
  await expect(toolbar).toContainText("Saved dictation");
  await expect(toolbar.getByRole("button", { name: "Retry saved dictation" })).toBeDisabled();
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
  await expect(toolbar.getByRole("button", { name: "Start voice recording" })).toHaveCount(0);
  const savedLabel = toolbar.locator(".voice-card-saved-label");
  const savedLabelBounds = await savedLabel.evaluate(label => ({ right: label.getBoundingClientRect().right, parentRight: label.parentElement!.getBoundingClientRect().right }));
  expect(savedLabelBounds.right).toBeLessThanOrEqual(savedLabelBounds.parentRight);
  const savedTargets = await Promise.all([
    toolbar.locator(".voice-card-tile").boundingBox(), toolbar.locator(".voice-card-body").boundingBox(),
    toolbar.getByRole("button", { name: "Retry saved dictation" }).boundingBox(),
    toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox(), toolbar.locator(".voice-card-send-slot").boundingBox(),
  ]);
  for (const [index, target] of savedTargets.entries()) {
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(target!.x + target!.width).toBeLessThanOrEqual(320);
    if (index) expect(target!.x).toBeGreaterThanOrEqual(savedTargets[index - 1]!.x + savedTargets[index - 1]!.width);
  }
  expect(savedTargets[3]!.x - savedTargets[2]!.x - savedTargets[2]!.width).toBeGreaterThanOrEqual(4);
  expect(savedTargets[4]!.x - savedTargets[3]!.x - savedTargets[3]!.width).toBeGreaterThanOrEqual(4);
  await expectNoPageOverflow(page);
  await measureRow("savedOff");
  await capture(page, testInfo, "voice-saved-dictation-off-narrow.png");
  await publishVoiceState(page, { phase: "recordingRecovery", settings: base.settings,
    actions: { ...base.actions, canStart: false, canResume: true } });
  await expect(toolbar.getByRole("button", { name: "Resume voice", exact: true })).toBeVisible();
  const resumeLabelBounds = await savedLabel.evaluate(label => ({ right: label.getBoundingClientRect().right, parentRight: label.parentElement!.getBoundingClientRect().right }));
  expect(resumeLabelBounds.right).toBeLessThanOrEqual(resumeLabelBounds.parentRight);
  for (const width of [334, 344, 360, 378]) {
    await page.setViewportSize({ width, height: 780 });
    const bounds = await savedLabel.evaluate(label => ({ right: label.getBoundingClientRect().right, parentRight: label.parentElement!.getBoundingClientRect().right }));
    expect(bounds.right, `Saved label fits beside Resume at ${width}px`).toBeLessThanOrEqual(bounds.parentRight);
    const [resume, discard, slot] = await Promise.all([
      toolbar.getByRole("button", { name: "Resume voice", exact: true }).boundingBox(),
      toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox(), toolbar.locator(".voice-card-send-slot").boundingBox(),
    ]);
    expect(discard!.x - resume!.x - resume!.width, `Resume/Discard gap at ${width}px`).toBeGreaterThanOrEqual(4);
    expect(slot!.x - discard!.x - discard!.width, `Discard/Send gap at ${width}px`).toBeGreaterThanOrEqual(4);
    await measureRow(`savedResume${width}`);
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize({ width: 320, height: 780 });
  await publishVoiceState(page, { phase: "off", settings: { ...base.settings, audioMode: "off" }, actions: { ...base.actions, canStart: false } });
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
  const savedRetryBox = (await toolbar.getByRole("button", { name: "Retry saved dictation" }).boundingBox())!;
  const interruptedDiscardBox = (await toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox())!;
  await toolbar.getByRole("button", { name: "Retry saved dictation" }).click();
  await expect(toolbar).toContainText("Recognizing saved audio…");
  await expect(toolbar.getByRole("button", { name: /Stop voice interaction|Cancel voice recording/ })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
  await measureRow("savedRecognizing");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "retryRecordingRecognition").at(-1))).toEqual({
    method: "retryRecordingRecognition", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 5 },
  });
  await publishVoiceState(page, { phase: "off", active: null, ready: false, readiness: "off", settings: { ...base.settings, audioMode: "off" },
    recordingRecovery: { ...saved, revision: 7, stage: "ready", reason: null, hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true } });
  await expect(toolbar).toContainText("Ready to send");
  await expect(toolbar).toContainText("End may be missing");
  await expect(toolbar.getByRole("button", { name: "Send saved dictation" })).toBeEnabled();
  await expect.poll(() => toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox()).toEqual(interruptedDiscardBox);
  await page.mouse.click(savedRetryBox.x + savedRetryBox.width / 2, savedRetryBox.y + savedRetryBox.height / 2);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "discardRecording"))).toEqual([]);
  await expectNoPageOverflow(page);
  await measureRow("readyOff");
  await capture(page, testInfo, "voice-ready-dictation-off-narrow.png");
  const savedSendBox = (await toolbar.getByRole("button", { name: "Send saved dictation" }).boundingBox())!;
  const savedDiscardBox = (await toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox())!;
  expect(savedSendBox.x - savedDiscardBox.x - savedDiscardBox.width).toBeGreaterThanOrEqual(4);
  await toolbar.getByRole("button", { name: "Send saved dictation" }).click();
  await expect(sheet).toBeVisible();
  const warning = sheet.getByText("The end of this dictation may be missing. Sending uses the saved portion.", { exact: true });
  const acknowledge = sheet.getByRole("checkbox", { name: "Send the saved portion even if the end is missing" });
  const sendSaved = sheet.getByRole("button", { name: "Send saved dictation" });
  await expect(acknowledge).not.toBeChecked();
  await expect(sendSaved).toBeDisabled();
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecoveredRecording"))).toEqual([]);
  await acknowledge.check();
  await expect(sendSaved).toBeEnabled();
  await sendSaved.scrollIntoViewIfNeeded();
  await expect(warning).toBeInViewport();
  await expect(acknowledge).toBeInViewport();
  await expect(sendSaved).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-incomplete-dictation-confirmation-narrow.png");
  await sendSaved.click();
  await expect(sheet).toContainText("Sending…");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecoveredRecording"))).toEqual([
    { method: "sendRecoveredRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 7, acknowledgeIncomplete: true } },
  ]);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(toolbar).toContainText("Sending…");
  await expect(toolbar.getByRole("button", { name: /Stop voice interaction|Cancel voice recording/ })).toHaveCount(0);
  await measureRow("savedSubmitting");
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
  await expect.poll(() => toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox()).toEqual(savedDiscardBox);
  await page.mouse.click(savedSendBox.x + savedSendBox.width / 2, savedSendBox.y + savedSendBox.height / 2);
  await expect(toolbar).toContainText("Sending…");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "discardRecording"))).toEqual([]);
  await publishVoiceState(page, { recordingRecovery: { ...saved, revision: 9, stage: "rejected", reason: "The server rejected this input.",
    hasUnrecognizedAudio: false, captureIncomplete: false, canRetryRecognition: false, canSend: false } });
  await expect.poll(() => toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox()).toEqual(savedDiscardBox);
  await page.mouse.click(savedSendBox.x + savedSendBox.width / 2, savedSendBox.y + savedSendBox.height / 2);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "discardRecording"))).toEqual([]);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-saved-rejected-narrow.png");
  await toolbar.getByRole("button", { name: "Discard saved dictation" }).click();
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toHaveCount(0);
  expect(await page.evaluate(() => ({ active: window.__voiceFixture.state.active, saved: window.__voiceFixture.state.recordingRecovery }))).toEqual({ active: null, saved: null });
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "discardRecording"))).toEqual([
    { method: "discardRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 9 } },
  ]);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
  await publishVoiceState(page, { phase: "listening", settings: base.settings, ready: true, readiness: "ready",
    active: { ...active, id: "new-interaction", recording: { id: "new-recording", keepListening: false, reconnecting: false } },
    actions: { ...base.actions, canStart: false, canStop: true, canRetarget: true, canSetKeepListening: false, keepListeningBlockedReason: "saved_recording_pending" },
    recordingRecovery: { ...saved, recordingId: "older-recording", revision: 9, stage: "admitting", hasUnrecognizedAudio: false, captureIncomplete: false, canRetryRecognition: false,
      admission: { mutationId: "original-input", status: "uncertain", cancelled: false } } });
  const savedAccess = toolbar.getByRole("button", { name: "Saved dictation", exact: true });
  await expect(savedAccess).toBeVisible();
  const savedAccessBox = await savedAccess.boundingBox();
  expect(savedAccessBox!.height).toBeGreaterThanOrEqual(44);
  expect(savedAccessBox!.width).toBeGreaterThanOrEqual(44);
  await expect(keep).toHaveAttribute("title", "Resolve saved dictation first");
  await expect(savedAccess).toHaveAttribute("title", "Saved dictation");
  await expect(savedAccess.locator(".voice-card-saved-indicator")).toBeVisible();
  await measureRow("olderSavedDuringRecording");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-saved-access-during-recording-narrow.png");
  await expect(composer).toHaveValue(draft);
  await testInfo.attach("voice-row-heights", { body: JSON.stringify({ viewports, originalRowHeight: 60, heights }, null, 2), contentType: "application/json" });
  await testInfo.attach("voice-row-left-offsets", { body: JSON.stringify({ viewports, leftOffsets }, null, 2), contentType: "application/json" });
  await testInfo.attach("voice-recording-control-gaps", { body: JSON.stringify({ viewports, controlGaps }, null, 2), contentType: "application/json" });
});
