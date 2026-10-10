import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

test.use({ hasTouch: true });

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
    ["recordDuringPlayback", "skipCurrentPlayback", "stopCurrentInteraction", "startManualListen"].includes(call.method)));
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
    for (const name of ["Record reply", "Next voice interaction", "Stop voice interaction"]) {
      const button = toolbar.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled();
      const box = (await button.boundingBox())!;
      expect(box.width, `${name} touch width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${name} touch height`).toBeGreaterThanOrEqual(44);
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
  };

  for (const [phase, automatic] of [["synthesizing", true], ["speaking", false]] as const) {
    const id = `playback-${phase}`;
    await playback(id, phase, automatic);
    await assertPlaybackTargets();
    await capture(page, testInfo, `voice-record-before-${phase}-320.png`);
    await toolbar.getByRole("button", { name: "Record reply", exact: true }).tap();
    expected.push({ method: "recordDuringPlayback", args: { expectedConnectionGeneration: 1, interactionId: id } });
    await expect.poll(calls).toEqual(expected);
    await expect(toolbar.locator(".voice-card-sub")).toHaveText("Listening");
    await expect(toolbar.locator(".voice-card-title")).toHaveText("Spoken thread B");
    await expect(toolbar.getByRole("button", { name: "Next voice interaction" })).toHaveCount(0);
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

  await playback("playback-next", "speaking", true);
  await toolbar.getByRole("button", { name: "Next voice interaction", exact: true }).tap();
  expected.push({ method: "skipCurrentPlayback", args: { expectedConnectionGeneration: 1, interactionId: "playback-next" } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await playback("playback-stop", "speaking", false);
  await toolbar.getByRole("button", { name: "Stop voice interaction", exact: true }).tap();
  expected.push({ method: "stopCurrentInteraction", args: { expectedConnectionGeneration: 1, interactionId: "playback-stop" } });
  await expect.poll(calls).toEqual(expected);
  await expect(toolbar.locator(".voice-card-sub")).toContainText("Ready");
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(composer).toHaveValue(draft);
});

test("recording announcements are opt-in and their preparation can be cancelled on a narrow screen", async ({ page }, testInfo) => {
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
  await expect(toggle).toHaveAccessibleDescription("Read the destination thread before the recording cue.");
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
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
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

test("idle Next releases the last voice thread without moving Mic or discarding a chosen target", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "voice-retained-target");
  await mkdir(workspace, { recursive: true });
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const viewedPath = await createDraftThread(page, "Viewed thread A");
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
    await expect(toolbar.locator(".voice-card-title")).toHaveText("Last voice thread B");
  };
  const calls = () => page.evaluate(() => window.__voiceFixture.calls.filter(call =>
    ["releaseRetainedVoiceTarget", "startManualListen", "skipCurrentPlayback"].includes(call.method)));
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Viewed thread A");
  await expect(toolbar.locator(".voice-card-next-slot")).toHaveCount(0);
  const originalTextWidth = (await toolbar.locator(".voice-card-body").boundingBox())!.width;
  await retain(7);
  const next = toolbar.getByRole("button", { name: "Next voice interaction", exact: true });
  const mic = toolbar.getByRole("button", { name: "Start voice recording", exact: true });
  await expect(next).toBeEnabled();
  const nextBox = (await next.boundingBox())!;
  const micBox = (await mic.boundingBox())!;
  expect(nextBox.width).toBeGreaterThanOrEqual(44);
  expect(nextBox.height).toBeGreaterThanOrEqual(44);
  expect(nextBox.x + nextBox.width).toBeLessThan(micBox.x);
  expect(originalTextWidth - (await toolbar.locator(".voice-card-body").boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-retained-before-release-320.png");
  await next.tap();
  await expect.poll(calls).toEqual([{ method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: 7 } }]);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Viewed thread A");
  await expect(next).toHaveCount(0);
  await expect.poll(() => mic.boundingBox()).toEqual(micBox);
  // A repeated tap at the old Next position reaches an empty slot, never Mic or the expanding thread-title link.
  await page.touchscreen.tap(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  expect(await calls()).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(composer).toHaveValue(draft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-retained-after-release-320.png");

  await retain(9);
  await toolbar.getByRole("button", { name: "Choose target thread: Last voice thread B", exact: true }).tap();
  await page.getByRole("dialog", { name: "Choose target thread", exact: true }).getByRole("button", { name: "Chosen thread C", exact: true }).tap();
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  await next.tap();
  await expect.poll(calls).toEqual([
    { method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: 7 } },
    { method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: 9 } },
  ]);
  await expect(toolbar.locator(".voice-card-title")).toHaveText("Chosen thread C");
  expect(await page.evaluate(() => window.__voiceFixture.state.nextRecordingTarget)).toEqual({ threadId: chosenId, threadTitle: "Chosen thread C" });
  await expect.poll(() => mic.boundingBox()).toEqual(micBox);
  await capture(page, testInfo, "voice-retained-explicit-choice-320.png");
  await mic.tap();
  await expect.poll(calls).toEqual([
    { method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: 7 } },
    { method: "releaseRetainedVoiceTarget", args: { expectedConnectionGeneration: 1, expectedRetainedRevision: 9 } },
    { method: "startManualListen", args: { expectedConnectionGeneration: 1, threadId: chosenId, threadTitle: "Chosen thread C" } },
  ]);
  await expect(page).toHaveURL(new RegExp(`${viewedPath}$`, "u"));
  await expect(composer).toHaveValue(draft);
});
