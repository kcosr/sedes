import { z } from "zod";
import { applicationTurnIdSchema, threadIdSchema } from "./domain.js";
import { requireSerializedByteLimit } from "./payload.js";
import { clientOriginSchema } from "./thread-input.js";

export const MAX_EARLY_REPLY_BYTES = 8 * 1024;
export const MAX_EARLY_REPLY_FRAMES = 256;

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const earlyReplySessionSchema = z.strictObject({ voiceStreamId: z.uuid(), token, revision });
export const earlyReplyInterestSchema = z.strictObject({ token, revision, enabled: z.boolean() });
export type EarlyReplySession = z.infer<typeof earlyReplySessionSchema>;
export type EarlyReplyInterest = z.infer<typeof earlyReplyInterestSchema>;

const common = {
  replyId: z.string().regex(/^[a-f0-9]{64}$/u),
  threadId: threadIdSchema,
  turnId: applicationTurnIdSchema,
  itemId: z.string().min(1).max(512),
  generation: revision,
};
const offset = z.number().int().min(0).max(MAX_EARLY_REPLY_BYTES);
const encoder = new TextEncoder();
// Unicode-mode character classes match lone surrogate code units, never valid pairs.
const unicode = z.string().refine(text => !/[\uD800-\uDFFF]/u.test(text), "Invalid Unicode.");
const segmentFields = {
  rawStart: offset, rawEnd: offset, text: unicode.max(MAX_EARLY_REPLY_BYTES), paragraphEnd: z.boolean(),
};
export type EarlyReplySegment = z.infer<z.ZodObject<typeof segmentFields>>;

const controlSequence = z.number().int().min(1).max(MAX_EARLY_REPLY_FRAMES);
export const earlyReplyFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("begin"), seq: z.literal(0),
    threadTitle: unicode.max(512), userInputRevision: revision, origin: clientOriginSchema.optional(),
    ...segmentFields, rawStart: z.literal(0) }),
  z.strictObject({ ...common, kind: z.literal("append"), seq: z.number().int().min(1).max(MAX_EARLY_REPLY_FRAMES - 1),
    ...segmentFields }),
  z.strictObject({ ...common, kind: z.literal("yield"), seq: controlSequence,
    reason: z.enum(["markup", "item_done", "limit", "stall"]) }),
  z.strictObject({ ...common, kind: z.literal("cancel"), seq: controlSequence,
    reason: z.enum(["source_changed", "authority_lost", "superseded", "policy_changed", "publication_suppressed", "expired"]) }),
]).superRefine((frame, context) => {
  requireSerializedByteLimit(frame, context, 65_536, "Early reply frame exceeds 64 KiB.");
  if (frame.kind !== "begin" && frame.kind !== "append") return;
  if (frame.rawEnd - frame.rawStart !== frame.text.length ||
    encoder.encode(frame.text).byteLength > MAX_EARLY_REPLY_BYTES ||
    (!frame.text.length && (frame.kind === "begin" || !frame.paragraphEnd))) {
    context.addIssue({ code: "custom", message: "Invalid early reply text range." });
  }
});
export type EarlyReplyFrame = z.infer<typeof earlyReplyFrameSchema>;
