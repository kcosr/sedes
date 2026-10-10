import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

test.use({ hasTouch: true });

declare global {
  interface Window { __voiceRepeatTap?: Promise<{ interval: number; target: string | null }> }
}

/** A real first tap, then a controlled rapid click at the same point after the DOM changes.
 * Event.timeStamp is not controlled by Playwright's clock; set the repeat interval explicitly
 * so a slow fixture response cannot turn this into a deliberately late click. */
async function tapAndRepeatAfterRemoval(page: Page, button: Locator) {
  await button.evaluate(element => {
    window.__voiceRepeatTap = new Promise((resolve, reject) => {
      element.addEventListener("click", raw => {
        const first = raw as MouseEvent;
        const observer = new MutationObserver(() => {
          if (element.isConnected) return;
          const target = document.elementFromPoint(first.clientX, first.clientY);
          if (!target) { observer.disconnect(); window.clearTimeout(deadline); reject(new Error("No target at the released action position")); return; }
          const button = target.closest("button");
          if (button?.disabled || button?.getAttribute("aria-disabled") === "true") return;
          observer.disconnect(); window.clearTimeout(deadline);
          const repeat = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: first.clientX, clientY: first.clientY });
          Object.defineProperty(repeat, "timeStamp", { value: first.timeStamp + 100 });
          target.dispatchEvent(repeat);
          resolve({ interval: repeat.timeStamp - first.timeStamp, target: target.closest("button")?.getAttribute("aria-label") ?? null });
        });
        const deadline = window.setTimeout(() => { observer.disconnect(); reject(new Error("Voice action did not unmount")); }, 10000);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-disabled"] });
      }, { once: true, capture: true });
    });
  });
  await button.tap();
  const result = await page.evaluate(async () => {
    try { return await window.__voiceRepeatTap; } finally { delete window.__voiceRepeatTap; }
  });
  expect(result?.interval).toBe(100);
  return result!;
}

