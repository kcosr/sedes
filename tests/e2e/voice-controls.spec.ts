import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { NativeRecordingRecovery } from "../../src/client/voice/native-voice-plugin.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory, sendCurrentDraft } from "./helpers.js";
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
  const leftOffsets: Record<string, { tile: number; title: number; status: number }> = {};
  const topOffsets: Record<string, { title: number; status: number }> = {};
  const measureRow = async (state: string, actionCount = 3) => {
    viewports[state] = page.viewportSize()!.width;
    heights[state] = (await toolbar.boundingBox())!.height;
    expect(heights[state], `${state} preserves the compact single-row card`).toBe(60);
    const [tile, title, status] = await Promise.all([
      toolbar.locator(".voice-card-tile").boundingBox(), toolbar.locator(".voice-card-title").boundingBox(), toolbar.locator(".voice-card-sub").boundingBox(),
    ]);
    leftOffsets[state] = { tile: tile!.x, title: title!.x, status: status!.x };
    const row = (await toolbar.boundingBox())!;
    topOffsets[state] = { title: title!.y - row.y, status: status!.y - row.y };
    expect(leftOffsets[state], `${state} preserves the Ready-state icon and text positions`).toEqual(leftOffsets.idleBeforeRecording);
    expect(topOffsets[state].title, `${state} preserves the title baseline`).toBeCloseTo(topOffsets.idleBeforeRecording!.title, 1);
    expect(topOffsets[state].status, `${state} preserves the status baseline`).toBeCloseTo(topOffsets.idleBeforeRecording!.status, 1);
    expect(title!.x - tile!.x - tile!.width, `${state} keeps settings before the thread`).toBe(8);
    const actions = (await toolbar.locator(".voice-card-actions").boundingBox())!;
    expect(status!.y, `${state} keeps text beside the actions`).toBeLessThan(actions.y + actions.height);
    expect(status!.y + status!.height).toBeGreaterThan(actions.y);
    expect(await toolbar.locator(".voice-card-title").evaluate(el => getComputedStyle(el).fontSize)).toBe("15px");
    expect(await toolbar.locator(".voice-card-sub").evaluate(el => getComputedStyle(el).fontSize)).toBe("13px");
    expect(await toolbar.locator(".voice-card-actions > button").count()).toBe(actionCount);
  };
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(toolbar).toBeVisible();
  await measureRow("idleBeforeRecording", 1);
  await capture(page, testInfo, "voice-ready-spacing-narrow.png");
  const base = voiceFixtureState();
  await publishVoiceState(page, { settings: { ...base.settings, onlyVoiceThread: true } });
  await expect(toolbar.locator(".voice-card-sub")).toHaveText("Default thread needed");
  await expect(toolbar.getByRole("button", { name: "Start voice recording", exact: true })).toBeEnabled();
  await measureRow("defaultThreadNeeded", 1);
  await capture(page, testInfo, "voice-default-thread-needed-narrow.png");
  await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
  const filterSheet = page.getByRole("dialog", { name: "Voice", exact: true });
  await expect(filterSheet.getByRole("status")).toContainText("Automatic playback and listening are paused.");
  await expect(filterSheet.getByRole("switch", { name: "Only play from default voice thread", exact: true })).toBeChecked();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-default-thread-warning-sheet-narrow.png");
  await filterSheet.press("Escape");
  await expect(filterSheet).toHaveCount(0);
  await publishVoiceState(page, { settings: base.settings });
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
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
  await measureRow("idleKeepListeningDefault", 1);
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
    canRetarget: true, canSetKeepListening: true, canSend: true, keepListeningBlockedReason: null } });
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
    await expect(send).toBeEnabled();
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
    // Cancel must never move into this hit region when the mode changes.
    await page.mouse.click(ordinaryKeep.x + ordinaryKeep.width / 2, ordinaryKeep.y + ordinaryKeep.height / 2);
    await expect(keep).toHaveAttribute("aria-pressed", "false");
    await expect(send).toBeEnabled();
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
  const assertVisualFocusOrder = async () => {
    const controls = [tile, body, change, keep, cancel, send];
    let previous: Awaited<ReturnType<typeof tile.boundingBox>> = null;
    await tile.focus();
    for (const [index, control] of controls.entries()) {
      await expect(control).toBeFocused();
      // The Open thread button overlays both text lines. Its visible title is
      // before the separate inline picker, which owns its own hit region.
      const current = (await (control === body ? toolbar.locator(".voice-card-title") : control).boundingBox())!;
      if (previous) {
        const sameRow = current.y < previous.y + previous.height && previous.y < current.y + current.height;
        if (sameRow) expect(current.x, "Tab moves right across the row").toBeGreaterThanOrEqual(previous.x + previous.width);
        else throw new Error("Voice controls unexpectedly wrapped to another row");
      }
      previous = current;
      if (index < controls.length - 1) await page.keyboard.press("Tab");
    }
  };
  await assertVisualFocusOrder();
  const controlGaps: Record<string, { titleTarget: number | null; textActions: number; keepCancel: number; cancelSend: number }> = {};
  const measureControlGaps = async (state: string) => {
    const target = toolbar.locator(".voice-card-target");
    const [bodyBox, titleBox, targetBox, keepBox, cancelBox, sendBox] = await Promise.all([
      body.boundingBox(), toolbar.locator(".voice-card-title").boundingBox(), await target.count() ? target.boundingBox() : null,
      keep.boundingBox(), cancel.boundingBox(), send.boundingBox(),
    ]);
    for (const box of [bodyBox, targetBox, keepBox, cancelBox, sendBox].filter(box => box !== null)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    for (const box of [keepBox!, cancelBox!, sendBox!]) {
      expect(box.width).toBe(40);
      expect(box.height).toBe(40);
    }
    if (targetBox) {
      expect(targetBox.width).toBe(24);
      expect(targetBox.height).toBe(24);
      expect((await target.locator("svg").boundingBox())!.width).toBe(14);
      expect(await target.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
      })).toBe(true);
    }
    return controlGaps[state] = {
      titleTarget: targetBox ? targetBox.x - titleBox!.x - titleBox!.width : null,
      textActions: keepBox!.x - bodyBox!.x - bodyBox!.width,
      keepCancel: cancelBox!.x - keepBox!.x - keepBox!.width,
      cancelSend: sendBox!.x - cancelBox!.x - cancelBox!.width,
    };
  };
  const [tileBox, bodyBox, changeBox, keepBox, cancelBox, sendBox] = await Promise.all([tile.boundingBox(), body.boundingBox(), change.boundingBox(), keep.boundingBox(), cancel.boundingBox(), send.boundingBox()]);
  expect(tileBox!.y + tileBox!.height / 2).toBeCloseTo(bodyBox!.y + bodyBox!.height / 2, 1);
  expect(tileBox!.x + tileBox!.width + 8).toBe(bodyBox!.x);
  expect(bodyBox!.x + bodyBox!.width + 4).toBe(keepBox!.x);
  expect(changeBox!.x).toBeGreaterThan(bodyBox!.x);
  expect(changeBox!.x + changeBox!.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width);
  expect(keepBox!.x + keepBox!.width + 4).toBeLessThanOrEqual(cancelBox!.x);
  expect(sendBox!.x - cancelBox!.x - cancelBox!.width).toBe(4);
  const phaseBox = (await toolbar.locator(".voice-card-phase").boundingBox())!;
  const infinityBox = (await keep.locator("svg").boundingBox())!;
  expect(phaseBox.x + phaseBox.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width);
  expect(await toolbar.locator(".voice-card-sub").evaluate(status => status.scrollWidth <= status.clientWidth)).toBe(true);
  expect(infinityBox.y + infinityBox.height / 2).toBe(tileBox!.y + tileBox!.height / 2);
  expect(await toolbar.locator(".voice-card-title > span").evaluate(title => title.scrollWidth > title.clientWidth)).toBe(true);
  expect(keepBox!.height).toBe(cancelBox!.height);
  expect(keepBox!.width).toBe(cancelBox!.width);
  expect(keepBox!.y).toBe(cancelBox!.y);
  expect(await keep.evaluate(button => getComputedStyle(button).borderRadius)).toBe(await cancel.evaluate(button => getComputedStyle(button).borderRadius));
  for (const box of [tileBox!, bodyBox!, changeBox!, keepBox!, cancelBox!, sendBox!]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await measureRow("heldListening");
  expect(await measureControlGaps("heldListening")).toEqual({ titleTarget: 2, textActions: 4, keepCancel: 4, cancelSend: 4 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-narrow.png");

  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 780 });
    await publishVoiceState(page, { active });
    await assertSafeKeepToggle();
    await assertVisualFocusOrder();
    if (width === 360) {
      await measureRow("heldListening360");
      const cardBox = (await toolbar.boundingBox())!;
      expect(cardBox.x).toBe(9);
      expect(width - cardBox.x - cardBox.width).toBe(9);
      expect(await measureControlGaps("heldListening360")).toEqual({ titleTarget: 2, textActions: 4, keepCancel: 4, cancelSend: 4 });
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
  expect(await measureControlGaps("heldListening480")).toEqual({ titleTarget: 2, textActions: 4, keepCancel: 4, cancelSend: 4 });
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
  expect(await measureControlGaps("heldListeningMutationPending")).toEqual({ titleTarget: null, textActions: 4, keepCancel: 4, cancelSend: 4 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-held-listening-pending-narrow.png");
  await publishVoiceState(page, { actions: { ...base.actions, canStart: false, canStop: true,
    canRetarget: true, canSetKeepListening: true, canSend: true, keepListeningBlockedReason: null } });
  await expect(change).toBeVisible();
  await expect(keep).toBeEnabled();

  await publishVoiceState(page, { active: { ...active, recording: { id: "recording", keepListening: true, reconnecting: true } } });
  await expect(toolbar.locator(".voice-card-reconnecting")).toHaveText("Reconnecting");
  await expect(toolbar.locator(".voice-card-reconnecting")).toBeVisible();
  await expect(toolbar).toContainText("Listening");
  await expect(send).toBeEnabled();
  await expect(cancel).toBeEnabled();
  await expectNoPageOverflow(page);
  await measureRow("reconnecting");
  await capture(page, testInfo, "voice-reconnecting-narrow.png");
  await expect(composer).toHaveValue(draft);
  for (const [width, held] of [[320, false], [320, true], [360, false], [360, true], [1280, false], [1280, true]] as const) {
    await page.setViewportSize({ width, height: 780 });
    await publishVoiceState(page, { phase: "listening", active: { ...active, recording: { ...active.recording, keepListening: held } },
      actions: { ...base.actions, canStart: false, canStop: true, canRetarget: true, canSetKeepListening: true, canSend: true, keepListeningBlockedReason: null } });
    const originalSend = (await send.boundingBox())!;
    const originalCancel = (await cancel.boundingBox())!;
    await send.click();
    await expect(toolbar).toContainText("Recognizing…");
    await expect(keep).toBeDisabled();
    await expect(send).toBeDisabled();
    await expect.poll(() => cancel.boundingBox()).toEqual(originalCancel);
    await page.mouse.click(originalSend.x + originalSend.width / 2, originalSend.y + originalSend.height / 2);
    await expect(toolbar).toContainText("Recognizing…");
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
    if (width === 320) await capture(page, testInfo, `voice-finishing-${held ? "held" : "ordinary"}-recording-narrow.png`);
    await publishVoiceState(page, { phase: "submitting", actions: { ...base.actions, canStart: false, canStop: true } });
    await expect.poll(() => toolbar.getByRole("button", { name: "Stop voice interaction" }).boundingBox()).toEqual(originalCancel);
    await page.mouse.click(originalSend.x + originalSend.width / 2, originalSend.y + originalSend.height / 2);
    await expect(toolbar).toContainText("Sending…");
    expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopCurrentInteraction"))).toEqual([]);
  }
  await page.setViewportSize({ width: 320, height: 780 });
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecording"))).toEqual(
    Array.from({ length: 6 }, () => ({ method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording" } })),
  );
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
    toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox(), toolbar.getByRole("button", { name: "Send saved dictation" }).boundingBox(),
  ]);
  for (const [index, target] of savedTargets.entries()) {
    expect(target!.width).toBeGreaterThanOrEqual(40);
    expect(target!.height).toBeGreaterThanOrEqual(40);
    expect(target!.x + target!.width).toBeLessThanOrEqual(320);
    if (index > 2) expect(target!.x).toBeGreaterThanOrEqual(savedTargets[index - 1]!.x + savedTargets[index - 1]!.width);
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
      toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox(), toolbar.getByRole("button", { name: "Send saved dictation" }).boundingBox(),
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
  await expect(sheet).toContainText("Needs transcription");
  await expect(sheet.getByRole("button", { name: "Copy text" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Add to composer" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Add to composer" })).toHaveAccessibleDescription("Finish transcription to add to the composer.");
  await expect(sheet.getByText("Finish transcription to add to the composer.", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-recovery-transcription-needed-narrow.png");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(composer).toHaveValue(draft);

  await publishVoiceState(page, { phase: "recordingRecovery", ready: true, readiness: "ready", settings: base.settings,
    recordingRecovery: { ...saved, revision: 5, canRetryRecognition: true } });
  const savedRetryBox = (await toolbar.getByRole("button", { name: "Retry saved dictation" }).boundingBox())!;
  const interruptedDiscardBox = (await toolbar.getByRole("button", { name: "Discard saved dictation" }).boundingBox())!;
  await toolbar.getByRole("button", { name: "Retry saved dictation" }).click();
  await expect(toolbar).toContainText("Transcribing…");
  await expect(toolbar.getByRole("button", { name: /Stop voice interaction|Cancel voice recording/ })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Discard saved dictation" })).toBeEnabled();
  await measureRow("savedRecognizing");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "retryRecordingRecognition").at(-1))).toEqual({
    method: "retryRecordingRecognition", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 5 },
  });
  await publishVoiceState(page, { phase: "off", active: null, ready: false, readiness: "off", settings: { ...base.settings, audioMode: "off" },
    recordingRecovery: { ...saved, revision: 7, stage: "ready", reason: null, hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true } });
  await expect(toolbar).toContainText("Ready to send");
  await expect(toolbar).toContainText("Recording interrupted");
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
  await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
  await expect(sheet).toBeVisible();
  const recovery = sheet.getByRole("region", { name: "Saved dictation", exact: true });
  const sendSaved = recovery.getByRole("button", { name: "Send", exact: true });
  await expect(recovery.getByRole("checkbox")).toHaveCount(0);
  await expect(recovery).toContainText("Recording interrupted");
  await expect(sendSaved).toBeEnabled();
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecoveredRecording"))).toEqual([]);
  await sendSaved.scrollIntoViewIfNeeded();
  await expect(recovery.getByRole("status")).toBeInViewport();
  await expect(sendSaved).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-interrupted-dictation-recovery-narrow.png");
  await sendSaved.click();
  await expect(sheet).toContainText("Sending…");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "sendRecoveredRecording"))).toEqual([
    { method: "sendRecoveredRecording", args: { expectedConnectionGeneration: 1, recordingId: "recording", expectedRecoveryRevision: 7 } },
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
  expect(savedAccessBox!.height).toBe(40);
  expect(savedAccessBox!.width).toBe(40);
  await expect(keep).toHaveAttribute("title", "Resolve saved dictation first");
  await expect(savedAccess).toHaveAttribute("title", "Saved dictation");
  await expect(savedAccess.locator(".voice-card-saved-indicator")).toBeVisible();
  await measureRow("olderSavedDuringRecording");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-saved-access-during-recording-narrow.png");
  await expect(composer).toHaveValue(draft);
  await testInfo.attach("voice-row-heights", { body: JSON.stringify({ viewports, originalRowHeight: 60, heights }, null, 2), contentType: "application/json" });
  await testInfo.attach("voice-row-text-offsets", { body: JSON.stringify({ viewports, leftOffsets, topOffsets }, null, 2), contentType: "application/json" });
  await testInfo.attach("voice-recording-control-gaps", { body: JSON.stringify({ viewports, controlGaps }, null, 2), contentType: "application/json" });
});

test("saved dictation appends to its original composer without losing drafts or truncating text", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-composer-recovery");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await openWorkspaceDirectory(page, workspace);
  const originalPath = await createDraftThread(page, "Dictation destination");
  const originalId = originalPath.split("/").at(-1)!;
  await fillAndPersistDraft(page, "Existing destination draft.");
  const otherPath = await createDraftThread(page, "Other draft stays separate");
  await fillAndPersistDraft(page, "Keep this other draft.");
  await page.setViewportSize({ width: 320, height: 780 });
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const sheet = page.getByRole("dialog", { name: "Voice", exact: true });
  const saved: NativeRecordingRecovery = { recordingId: "composer-recovery", revision: 1, threadId: originalId,
    threadTitle: "Dictation destination", stage: "ready", reason: "Microphone unavailable.", captureIncomplete: true,
    hasUnrecognizedAudio: false, canRetryRecognition: false, canSend: true, canCopyRecognizedText: true, canDiscard: true, admission: null };
  await publishVoiceState(page, { phase: "recordingRecovery", active: null, recordingRecovery: saved });
  await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
  const recovery = sheet.getByRole("region", { name: "Saved dictation", exact: true });
  await expect(recovery).toContainText("Recording interrupted");
  await expect(recovery.getByRole("button", { name: "Copy text", exact: true })).toBeVisible();
  await expect(recovery.getByRole("checkbox")).toHaveCount(0);
  await recovery.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-recovery-actions-narrow.png");
  const firstSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith(`/threads/${originalId}/draft`) && response.ok() &&
    response.request().postDataJSON().text === "Existing destination draft.\n\nRecovered dictation text.");
  await recovery.getByRole("button", { name: "Add to composer", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${originalPath}$`, "u"));
  await expect(composer).toHaveValue("Existing destination draft.\n\nRecovered dictation text.");
  await firstSaved;
  expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery?.recordingId)).toBe(saved.recordingId);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => ["sendRecoveredRecording", "discardRecording"].includes(call.method)))).toEqual([]);
  await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Added to composer", exact: true })).toBeDisabled();
  await sheet.press("Escape");

  // A pending autosave must not make the recovery action read an older server draft.
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  let sawSave!: () => void;
  const saveStarted = new Promise<void>(resolve => { sawSave = resolve; });
  let blocked = false;
  await page.route(`**/api/threads/${originalId}/draft`, async route => {
    if (route.request().method() === "PUT" && !blocked) { blocked = true; sawSave(); await saveGate; }
    await route.continue();
  });
  const unsaved = "My latest unsaved edits.";
  const recoveredSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith(`/threads/${originalId}/draft`) && response.ok() &&
    response.request().postDataJSON().text === `${unsaved}\n\nMore recovered words.`);
  await composer.fill(unsaved);
  await saveStarted;
  try {
    await page.evaluate(() => { window.__voiceFixture.recoveredText = "More recovered words."; });
    await publishVoiceState(page, { recordingRecovery: { ...saved, recordingId: "second-recording" } });
    await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
    await sheet.getByRole("button", { name: "Add to composer", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(composer).toHaveValue(`${unsaved}\n\nMore recovered words.`);
  } finally { releaseSave(); }
  await recoveredSaved;
  await page.reload();
  await expect(composer).toHaveValue(`${unsaved}\n\nMore recovered words.`);

  await page.evaluate(() => { window.__voiceFixture.recoveredText = "é".repeat(32_768); });
  await publishVoiceState(page, { recordingRecovery: { ...saved, recordingId: "oversized-recording" } });
  await toolbar.getByRole("button", { name: "Open voice controls", exact: true }).click();
  await sheet.getByRole("button", { name: "Add to composer", exact: true }).click();
  await expect(sheet).toContainText("This dictation does not fit in the composer. Copy the text instead.");
  expect(await page.evaluate(() => window.__voiceFixture.state.recordingRecovery?.recordingId)).toBe("oversized-recording");
  await sheet.press("Escape");
  await expect(composer).toHaveValue(`${unsaved}\n\nMore recovered words.`);
  await page.goto(otherPath);
  await expect(composer).toHaveValue("Keep this other draft.");
});

test("a completed turn's footer replays its reply and stays reachable on touch with voice on or Off", async ({ page, browser }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-replay");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page, "Voice replay");
  const threadId = threadPath.split("/").at(-1)!;
  // This script completes in two short steps and gives the footer its fullest content, including the tok/s rate.
  await fillAndPersistDraft(page, "Measure turn throughput");
  await sendCurrentDraft(page);
  const turn = page.locator(".conversation-turn").last();
  await expect(turn).toHaveAttribute("data-turn-status", "completed");
  const turnId = (await turn.getAttribute("data-turn-id"))!;
  // The route is mocked so the text choice is deterministic: a stored completion result for two taps, then none.
  const storedReply = { assistantResult: { final: { text: "Stored final answer." }, unclassified: null } };
  const replies = [storedReply, storedReply, { assistantResult: null }];
  const reads: string[] = [];
  await page.route("**/api/threads/*/turns/*/reply-speech", async route => {
    reads.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: replies.shift(), headers: { "cache-control": "no-store" } });
  });
  const speakCalls = () => page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "speakReply"));
  const storedCall = { method: "speakReply", args: { expectedConnectionGeneration: 1, threadId, turnId, threadTitle: "Voice replay",
    assistantResult: storedReply.assistantResult } };
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const cardStatus = toolbar.locator(".voice-card-sub");
  const speak = turn.getByRole("button", { name: "Play response aloud", exact: true });
  const footerStatus = (text: string) => turn.getByRole("status").filter({ hasText: new RegExp(`^${text}$`, "u") });
  const base = voiceFixtureState();

  await speak.click();
  await expect(footerStatus("Queued to play")).toHaveClass("sr-only");
  await expect(speak.locator(".lucide-check")).toBeVisible();
  await expect(cardStatus).toContainText("Speaking");
  await expect(cardStatus).toContainText("Replay");
  expect(reads).toEqual([`/api/threads/${threadId}/turns/${turnId}/reply-speech`]);
  expect(await speakCalls()).toEqual([storedCall]);
  await capture(page, testInfo, "voice-replay-playing.png");

  // Tapping while this turn's replay plays succeeds and, as in native, adds nothing to the queue.
  await speak.click();
  await expect.poll(speakCalls).toEqual([storedCall, storedCall]);
  await expect(footerStatus("Queued to play")).toHaveCount(1);
  await expect(speak.locator(".lucide-check")).toBeVisible();
  expect(await page.evaluate(() => window.__voiceFixture.state.queue.count)).toBe(0);
  await expect(cardStatus).not.toContainText("queued");
  await toolbar.getByRole("button", { name: "Stop voice interaction", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "stopPlayback"))).toEqual([
    { method: "stopPlayback", args: { expectedConnectionGeneration: 1, interactionId: `replay:${turnId}` } },
  ]);

  // Behind another notice a tap queues; with no stored result it reads the whole reply, as Copy response gives it.
  await publishVoiceState(page, { phase: "speaking", active: { id: "notice", eventKind: "turn.completed", threadId, threadTitle: "Voice replay",
    recognitionThreadId: null, recognitionThreadTitle: null, automatic: true, recording: null },
    actions: { ...base.actions, canStart: false, canStop: true, canSkip: true, canRecordDuringPlayback: true } });
  await speak.click();
  await expect(cardStatus).toContainText("1 queued");
  expect((await speakCalls()).at(-1)).toEqual({ method: "speakReply", args: { ...storedCall.args,
    assistantResult: { unclassified: { text: "The measured response is complete." } } } });
  await publishVoiceState(page, { settings: { ...base.settings, audioMode: "off" } });
  await expect(speak).toHaveCount(0);
  await publishVoiceState(page, { settings: { ...base.settings, audioMode: "manual" } });
  await expect(speak).toBeVisible();
  expect(reads).toHaveLength(3);

  const touchContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string,
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const touchPage = await touchContext.newPage();
    await installVoiceFixture(touchPage);
    await touchPage.goto(threadPath);
    const footer = touchPage.getByTestId(`turn-fork-${turnId}`);
    const touchSpeak = footer.getByRole("button", { name: "Play response aloud", exact: true });
    await expect(touchSpeak).toBeVisible();
    await expect(footer.locator(".turn-throughput")).toBeVisible();
    await footer.scrollIntoViewIfNeeded();
    const measure = () => footer.locator(".turn-fork-controls").evaluate(controls => ({
      width: controls.getBoundingClientRect().width,
      buttons: Array.from(controls.querySelectorAll("button"), button => {
        const box = button.getBoundingClientRect();
        return { name: button.getAttribute("aria-label")!, left: box.left, right: box.right, width: box.width, height: box.height };
      }),
    }));
    const expectReachable = (layout: Awaited<ReturnType<typeof measure>>) => {
      for (const [index, action] of layout.buttons.entries()) {
        expect(action.width, `${action.name} width`).toBeGreaterThanOrEqual(44);
        expect(action.height, `${action.name} height`).toBeGreaterThanOrEqual(44);
        expect(action.left, `${action.name} left`).toBeGreaterThanOrEqual(0);
        expect(action.right, `${action.name} right`).toBeLessThanOrEqual(390);
        // Touch footers pack their actions with no gap, so a hidden action leaves none behind.
        if (index > 0) expect(Math.abs(action.left - layout.buttons[index - 1]!.right), `${action.name} gap`).toBeLessThanOrEqual(0.5);
      }
    };
    const on = await measure();
    const names = on.buttons.map(action => action.name);
    expect(names.indexOf("Play response aloud")).toBe(names.indexOf("Copy response") + 1);
    expectReachable(on);
    await expectNoPageOverflow(touchPage);
    await capture(touchPage, testInfo, "voice-replay-footer-touch.png");

    await publishVoiceState(touchPage, { settings: { ...base.settings, audioMode: "off" } });
    await expect(touchSpeak).toHaveCount(0);
    const off = await measure();
    expect(off.buttons.map(action => action.name)).toEqual(names.filter(name => name !== "Play response aloud"));
    expect(on.width - off.width).toBeCloseTo(44, 0);
    expectReachable(off);
    await expectNoPageOverflow(touchPage);
    await capture(touchPage, testInfo, "voice-replay-footer-touch-off.png");
  } finally {
    await touchContext.close();
  }
});
