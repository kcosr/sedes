import { afterEach, describe, expect, it, vi } from "vitest";
import { unified } from "unified";
import { defaultNotificationDelivery, voiceNotificationSchema, type NotificationPolicy, type VoiceNotification } from "../../shared/protocol/notification.js";
import type { ThreadInputContext } from "../../shared/protocol/thread-input.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";
import { automaticTargetCurrent, electronSpeechText, ElectronVoiceQueue, notificationEligible, notificationListens, stopCommand,
  voiceChunks, voiceItemText, type ElectronVoiceQueueItem } from "./electron-voice-policy.js";
import { electronVoiceDefaults } from "./electron-voice-state.js";

afterEach(() => { vi.restoreAllMocks(); });

const THREAD = "10000000-0000-4000-8000-000000000001";
const settings = (patch: Partial<NativeVoiceSettings> = {}): NativeVoiceSettings => ({ ...electronVoiceDefaults(), audioMode: "speak", ...patch });
const policy: NotificationPolicy = { generation: 3, settings: { revision: 2, enabled: true, silenced: false,
  assistantResultPhases: ["final"], scriptPath: "", arguments: [], timeoutSeconds: 30, delivery: defaultNotificationDelivery() } };
function notice(id = "notice", patch: Partial<VoiceNotification> = {}): VoiceNotification {
  return voiceNotificationSchema.parse({ sourceEventId: id, generation: 3, voice: "speakThenListen", userInputRevision: 7,
    recognitionTarget: { threadId: THREAD, activityToken: "activity", sourceTurnId: "turn-1" },
    payload: { schemaVersion: 5, notificationId: id, event: "turn.completed", occurredAt: "2026-10-28T00:00:00.000Z",
      title: "Thread finished", message: "Release review", thread: { id: THREAD, title: "Review" },
      assistantResult: { final: { text: "Final answer" } } }, ...patch });
}
function item(id = "notice", text = "Final answer", event: "turn.completed" | "turn.progress" | "turn.partial" = "turn.completed"): ElectronVoiceQueueItem {
  const original = notice(id);
  const notification = notice(id, { voice: event === "turn.completed" ? "speakThenListen" : "speak",
    payload: { ...original.payload, event, ...(event === "turn.completed" ? { assistantResult: { final: { text } } }
      : { progress: { itemId: id, phase: event === "turn.partial" ? "partial" : "provisional", text } }) } });
  return { id, threadId: THREAD, threadTitle: "Review", event, notification };
}
function replay(id = "replay", text = "Replay answer", turnId = "turn-1"): ElectronVoiceQueueItem {
  return { id, threadId: THREAD, threadTitle: "Review", event: "replay", replay: { threadId: THREAD, turnId, assistantResult: { final: { text } } } };
}
const context = (patch: Partial<ThreadInputContext> = {}): ThreadInputContext => ({ threadId: THREAD, threadTitle: "Review",
  authority: "current", runState: null, activityToken: "activity", sourceTurnId: "turn-1", userInputRevision: 7,
  manualListenEligible: true, automaticListenEligible: true, steer: { availability: "unsupported" }, ...patch });