test("playback Record, Next and Stop stay separate on touch while replying to another thread", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-playback-controls");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const viewedPath = await createDraftThread(page, "Viewed thread A");
  const draft = "Keep the viewed thread's draft.";
  await fillAndPersistDraft(page, draft);
  const spokenPath = await createDraftThread(page, "Spoken thread B");
  const defaultPath = await createDraftThread(page, "Pinned thread C");
  const spokenId = spokenPath.split("/").at(-1)!;
  const defaultId = defaultPath.split("/").at(-1)!;
  await page.goto(viewedPath);
  await page.setViewportSize({ width: 320, height: 780 });
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const base = voiceFixtureState();
  const settings = { ...base.settings, autoListen: false, pinDefaultVoiceThread: true, voiceThreadId: defaultId, voiceThreadTitle: "Pinned thread C" };
  const queue = { count: 2, bytes: 80, droppedCount: 0, droppedReasons: {} };
  const calls = () => page.evaluate(() => window.__voiceFixture.calls.filter(call =>
    ["recordDuringPlayback", "sendRecording", "skipCurrentPlayback", "stopCurrentInteraction", "stopPlayback", "startManualListen", "releaseRetainedVoiceTarget"].includes(call.method)));
  const expected: Awaited<ReturnType<typeof calls>> = [];
  const playback = async (id: string, phase: "synthesizing" | "speaking", automatic: boolean) => {
    await publishVoiceState(page, { phase, settings, queue,
      nextRecordingTarget: { threadId: defaultId, threadTitle: "Pinned thread C" },
      active: { id, eventKind: automatic ? "turn.completed" : "replay", threadId: spokenId, threadTitle: "Spoken thread B",
        recognitionThreadId: null, recognitionThreadTitle: null, automatic, recording: null },
      actions: { ...base.actions, canStart: false, canStop: true, canSkip: true, canRecordDuringPlayback: true } });
    await expect(toolbar.locator(".voice-card-title")).toHaveText("Spoken thread B");
  };
  const assertPlaybackTargets = async () => {
    const boxes = [];
    for (const name of ["Next voice interaction", "Stop voice interaction", "Record reply"]) {
      const button = toolbar.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled();
      const box = (await button.boundingBox())!;
      expect(box.width, `${name} touch width`).toBe(40);
      expect(box.height, `${name} touch height`).toBe(40);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
      })).toBe(true);
      boxes.push(box);
    }
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThan(boxes[1]!.x);
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThan(boxes[2]!.x);
    await expectNoPageOverflow(page);
    return boxes;
  };

  for (const [phase, automatic] of [["synthesizing", true], ["speaking", false]] as const) {
    const id = `playback-${phase}`;
    await playback(id, phase, automatic);
    const playbackBoxes = await assertPlaybackTargets();
    await capture(page, testInfo, `voice-record-before-${phase}-320.png`);
    await toolbar.getByRole("button", { name: "Record reply", exact: true }).tap();
    expected.push({ method: "recordDuringPlayback", args: { expectedConnectionGeneration: 1, interactionId: id } });
    await expect.poll(calls).toEqual(expected);
    await expect(toolbar.locator(".voice-card-sub")).toHaveText("Listening");
    await expect(toolbar.locator(".voice-card-title")).toHaveText("Spoken thread B");
    await expect(toolbar.getByRole("button", { name: "Next voice interaction" })).toHaveCount(0);
    for (const [index, name] of ["Keep listening", "Cancel voice recording", "Send voice recording"].entries()) {
      await expect.poll(() => toolbar.getByRole("button", { name, exact: true }).boundingBox()).toEqual(playbackBoxes[index]);
    }
    await expect(toolbar.getByRole("button", { name: "Send voice recording" })).toBeEnabled();
    const recordBox = playbackBoxes[2]!;
    await page.touchscreen.tap(recordBox.x + recordBox.width / 2, recordBox.y + recordBox.height / 2);
    expected.push({ method: "sendRecording", args: { expectedConnectionGeneration: 1, recordingId: `recording:${id}` } });
    await expect.poll(calls).toEqual(expected);
    await expect(toolbar.locator(".voice-card-sub")).toContainText("Recognizing");
    await expect(toolbar.getByRole("button", { name: "Send voice recording" })).toBeDisabled();
    await page.touchscreen.tap(recordBox.x + recordBox.width / 2, recordBox.y + recordBox.height / 2);
    expect(await calls()).toEqual(expected);
    await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
    await expect(composer).toHaveValue(draft);
    expect(await page.evaluate(() => ({ queue: window.__voiceFixture.state.queue,
      next: window.__voiceFixture.state.nextRecordingTarget, target: window.__voiceFixture.state.active?.recognitionThreadId,
      autoListen: window.__voiceFixture.state.settings.autoListen }))).toEqual({ queue, next: null, target: spokenId, autoListen: false });
    await expectNoPageOverflow(page);
    await capture(page, testInfo, `voice-record-after-${phase}-320.png`);
    await toolbar.getByRole("button", { name: "Cancel voice recording", exact: true }).tap();
    expected.push({ method: "stopCurrentInteraction", args: { expectedConnectionGeneration: 1, interactionId: `reply:${id}` } });
    await expect.poll(calls).toEqual(expected);
  }

  for (const width of [320, 360, 480]) {
    await page.setViewportSize({ width, height: 780 });
    for (const phase of ["synthesizing", "speaking"] as const) {
      await playback(`last-${phase}`, phase, true);
      const stop = toolbar.getByRole("button", { name: "Stop voice interaction", exact: true });
      const record = toolbar.getByRole("button", { name: "Record reply", exact: true });
      const next = toolbar.getByRole("button", { name: "Next voice interaction", exact: true });
      const stopBox = (await stop.boundingBox())!, recordBox = (await record.boundingBox())!;
      for (const [count, autoListen, showNext] of [[0, false, false], [0, true, true], [0, false, false], [1, false, true]] as const) {
        await publishVoiceState(page, { settings: { ...settings, autoListen }, queue: { ...queue, count } });
        await expect(next).toHaveCount(showNext ? 1 : 0);
        await expect(stop).toBeEnabled();
        await expect(record).toBeEnabled();
        await expect.poll(() => stop.boundingBox()).toEqual(stopBox);
        await expect.poll(() => record.boundingBox()).toEqual(recordBox);
        expect((await toolbar.boundingBox())!.height).toBe(60);
        await expectNoPageOverflow(page);
      }
      if (width === 360 && phase === "speaking") {
        await publishVoiceState(page, { queue: { ...queue, count: 0 } });
        await expect(next).toHaveCount(0);
        await capture(page, testInfo, "voice-final-playback-no-next-360.png");
        await publishVoiceState(page, { queue: { ...queue, count: 1 } });
        await expect(next).toBeVisible();
        await capture(page, testInfo, "voice-next-returned-360.png");
      }
    }
  }
  await playback("playback-next", "speaking", true);
  await tapAndRepeatAfterRemoval(page, toolbar.getByRole("button", { name: "Next voice interaction", exact: true }));
  expected.push({ method: "skipCurrentPlayback", args: { expectedConnectionGeneration: 1, interactionId: "playback-next" } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls()).toEqual(expected);
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await playback("playback-stop", "speaking", false);
  await tapAndRepeatAfterRemoval(page, toolbar.getByRole("button", { name: "Stop voice interaction", exact: true }));
  expected.push({ method: "stopPlayback", args: { expectedConnectionGeneration: 1, interactionId: "playback-stop" } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls()).toEqual(expected);
  expect(await page.evaluate(() => window.__voiceFixture.state.queue)).toEqual({ ...queue, count: 0, bytes: 0 });
  await expect(toolbar.getByRole("button", { name: "Next voice interaction" })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Stop voice interaction" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(composer).toHaveValue(draft);

  await page.goto("/settings/voice");
  expected.length = 0;
  await playback("unpinned-stop", "speaking", false);
  await publishVoiceState(page, { settings: { ...settings, pinDefaultVoiceThread: false }, nextRecordingTarget: null,
    retainedVoiceTarget: { threadId: spokenId, threadTitle: "Spoken thread B", revision: 12 } });
  const repeat = await tapAndRepeatAfterRemoval(page, toolbar.getByRole("button", { name: "Stop voice interaction", exact: true }));
  expect(repeat.target).toBe("Next voice interaction");
  expected.push({ method: "stopPlayback", args: { expectedConnectionGeneration: 1, interactionId: "unpinned-stop" } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.getByRole("button", { name: "Next voice interaction", exact: true })).toBeEnabled();
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Spoken thread B");
  expect(await page.evaluate(() => window.__voiceFixture.state.retainedVoiceTarget?.threadId)).toBe(spokenId);
  await expect(page).toHaveURL(/\/settings\/voice$/u);
  await capture(page, testInfo, "voice-unpinned-after-stop-repeat-480.png");
});

test("background recording announcements are opt-in and their preparation can be cancelled on a narrow screen", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-announcement");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const viewedPath = await createDraftThread(page, "Viewed while announcing");
  const draft = "Keep this draft while announcing another thread.";
  await fillAndPersistDraft(page, draft);
  const targetPath = await createDraftThread(page, "Recording destination");
  const targetId = targetPath.split("/").at(-1)!;
  await page.goto("/settings/voice");
  await page.setViewportSize({ width: 320, height: 780 });
  const toggle = page.getByRole("switch", { name: "Announce recording thread", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAccessibleDescription("Read the destination before a new headset or notification recording. Skip in-app starts, playback interruptions to reply, and automatic follow-up recording.");
  await toggle.tap();
  await expect(toggle).toBeChecked();
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "updateSettings"))).toEqual([
    { method: "updateSettings", args: { expectedConnectionGeneration: 1, expectedRevision: 0, patch: { announceRecordingThread: true } } },
  ]);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-announcement-setting-320.png");
  await page.goto(viewedPath);
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const base = voiceFixtureState();
  // Native publishes the validated destination's current title, even if the browser's inventory has an older one.
  await publishVoiceState(page, { phase: "announcing", active: { id: "announcement", eventKind: "manual", threadId: viewedPath.split("/").at(-1)!,
    threadTitle: "Earlier speech", recognitionThreadId: targetId, recognitionThreadTitle: "Renamed recording destination", automatic: false, recording: null },
    actions: { ...base.actions, canStart: false, canStop: true } });
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Renamed recording destination");
  await expect(toolbar.locator(".voice-card-sub")).toHaveText("Announcing thread…");
  await expect(toolbar.getByRole("button", { name: "Record reply" })).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Next voice interaction" })).toHaveCount(0);
  const cancel = toolbar.getByRole("button", { name: "Cancel voice recording", exact: true });
  await expect(cancel).toBeEnabled();
  const box = (await cancel.boundingBox())!;
  expect(box.width).toBe(40);
  expect(box.height).toBe(40);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-announcement-before-cancel-320.png");
  await cancel.tap();
  await expect.poll(() => page.evaluate(() => window.__voiceFixture.calls.filter(call =>
    ["stopCurrentInteraction", "recordDuringPlayback", "skipCurrentPlayback", "startManualListen"].includes(call.method)))).toEqual([
    { method: "stopCurrentInteraction", args: { expectedConnectionGeneration: 1, interactionId: "announcement" } },
  ]);
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(page.getByRole("textbox", { name: "Message Scripted agent", exact: true })).toHaveValue(draft);
  expect(await page.evaluate(() => window.__voiceFixture.state.settings.announceRecordingThread)).toBe(true);
  await capture(page, testInfo, "voice-announcement-after-cancel-320.png");
});

