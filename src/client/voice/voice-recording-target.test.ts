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
  it("keeps voice continuity ahead of the viewed thread until native releases it", () => {
    const native = voiceSnapshot({ retainedVoiceTarget, settings: voiceSettings({ voiceThreadId: "default" }) });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
    expect(voiceRecordingTarget(threads, native, "next")).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
    expect(voiceRecordingTarget(threads, native, null)).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, "viewed")).toEqual({ threadId: "viewed", threadTitle: "Viewed thread", source: "visible" });
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: null }, null)).toEqual({ threadId: "default", threadTitle: "Default thread", source: "default" });
  });
  it("uses the visible source when continuity already names the viewed thread", () => {
    const native = voiceSnapshot({ retainedVoiceTarget: { threadId: "viewed", threadTitle: "Old title", revision: 2 } });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "viewed", threadTitle: "Viewed thread", source: "visible" });
  });
  it("follows a new visible route before its foreground bridge reply arrives", () => {
    const native = voiceSnapshot({ retainedVoiceTarget,
      foreground: { visible: true, threadId: "viewed", threadTitle: "Viewed thread" } });
    expect(voiceRecordingTarget(threads, native, "next")).toEqual({ threadId: "next", threadTitle: "Explicit choice", source: "visible" });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
    expect(voiceRecordingTarget(threads, { ...native, nextRecordingTarget: { threadId: "default", threadTitle: "Default thread" } }, "next"))
      .toEqual({ threadId: "default", threadTitle: "Default thread", source: "explicit" });
    expect(voiceRecordingTarget(threads, { ...native, settings: voiceSettings({ voiceThreadId: "default", pinDefaultVoiceThread: true }) }, "next"))
      .toEqual({ threadId: "default", threadTitle: "Default thread", source: "pinned" });
  });
  it.each([false, true])("keeps continuity while foreground context is absent on resume (visible=%s)", visible => {
    const native = voiceSnapshot({ retainedVoiceTarget, foreground: { visible, threadId: null, threadTitle: null } });
    expect(voiceRecordingTarget(threads, native, "viewed")).toEqual({ threadId: "outside-inventory", threadTitle: "Last voice thread", source: "retained" });
  });
  it.each(["offline", "archived", "missing"])("opens the chooser for unavailable newly viewed %s before foreground reconciliation", threadId => {
    const native = voiceSnapshot({ retainedVoiceTarget,
      foreground: { visible: true, threadId: "viewed", threadTitle: "Viewed thread" } });
    expect(voiceRecordingTarget(threads, native, threadId)).toBeUndefined();
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
  it.each(["offline", "archived", "missing"])("does not redirect an unavailable visible thread (%s) after continuity is released", threadId => {
    const native = voiceSnapshot({ settings: voiceSettings({ voiceThreadId: "default" }) });
    expect(voiceRecordingTarget(threads, native, threadId)).toBeUndefined();
    expect(voiceRecordingTarget(threads, { ...native, retainedVoiceTarget: { threadId, threadTitle: "Old title", revision: 2 } }, threadId)).toBeUndefined();
  });
});
