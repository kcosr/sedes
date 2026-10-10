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