test("idle navigation follows the viewed thread and only releases a displayed retained fallback", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-retained-target");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const viewedPath = await createDraftThread(page, "Viewed thread A");
  const viewedId = viewedPath.split("/").at(-1)!;
  const draft = "Keep the current thread and its draft.";
  await fillAndPersistDraft(page, draft);
  const retainedPath = await createDraftThread(page, "Last voice thread B");
  const chosenPath = await createDraftThread(page, "Chosen thread C");
  const retainedId = retainedPath.split("/").at(-1)!;
  const chosenId = chosenPath.split("/").at(-1)!;
  await page.goto(viewedPath);
  await page.setViewportSize({ width: 320, height: 780 });
  const toolbar = page.getByRole("group", { name: "Voice controls", exact: true });
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const base = voiceFixtureState();
  const retain = async (revision: number) => {
    await publishVoiceState(page, { phase: "idle", active: null, queue: base.queue,
      settings: { ...base.settings, voiceThreadId: chosenId, voiceThreadTitle: "Chosen thread C" },
      retainedVoiceTarget: { threadId: retainedId, threadTitle: "Last voice thread B", revision }, idleTargetRevision: revision,
      actions: { ...base.actions, canReleaseRetainedTarget: true } });
  };
  const calls = () => page.evaluate(() => window.__voiceFixture.calls.filter(call =>
    ["releaseRetainedVoiceTarget", "startManualListen", "skipCurrentPlayback"].includes(call.method)));
  const expected: Awaited<ReturnType<typeof calls>> = [];
  const next = toolbar.getByRole("button", { name: "Next voice interaction", exact: true });
  const stop = toolbar.getByRole("button", { name: "Stop voice interaction", exact: true });
  const mic = toolbar.getByRole("button", { name: "Start voice recording", exact: true });
  await retain(7);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Viewed thread A");
  await expect(next).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await mic.tap();
  expected.push({ method: "startManualListen", args: { expectedConnectionGeneration: 1, threadId: viewedId, threadTitle: "Viewed thread A" } });
  await expect.poll(calls).toEqual(expected);
  await expect(composer).toHaveValue(draft);
  await capture(page, testInfo, "voice-retained-viewed-thread-320.png");
  await page.goto(chosenPath);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  await expect(next).toHaveCount(0);
  expect(await page.evaluate(() => window.__voiceFixture.state.retainedVoiceTarget?.threadId)).toBe(chosenId);
  expect(await calls()).toEqual([]);

  // With no viewed thread, retention is the displayed fallback and Next releases it.
  await page.goto("/settings/voice");
  // Reloads preserve the native fixture state, while its call log belongs to the new document.
  expected.length = 0;
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  const retainedRevision = await page.evaluate(() => window.__voiceFixture.state.retainedVoiceTarget!.revision);
  expect(await calls()).toEqual(expected);
  await expect(next).toBeEnabled();
  const nextBox = (await next.boundingBox())!;
  await expect(stop).toHaveCount(0);
  const micBox = (await mic.boundingBox())!;
  for (const box of [nextBox, micBox]) {
    expect(box.width).toBe(40);
    expect(box.height).toBe(40);
  }
  expect(nextBox.x + nextBox.width + 4).toBe(micBox.x);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-retained-before-release-320.png");
  await tapAndRepeatAfterRemoval(page, next);
  expected.push({ method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: retainedRevision } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  await expect(next).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  await expect.poll(() => mic.boundingBox()).toEqual(micBox);
  expect(await calls()).toEqual(expected);
  await expect(page).toHaveURL(/\/settings\/voice$/u);
  await capture(page, testInfo, "voice-retained-after-release-320.png");

  await retain(9);
  await toolbar.getByRole("button", { name: "Choose target thread: Last voice thread B", exact: true }).tap();
  await page.getByRole("dialog", { name: "Choose target thread", exact: true }).getByRole("button", { name: "Chosen thread C", exact: true }).tap();
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  await expect(next).toHaveCount(0);
  expect(await calls()).toEqual(expected);
  expect(await page.evaluate(() => window.__voiceFixture.state.nextRecordingTarget)).toEqual({ threadId: chosenId, threadTitle: "Chosen thread C" });
  await expect.poll(() => mic.boundingBox()).toEqual(micBox);
  await capture(page, testInfo, "voice-retained-explicit-choice-320.png");
  await page.goto(viewedPath);
  // The Settings-stage calls were asserted before this second reload boundary.
  expected.length = 0;
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  expect(await calls()).toEqual(expected);
  await mic.tap();
  expected.push({ method: "startManualListen", args: { expectedConnectionGeneration: 1, threadId: chosenId, threadTitle: "Chosen thread C" } });
  await expect.poll(calls).toEqual(expected);
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(composer).toHaveValue(draft);
});
