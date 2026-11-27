import { z } from "zod";
import { backendBrandSchema, threadIdSchema } from "./protocol/domain.js";
import { MAXIMUM_THREAD_INPUT_BYTES } from "./protocol/context-excerpts.js";

export const MAXIMUM_THREAD_REFERENCES = 16;
export const THREAD_REFERENCE_HEADER =
  "Sedes thread references selected for this message:";

const legacyThreadReferenceSchema = z.strictObject({
  threadId: threadIdSchema,
  title: z.string().min(1).max(512),
});
export const threadReferenceSchema = legacyThreadReferenceSchema.extend({
  brand: backendBrandSchema.optional(),
  project: z.string().min(1).max(512).optional(),
  environment: z.string().min(1).max(512).optional(),
});
export type ThreadReference = z.infer<typeof threadReferenceSchema>;
export type ThreadReferencePart = string | ThreadReference;

export const threadReferencePartsSchema = z.array(
  z.union([z.string().min(1).max(MAXIMUM_THREAD_INPUT_BYTES), threadReferenceSchema]),
).min(1).max(2 * MAXIMUM_THREAD_REFERENCES + 1).refine(
  (parts) => parts.filter((part) => typeof part !== "string").length <= MAXIMUM_THREAD_REFERENCES &&
    parts.every((part, index) => typeof part !== "string" || typeof parts[index - 1] !== "string"),
  "An inline body must contain coalesced text and at most 16 thread references.",
).refine(
  (parts) => tokenEncoder.encode(threadReferenceProviderParts(parts)).byteLength <= MAXIMUM_THREAD_INPUT_BYTES,
  "Thread reference text exceeds the UTF-8 input limit.",
);

const referenceBlockSchema = z.strictObject({
  threadReferences: z.array(legacyThreadReferenceSchema).min(1).max(MAXIMUM_THREAD_REFERENCES)
    .refine((items) => new Set(items.map(({ threadId }) => threadId)).size === items.length),
});

function codeFenceRanges(value: string): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  let fence: { character: string; length: number; start: number } | undefined;
  for (const match of value.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const marker = match[1]!;
    if (!fence) fence = { character: marker[0]!, length: marker.length, start: match.index };
    else if (marker[0] === fence.character && marker.length >= fence.length && !match[2]!.trim()) {
      ranges.push([fence.start, match.index + match[0].length]);
      fence = undefined;
    }
  }
  if (fence) ranges.push([fence.start, value.length]);
  return ranges;
}

/**
 * Historical drafts and snapshots used a leading reference block. Preserve
 * its original format when changing the ordinary text of such a draft.
 */
export function formatThreadReferenceText(
  text: string,
  references: readonly ThreadReference[],
): string {
  if (references.length === 0) return text;
  const block = referenceBlockSchema.parse({ threadReferences: references });
  return `${THREAD_REFERENCE_HEADER}\n${JSON.stringify(block)}\n\n${text}`;
}

/**
 * Only an exact, canonical block is presented as chips. Unknown fields,
 * malformed JSON, duplicate IDs, excessive references and noncanonical text
 * remain visible verbatim. Multiple blocks can result from appending a stash
 * or restoring a failed delivery; later titles win for the same stable ID.
 */
export function splitThreadReferenceText(value: string): {
  readonly text: string;
  readonly references: readonly ThreadReference[];
} {
  if (!value.includes(`${THREAD_REFERENCE_HEADER}\n`)) return { text: value, references: [] };
  const references = new Map<string, ThreadReference>();
  const fences = codeFenceRanges(value);
  let fenceIndex = 0;
  const pattern = /^Sedes thread references selected for this message:\n([^\n]*)\n\n/gm;
  const text = value.replace(pattern, (whole: string, json: string, offset: number) => {
    if (offset !== 0 && value.slice(offset - 2, offset) !== "\n\n") return whole;
    // Escaped titles can exceed 32 KiB even within the reference count limit.
    // Admit any block that can fit the composer's existing UTF-8 input budget;
    // the complete input is byte-checked at draft and delivery admission.
    if (json.length > MAXIMUM_THREAD_INPUT_BYTES) return whole;
    try {
      const parsed = referenceBlockSchema.safeParse(JSON.parse(json));
      if (!parsed.success || JSON.stringify(parsed.data) !== json) return whole;
      while (fences[fenceIndex] && fences[fenceIndex]![1] <= offset) fenceIndex += 1;
      if (fences[fenceIndex] && fences[fenceIndex]![0] <= offset) return whole;
      const ids = new Set([...references.keys(), ...parsed.data.threadReferences.map(({ threadId }) => threadId)]);
      if (ids.size > MAXIMUM_THREAD_REFERENCES) return whole;
      for (const reference of parsed.data.threadReferences) references.set(reference.threadId, reference);
      return "";
    } catch {
      return whole;
    }
  });
  return { text, references: [...references.values()] };
}

