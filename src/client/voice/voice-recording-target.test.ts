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
  it("follows browsing before retention and keeps retention as the no-visible-thread fallback", () => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default" }) });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "viewed", threadTitle: "Viewed thread", source: "visible" });
    expect(voiceRecordingTarget(threads, native, "next")).toEqual({ threadId: "next", threadTitle: "Explicit choice", source: "visible" });
    expect(voiceRecordingTarget(threads, native, null)).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, "viewed")).toEqual({ threadId: "viewed", threadTitle: "Viewed thread", source: "visible" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, null)).toEqual({ threadId: "default", threadTitle: "Default thread", source: "default" });
  });
  it.each(["Original title", null])("refreshes the retained title from inventory without changing its destination (native title %s)", threadTitle => {
    const native = voiceSnapshot({ retainedVoiceTarget: { threadId: "retained", threadTitle, revision: 2 },
      settings: voiceSettings({ voiceThreadId: "default" }) });
    const currentThreads = [...threads, thread("retained", "Original title")];
    expect(voiceRecordingTarget(currentThreads, native, null)).toEqual({ threadId: "retained", threadTitle: "Original title", source: "retained" });
    const renamedThreads = currentThreads.map(item => item.id === "retained" ? thread(item.id, "Renamed title") : item);
    expect(voiceRecordingTarget(renamedThreads, native, null)).toEqual({ threadId: "retained", threadTitle: "Renamed title", source: "retained" });
  });
  it.each([["offline", "Unavailable"], ["archived", "Archived"]])("keeps the retained destination and its inventory title pending native validation (%s)", (threadId, threadTitle) => {
    const native = voiceSnapshot({ retainedVoiceTarget: { threadId, threadTitle: "Old title", revision: 2 } });
    expect(voiceRecordingTarget(threads, native, null)).toEqual({ threadId, threadTitle, source: "retained" });
  });
  it("gives the explicit next choice precedence over the pin, and the pin precedence over retention", () => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default", pinDefaultVoiceThread: true }) });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "default", threadTitle: "Default thread", source: "pinned" });
    expect(voiceRecordingTarget(threads, { ...native, nextRecordingTarget: { threadId: "next", threadTitle: "Explicit choice" } }, "viewed"))
      .toEqual({ threadId: "next", threadTitle: "Explicit choice", source: "explicit" });
  });
  it.each(["offline", "archived", "missing"])("does not silently replace an unavailable explicit choice or pin (%s) with retention", threadId => {
    const native = voiceSnapshot({ retainedVoiceTarget });
    expect(voiceRecordingTarget(threads, { ...native, nextRecordingTarget: { threadId, threadTitle: null } }, "viewed")).toBeUndefined();
    expect(voiceRecordingTarget(threads, { ...native, settings: voiceSettings({ pinDefaultVoiceThread: true, voiceThreadId: threadId }) }, "viewed")).toBeUndefined();
  });
  it.each(["offline", "archived", "missing"])("does not redirect an unavailable visible thread (%s) to retained or default", threadId => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default" }) });
    expect(voiceRecordingTarget(threads, native, threadId)).toBeUndefined();
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, threadId)).toBeUndefined();
  });
});
