import { describe, expect, it } from "vitest";
import { earlyReplyFrameSchema, earlyReplyInterestSchema, earlyReplySessionSchema } from "../../src/shared/protocol/early-reply.js";
import { applicationEventStreamQuerySchema } from "../../src/shared/protocol/api.js";
import { progressParkedSchema, voiceNotificationSchema } from "../../src/shared/protocol/notification.js";

const id = "975f9653-3bc0-487f-865a-319eb5ae1aec";
const base = { replyId: "0".repeat(64), itemId: "item", turnId: "turn", threadId: id, generation: 1 };
describe("identified early reply voice lane", () => {
  it("accepts only a paired interest and canonical revision for a native reservation", () => {
    const parse = (input: object) => applicationEventStreamQuerySchema.safeParse(input).success;
    expect(parse({})).toBe(true);
    expect(parse({ voiceStreamId: id })).toBe(true);
    expect(applicationEventStreamQuerySchema.parse({ voiceStreamId: id, earlyReply: "off", earlyRevision: "12" }).earlyRevision).toBe(12);
    for (const earlyRevision of ["", "-1", "01", "1e2", "9007199254740992"]) expect(parse({ voiceStreamId: id, earlyReply: "on", earlyRevision })).toBe(false);
    expect(parse({ earlyReply: "on", earlyRevision: "0" })).toBe(false);
    expect(parse({ voiceStreamId: id, earlyReply: "on" })).toBe(false);
    const token = "A".repeat(43);
    expect(earlyReplySessionSchema.safeParse({ voiceStreamId: id, token, revision: 0 }).success).toBe(true);
    expect(earlyReplyInterestSchema.safeParse({ token, enabled: true, revision: 1, voiceStreamId: id }).success).toBe(false);
  });
  it("checks exact control and text shapes, Unicode, byte bounds and offsets", () => {
    const begin = { ...base, kind: "begin", event: "turn.completed", seq: 0, threadTitle: "Title", userInputRevision: 0,
      rawStart: 0, rawEnd: 2, text: "Hi", paragraphEnd: false };
    const valid = (frame: object) => earlyReplyFrameSchema.safeParse(frame).success;
    expect(valid(begin)).toBe(true);
    expect(valid({ ...begin, event: "turn.progress", progressParkRevision: 0 })).toBe(true);
    expect(valid({ ...begin, event: "turn.progress" })).toBe(false);
    expect(valid({ ...begin, event: "turn.progress", progressParkRevision: -1 })).toBe(false);
    expect(valid({ ...begin, progressParkRevision: 1 })).toBe(false);
    for (const overrides of [{ event: undefined }, { event: "turn.partial" }, { seq: 1 }, { rawStart: 1 }, { rawEnd: 1 }, { recognitionTarget: "x" }, { text: "\uD83D!", rawEnd: 2 },
      { text: "漢".repeat(3000), rawEnd: 3000 }, { replyId: "x" }]) expect(valid({ ...begin, ...overrides })).toBe(false);
    const append = { ...base, kind: "append", seq: 1, rawStart: 4, rawEnd: 4, text: "", paragraphEnd: true };
    expect(valid(append)).toBe(true);
    expect(valid({ ...append, event: "turn.progress" })).toBe(false);
    expect(valid({ ...append, progressParkRevision: 0 })).toBe(false);
    expect(valid({ ...append, paragraphEnd: false })).toBe(false);
    expect(valid({ ...append, seq: 256 })).toBe(false);
    expect(valid({ ...base, kind: "yield", seq: 256, reason: "limit" })).toBe(true);
    for (const reason of ["item_done", "observation_ended"]) {
      expect(valid({ ...base, kind: "yield", seq: 4, reason })).toBe(true);
      expect(valid({ ...base, kind: "cancel", seq: 4, reason })).toBe(false);
    }
  });
  it("carries the park revision only on automatic progress notifications", () => {
    const payload = {
      schemaVersion: 5, notificationId: "notice", occurredAt: "2026-01-01T00:00:00.000Z",
      title: "Title", message: "Message", thread: { id, title: "Title" }, turn: { id: "turn" },
    };
    const notice = { sourceEventId: "event", generation: 1, voice: "speak", userInputRevision: 2 };
    const progress = { ...notice, payload: { ...payload, event: "turn.progress",
      progress: { itemId: "item", phase: "provisional", text: "Working." } } };
    const valid = (input: object) => voiceNotificationSchema.safeParse(input).success;
    expect(valid({ ...progress, progressParkRevision: 2 })).toBe(true);
    expect(valid(progress)).toBe(false);
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(valid({ ...progress, progressParkRevision: invalid })).toBe(false);
    }
    for (const other of [
      { ...payload, event: "turn.completed" },
      { ...payload, event: "turn.partial", progress: { itemId: "item", phase: "partial", text: "First result." } },
    ]) {
      expect(valid({ ...notice, payload: other })).toBe(true);
      expect(valid({ ...notice, payload: other, progressParkRevision: 0 })).toBe(false);
    }
  });
  it("scopes a park signal to a thread and a safe revision", () => {
    const signal = { threadId: id, progressParkRevision: 3 };
    expect(progressParkedSchema.parse(signal)).toEqual(signal);
    for (const invalid of [{ threadId: id }, { ...signal, progressParkRevision: 0 }, { ...signal, progressParkRevision: "3" },
      { ...signal, progressParkRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...signal, turnId: "turn" }]) {
      expect(progressParkedSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
