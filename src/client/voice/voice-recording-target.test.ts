import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { voiceSettings, voiceSnapshot } from "./native-voice-test-fixture.js";
import { voiceRecordingTarget } from "./voice-recording-target.js";

const thread = (id: string, title: string, patch: Partial<NormalizedApplicationThreadSummary> = {}) => ({
  id, title: { text: title }, available: true, inventoryState: "active", ...patch,
}) as NormalizedApplicationThreadSummary;
const threads = [thread("viewed", "Viewed thread"), thread("default", "Default thread"), thread("next", "Explicit choice"),
  thread("offline", "Unavailable", { available: false }), thread("archived", "Archived", { inventoryState: "archived" })];
const retainedVoiceTarget = { threadId: "outside-inventory", threadTitle: "Last voice thread", revision: 2 };

describe("recording target precedence", () => {
  it("keeps the retained thread outside the browser inventory until it is released", () => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default" }) });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, "viewed")).toEqual({ threadId: "viewed", threadTitle: "Viewed thread" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, null)).toEqual({ threadId: "default", threadTitle: "Default thread" });
  });
  it("gives the explicit next choice precedence over the pin, and the pin precedence over retention", () => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default", pinDefaultVoiceThread: true }) });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "default", threadTitle: "Default thread" });
    expect(voiceRecordingTarget(threads, { ...native, nextRecordingTarget: { threadId: "next", threadTitle: "Explicit choice" } }, "viewed"))
      .toEqual({ threadId: "next", threadTitle: "Explicit choice" });
  });
  it.each(["offline", "archived", "missing"])("does not silently replace an unavailable explicit choice or pin (%s) with retention", threadId => {
    const native = voiceSnapshot({ retainedVoiceTarget });
    expect(voiceRecordingTarget(threads, { ...native, nextRecordingTarget: { threadId, threadTitle: null } }, "viewed")).toBeUndefined();
    expect(voiceRecordingTarget(threads, { ...native, settings: voiceSettings({ pinDefaultVoiceThread: true, voiceThreadId: threadId }) }, "viewed")).toBeUndefined();
  });
});