export function replaceThreadReferenceBody(value: string, text: string): string {
  return formatThreadReferenceText(text, splitThreadReferenceText(value).references);
}

// A whole-value envelope distinguishes selected atoms from literal Markdown in
// existing text-bearing draft, stash, creation, queue and snapshot records.
const INLINE_BODY_HEADER = "Sedes inline thread reference body:\n";
const tokenEncoder = new TextEncoder();

function encodeLabel(title: string): string {
  return title.replace(/[%[\]()\\\x00-\x1f\x7f\u2028\u2029]/gu, (character) =>
    [...tokenEncoder.encode(character)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

function serializeParts(parts: readonly ThreadReferencePart[]): string {
  // Reuse the provider's escaped title here, so storage byte checks always
  // cover the projected prompt as well, even for a title of 512 controls.
  return INLINE_BODY_HEADER + JSON.stringify(parts.map((part) =>
    typeof part === "string" ? part : { ...part, title: encodeLabel(part.title) },
  ));
}

function requiresEnvelope(text: string): boolean {
  return (text.startsWith(INLINE_BODY_HEADER) && inlineParts(text) !== undefined) || splitThreadReferenceText(text).references.length > 0;
}

function inlineParts(value: string): ThreadReferencePart[] | undefined {
  if (!value.startsWith(INLINE_BODY_HEADER)) return undefined;
  try {
    const wire: unknown = JSON.parse(value.slice(INLINE_BODY_HEADER.length));
    if (!Array.isArray(wire) || wire.length > 2 * MAXIMUM_THREAD_REFERENCES + 1) return undefined;
    const parts = threadReferencePartsSchema.safeParse(wire.map((part: unknown) =>
      part && typeof part === "object" && "title" in part && typeof part.title === "string"
        ? { ...part, title: decodeURIComponent(part.title) } : part,
    ));
    if (!parts.success || serializeParts(parts.data) !== value) return undefined;
    const plain = parts.data[0];
    if (parts.data.length === 1 && typeof plain === "string" && !requiresEnvelope(plain)) return undefined;
    return parts.data;
  } catch { /* A look-alike that is not canonical remains ordinary text. */ }
  return undefined;
}

export function formatInlineThreadReferenceText(parts: readonly ThreadReferencePart[]): string {
  const normalized: ThreadReferencePart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (!part) continue;
      const previous = normalized.at(-1);
      if (typeof previous === "string") {
        normalized[normalized.length - 1] = previous + part;
        continue;
      }
    }
    normalized.push(part);
  }
  if (normalized.length === 0) return "";
  const plain = normalized[0];
  if (normalized.length === 1 && typeof plain === "string" &&
    !requiresEnvelope(plain)) return plain;
  return serializeParts(threadReferencePartsSchema.parse(normalized));
}

export function hasInlineThreadReferenceBody(value: string): boolean {
  return inlineParts(value) !== undefined;
}

export function readThreadReferenceBody(value: string): {
  parts: ThreadReferencePart[];
  legacyReferences: readonly ThreadReference[];
} {
  const parts = inlineParts(value);
  if (parts) return { parts, legacyReferences: [] };
  const { text, references } = splitThreadReferenceText(value);
  return { parts: text ? [text] : [], legacyReferences: references };
}

export function threadReferenceDisplayText(parts: readonly ThreadReferencePart[]): string {
  return parts.map((part) => typeof part === "string" ? part : part.title).join("");
}

export function threadReferenceProviderParts(parts: readonly ThreadReferencePart[]): string {
  return parts.map((part) => typeof part === "string"
    ? part : `[${encodeLabel(part.title)}](sedes-thread:${part.threadId.toLowerCase()})`).join("");
}

export function threadReferenceProviderText(value: string): string {
  const parts = inlineParts(value);
  return parts ? threadReferenceProviderParts(parts) : value;
}

export function threadReferenceMessagePart(value: string) {
  const parts = inlineParts(value);
  return parts
    ? { kind: "thread_reference_body" as const, parts }
    : { kind: "text" as const, text: { text: value } };
}

export function editableThreadParts(value: string): ThreadReferencePart[] {
  const { parts, legacyReferences } = readThreadReferenceBody(value);
  return [...legacyReferences.flatMap((ref) => [ref, " "]), ...parts];
}

/** Both arguments come from durable drafts; literal input must be formatted first. */
export function appendThreadReferenceText(left: string, right: string, separator = "\n\n"): string {
  if (!left) return right;
  if (!right) return left;
  if (!left.startsWith(INLINE_BODY_HEADER) && !right.startsWith(INLINE_BODY_HEADER)) {
    const combined = left + separator + right;
    if (!requiresEnvelope(combined) || splitThreadReferenceText(left).references.length ||
      splitThreadReferenceText(right).references.length) return combined;
    // A separator can complete the framing of two pieces of literal text.
    return formatInlineThreadReferenceText([combined]);
  }
  return formatInlineThreadReferenceText([...editableThreadParts(left), separator, ...editableThreadParts(right)]);
}
