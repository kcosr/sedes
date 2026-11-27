import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ElectronEarlyReply } from "../../src/client/voice/electron-early-reply.js";
import { electronSpeechText } from "../../src/client/voice/electron-voice-policy.js";
import { electronVoiceDefaults } from "../../src/client/voice/electron-voice-state.js";
import { EarlyReplyPublication } from "../../src/server/domain/early-reply-publication.js";
import { earlyReplyFrameSchema } from "../../src/shared/protocol/early-reply.js";

const examples = [
  { live: "Yes.", completed: "Yes." },
  { live: "Yes. This", completed: "Yes. This is a test." },
  {
    live: "Yes. Sedes",
    completed: "Yes. Sedes can show whether a thread is running, idle, or waiting for input, either for one thread or across a list of threads.\n"
      + "The tools I have don’t show whether a thread has an unread or unacknowledged notification, or whether it has an attention badge. "
      + "They do show when an automation needs attention because a run failed or its outcome is uncertain.",
  },
];

describe.each(["turn.progress", "turn.completed"] as const)("%s completed-text handoff", event => {
  it.each(["responsive", "balanced", "natural"] as const)("keeps the full opening together in %s", mode => {
    const settings = { ...electronVoiceDefaults(), audioMode: "speak" as const, speechContent: "messages" as const };
    for (const { live, completed } of examples) {
      const requests: string[] = [];
      const streamId = randomUUID();
      let reply: ElectronEarlyReply | undefined;
      const publication = new EarlyReplyPublication(
        { tenantId: "tenant", principalId: "principal" }, randomUUID(), "turn", "item", event, 1, "a".repeat(64), ["final"],
        [{ voiceStreamId: streamId, send(frame) {
          const received = earlyReplyFrameSchema.parse(frame);
          if (received.kind === "begin") reply = new ElectronEarlyReply(received, 0, streamId);
          else if (reply?.receive(received, 1) !== "accepted") throw new Error("Missing or invalid early frame");
          // Give the device a chance to request speech immediately on every frame.
          for (let part; (part = reply?.next(settings, mode, 4096));) requests.push(part.text);
          return true;
        } }],
        { threadTitle: "Thread", userInputRevision: 1, admitted: () => true, fresh: () => true },
        event === "turn.progress" ? 0 : undefined,
        () => true, () => {},
      );
      try {
        publication.observe(live, []);
        expect(requests).toEqual([]);
        publication.finish("item_done", completed, []);
        expect(requests).toEqual([electronSpeechText(completed, settings.cleanSpeechText)]);
      } finally {
        publication.dispose();
      }
    }
  });
});