describe("desktop voice notification policy", () => {
  it("requires the current enabled policy and limits other-device notices while keeping unowned automation notices", () => {
    const current = notice();
    expect(notificationEligible(current, policy, settings(), "this-client")).toBe(true);
    expect(notificationEligible(notice("other", { origin: { clientId: "other-client" } }), policy, settings(), "this-client")).toBe(false);
    expect(notificationEligible(notice("same", { origin: { clientId: "this-client" } }), policy, settings(), "this-client")).toBe(true);
    expect(notificationEligible(notice("other", { origin: { clientId: "other-client" } }), policy, settings({ ignoreOtherDevices: false }), "this-client")).toBe(true);
    for (const denied of [null, { ...policy, generation: 4 }, { ...policy, settings: { ...policy.settings, silenced: true } },
      { ...policy, settings: { ...policy.settings, enabled: false } }]) expect(notificationEligible(current, denied, settings(), "this-client")).toBe(false);
    expect(notificationEligible(current, policy, settings({ audioMode: "off" }), "this-client")).toBe(false);
    expect(notificationEligible(notice("none", { voice: "none" }), policy, settings(), "this-client")).toBe(false);
  });

  it("filters to the explicit default thread and fails closed when that thread is missing", () => {
    expect(notificationEligible(notice(), policy, settings({ onlyVoiceThread: true, voiceThreadId: THREAD }), null)).toBe(true);
    expect(notificationEligible(notice(), policy, settings({ onlyVoiceThread: true, voiceThreadId: "other-thread" }), null)).toBe(false);
    expect(notificationEligible(notice(), policy, settings({ onlyVoiceThread: true, voiceThreadId: null }), null)).toBe(false);
    const sourceOnly = notice("source", { recognitionTarget: undefined, voice: "speak" });
    expect(notificationEligible(sourceOnly, policy, settings({ onlyVoiceThread: true, voiceThreadId: THREAD }), null)).toBe(true);
  });

  it("opens automatic listening only when requested, enabled and backed by current target authority", () => {
    expect(notificationListens(notice(), settings())).toBe(true);
    expect(notificationListens(notice(), settings({ audioMode: "input" }))).toBe(true);
    expect(notificationListens(notice(), settings({ autoListen: false }))).toBe(false);
    expect(notificationListens(notice("speak", { voice: "speak" }), settings())).toBe(false);
    expect(notificationListens(notice("untargeted", { recognitionTarget: undefined }), settings())).toBe(false);
    const failed = notice("failed", { payload: { ...notice().payload, event: "turn.failed" } });
    expect(notificationListens(failed, settings({ audioMode: "input" }))).toBe(false);
    expect(automaticTargetCurrent(notice(), context())).toBe(true);
    for (const patch of [{ threadId: "other-thread" }, { activityToken: "new-activity" }, { sourceTurnId: "new-turn" },
      { userInputRevision: 8 }, { authority: "unbound" as const }, { authority: "unavailable" as const }, { automaticListenEligible: false }]) {
      expect(automaticTargetCurrent(notice(), context(patch))).toBe(false);
    }
  });

  it("selects announcement, reply and progress content independently and replays only the reply", () => {
    const automatic = item();
    expect(voiceItemText(automatic, settings({ speechContent: "announcements" }))).toBe("Thread finished\n\nRelease review");
    expect(voiceItemText(automatic, settings({ speechContent: "messages" }))).toBe("Final answer");
    expect(voiceItemText(automatic, settings())).toBe("Thread finished\n\nRelease review\n\nFinal answer");
    expect(voiceItemText(automatic, settings({ audioMode: "input" }))).toBe("");
    expect(voiceItemText(item("progress", "Progress text", "turn.progress"), settings({ speechContent: "messages" }))).toBe("Progress text");
    expect(voiceItemText(replay(), settings({ audioMode: "input", speechContent: "announcements" }))).toBe("Replay answer");
    const truncated = notice("truncated", { payload: { ...notice().payload, assistantResult: { provisional: { text: "Draft" }, final: {
      text: "Answer", truncation: { truncated: true, retainedBytes: 6, reason: "byte_limit" } } } } });
    expect(voiceItemText({ ...automatic, notification: truncated }, settings({ speechContent: "messages" })))
      .toBe("Draft\n\nAnswer\n\nThe remaining response was truncated.");
  });
});

describe("desktop speech formatting", () => {
  it("reads Markdown labels, code and table values without hidden link destinations", () => {
    const source = "# Heading\n\nRead [the **guide**](https://example.test/private?token=hidden) and ![a red fox](fox.png).\n\n`foo_bar(x * 2)`\n\n| Name | State |\n| --- | --- |\n| **Service** | Ready |";
    const spoken = electronSpeechText(source, true);
    expect(spoken).toBe("Heading\n\nRead the guide and a red fox.\n\nfoo_bar(x * 2)\n\nName; State\n\nService; Ready");
    expect(spoken).not.toContain("hidden");
    expect(electronSpeechText(source, false)).toBe(source);
    for (const empty of ["", " \n\t", "---", "#", "```\n```", "[ref]: https://example.test"])
      expect(electronSpeechText(empty, true)).toBe("");
  });

  it("flattens deeply nested valid Markdown without treating its speech as an invalid notification", () => {
    const source = `${"> ".repeat(200)}Read [the **guide**](https://example.test/hidden).`;
    expect(electronSpeechText(source, true)).toBe("Read the guide.");
    const queue = new ElectronVoiceQueue();
    const configured = settings({ speechContent: "messages" });
    expect(queue.add(item("deep", source), configured)).toBe(true);
    expect(queue.add(item("next", "Next reply"), configured)).toBe(true);
    expect(queue.items.map(entry => voiceItemText(entry, configured))).toEqual(["Read the guide.", "Next reply"]);
  });

  it("drops only the speech part when parsing reaches a resource limit and still renders later content", () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified()), "parse");
    parse.mockImplementationOnce(() => { throw new RangeError("Parser recursion limit"); });
    expect(electronSpeechText("unusually nested reply", true)).toBe("");
    expect(electronSpeechText("**Next reply**", true)).toBe("Next reply");
  });

  it("splits long speech within the request limit without breaking supplementary Unicode characters", () => {
    const text = "First sentence. Another sentence with a 🦦 and music 🎵. 最後の段落。";
    const chunks = voiceChunks(text, 19);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(19);
      // Unicode mode matches only unpaired surrogate code units in this range.
      expect(chunk).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(voiceChunks("🦦🦦🦦", 2)).toEqual(["🦦", "🦦", "🦦"]);
    expect(voiceChunks("", 10)).toEqual([]);
  });

  it("recognizes only the complete stop phrases with terminal punctuation", () => {
    for (const text of ["stop", " STOP! ", "Stop listening.", "stop listening…"]) expect(stopCommand(text)).toBe(true);
    for (const text of ["", "please stop", "stop the service", "don't stop", "stop listening and send"]) expect(stopCommand(text)).toBe(false);
  });
});

