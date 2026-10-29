import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow } from "./helpers.js";
import { installVoiceFixture, publishVoiceState, voiceFixtureState } from "./voice-controls-fixture.js";

test.use({ hasTouch: true });

test("Android upload quality follows optional model capabilities and preserves an unsupported selection until changed", async ({ page }, testInfo) => {
  await installVoiceFixture(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/settings/voice");
  const quality = page.getByRole("combobox", { name: "Upload quality", exact: true });
  await expect(quality).toHaveValue("original");
  await expect(quality.locator("option")).toHaveCount(1);

  const base = voiceFixtureState();
  const serverSettings = { ...base.settings, speechProvider: "server" as const, speechEndpoint: "https://speech.example/v1", sttModel: "local-asr" };
  const catalog = { source: "server" as const, sttModels: ["local-asr"], ttsModels: [], voices: [], speed: null,
    formats: ["pcm"], audioInputFormats: { "local-asr": { binaryPcm: false, binaryOpus: false } } };
  await publishVoiceState(page, { settings: serverSettings,
    speech: { ...base.speech, catalogStatus: "ready", catalog } });
  await expect(quality.locator("option")).toHaveCount(1);
  await publishVoiceState(page, { speech: { ...base.speech, catalogStatus: "ready",
    catalog: { ...catalog, audioInputFormats: { "local-asr": { binaryPcm: true, binaryOpus: true } } } } });
  await expect(quality.locator("option")).toHaveCount(3);
  await quality.selectOption("opus_low");
  await expect(quality).toHaveValue("opus_low");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "setSpeechAudioQuality"))).toEqual([
    { method: "setSpeechAudioQuality", args: { expectedConnectionGeneration: 1, expectedAudioQualityRevision: 0, audioQuality: "opus_low" } },
  ]);
  await quality.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-upload-quality-supported-360.png");

  const selectedSpeech = await page.evaluate(() => window.__voiceFixture.state.speech);
  await publishVoiceState(page, { speech: { ...selectedSpeech, catalog: null, catalogStatus: "loading" } });
  await expect(quality).toHaveValue("opus_low");
  await expect(quality).toHaveAccessibleDescription(/Checking this model’s Opus support/);
  await expect(quality).not.toHaveAttribute("aria-invalid", "true");
  await expect(quality.getByRole("option", { name: "Low bandwidth (checking support…)", exact: true })).toBeDisabled();
  await expect(page.getByText(/Choose Original to record/)).toHaveCount(0);
  await quality.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "voice-upload-quality-checking-360.png");
  await publishVoiceState(page, { speech: { ...selectedSpeech, catalog: null, catalogStatus: "error", error: "Couldn’t refresh." } });
  await expect(quality).toHaveValue("opus_low");
  await expect(quality).toHaveAccessibleDescription(/Opus support is unverified/);
  await expect(quality).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(/Choose Original to record/)).toHaveCount(0);
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "setSpeechAudioQuality"))).toHaveLength(1);
  await quality.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-upload-quality-unverified-360.png");

  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await expect(quality).toHaveValue("opus_low");
  await expect(quality).toHaveAccessibleDescription(/Choose Original to record/);
  await expect(quality.getByRole("option", { name: "Low bandwidth (unavailable)", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "setSpeechAudioQuality"))).toHaveLength(1);
  await quality.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "voice-upload-quality-unsupported-360.png");
  await quality.selectOption("original");
  await expect(quality).toHaveValue("original");
  expect(await page.evaluate(() => window.__voiceFixture.calls.filter(call => call.method === "setSpeechAudioQuality").at(-1))).toEqual({
    method: "setSpeechAudioQuality", args: { expectedConnectionGeneration: 1, expectedAudioQualityRevision: 1, audioQuality: "original" },
  });
  await publishVoiceState(page, { phase: "listening", active: { id: "recording", eventKind: "manual", threadId: null,
    threadTitle: null, recognitionThreadId: null, recognitionThreadTitle: null, automatic: false,
    recording: { id: "capture", keepListening: true, reconnecting: false } } });
  await expect(quality).toBeDisabled();
  await quality.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "voice-upload-quality-recording-360.png");
});