describe("desktop playback queue", () => {
  const raw = settings({ speechContent: "messages", cleanSpeechText: false });

  it("reuses prepared speech across queue accounting, playback and unrelated settings changes", () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified()), "parse");
    const queue = new ElectronVoiceQueue();
    const configured = settings({ speechContent: "messages" });
    const first = item("first", "**Long reply**. ".repeat(400));
    const second = item("second", "Another [reply](https://example.test). ".repeat(400));
    queue.add(first, configured); queue.add(second, configured);
    const initialParses = parse.mock.calls.length;
    expect(initialParses).toBeGreaterThan(0);
    const firstBytes = new TextEncoder().encode(voiceItemText(first, configured)).byteLength;
    const secondBytes = new TextEncoder().encode(voiceItemText(second, configured)).byteLength;
    for (let iteration = 0; iteration < 100; iteration++) {
      expect(queue.bytes({ ...configured })).toBe(firstBytes + secondBytes);
      expect(voiceItemText(first, { ...configured, ttsGain: 50 })).toContain("Long reply");
    }
    queue.reconfigure({ ...configured, cueGain: 50 });
    expect(parse).toHaveBeenCalledTimes(initialParses);
    const playing = queue.items.shift()!;
    expect(voiceItemText(playing, { ...configured })).toContain("Long reply");
    expect(queue.bytes(configured)).toBe(secondBytes);
    queue.add(replay("manual", "Manual **reply**"), configured);
    expect(parse).toHaveBeenCalledTimes(initialParses + 1);
    queue.reconfigure({ ...configured, speechContent: "announcements" });
    const updatedParses = parse.mock.calls.length;
    expect(updatedParses).toBeGreaterThan(initialParses + 1);
    for (let iteration = 0; iteration < 100; iteration++) queue.bytes({ ...configured, speechContent: "announcements" });
    expect(parse).toHaveBeenCalledTimes(updatedParses);
    queue.items.splice(0, 1);
    expect(queue.bytes(configured)).toBe(new TextEncoder().encode("Manual reply").byteLength);
    queue.items.length = 0;
    expect(queue.bytes(configured)).toBe(0);
    expect(parse).toHaveBeenCalledTimes(updatedParses);
  });

  it("preserves arrival order, suppresses duplicate events and deduplicates pending replays by thread and turn", () => {
    const queue = new ElectronVoiceQueue();
    expect(queue.add(item("first"), raw)).toBe(true);
    expect(queue.add(replay("replay-one"), raw)).toBe(true);
    expect(queue.add(item("second"), raw)).toBe(true);
    expect(queue.add(item("first"), raw)).toBe(false);
    expect(queue.add(replay("replay-duplicate"), raw)).toBe(false);
    expect(queue.items.map(entry => entry.id)).toEqual(["first", "replay-one", "second"]);
    queue.items.shift();
    expect(queue.add(item("first"), raw)).toBe(false);
    queue.items.shift();
    expect(queue.add(replay("replay-again"), raw)).toBe(true);
    expect(queue.items.map(entry => entry.id)).toEqual(["second", "replay-again"]);
  });

  it("bounds item count and evicts only provisional progress to make room for an answer", () => {
    const queue = new ElectronVoiceQueue();
    queue.add(item("progress", "Working", "turn.progress"), raw);
    for (let index = 0; index < 63; index++) queue.add(item(`partial-${index}`, "Answer fragment", "turn.partial"), raw);
    expect(queue.add(item("new-progress", "More work", "turn.progress"), raw)).toBe(false);
    expect(queue.items).toHaveLength(64);
    expect(queue.dropped.overflow).toBe(1);
    expect(queue.add(item("completed"), raw)).toBe(true);
    expect(queue.items).toHaveLength(64);
    expect(queue.items[0]!.id).toBe("partial-0");
    expect(queue.items.at(-1)!.id).toBe("completed");
    expect(queue.dropped.progress_evicted).toBe(1);
    expect(queue.add(item("extra"), raw)).toBe(false);
  });

  it("bounds UTF-8 speech bytes and rejects a replay without evicting progress when it still cannot fit", () => {
    const queue = new ElectronVoiceQueue();
    for (let index = 0; index < 4; index++) expect(queue.add(item(`large-${index}`, "é".repeat(30_000)), raw)).toBe(true);
    expect(queue.add(item("progress", "x".repeat(20_000), "turn.progress"), raw)).toBe(true);
    expect(queue.bytes(raw)).toBe(260_000);
    const before = [...queue.items];
    expect(() => queue.add(replay("too-large", "x".repeat(30_000)), raw)).toThrow("Voice playback queue is full");
    expect(queue.items).toEqual(before);
    expect(queue.dropped).toEqual({});
    expect(queue.add(replay("fits", "x".repeat(10_000)), raw)).toBe(true);
    expect(queue.bytes(raw)).toBe(250_000);
    expect(queue.items.some(entry => entry.id === "progress")).toBe(false);
    expect(queue.dropped.progress_evicted).toBe(1);
  });

  it("keeps pending IDs deduplicated after the bounded event history has rolled over", () => {
    const queue = new ElectronVoiceQueue();
    const silent = settings({ audioMode: "input" });
    queue.add(item("pending"), silent);
    for (let index = 0; index < 63; index++) queue.add(item(`queued-${index}`), silent);
    for (let index = 0; index < 4096; index++) queue.add(item(`dropped-${index}`), silent);
    queue.items.pop(); // A newer item became ineligible; the original pending item remains.
    expect(queue.add(item("pending"), silent)).toBe(false);
    expect(queue.items.filter(entry => entry.id === "pending")).toHaveLength(1);
    expect(queue.seen.size).toBeLessThanOrEqual(4096);
  });

  it("rebuilds queued presentation from original content when speech selection or cleanup changes", () => {
    const queue = new ElectronVoiceQueue();
    const source = "Read [the guide](https://example.test/private).";
    queue.add(item("notice", source), settings({ speechContent: "announcements" }));
    expect(voiceItemText(queue.items[0]!, settings({ speechContent: "messages" }))).toBe("Read the guide.");
    expect(voiceItemText(queue.items[0]!, raw)).toBe(source);
    expect(queue.items[0]!.notification!.payload.assistantResult!.final!.text).toBe(source);
  });

  it("reapplies queue bounds when changed speech selection expands pending messages", () => {
    const queue = new ElectronVoiceQueue();
    const announcements = settings({ speechContent: "announcements", cleanSpeechText: false });
    for (let index = 0; index < 6; index++) {
      expect(queue.add(item(`item-${index}`, "x".repeat(60_000), index === 1 ? "turn.progress" : "turn.completed"), announcements)).toBe(true);
    }
    const expanded = settings({ speechContent: "both", cleanSpeechText: false });
    expect(queue.reconfigure(expanded)).toEqual(["item-1", "item-5"]);
    expect(queue.items.map(entry => entry.id)).toEqual(["item-0", "item-2", "item-3", "item-4"]);
    expect(queue.bytes(expanded)).toBeLessThanOrEqual(256 * 1024);
    expect(queue.dropped).toEqual({ progress_evicted: 1, overflow: 1 });
    expect(queue.add(item("item-5"), expanded)).toBe(false);
    expect(queue.reconfigure(announcements)).toEqual([]);
    expect(queue.items.map(entry => entry.id)).toEqual(["item-0", "item-2", "item-3", "item-4"]);
  });

  it("coalesces only repeated attention for the same subject while preserving unrelated queue order", () => {
    const wake = (id: string, subjectId: string): ElectronVoiceQueueItem => {
      const notification = notice(id, { userInputRevision: undefined, subjectId, recognitionTarget: undefined, voice: "speak",
        payload: { ...notice(id).payload, event: "thread.woke" } });
      return { id, notification, threadId: THREAD, threadTitle: "Review", event: "thread.woke" };
    };
    const queue = new ElectronVoiceQueue();
    queue.add(wake("old", "subject-one"), raw);
    queue.add(wake("other", "subject-two"), raw);
    queue.add(item("answer"), raw);
    queue.add(wake("new", "subject-one"), raw);
    expect(queue.items.map(entry => entry.id)).toEqual(["other", "answer", "new"]);
  });

  it("clears automatic notifications without clearing manual replay, then resets all session state", () => {
    const queue = new ElectronVoiceQueue();
    queue.add(item("first"), raw); queue.add(replay(), raw); queue.add(item("last"), raw);
    queue.clearAutomatic("settings_changed");
    expect(queue.items.map(entry => entry.id)).toEqual(["replay"]);
    expect(queue.dropped).toEqual({ settings_changed: 2 });
    queue.reset();
    expect(queue.items).toEqual([]);
    expect(queue.seen.size).toBe(0);
    expect(queue.dropped).toEqual({});
  });
});
